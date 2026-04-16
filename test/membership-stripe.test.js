const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openDatabase } = require("../src/store/db");
const { createRoomRepository } = require("../src/store/roomRepository");
const { createDeviceMembershipStore } = require("../src/deviceMembership");
const { processMembershipStripeEvent } = require("../src/stripeMembershipWebhook");

describe("CONNECT membership (Phase M2)", () => {
  let dbPath;
  let db;
  let rooms;
  let membership;
  let prevRetentionTier;

  before(() => {
    prevRetentionTier = process.env.CONNECT_MEMBER_RETENTION_TIER;
    delete process.env.CONNECT_MEMBER_RETENTION_TIER;

    dbPath = path.join(
      os.tmpdir(),
      `burner-mem-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    db = openDatabase(dbPath);
    membership = createDeviceMembershipStore(db);
    rooms = createRoomRepository(db, { membership });
    rooms.createRoomFromV1({
      id: "room-mem",
      inviteCode: "666666",
      creatorDeviceId: "dev-mem",
    });
  });

  after(() => {
    if (prevRetentionTier === undefined) delete process.env.CONNECT_MEMBER_RETENTION_TIER;
    else process.env.CONNECT_MEMBER_RETENTION_TIER = prevRetentionTier;

    try {
      fs.unlinkSync(dbPath);
    } catch (_) {
      /* ignore */
    }
    for (const ext of ["-shm", "-wal"]) {
      try {
        fs.unlinkSync(dbPath + ext);
      } catch (_) {
        /* ignore */
      }
    }
  });

  const meta = {
    deviceId: "dev-mem",
    connectBilling: "membership",
    membershipTier: "pro",
  };

  const stripeMock = (periodEndSec) => ({
    subscriptions: {
      retrieve: async (id) => ({
        id,
        metadata: { ...meta },
        customer: "cus_testmem",
        current_period_end: periodEndSec,
      }),
    },
  });

  test("subscription activation via checkout.session.completed", async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 86400 * 30;
    const ev = {
      id: "evt_mem_checkout",
      object: "event",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "cs_mem",
          object: "checkout.session",
          mode: "subscription",
          metadata: { ...meta },
          subscription: "sub_mem_1",
          customer: "cus_testmem",
        },
      },
    };
    const out = await processMembershipStripeEvent(ev, {
      membership,
      stripe: stripeMock(periodEnd),
    });
    assert.equal(out.handled, true);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.duplicate, false);
    assert.equal(membership.isDeviceMember("dev-mem"), true);
    const rec = membership.getMembershipRecord("dev-mem");
    assert.equal(rec.isMember, true);
    assert.equal(rec.membershipTier, "pro");
    assert.equal(rec.stripeSubscriptionId, "sub_mem_1");
  });

  test("invoice.paid renews membership (new period)", async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 86400 * 60;
    const ev = {
      id: "evt_mem_inv_paid",
      object: "event",
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "in_mem_1",
          object: "invoice",
          subscription: "sub_mem_1",
          customer: "cus_testmem",
          period_end: periodEnd,
        },
      },
    };
    const out = await processMembershipStripeEvent(ev, {
      membership,
      stripe: stripeMock(periodEnd),
    });
    assert.equal(out.handled, true);
    assert.equal(out.body.ok, true);
    const rec = membership.getMembershipRecord("dev-mem");
    assert.equal(rec.membershipActiveUntil, periodEnd * 1000);
  });

  test("invoice.payment_failed expires membership", async () => {
    const ev = {
      id: "evt_mem_pay_fail",
      object: "event",
      type: "invoice.payment_failed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "in_mem_fail",
          object: "invoice",
          subscription: "sub_mem_1",
        },
      },
    };
    const out = await processMembershipStripeEvent(ev, {
      membership,
      stripe: stripeMock(Math.floor(Date.now() / 1000) + 99999),
    });
    assert.equal(out.handled, true);
    assert.equal(out.body.expired, true);
    assert.equal(membership.isDeviceMember("dev-mem"), false);
  });

  test("customer.subscription.deleted expires at period end", async () => {
    const periodEndSec = Math.floor(Date.now() / 1000) + 86400 * 5;
    membership.applyActivationOrRenewal({
      eventId: "evt_reactivate",
      deviceId: "dev-mem2",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_mem_cancel",
      periodEndMs: periodEndSec * 1000,
      tier: "pro",
    });
    assert.equal(membership.isDeviceMember("dev-mem2"), true);

    const endedAtSec = Math.floor(Date.now() / 1000) - 120;

    const ev = {
      id: "evt_sub_deleted",
      object: "event",
      type: "customer.subscription.deleted",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "sub_mem_cancel",
          object: "subscription",
          metadata: { ...meta, deviceId: "dev-mem2" },
          current_period_end: endedAtSec,
        },
      },
    };
    const out = await processMembershipStripeEvent(ev, {
      membership,
      stripe: null,
    });
    assert.equal(out.handled, true);
    assert.equal(out.body.expired, true);
    assert.equal(membership.isDeviceMember("dev-mem2"), false);
  });

  test("active member receives included retention tier on GET retention", () => {
    const future = Date.now() + 86400000 * 400;
    membership.applyActivationOrRenewal({
      eventId: "evt_mem_ret",
      deviceId: "dev-ret",
      stripeCustomerId: "cus_r",
      stripeSubscriptionId: "sub_ret",
      periodEndMs: future,
      tier: "pro",
    });
    rooms.createRoomFromV1({
      id: "room-ret",
      inviteCode: "777777",
      creatorDeviceId: "dev-ret",
    });
    const snap = rooms.getRetentionForLinkedDevice("room-ret", "dev-ret");
    assert.equal(snap.ok, true);
    assert.equal(snap.retentionTier, "30_days");
    assert.equal(snap.retentionSource, "connect_membership");
    assert.equal(snap.connectMembershipActive, true);
  });
});
