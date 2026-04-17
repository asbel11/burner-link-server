/**
 * CONNECT vs legacy Burner — V1 heartbeat auto-end policy (Phase Fix-1).
 */

function envFlag(name, defaultValue = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

/**
 * When unset or empty: default **true** (do not run legacy heartbeat burn).
 * Set to `0` / `false` / `off` to allow `SESSION_HEARTBEAT_AUTO_END` to apply.
 */
function connectDisableSessionAutoEndViaHeartbeat() {
  const v = process.env.CONNECT_DISABLE_SESSION_AUTO_END;
  if (v === undefined || v === "") return true;
  return envFlag("CONNECT_DISABLE_SESSION_AUTO_END", true);
}

/**
 * Effective flag passed to `touchHeartbeatV1`.
 */
function getEffectiveSessionHeartbeatAutoEnd() {
  return (
    !connectDisableSessionAutoEndViaHeartbeat() &&
    envFlag("SESSION_HEARTBEAT_AUTO_END", false)
  );
}

module.exports = {
  getEffectiveSessionHeartbeatAutoEnd,
  connectDisableSessionAutoEndViaHeartbeat,
  envFlag,
};
