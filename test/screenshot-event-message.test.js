const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createRoomStore } = require("../src/store");

describe("screenshot_event message type", () => {
  test("append, list, and reject attachmentId", () => {
    const dbPath = path.join(
      os.tmpdir(),
      `burner-ss-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    const store = createRoomStore({ dbFilePath: dbPath });
    const { rooms } = store;

    const roomId = "room-ss-1";
    rooms.createRoomFromV1({
      id: roomId,
      inviteCode: "333333",
      creatorDeviceId: "dev-a",
    });

    const out = rooms.appendMessageForLinkedDevice({
      roomId,
      deviceId: "dev-a",
      messageId: "msg-ss-1",
      senderId: "dev-a",
      type: "screenshot_event",
      encrypted: { ciphertext: "enc", nonce: "n1" },
      fileName: null,
    });
    assert.equal(out.ok, true);
    assert.equal(out.message.type, "screenshot_event");

    const listed = rooms.listMessagesForDeviceRoom(roomId, "dev-a");
    assert.equal(listed.ok, true);
    assert.equal(listed.messages[0].type, "screenshot_event");

    const bad = rooms.appendMessageForLinkedDevice({
      roomId,
      deviceId: "dev-a",
      messageId: "msg-ss-2",
      senderId: "dev-a",
      type: "screenshot_event",
      encrypted: { ciphertext: "e2", nonce: "n2" },
      fileName: null,
      attachmentId: "not-allowed",
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "screenshot_event_no_attachments");

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
});
