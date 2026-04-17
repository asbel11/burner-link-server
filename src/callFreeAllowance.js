/**
 * Per-device daily free call seconds (UTC day) before coin metering.
 *
 * @see docs/connect-call-free-allowance.md
 */

/**
 * @returns {number}
 */
function getFreeCallDailyCapSeconds() {
  const raw = process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY;
  if (raw === undefined || raw === "") {
    return 180;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 86400) {
    return 180;
  }
  return n;
}

/**
 * @param {number} [nowMs]
 * @returns {string} YYYY-MM-DD (UTC)
 */
function utcUsageDateString(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Next UTC midnight after `nowMs` (exclusive of the current calendar day’s end).
 * Used as **`daily_free_reset_at`** for the default UTC-day allowance model.
 * @param {number} [nowMs]
 * @returns {string} ISO 8601
 */
function nextUtcMidnightIso(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const t = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
  return new Date(t).toISOString();
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function createCallFreeAllowance(db) {
  const selectUsage = db.prepare(
    `SELECT free_seconds_used FROM device_daily_call_free_usage
     WHERE device_id = ? AND usage_utc_date = ?`
  );

  const upsertUsage = db.prepare(
    `INSERT INTO device_daily_call_free_usage (
       device_id, usage_utc_date, free_seconds_used, updated_at
     ) VALUES (@device_id, @usage_utc_date, @free_seconds_used, @updated_at)
     ON CONFLICT(device_id, usage_utc_date) DO UPDATE SET
       free_seconds_used = excluded.free_seconds_used,
       updated_at = excluded.updated_at`
  );

  /**
   * @param {string} deviceId
   */
  function getSnapshot(deviceId) {
    const dev = typeof deviceId === "string" ? deviceId.trim() : "";
    const day = utcUsageDateString();
    const cap = getFreeCallDailyCapSeconds();
    if (!dev) {
      const resetAt = nextUtcMidnightIso();
      return {
        usageUtcDate: day,
        callFreeSecondsAllowancePerDay: cap,
        callFreeSecondsUsedToday: 0,
        callFreeSecondsRemainingToday: cap,
        freeSecondsRemaining: cap,
        daily_free_seconds_used: 0,
        daily_free_reset_at: resetAt,
      };
    }
    const row = selectUsage.get(dev, day);
    const used = row ? row.free_seconds_used : 0;
    const remaining = Math.max(0, cap - used);
    const resetAt = nextUtcMidnightIso();
    return {
      usageUtcDate: day,
      callFreeSecondsAllowancePerDay: cap,
      callFreeSecondsUsedToday: used,
      callFreeSecondsRemainingToday: remaining,
      freeSecondsRemaining: remaining,
      daily_free_seconds_used: used,
      daily_free_reset_at: resetAt,
    };
  }

  /**
   * Apply `billedSeconds` against today's free pool. Run **only** inside `db.transaction`.
   *
   * @param {string} deviceId
   * @param {number} billedSeconds
   * @returns {{
   *   freeSecondsApplied: number,
   *   coinBillableSeconds: number,
   *   freeSecondsRemainingAfter: number,
   * }}
   */
  function consumeAgainstAllowanceInTransaction(deviceId, billedSeconds) {
    const dev = typeof deviceId === "string" ? deviceId.trim() : "";
    if (!dev) {
      throw new Error("call_free: invalid deviceId");
    }
    if (!Number.isInteger(billedSeconds) || billedSeconds < 0) {
      throw new Error("call_free: invalid billedSeconds");
    }
    const day = utcUsageDateString();
    const cap = getFreeCallDailyCapSeconds();
    const row = selectUsage.get(dev, day);
    const used = row ? row.free_seconds_used : 0;
    const remaining = Math.max(0, cap - used);
    const fromFree = Math.min(billedSeconds, remaining);
    const newUsed = used + fromFree;
    const t = Date.now();
    upsertUsage.run({
      device_id: dev,
      usage_utc_date: day,
      free_seconds_used: newUsed,
      updated_at: t,
    });
    return {
      freeSecondsApplied: fromFree,
      coinBillableSeconds: billedSeconds - fromFree,
      freeSecondsRemainingAfter: Math.max(0, cap - newUsed),
    };
  }

  return {
    getSnapshot,
    consumeAgainstAllowanceInTransaction,
    getFreeCallDailyCapSeconds,
    utcUsageDateString,
  };
}

module.exports = {
  createCallFreeAllowance,
  getFreeCallDailyCapSeconds,
  utcUsageDateString,
  nextUtcMidnightIso,
};
