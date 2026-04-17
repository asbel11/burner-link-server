/**
 * HTTP handlers for CONNECT attachment storage (prepare / finalize / download / cancel).
 *
 * @see docs/connect-attachments-storage.md
 */

const crypto = require("crypto");
const {
  validatePrepareBody,
  envPresignPutSeconds,
  envPresignGetSeconds,
} = require("./attachmentPolicy");

function newId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

/**
 * @param {string} roomId
 * @param {string} attachmentId
 */
function buildStorageKey(roomId, attachmentId) {
  const safe = String(roomId).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `rooms/${safe}/att/${attachmentId}`;
}

/**
 * @param {*} store
 * @param {string} roomId
 * @param {Record<string, unknown>} body
 */
async function handlePrepareAttachment(store, roomId, body) {
  const raw = body && typeof body === "object" ? body : {};
  const deviceId =
    typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    return { status: 400, json: { error: "Missing deviceId", reason: "invalid_device" } };
  }

  if (!store.attachmentStorage) {
    return {
      status: 503,
      json: {
        error: "Object storage is not configured",
        reason: "storage_not_configured",
      },
    };
  }

  const prep = validatePrepareBody({
    kind: raw.kind,
    mimeType: raw.mimeType,
    sizeBytes: raw.sizeBytes,
    originalFilename: raw.originalFilename,
  });
  if (!prep.ok) {
    return {
      status: 400,
      json: { error: "Invalid prepare body", reason: prep.reason },
    };
  }

  const detail = store.rooms.getRoomDetailForDevice(roomId, deviceId);
  if (!detail.ok) {
    if (detail.reason === "forbidden") {
      return { status: 403, json: { error: "Forbidden", reason: "forbidden" } };
    }
    return { status: 404, json: { error: "Room not found", reason: "not_found" } };
  }
  if (detail.room.state !== "active") {
    return {
      status: 409,
      json: { error: "Room is not active", reason: "room_not_active" },
    };
  }

  const attachmentId = newId();
  const storageKey = buildStorageKey(roomId, attachmentId);
  const t = Date.now();

  store.attachments.insertPending.run({
    id: attachmentId,
    room_id: roomId,
    device_id: deviceId,
    kind: raw.kind,
    mime_type: String(raw.mimeType).trim(),
    size_bytes: Number(raw.sizeBytes),
    original_filename:
      raw.originalFilename != null && String(raw.originalFilename).trim() !== ""
        ? String(raw.originalFilename).trim()
        : null,
    storage_key: storageKey,
    created_at: t,
  });

  const exp = envPresignPutSeconds();
  const uploadUrl = await store.attachmentStorage.presignPutObject(
    storageKey,
    "application/octet-stream",
    exp
  );

  return {
    status: 200,
    json: {
      attachmentId,
      storageKey,
      uploadUrl,
      uploadExpiresInSeconds: exp,
      bucket: store.attachmentStorage.bucket,
    },
  };
}

/**
 * @param {*} store
 * @param {string} roomId
 * @param {string} attachmentId
 * @param {Record<string, unknown>} body
 */
