const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openDatabase } = require("../src/store/db");
const { createRoomRepository } = require("../src/store/roomRepository");

describe("applyBillingRetentionEntitlement", () => {
  let dbPath;
  let rooms;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-bill-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    const db = openDatabase(dbPath);
    rooms = createRoomRepository(db);
    rooms.createRoomFromV1({
      id: "room-x",
      inviteCode: "333333",
      creatorDeviceId: "dev-x",
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

  test("valid billing event grants retention + source", () => {
    const out = rooms.applyBillingRetentionEntitlement({
      idempotencyProvider: "stripe",
      idempotencyKey: "evt_abc_1",
      roomId: "room-x",
      deviceId: "dev-x",
      retentionTier: "30_days",
      retentionSource: "stripe",
      note: '{"eventType":"purchase"}',
    });
    assert.equal(out.ok, true);
    assert.equal(out.duplicate, false);
    assert.equal(out.retentionTier, "30_days");
    assert.equal(out.retentionSource, "stripe");
    assert.equal(out.isPaidRetention, true);
  });

  test("duplicate external id is idempotent", () => {
    const a = rooms.applyBillingRetentionEntitlement({
      idempotencyProvider: "stripe",
      idempotencyKey: "evt_dup_1",
      roomId: "room-x",
      deviceId: "dev-x",
      retentionTier: "30_days",
      retentionSource: "stripe",
    });
    assert.equal(a.duplicate, false);
    const b = rooms.applyBillingRetentionEntitlement({
      idempotencyProvider: "stripe",
      idempotencyKey: "evt_dup_1",
      roomId: "room-x",
      deviceId: "dev-x",
      retentionTier: "30_days",
      retentionSource: "stripe",
    });
    assert.equal(b.ok, true);
    assert.equal(b.duplicate, true);
    assert.equal(b.retentionTier, "30_days");
  });

  test("would_downgrade rejected", () => {
    rooms.applyBillingRetentionEntitlement({
      idempotencyProvider: "stripe",
      idempotencyKey: "evt_up_1",
      roomId: "room-x",
      deviceId: "dev-x",
      retentionTier: "30_days",
      retentionSource: "stripe",
    });
    const down = rooms.applyBillingRetentionEntitlement({
      idempotencyProvider: "stripe",
      idempotencyKey: "evt_down_1",
      roomId: "room-x",
      deviceId: "dev-x",
      retentionTier: "7_days",
      retentionSource: "stripe",
    });
    assert.equal(down.ok, false);
    assert.equal(down.reason, "would_downgrade");
  });

  test("invalid room", () => {
    const out = rooms.applyBillingRetentionEntitlement({
      idempotencyProvider: "stripe",
      idempotencyKey: "evt_noroom",
      roomId: "missing-room",
      deviceId: "dev-x",
      retentionTier: "7_days",
      retentionSource: "stripe",
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "unknown");
  });

  test("forbidden without link", () => {
    const out = rooms.applyBillingRetentionEntitlement({
      idempotencyProvider: "stripe",
      idempotencyKey: "evt_no_link",
      roomId: "room-x",
      deviceId: "stranger",
      retentionTier: "7_days",
      retentionSource: "stripe",
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "forbidden");
  });
});
