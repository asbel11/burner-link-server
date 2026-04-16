const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openDatabase } = require("../src/store/db");
const { createRoomRepository } = require("../src/store/roomRepository");
const { getCheckoutSessionSyncStatus } = require("../src/stripeCheckoutStatus");
const {
  RETENTION_POLL_AFTER_CHECKOUT,
  delayBeforeRetentionPollAttempt,
} = require("../src/retentionSyncPolicy");

describe("retentionSyncPolicy", () => {
  test("constants are bounded", () => {
    assert.equal(RETENTION_POLL_AFTER_CHECKOUT.maxAttempts >= 5, true);
    assert.equal(RETENTION_POLL_AFTER_CHECKOUT.maxDelayMs >= 1000, true);
  });

  test("delay grows then caps", () => {
    const d0 = delayBeforeRetentionPollAttempt(0);
    const d5 = delayBeforeRetentionPollAttempt(5);
    assert.equal(d0 >= RETENTION_POLL_AFTER_CHECKOUT.initialDelayMs, true);
    assert.equal(d5 <= RETENTION_POLL_AFTER_CHECKOUT.maxDelayMs + 200, true);
  });
});

describe("getCheckoutSessionSyncStatus", () => {
  let dbPath;
  let rooms;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-cs-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    const db = openDatabase(dbPath);
    rooms = createRoomRepository(db);
    rooms.createRoomFromV1({
      id: "room-cs",
      inviteCode: "888888",
      creatorDeviceId: "dev-cs",
    });
  });

  after(() => {
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

  test("invalid session id", async () => {
    const mockStripe = { checkout: { sessions: { retrieve: async () => ({}) } } };
    const out = await getCheckoutSessionSyncStatus(rooms, mockStripe, {
      roomId: "room-cs",
      deviceId: "dev-cs",
      sessionId: "not_cs",
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "invalid_session_id");
  });

  test("metadata mismatch → 403 shape", async () => {
    const mockStripe = {
      checkout: {
        sessions: {
          retrieve: async () => ({
            id: "cs_test_1",
            payment_status: "paid",
            status: "complete",
            metadata: { roomId: "other", deviceId: "dev-cs", retentionTier: "30_days" },
          }),
        },
      },
    };
    const out = await getCheckoutSessionSyncStatus(rooms, mockStripe, {
      roomId: "room-cs",
      deviceId: "dev-cs",
      sessionId: "cs_test_1",
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "session_metadata_mismatch");
  });

  test("paid session + tier in sync", async () => {
    await rooms.applyBillingRetentionEntitlement({
      idempotencyProvider: "stripe",
      idempotencyKey: "evt_test_sync",
      roomId: "room-cs",
      deviceId: "dev-cs",
      retentionTier: "30_days",
      retentionSource: "stripe",
    });

    const mockStripe = {
      checkout: {
        sessions: {
          retrieve: async () => ({
            id: "cs_test_2",
            payment_status: "paid",
            status: "complete",
            metadata: {
              roomId: "room-cs",
              deviceId: "dev-cs",
              retentionTier: "30_days",
            },
          }),
        },
      },
    };

    const out = await getCheckoutSessionSyncStatus(rooms, mockStripe, {
      roomId: "room-cs",
      deviceId: "dev-cs",
      sessionId: "cs_test_2",
    });

    assert.equal(out.ok, true);
    assert.equal(out.stripePaymentComplete, true);
    assert.equal(out.entitlementInSync, true);
    assert.equal(out.retention.retentionTier, "30_days");
    assert.equal(out.retention.retentionSource, "stripe");
  });

  test("paid session but webhook lag — entitlement not in sync", async () => {
    const mockStripe = {
      checkout: {
        sessions: {
          retrieve: async () => ({
            id: "cs_test_3",
            payment_status: "paid",
            status: "complete",
            metadata: {
              roomId: "room-cs",
              deviceId: "dev-cs",
              retentionTier: "permanent",
            },
          }),
        },
      },
    };

    const out = await getCheckoutSessionSyncStatus(rooms, mockStripe, {
      roomId: "room-cs",
      deviceId: "dev-cs",
      sessionId: "cs_test_3",
    });

    assert.equal(out.ok, true);
    assert.equal(out.stripePaymentComplete, true);
    assert.equal(out.expectedRetentionTier, "permanent");
    assert.equal(out.entitlementInSync, false);
  });
});
