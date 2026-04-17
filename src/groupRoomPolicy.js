/**
 * Group rooms (Phase Group-Rooms-1): room kind, member caps, optional Pro gate.
 * @see docs/v2-group-rooms.md
 */

function envTruthy(name, defaultValue = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function envInt(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : defaultValue;
}

/** When true, only CONNECT Pro devices (`device_memberships`) may create group rooms. Default: off. */
function groupRoomsRequirePro() {
  return envTruthy("CONNECT_GROUP_ROOMS_REQUIRE_PRO", false);
}

/** Upper bound for `memberCap` on group rooms (server validation). Default 100. */
function connectGroupMaxMemberCap() {
  const d = 100;
  const n = envInt("CONNECT_GROUP_MAX_MEMBER_CAP", d);
  return Math.max(3, Math.min(10000, n));
}

/** Minimum `memberCap` for `room_kind = group` (must be > 2 to distinguish from 1:1 direct). Default 3. */
function connectGroupMinMemberCap() {
  const d = 3;
  const n = envInt("CONNECT_GROUP_MIN_MEMBER_CAP", d);
  return Math.max(3, Math.min(connectGroupMaxMemberCap(), n));
}

/**
 * @param {string | null | undefined} raw
 * @returns {'direct' | 'group'}
 */
function normalizeRoomKind(raw) {
  if (raw === "group") return "group";
  return "direct";
}

/**
 * Cap used when deciding whether a new device may join (existing members only).
 * @param {{ room_kind?: string | null, member_cap?: number | null }} room
 */
function effectiveJoinMemberCap(room) {
  const rk = normalizeRoomKind(room.room_kind);
  if (rk === "direct") return 2;
  const c = room.member_cap;
  if (typeof c === "number" && Number.isInteger(c) && c >= 2) return c;
  return 2;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, memberCap: number } | { ok: false, reason: string, min?: number, max?: number }}
 */
function parseGroupMemberCap(raw) {
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.trunc(raw)
      : parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isInteger(n)) {
    return { ok: false, reason: "invalid_member_cap" };
  }
  const min = connectGroupMinMemberCap();
  const max = connectGroupMaxMemberCap();
  if (n < min || n > max) {
    return { ok: false, reason: "member_cap_out_of_range", min, max };
  }
  return { ok: true, memberCap: n };
}

/**
 * Mutual save is 1:1-only; hide from API surface when the room is a group.
 * When `room` is missing, returns true so callers can still show the neutral `{ enabled: true, state: "none" }` stub.
 */
function mutualSaveApplicableForRoom(room, mutualSaveFeatureEnabled) {
  if (mutualSaveFeatureEnabled !== true) return false;
  if (!room) return true;
  return normalizeRoomKind(room.room_kind) === "direct";
}

module.exports = {
  groupRoomsRequirePro,
  connectGroupMaxMemberCap,
  connectGroupMinMemberCap,
  normalizeRoomKind,
  effectiveJoinMemberCap,
  parseGroupMemberCap,
  mutualSaveApplicableForRoom,
};
