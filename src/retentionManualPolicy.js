/**
 * Manual POST /v2/rooms/:id/retention — allowed only when not in strict production,
 * or when explicitly opted in (ops / local testing).
 */

function envFlag(name, defaultValue = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

/**
 * @returns {boolean}
 */
function isManualRetentionPostAllowed() {
  if (envFlag("ALLOW_MANUAL_RETENTION_POST", false)) return true;
  if (process.env.NODE_ENV === "production") return false;
  return true;
}

module.exports = { isManualRetentionPostAllowed };
