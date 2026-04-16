const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openDatabase } = require("../src/store/db");
const { createRoomRepository } = require("../src/store/roomRepository");
const { handleBillingRetentionPost } = require("../src/billingIngestion");

function mockReq(body, headers = {}) {
  return { body, headers };
}

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
    _o: o,
  };
}

describe("handleBillingRetentionPost", () => {
  let dbPath;
  let rooms;
  let prevSecret;
  let prevNodeEnv;

  before(() => {
    prevSecret = process.env.BILLING_WEBHOOK_SECRET;
    prevNodeEnv = process.env.NODE_ENV;
    process.env.BILLING_WEBHOOK_SECRET = "test-secret-hex";
    process.env.NODE_ENV = "test";

    dbPath = path.join(
      os.tmpdir(),
      `burner-bh-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    const db = openDatabase(dbPath);
    rooms = createRoomRepository(db);
    rooms.createRoomFromV1({
      id: "room-h",
      inviteCode: "444444",
      creatorDeviceId: "dev-h",
    });
  });

  after(() => {
    if (prevSecret === undefined) delete process.env.BILLING_WEBHOOK_SECRET;
    else process.env.BILLING_WEBHOOK_SECRET = prevSecret;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

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

  test("bad secret → 401", () => {
    const req = mockReq(
      {
        provider: "stripe",
        externalTransactionId: "e1",
        roomId: "room-h",
        deviceId: "dev-h",
        retentionTier: "7_days",
        eventType: "purchase",
      },
      { authorization: "Bearer wrong" }
    );
    const res = mockRes();
    handleBillingRetentionPost(req, res, rooms);
    assert.equal(res._o.statusCode, 401);
    assert.equal(res._o.body.reason, "unauthorized");
  });

  test("valid secret grants 200", () => {
    const req = mockReq(
      {
        provider: "stripe",
        externalTransactionId: "evt_ok_1",
        roomId: "room-h",
        deviceId: "dev-h",
        retentionTier: "permanent",
        eventType: "purchase",
      },
      { authorization: "Bearer test-secret-hex" }
    );
    const res = mockRes();
    handleBillingRetentionPost(req, res, rooms);
    assert.equal(res._o.statusCode, 200);
    assert.equal(res._o.body.retentionTier, "permanent");
    assert.equal(res._o.body.retentionSource, "stripe");
    assert.equal(res._o.body.duplicate, false);
  });

  test("missing secret env → 503", () => {
    const prev = process.env.BILLING_WEBHOOK_SECRET;
    delete process.env.BILLING_WEBHOOK_SECRET;
    try {
      const req = mockReq({}, { authorization: "Bearer x" });
      const res = mockRes();
      handleBillingRetentionPost(req, res, rooms);
      assert.equal(res._o.statusCode, 503);
      assert.equal(res._o.body.reason, "billing_not_configured");
    } finally {
      if (prev === undefined) delete process.env.BILLING_WEBHOOK_SECRET;
      else process.env.BILLING_WEBHOOK_SECRET = prev;
    }
  });
});
