const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openDatabase } = require("../src/store/db");
const { createRoomRepository } = require("../src/store/roomRepository");
const {
  createRetentionCheckoutSession,
  getConfiguredPriceIdForTier,
} = require("../src/stripeCheckout");

describe("stripeCheckout helpers", () => {
  test("getConfiguredPriceIdForTier reads env", () => {
    process.env.STRIPE_PRICE_RETENTION_7_DAYS = "price_7";
    assert.equal(getConfiguredPriceIdForTier("7_days"), "price_7");
    delete process.env.STRIPE_PRICE_RETENTION_7_DAYS;
    assert.equal(getConfiguredPriceIdForTier("7_days"), null);
  });
});

describe("createRetentionCheckoutSession", () => {
  let dbPath;
  let rooms;
  let prevEnv;

  before(() => {
    prevEnv = {
      STRIPE_PRICE_RETENTION_7_DAYS: process.env.STRIPE_PRICE_RETENTION_7_DAYS,
      STRIPE_PRICE_RETENTION_30_DAYS: process.env.STRIPE_PRICE_RETENTION_30_DAYS,
      STRIPE_PRICE_RETENTION_PERMANENT: process.env.STRIPE_PRICE_RETENTION_PERMANENT,
      STRIPE_CHECKOUT_SUCCESS_URL: process.env.STRIPE_CHECKOUT_SUCCESS_URL,
      STRIPE_CHECKOUT_CANCEL_URL: process.env.STRIPE_CHECKOUT_CANCEL_URL,
    };
    process.env.STRIPE_PRICE_RETENTION_30_DAYS = "price_30_test";
    process.env.STRIPE_CHECKOUT_SUCCESS_URL = "https://app.example/success?sid={CHECKOUT_SESSION_ID}";
    process.env.STRIPE_CHECKOUT_CANCEL_URL = "https://app.example/cancel";

    dbPath = path.join(
      os.tmpdir(),
      `burner-co-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    const db = openDatabase(dbPath);
    rooms = createRoomRepository(db);
    rooms.createRoomFromV1({
      id: "room-co",
      inviteCode: "666666",
      creatorDeviceId: "dev-co",
    });
    rooms.createRoomFromV1({
      id: "room-ended",
      inviteCode: "777777",
      creatorDeviceId: "dev-ended",
    });
  });

  after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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

  test("happy path — metadata and mode for webhook", async () => {
    let captured;
    const mockStripe = {
      checkout: {
        sessions: {
          create: async (opts) => {
            captured = opts;
            return {
              id: "cs_test_happy",
              url: "https://checkout.stripe.com/c/pay/cs_test_happy",
            };
          },
        },
      },
    };

    const out = await createRetentionCheckoutSession(rooms, mockStripe, {
      roomId: "room-co",
      deviceId: "dev-co",
      retentionTier: "30_days",
    });

    assert.equal(out.ok, true);
    assert.equal(out.sessionId, "cs_test_happy");
    assert.equal(out.url.includes("checkout.stripe.com"), true);
    assert.equal(out.roomId, "room-co");
    assert.equal(out.retentionTier, "30_days");

    assert.equal(captured.mode, "payment");
    assert.equal(captured.line_items[0].price, "price_30_test");
    assert.equal(captured.metadata.roomId, "room-co");
    assert.equal(captured.metadata.deviceId, "dev-co");
    assert.equal(captured.metadata.retentionTier, "30_days");
    assert.equal(captured.payment_intent_data.metadata.roomId, "room-co");
    assert.equal(captured.client_reference_id, "room-co:dev-co");
  });

  test("unlinked device → forbidden", async () => {
    const mockStripe = {
      checkout: {
        sessions: {
          create: async () => {
            throw new Error("should not create");
          },
        },
      },
    };
    const out = await createRetentionCheckoutSession(rooms, mockStripe, {
      roomId: "room-co",
      deviceId: "stranger",
      retentionTier: "30_days",
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "forbidden");
  });

  test("invalid tier", async () => {
    const out = await createRetentionCheckoutSession(rooms, {}, {
      roomId: "room-co",
      deviceId: "dev-co",
      retentionTier: "default",
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "invalid_tier");
  });

  test("missing price id for tier", async () => {
    delete process.env.STRIPE_PRICE_RETENTION_7_DAYS;
    const out = await createRetentionCheckoutSession(rooms, {}, {
      roomId: "room-co",
      deviceId: "dev-co",
      retentionTier: "7_days",
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "price_not_configured");
    assert.equal(out.envKey, "STRIPE_PRICE_RETENTION_7_DAYS");
  });

  test("missing urls", async () => {
    const su = process.env.STRIPE_CHECKOUT_SUCCESS_URL;
    const cu = process.env.STRIPE_CHECKOUT_CANCEL_URL;
    delete process.env.STRIPE_CHECKOUT_SUCCESS_URL;
    delete process.env.STRIPE_CHECKOUT_CANCEL_URL;
    try {
      const out = await createRetentionCheckoutSession(rooms, {}, {
        roomId: "room-co",
        deviceId: "dev-co",
        retentionTier: "30_days",
      });
      assert.equal(out.ok, false);
      assert.equal(out.reason, "missing_checkout_urls");
    } finally {
      process.env.STRIPE_CHECKOUT_SUCCESS_URL = su;
      process.env.STRIPE_CHECKOUT_CANCEL_URL = cu;
    }
  });

  test("ended room → room_not_active", async () => {
    rooms.endRoomBurnV1("room-ended");
    const out = await createRetentionCheckoutSession(rooms, {}, {
      roomId: "room-ended",
      deviceId: "dev-ended",
      retentionTier: "30_days",
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "room_not_active");
  });

  test("body successUrl + cancelUrl", async () => {
    let captured;
    const mockStripe = {
      checkout: {
        sessions: {
          create: async (opts) => {
            captured = opts;
            return { id: "cs_b", url: "https://x.test" };
          },
        },
      },
    };
    const su = process.env.STRIPE_CHECKOUT_SUCCESS_URL;
    const cu = process.env.STRIPE_CHECKOUT_CANCEL_URL;
    delete process.env.STRIPE_CHECKOUT_SUCCESS_URL;
    delete process.env.STRIPE_CHECKOUT_CANCEL_URL;
    try {
      const out = await createRetentionCheckoutSession(rooms, mockStripe, {
        roomId: "room-co",
        deviceId: "dev-co",
        retentionTier: "30_days",
        successUrl: "https://a/s",
        cancelUrl: "https://a/c",
      });
      assert.equal(out.ok, true);
      assert.equal(captured.success_url, "https://a/s");
      assert.equal(captured.cancel_url, "https://a/c");
    } finally {
      process.env.STRIPE_CHECKOUT_SUCCESS_URL = su;
      process.env.STRIPE_CHECKOUT_CANCEL_URL = cu;
    }
  });
});
