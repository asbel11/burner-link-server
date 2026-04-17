/**
 * Shared process.env readers for CONNECT server (feature flags).
 */

function envFlag(name, defaultValue = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

/**
 * When true: mutual-save request/respond endpoints are active; GET list/detail include `save` truth.
 * Default false — temporary-only behavior unchanged for existing deployments.
 */
function mutualSaveEnabled() {
  return envFlag("MUTUAL_SAVE_ENABLED", false);
}

module.exports = {
  envFlag,
  mutualSaveEnabled,
};
