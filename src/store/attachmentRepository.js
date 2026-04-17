/**
 * SQLite metadata for room attachments (Media-Storage-1).
 *
 * @param {import("better-sqlite3").Database} db
 */
function createAttachmentRepository(db) {
  const insertPending = db.prepare(
    `INSERT INTO room_attachments (
       id, room_id, device_id, status, kind, mime_type, size_bytes,
       original_filename, storage_key, message_id, created_at, finalized_at
     ) VALUES (
       @id, @room_id, @device_id, 'pending', @kind, @mime_type, @size_bytes,
       @original_filename, @storage_key, NULL, @created_at, NULL
     )`
  );

  const selectById = db.prepare(`SELECT * FROM room_attachments WHERE id = ?`);

  const finalizeReady = db.prepare(
    `UPDATE room_attachments SET status = 'ready', finalized_at = @finalized_at
     WHERE id = @id AND status = 'pending'`
  );

  const linkMessage = db.prepare(
    `UPDATE room_attachments SET status = 'linked', message_id = @message_id
     WHERE id = @id AND room_id = @room_id AND status = 'ready' AND device_id = @device_id`
  );

  const selectKeysByRoom = db.prepare(
    `SELECT storage_key FROM room_attachments WHERE room_id = ?`
  );

  const deleteByRoom = db.prepare(
    `DELETE FROM room_attachments WHERE room_id = ?`
  );

  const deletePendingByIdForDevice = db.prepare(
    `DELETE FROM room_attachments WHERE id = ? AND room_id = ? AND device_id = ? AND status = 'pending'`
  );

  /**
   * @param {string} roomId
   * @returns {string[]}
   */
  function listStorageKeysForRoom(roomId) {
    return selectKeysByRoom.all(roomId).map((r) => r.storage_key);
  }

  /**
   * @param {string} id
   */
  function getById(id) {
    return selectById.get(id) || null;
  }

  return {
    getById,
    listStorageKeysForRoom,
    insertPending,
    finalizeReady,
    linkMessage,
    deleteByRoom,
    deletePendingByIdForDevice,
    selectById,
  };
}

module.exports = {
  createAttachmentRepository,
};