async function handleFinalizeAttachment(store, roomId, attachmentId, body) {
  const raw = body && typeof body === "object" ? body : {};
  const deviceId =
    typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    return { status: 400, json: { error: "Missing deviceId", reason: "invalid_device" } };
  }

  if (!store.attachmentStorage) {
    return {
      status: 503,
      json: {
        error: "Object storage is not configured",
        reason: "storage_not_configured",
      },
    };
  }

  const row = store.attachments.getById(attachmentId);
  if (!row || row.room_id !== roomId) {
    return { status: 404, json: { error: "Not found", reason: "not_found" } };
  }
  if (row.device_id !== deviceId) {
    return { status: 403, json: { error: "Forbidden", reason: "forbidden" } };
  }
  if (row.status !== "pending") {
    return {
      status: 409,
      json: { error: "Attachment is not pending", reason: "not_pending" },
    };
  }

  const head = await store.attachmentStorage.headObject(row.storage_key);
  if (!head) {
    return {
      status: 400,
      json: {
        error: "Object not found in storage; upload before finalize",
        reason: "object_missing",
      },
    };
  }

  const maxAllowed = Math.ceil(row.size_bytes * 1.05 + 65536);
  if (head.contentLength > maxAllowed) {
    await store.attachmentStorage.deleteObjects([row.storage_key]);
    store.attachments.deletePendingByIdForDevice.run(
      attachmentId,
      roomId,
      deviceId
    );
    return {
      status: 400,
      json: {
        error: "Uploaded size does not match declared size",
        reason: "size_mismatch",
      },
    };
  }

  const t = Date.now();
  const n = store.attachments.finalizeReady.run({
    id: attachmentId,
    finalized_at: t,
  }).changes;
  if (n !== 1) {
    return { status: 409, json: { error: "Could not finalize", reason: "finalize_failed" } };
  }

  const refreshed = store.attachments.getById(attachmentId);
  return {
    status: 200,
    json: {
      attachmentId,
      status: refreshed.status,
      kind: refreshed.kind,
      mimeType: refreshed.mime_type,
      sizeBytes: refreshed.size_bytes,
    },
  };
}

/**
 * @param {*} store
 * @param {string} roomId
 * @param {string} attachmentId
 * @param {string} deviceId
 */
async function handleDownloadAttachment(store, roomId, attachmentId, deviceId) {
  const dev = typeof deviceId === "string" ? deviceId.trim() : "";
  if (!dev) {
    return { status: 400, json: { error: "Missing deviceId", reason: "invalid_device" } };
  }

  if (!store.attachmentStorage) {
    return {
      status: 503,
      json: {
        error: "Object storage is not configured",
        reason: "storage_not_configured",
      },
    };
  }

  const detail = store.rooms.getRoomDetailForDevice(roomId, dev);
  if (!detail.ok) {
    if (detail.reason === "forbidden") {
      return { status: 403, json: { error: "Forbidden", reason: "forbidden" } };
    }
    return { status: 404, json: { error: "Room not found", reason: "not_found" } };
  }

  const row = store.attachments.getById(attachmentId);
  if (!row || row.room_id !== roomId) {
    return { status: 404, json: { error: "Not found", reason: "not_found" } };
  }
  if (row.status !== "linked") {
    return {
      status: 409,
      json: { error: "Attachment not available", reason: "not_linked" },
    };
  }

  const exp = envPresignGetSeconds();
  const downloadUrl = await store.attachmentStorage.presignGetObject(
    row.storage_key,
    exp
  );

  return {
    status: 200,
    json: {
      attachmentId,
      downloadUrl,
      downloadExpiresInSeconds: exp,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      originalFilename: row.original_filename,
    },
  };
}

/**
 * @param {*} store
 * @param {string} roomId
 * @param {string} attachmentId
 * @param {Record<string, unknown>} body
 */
async function handleCancelAttachment(store, roomId, attachmentId, body) {
  const raw = body && typeof body === "object" ? body : {};
  const deviceId =
    typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    return { status: 400, json: { error: "Missing deviceId", reason: "invalid_device" } };
  }

  const row = store.attachments.getById(attachmentId);
  if (!row || row.room_id !== roomId) {
    return { status: 404, json: { error: "Not found", reason: "not_found" } };
  }
  if (row.device_id !== deviceId) {
    return { status: 403, json: { error: "Forbidden", reason: "forbidden" } };
  }
  if (row.status !== "pending") {
    return {
      status: 409,
      json: { error: "Only pending uploads can be cancelled", reason: "not_pending" },
    };
  }

  if (store.attachmentStorage) {
    await store.attachmentStorage.deleteObjects([row.storage_key]);
  }
  const n = store.attachments.deletePendingByIdForDevice.run(
    attachmentId,
    roomId,
    deviceId
  ).changes;
  if (n !== 1) {
    return { status: 409, json: { error: "Could not cancel", reason: "cancel_failed" } };
  }
  return { status: 200, json: { ok: true, cancelled: true } };
}

module.exports = {
  buildStorageKey,
  handlePrepareAttachment,
  handleFinalizeAttachment,
  handleDownloadAttachment,
  handleCancelAttachment,
};
