const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createRoomStore } = require("../src/store");
const { validatePrepareBody } = require("../src/attachments/attachmentPolicy");

describe("attachmentPolicy.validatePrepareBody", () => {
  test("accepts valid image prepare", () => {
    const r = validatePrepareBody({
      kind: "image",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      originalFilename: "a.jpg",
    });
    assert.equal(r.ok, true);
  });

  test("rejects wrong mime for kind", () => {
    const r = validatePrepareBody({
      kind: "image",
      mimeType: "video/mp4",
      sizeBytes: 1024,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mime_not_allowed_for_kind");
  });

  test("file kind allows application mime", () => {
    const r = validatePrepareBody({
      kind: "file",
      mimeType: "application/pdf",
      sizeBytes: 10,
    });
    assert.equal(r.ok, true);
  });

  test("video kind requires video/* mime", () => {
    const ok = validatePrepareBody({
      kind: "video",
      mimeType: "video/mp4",
      sizeBytes: 1000,
    });
    assert.equal(ok.ok, true);
    const bad = validatePrepareBody({
      kind: "video",
      mimeType: "application/mp4",
      sizeBytes: 1000,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "mime_not_allowed_for_kind");
  });
});

describe("room_attachments + message linkage", () => {
  test("migration creates room_attachments; file message links attachment", () => {
    const dbPath = path.join(
      os.tmpdir(),
      `burner-att-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    const store = createRoomStore({ dbFilePath: dbPath });
    const { db, rooms, attachments } = store;

    const cols = db.prepare(`PRAGMA table_info(room_messages)`).all();
    assert.ok(cols.some((c) => c.name === "attachment_id"));

    const roomId = "room-att-1";
    rooms.createRoomFromV1({
      id: roomId,
      inviteCode: "222222",
      creatorDeviceId: "dev-u1",
    });

    const t = Date.now();
    const aid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    attachments.insertPending.run({
      id: aid,
      room_id: roomId,
      device_id: "dev-u1",
      kind: "file",
      mime_type: "application/pdf",
      size_bytes: 100,
      original_filename: "x.pdf",
      storage_key: `rooms/${roomId}/att/${aid}`,
      created_at: t,
    });
    attachments.finalizeReady.run({ id: aid, finalized_at: t + 1 });

    const msgId = "msg-1";
    const out = rooms.appendMessageForLinkedDevice({
      roomId,
      deviceId: "dev-u1",
      messageId: msgId,
      senderId: "dev-u1",
      type: "file",
      encrypted: { ciphertext: "cap", nonce: "n" },
      fileName: null,
      attachmentId: aid,
    });
    assert.equal(out.ok, true);
    assert.equal(out.message.type, "file");
    assert.equal(out.message.attachment.id, aid);

    const listed = rooms.listMessagesForDeviceRoom(roomId, "dev-u1");
    assert.equal(listed.ok, true);
    assert.equal(listed.messages[0].attachment.mimeType, "application/pdf");

    const keys = attachments.listStorageKeysForRoom(roomId);
    assert.equal(keys.length, 1);
    assert.equal(keys[0], `rooms/${roomId}/att/${aid}`);

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
