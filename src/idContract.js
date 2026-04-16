/**
 * Phase 7 — canonical identity contract (Burner Link server).
 *
 * There is exactly ONE primary key string for a chat in this codebase:
 *   - SQLite table `rooms.id`
 *
 * Route naming uses different parameter names for historical reasons only:
 *   - V1: `:sessionId` in paths, `sessionId` in JSON bodies where applicable
 *   - V2: `:roomId` in paths
 *
 * These values are bitwise-identical for the same chat. There is no separate
 * "session table" or session-scoped id distinct from the room row.
 *
 * @typedef {string} CanonicalRoomId
 */

/** Same value as V1 `sessionId` everywhere. */
const ID_FIELD_DOC =
  "Use rooms.id === V1 sessionId === V2 path roomId; see docs/v1-v2-id-contract.md";

function v1SessionIdFromRoomId(roomId) {
  return roomId;
}

function roomIdFromV1SessionId(sessionId) {
  return sessionId;
}

module.exports = {
  ID_FIELD_DOC,
  v1SessionIdFromRoomId,
  roomIdFromV1SessionId,
};
