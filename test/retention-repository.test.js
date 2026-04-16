const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openDatabase } = require("../src/store/db");
const { createRoomRepository } = require("../src/store/roomRepository");

describe("retention repository integration", () => {
  let dbPath;
  let rooms;

  before(() => {
    dbPath = path.join(os.tmpdir(), `burner-ret-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    const db = openDatabase(dbPath);
    rooms = createRoomRepository(db);
    rooms.createRoomFromV1({
      id: "room-a",
      inviteCode: "111111",
      creatorDeviceId: "dev-a",
    });
    rooms.joinActiveRoomByCode({ inviteCode: "111111", deviceId: "dev-b" });
    rooms.createRoomFromV1({
      id: "room-b",
      inviteCode: "222222",
      creatorDeviceId: "dev-c",
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

  test("default retention GET shape", () => {
    const out = rooms.getRetentionForLinkedDevice("room-a", "dev-a");
    assert.equal(out.ok, true);
    assert.equal(out.retentionTier, "default");
    assert.equal(out.isPaidRetention, false);
    assert.equal(out.canExtendRetention, true);
    assert.ok(out.enforcementNote);
  });

  test("manual tier update + externalRef audit row", () => {
    const up = rooms.setRetentionManualForLinkedDevice("room-a", "dev-a", "30_days", {
      note: "test",
      externalRef: "evt_test_123",
    });
    assert.equal(up.ok, true);
    assert.equal(up.retentionTier, "30_days");
    assert.equal(up.isPaidRetention, true);
  });

  test("list / detail / GET retention fields aligned", () => {
    rooms.setRetentionManualForLinkedDevice("room-b", "dev-c", "7_days", {});
    const direct = rooms.getRetentionForLinkedDevice("room-b", "dev-c");
    assert.equal(direct.ok, true);
    const listed = rooms
      .listRoomsForDevice({ deviceId: "dev-c", status: "all" })
      .find((r) => r.id === "room-b");
    assert.ok(listed);
    const det = rooms.getRoomDetailForDevice("room-b", "dev-c");
    assert.equal(det.ok, true);
    const keys = [
      "roomId",
      "retentionTier",
      "retentionUntil",
      "retentionSource",
      "isPaidRetention",
      "canExtendRetention",
      "enforcementNote",
    ];
    for (const k of keys) {
      assert.equal(listed[k], direct[k], `list.${k}`);
      assert.equal(det.room[k], direct[k], `detail.${k}`);
    }
  });

  test("ended room — GET retention read-only (canExtend false), POST blocked", () => {
    rooms.endRoomBurnV1("room-a");
    const g = rooms.getRetentionForLinkedDevice("room-a", "dev-a");
    assert.equal(g.ok, true);
    assert.equal(g.canExtendRetention, false);
    const post = rooms.setRetentionManualForLinkedDevice("room-a", "dev-a", "default", {});
    assert.equal(post.ok, false);
    assert.equal(post.reason, "room_not_active");
  });

  test("forbidden without link", () => {
    const out = rooms.getRetentionForLinkedDevice("room-a", "stranger");
    assert.equal(out.ok, false);
    assert.equal(out.reason, "forbidden");
  });

  test("soft-deleted room — GET and POST return deleted", () => {
    rooms.softDeleteRoomForDevice("room-b", "dev-c");
    const g = rooms.getRetentionForLinkedDevice("room-b", "dev-c");
    assert.equal(g.ok, false);
    assert.equal(g.reason, "deleted");
    const post = rooms.setRetentionManualForLinkedDevice("room-b", "dev-c", "7_days", {});
    assert.equal(post.ok, false);
    assert.equal(post.reason, "deleted");
  });
});
