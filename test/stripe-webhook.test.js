const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const Stripe = require("stripe");
const { openDatabase } = require("../src/store/db");
const { createRoomRepository } = require("../src/store/roomRepository");
const {
  handleStripeWebhookPost,
  mapStripeEventToEntitlementInput,
} = require("../src/stripeWebhook");

const API_VERSION = "2025-02-24.acacia";
const WH_SECRET = "whsec_test_phase21_secret_value_32chars_x";

function mockRes() {
  const o = { statusCode: 200, body: null };
  return {
    status(c) {
      o.statusCode = c;
      return this;
    },
    json(b) {
      o.body = b;
      return this;
    },
    get headersSent() {
      return false;
    },
    _o: o,
  };
}

function signStripeEvent(event) {
  const stripe = new Stripe("sk_test_phase21_not_for_charges", {
    apiVersion: API_VERSION,
  });
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WH_SECRET,
  });
  return { rawBody: Buffer.from(payload, "utf8"), header, payload };
}

describe("mapStripeEventToEntitlementInput", () => {
  test("unsupported event → ignore", async () => {
    const m = await mapStripeEventToEntitlementInput({
      id: "evt_x",
      type: "customer.created",
      created: 1,
      data: { object: {} },
    });
    assert.equal(m.kind, "ignore");
  });

  test("checkout.session.completed missing metadata → reject", async () => {
    const m = await mapStripeEventToEntitlementInput({
      id: "evt_1",
      type: "checkout.session.completed",
      created: 1,
      data: {
        object: { id: "cs_1", metadata: {} },
      },
    });
    assert.equal(m.kind, "reject");
    assert.equal(m.reason, "missing_stripe_metadata");
  });
});

describe("handleStripeWebhookPost", () => {
  let dbPath;
  let rooms;
  let prevWh;
  let prevSk;

  before(() => {
    prevWh = process.env.STRIPE_WEBHOOK_SECRET;
    prevSk = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
    process.env.STRIPE_SECRET_KEY = "sk_test_phase21_not_for_charges";

    dbPath = path.join(
      os.tmpdir(),
      `burner-stripe-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    const db = openDatabase(dbPath);
    rooms = createRoomRepository(db);
    rooms.createRoomFromV1({
      id: "room-stripe",
      inviteCode: "555555",
      creatorDeviceId: "dev-stripe",
    });
  });

  after(() => {
    if (prevWh === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = prevWh;
    if (prevSk === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevSk;

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

  function checkoutEvent(id, metadata) {
    return {
      id,
      object: "event",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "cs_test",
          object: "checkout.session",
          metadata: metadata || {},
        },
      },
    };
  }

  test("invalid signature → 400", async () => {
    const ev = checkoutEvent("evt_bad_sig", {
      roomId: "room-stripe",
      deviceId: "dev-stripe",
      retentionTier: "7_days",
    });
    const { rawBody } = signStripeEvent(ev);
    const req = {
      body: rawBody,
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
    };
    const res = mockRes();
    await handleStripeWebhookPost(req, res, rooms);
    assert.equal(res._o.statusCode, 400);
    assert.equal(res._o.body.reason, "invalid_signature");
  });

  test("valid checkout.session.completed grants entitlement", async () => {
    const ev = checkoutEvent("evt_checkout_ok", {
      roomId: "room-stripe",
      deviceId: "dev-stripe",
      retentionTier: "30_days",
    });
    const { rawBody, header } = signStripeEvent(ev);
    const req = { body: rawBody, headers: { "stripe-signature": header } };
    const res = mockRes();
    await handleStripeWebhookPost(req, res, rooms);
    assert.equal(res._o.statusCode, 200);
    assert.equal(res._o.body.retentionTier, "30_days");
    assert.equal(res._o.body.retentionSource, "stripe");
    assert.equal(res._o.body.duplicate, false);
  });

  test("duplicate Stripe event id → idempotent", async () => {
    const ev = checkoutEvent("evt_dup_stripe", {
      roomId: "room-stripe",
      deviceId: "dev-stripe",
      retentionTier: "30_days",
    });
    const { rawBody, header } = signStripeEvent(ev);
    const req = { body: rawBody, headers: { "stripe-signature": header } };
    const res1 = mockRes();
    await handleStripeWebhookPost(req, res1, rooms);
    assert.equal(res1._o.body.duplicate, false);
    const res2 = mockRes();
    await handleStripeWebhookPost(
      { body: rawBody, headers: { "stripe-signature": header } },
      res2,
      rooms
    );
    assert.equal(res2._o.statusCode, 200);
    assert.equal(res2._o.body.duplicate, true);
  });

  test("invalid retention tier in metadata → 400", async () => {
    const ev = checkoutEvent("evt_bad_tier", {
      roomId: "room-stripe",
      deviceId: "dev-stripe",
      retentionTier: "lifetime_deluxe",
    });
    const { rawBody, header } = signStripeEvent(ev);
    const res = mockRes();
    await handleStripeWebhookPost(
      { body: rawBody, headers: { "stripe-signature": header } },
      res,
      rooms
    );
    assert.equal(res._o.statusCode, 400);
    assert.equal(res._o.body.reason, "invalid_retention_tier");
  });

  test("ignored event type → 200 ignored", async () => {
    const ev = {
      id: "evt_ignore_1",
      object: "event",
      type: "charge.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: { object: {} },
    };
    const { rawBody, header } = signStripeEvent(ev);
    const res = mockRes();
    await handleStripeWebhookPost(
      { body: rawBody, headers: { "stripe-signature": header } },
      res,
      rooms
    );
    assert.equal(res._o.statusCode, 200);
    assert.equal(res._o.body.ignored, true);
    assert.equal(res._o.body.received, true);
  });

  test("invoice.paid without metadata and no API key → 400", async () => {
    const prev = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const ev = {
        id: "evt_invoice_nometa",
        object: "event",
        type: "invoice.paid",
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: "in_nometa",
            object: "invoice",
            metadata: {},
            subscription: "sub_only_in_invoice",
          },
        },
      };
      const { rawBody, header } = signStripeEvent(ev);
      const res = mockRes();
      await handleStripeWebhookPost(
        { body: rawBody, headers: { "stripe-signature": header } },
        res,
        rooms
      );
      assert.equal(res._o.statusCode, 400);
      assert.equal(res._o.body.reason, "missing_stripe_metadata");
    } finally {
      if (prev === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prev;
    }
  });

  test("invoice.paid with invoice metadata grants", async () => {
    const ev = {
      id: "evt_invoice_1",
      object: "event",
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "in_test",
          object: "invoice",
          billing_reason: "subscription_cycle",
          subscription: "sub_test",
          metadata: {
            roomId: "room-stripe",
            deviceId: "dev-stripe",
            retentionTier: "30_days",
          },
        },
      },
    };
    const { rawBody, header } = signStripeEvent(ev);
    const res = mockRes();
    await handleStripeWebhookPost(
      { body: rawBody, headers: { "stripe-signature": header } },
      res,
      rooms
    );
    assert.equal(res._o.statusCode, 200);
    assert.equal(res._o.body.retentionTier, "30_days");
  });
});
