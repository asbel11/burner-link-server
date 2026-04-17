/**
 * Env-driven CONNECT call coin tariff (Phase Call-Meter-2).
 *
 * Set **`CONNECT_CALL_TARIFF_JSON`** to a JSON object, e.g.:
 * `{ "version": 1, "voice": { "coinsPerSecond": 1 }, "video": { "coinsPerSecond": 0 } }`
 * (**`video`** is required by the parser; use **`0`** for voice-only launch — see **`docs/connect-call-charging.md`**.)
 *
 * Costs use **`Math.ceil(billedSeconds * coinsPerSecond)`** (integer seconds × integer rate).
 *
 * @see docs/connect-call-charging.md
 */

const CALL_TYPES = Object.freeze({
  VOICE: "voice",
  VIDEO: "video",
});

const ALLOWED_CALL_TYPES = new Set([CALL_TYPES.VOICE, CALL_TYPES.VIDEO]);

const DEFAULT_MIN_HOLD_SECONDS = 120;
const MAX_BILLABLE_SECONDS = 3 * 24 * 60 * 60; // 72h safety cap
const MAX_ESTIMATE_SECONDS = MAX_BILLABLE_SECONDS;

/**
 * @returns {number}
 */
function defaultMinHoldSeconds() {
  const raw = process.env.CONNECT_CALL_DEFAULT_MIN_HOLD_SECONDS;
  if (raw === undefined || raw === "") {
    return DEFAULT_MIN_HOLD_SECONDS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_ESTIMATE_SECONDS) {
    return DEFAULT_MIN_HOLD_SECONDS;
  }
  return Math.floor(n);
}

/**
 * @param {unknown} j
 * @returns {{ version: number, voice: { coinsPerSecond: number }, video: { coinsPerSecond: number } }}
 */
function normalizeTariffOrThrow(j) {
  if (!j || typeof j !== "object") {
    throw new Error("invalid_tariff_shape");
  }
  const version = Number(j.version);
  const voice = j.voice;
  const video = j.video;
  if (!voice || typeof voice !== "object" || !video || typeof video !== "object") {
    throw new Error("invalid_tariff_shape");
  }
  const vps = Number(voice.coinsPerSecond);
  const vidps = Number(video.coinsPerSecond);
  if (!Number.isInteger(vps) || vps < 0 || vps > 1_000_000) {
    throw new Error("invalid_voice_rate");
  }
  if (!Number.isInteger(vidps) || vidps < 0 || vidps > 1_000_000) {
    throw new Error("invalid_video_rate");
  }
  return {
    version: Number.isInteger(version) && version > 0 ? version : 1,
    voice: { coinsPerSecond: vps },
    video: { coinsPerSecond: vidps },
  };
}

/**
 * @returns {{ version: number, voice: { coinsPerSecond: number }, video: { coinsPerSecond: number } } | null}
 */
function getCallTariffFromEnv() {
  const raw = process.env.CONNECT_CALL_TARIFF_JSON;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }
  try {
    const j = JSON.parse(String(raw));
    return normalizeTariffOrThrow(j);
  } catch {
    return null;
  }
}

/**
 * @param {number} billedSeconds — non-negative integer
 * @param {string} callType — `voice` | `video`
 * @param {{ voice: { coinsPerSecond: number }, video: { coinsPerSecond: number } }} tariff
 * @returns {number}
 */
function computeCoinsForBilledSeconds(billedSeconds, callType, tariff) {
  const rate =
    callType === CALL_TYPES.VOICE
      ? tariff.voice.coinsPerSecond
      : tariff.video.coinsPerSecond;
  return Math.ceil(billedSeconds * rate);
}

/**
 * @param {number} seconds
 * @param {string} callType
 * @param {{ voice: { coinsPerSecond: number }, video: { coinsPerSecond: number } }} tariff
 * @returns {number}
 */
function computeReserveCoinsForEstimatedSeconds(seconds, callType, tariff) {
  return computeCoinsForBilledSeconds(seconds, callType, tariff);
}

module.exports = {
  CALL_TYPES,
  ALLOWED_CALL_TYPES,
  DEFAULT_MIN_HOLD_SECONDS,
  MAX_BILLABLE_SECONDS,
  MAX_ESTIMATE_SECONDS,
  defaultMinHoldSeconds,
  getCallTariffFromEnv,
  normalizeTariffOrThrow,
  computeCoinsForBilledSeconds,
  computeReserveCoinsForEstimatedSeconds,
};
