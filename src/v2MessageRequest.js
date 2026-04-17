/**
 * CONNECT V2 POST `/v2/rooms/:roomId/messages` — normalize device identity from JSON + query.
 *
 * Precedence (first non-empty trimmed string wins):
 * `body.deviceId` → `body.device_id` → `query.deviceId` → `query.device_id`
 *
 * Matches mobile + GET parity: clients may send `?deviceId=` only, body mirrors only, or both.
 */

function firstNonEmptyTrimmedString(...candidates) {
  for (const v of candidates) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t.length > 0) return t;
    }
  }
  return "";
}

/**
 * @param {{ body?: unknown; query?: unknown }} req
 * @returns {string} empty string if missing/invalid
 */
function resolveDeviceIdForV2MessagePost(req) {
  const b =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
  const q =
    req.query && typeof req.query === "object" && !Array.isArray(req.query)
      ? req.query
      : {};
  return firstNonEmptyTrimmedString(
    b.deviceId,
    b.device_id,
    q.deviceId,
    q.device_id
  );
}

/**
 * Optional sender field: `senderId` or `sender_id` (must match device when set).
 * @returns {string|undefined}
 */
function resolveSenderIdForV2MessagePost(req) {
  const b =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
  const s = firstNonEmptyTrimmedString(b.senderId, b.sender_id);
  return s === "" ? undefined : s;
}

module.exports = {
  resolveDeviceIdForV2MessagePost,
  resolveSenderIdForV2MessagePost,
  firstNonEmptyTrimmedString,
};
