/**
 * CONNECT Pro — included room retention tier for active members (Phase M2+).
 * Single source for retention overlay and membership status API.
 */

const ALLOWED_RETENTION_TIERS = new Set([
  "default",
  "7_days",
  "30_days",
  "permanent",
]);

const DEFAULT_MEMBER_INCLUDED_RETENTION = "30_days";

/**
 * Env `CONNECT_MEMBER_RETENTION_TIER` (default `30_days`). Invalid values fall back to default.
 */
function getConnectMemberIncludedRetentionTier() {
  const raw = process.env.CONNECT_MEMBER_RETENTION_TIER;
  const s =
    raw != null && String(raw).trim() !== ""
      ? String(raw).trim().toLowerCase()
      : DEFAULT_MEMBER_INCLUDED_RETENTION;
  if (ALLOWED_RETENTION_TIERS.has(s) && s !== "default") {
    return s;
  }
  return DEFAULT_MEMBER_INCLUDED_RETENTION;
}

module.exports = {
  getConnectMemberIncludedRetentionTier,
  DEFAULT_MEMBER_INCLUDED_RETENTION,
};
