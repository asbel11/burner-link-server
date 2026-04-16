const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openDatabase } = require("../src/store/db");
const { createDeviceMembershipStore } = require("../src/deviceMembership");
const { getConnectMemberIncludedRetentionTier } = require("../src/connectMemberRetention");

describe("GET /v2/billing/membership shape (store.getMembershipStatus)", () => {
  let dbPath;
  let db;
  let membership;
  let prevTier;

  before(() => {
    prevTier = process.env.CONNECT_MEMBER_RETENTION_TIER;
    delete process.env.CONNECT_MEMBER_RETENTION_TIER;

    dbPath = path.join(
      os.tmpdir(),
      `burner-mstat-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    db = openDatabase(dbPath);
    membership = createDeviceMembershipStore(db);
  });

  after(() => {
    if (prevTier === undefined) delete process.env.CONNECT_MEMBER_RETENTION_TIER;
    else process.env.CONNECT_MEMBER_RETENTION_TIER = prevTier;

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

  test("never subscribed → status none, tier null, included retention default", () => {
    const s = membership.getMembershipStatus("dev-none");
    assert.equal(s.status, "none");
    assert.equal(s.isMember, false);
    assert.equal(s.membershipTier, null);
    assert.equal(s.membershipActiveUntil, null);
    assert.equal(s.includedRetentionTier, "30_days");
    assert.equal(s.deviceId, "dev-none");
  });

  test("active membership → status active, ISO until, included tier", () => {
    const future = Date.now() + 86400000 * 90;
    membership.applyActivationOrRenewal({
      eventId: "evt_status_active",
      deviceId: "dev-active",
      stripeCustomerId: "cus_a",
      stripeSubscriptionId: "sub_a",
      periodEndMs: future,
      tier: "pro",
    });
    const s = membership.getMembershipStatus("dev-active");
    assert.equal(s.status, "active");
    assert.equal(s.isMember, true);
    assert.equal(s.membershipTier, "pro");
    assert.equal(typeof s.membershipActiveUntil, "string");
    assert.ok(s.membershipActiveUntil.endsWith("Z"));
    assert.equal(s.includedRetentionTier, getConnectMemberIncludedRetentionTier());
  });

  test("inactive (expired) → status inactive, tier retained", () => {
    membership.applyActivationOrRenewal({
      eventId: "evt_status_inactive",
      deviceId: "dev-inactive",
      stripeCustomerId: "cus_i",
      stripeSubscriptionId: "sub_i",
      periodEndMs: Date.now() + 86400000,
      tier: "pro",
    });
    membership.applyExpirationBySubscription({
      eventId: "evt_expire_inactive",
      stripeSubscriptionId: "sub_i",
      atMs: Date.now() - 1000,
    });
    const s = membership.getMembershipStatus("dev-inactive");
    assert.equal(s.status, "inactive");
    assert.equal(s.isMember, false);
    assert.equal(s.membershipTier, "pro");
    assert.equal(typeof s.membershipActiveUntil, "string");
    assert.equal(s.includedRetentionTier, "30_days");
  });

  test("includedRetentionTier follows CONNECT_MEMBER_RETENTION_TIER when valid", () => {
    process.env.CONNECT_MEMBER_RETENTION_TIER = "permanent";
    try {
      const s = membership.getMembershipStatus("dev-none");
      assert.equal(s.includedRetentionTier, "permanent");
    } finally {
      delete process.env.CONNECT_MEMBER_RETENTION_TIER;
    }
  });

  test("empty deviceId → null (caller returns 400)", () => {
    assert.equal(membership.getMembershipStatus(""), null);
    assert.equal(membership.getMembershipStatus("   "), null);
  });
});
