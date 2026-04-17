const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  resolveDeviceIdForV2MessagePost,
  resolveSenderIdForV2MessagePost,
} = require("../src/v2MessageRequest");
const { createRoomStore } = require("../src/store");

const enc = { ciphertext: "ct", nonce: "nv" };

describe("resolveDeviceIdForV2MessagePost", () => {
  test("body.deviceId only", () => {
    const id = resolveDeviceIdForV2MessagePost({
      body: { deviceId: "  uuid-one  " },
      query: {},
    });
    assert.equal(id, "uuid-one");
  });

  test("body.device_id when camel missing", () => {
    const id = resolveDeviceIdForV2MessagePost({
      body: { device_id: "snake-id" },
      query: {},
    });
    assert.equal(id, "snake-id");
  });

  test("query deviceId when body has no device fields", () => {
    const id = resolveDeviceIdForV2MessagePost({
      body: { encrypted: enc },
      query: { deviceId: "from-query" },
    });
    assert.equal(id, "from-query");
  });

  test("query device_id fallback", () => {
    const id = resolveDeviceIdForV2MessagePost({
      body: {},
      query: { device_id: "q-snake" },
    });
    assert.equal(id, "q-snake");
  });

  test("precedence: body.deviceId over query.deviceId", () => {
    const id = resolveDeviceIdForV2MessagePost({
      body: { deviceId: "body-wins" },
      query: { deviceId: "query-loses" },
    });
    assert.equal(id, "body-wins");
  });

  test("precedence: body.device_id over query when camel empty", () => {
    const id = resolveDeviceIdForV2MessagePost({
      body: { deviceId: "", device_id: "snake-body" },
      query: { deviceId: "query" },
    });
    assert.equal(id, "snake-body");
  });

  test("empty string everywhere → empty", () => {
    const id = resolveDeviceIdForV2MessagePost({
      body: { deviceId: "  " },
      query: { deviceId: "" },
    });
    assert.equal(id, "");
  });
});

describe("resolveSenderIdForV2MessagePost", () => {
  test("sender_id when senderId absent", () => {
    const s = resolveSenderIdForV2MessagePost({
      body: { sender_id: "snd" },
    });
    assert.equal(s, "snd");
  });

  test("undefined when missing", () => {
    const s = resolveSenderIdForV2MessagePost({ body: {} });
    assert.equal(s, undefined);
  });
});

describe("appendMessageForLinkedDevice (V2 send semantics)", () => {
  let dbPath;
  let rooms;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-v2post-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    const store = createRoomStore({ dbFilePath: dbPath });
    rooms = store.rooms;
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

  test("mobile-shaped success: linked device, snake sender_id would map via handler", () => {
    rooms.createRoomFromV1({
      id: "room-ok",
      inviteCode: "222222",
      creatorDeviceId: "dev-creator",
    });
    const out = rooms.appendMessageForLinkedDevice({
      roomId: "room-ok",
      deviceId: "dev-creator",
      messageId: "m1",
      senderId: "dev-creator",
      type: "text",
      encrypted: enc,
      fileName: null,
    });
    assert.equal(out.ok, true);
  });

  test("unlinked device → forbidden", () => {
    rooms.createRoomFromV1({
      id: "room-f",
      inviteCode: "333333",
      creatorDeviceId: "only-one",
    });
    const out = rooms.appendMessageForLinkedDevice({
      roomId: "room-f",
      deviceId: "stranger",
      messageId: "m2",
      senderId: undefined,
      type: "text",
      encrypted: enc,
      fileName: null,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "forbidden");
  });

  test("unknown room → not_found", () => {
    const out = rooms.appendMessageForLinkedDevice({
      roomId: "no-such-room",
      deviceId: "x",
      messageId: "m3",
      type: "text",
      encrypted: enc,
      fileName: null,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "not_found");
  });

  test("senderId mismatch → sender_mismatch", () => {
    rooms.createRoomFromV1({
      id: "room-sm",
      inviteCode: "444444",
      creatorDeviceId: "dev-a",
    });
    const out = rooms.appendMessageForLinkedDevice({
      roomId: "room-sm",
      deviceId: "dev-a",
      messageId: "m4",
      senderId: "dev-b",
      type: "text",
      encrypted: enc,
      fileName: null,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "sender_mismatch");
  });

  test("ended room → ended", () => {
    rooms.createRoomFromV1({
      id: "room-end",
      inviteCode: "555555",
      creatorDeviceId: "dev-e",
    });
    const burned = rooms.endRoomBurnV1("room-end");
    assert.equal(burned.kind, "ended");
    const out = rooms.appendMessageForLinkedDevice({
      roomId: "room-end",
      deviceId: "dev-e",
      messageId: "m5",
      type: "text",
      encrypted: enc,
      fileName: null,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "ended");
  });

  test("soft-deleted room → deleted (before membership check)", () => {
    rooms.createRoomFromV1({
      id: "room-del",
      inviteCode: "666666",
      creatorDeviceId: "dev-d",
    });
    const del = rooms.softDeleteRoomForDevice("room-del", "dev-d");
    assert.equal(del.ok, true);
    const out = rooms.appendMessageForLinkedDevice({
      roomId: "room-del",
      deviceId: "dev-d",
      messageId: "m6",
      type: "text",
      encrypted: enc,
      fileName: null,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "deleted");
  });
});
