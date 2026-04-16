/**
 * CONNECT room retention — normalized view model (Phase 19).
 * Single source of truth for list, detail, GET/POST /v2/rooms/:id/retention responses.
 */

const ENFORCEMENT_NOTE =
  "Message TTL deletion is not enforced in this server phase; retention_until is advisory for future jobs.";

/** Documented sources; unknown strings preserved for forward compatibility. */
const KNOWN_SOURCES = new Set([
  "server_default",
  "manual",
  "stripe",
  "connect_membership",
  "revenuecat",
  "app_store",
  "google_play",
]);

function normalizeRetentionSource(raw) {
  if (raw == null || raw === "") return "server_default";
  const s = String(raw).trim();
  if (s === "") return "server_default";
  const lower = s.toLowerCase();
  if (KNOWN_SOURCES.has(lower)) return lower;
  return s;
}

/**
 * Whether the user may purchase / change retention (next monetization step).
 * Read-only states: ended tombstone, soft-deleted (deleted has no retention 200), permanent tier.
 */
function computeCanExtendRetention(room) {
  if (room.deleted_at != null) return false;
  if (room.state === "ended") return false;
  const tier = room.retention_tier || "default";
  if (tier === "permanent") return false;
  return true;
}

/**
 * @param {{ id: string, retention_tier?: string|null, retention_until?: number|null, retention_source?: string|null, state?: string, deleted_at?: number|null }} room
 * @param {{ toIso: (n: number|null|undefined) => string|null }} io
 */
function buildRetentionView(room, io) {
  const tier = room.retention_tier || "default";
  const source = normalizeRetentionSource(room.retention_source);
  const isPaid = tier !== "default";
  return {
    roomId: room.id,
    retentionTier: tier,
    retentionUntil: io.toIso(room.retention_until),
    retentionSource: source,
    isPaidRetention: isPaid,
    canExtendRetention: computeCanExtendRetention(room),
    enforcementNote: ENFORCEMENT_NOTE,
  };
}

module.exports = {
  ENFORCEMENT_NOTE,
  normalizeRetentionSource,
  computeCanExtendRetention,
  buildRetentionView,
  KNOWN_SOURCES,
};
