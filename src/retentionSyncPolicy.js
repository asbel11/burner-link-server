/**
 * Phase 24 — Recommended client behavior for syncing retention after Stripe Checkout return.
 * Mobile apps should mirror this (timing is a contract, not enforced server-side).
 */

/** Bounded exponential backoff for GET /v2/rooms/:roomId/retention until tier matches expected. */
const RETENTION_POLL_AFTER_CHECKOUT = Object.freeze({
  /** First delay before first retention GET after handling return URL */
  initialDelayMs: 400,
  /** Cap per sleep (avoid long stalls) */
  maxDelayMs: 6400,
  /** Max GET attempts including the first */
  maxAttempts: 14,
  /** Multiply delay each attempt (bounded by maxDelayMs) */
  backoffMultiplier: 1.75,
  /** Optional jitter 0..jitterMaxMs to reduce thundering herd */
  jitterMaxMs: 120,
});

/**
 * @param {number} attempt 0-based
 * @returns {number} ms to wait before next attempt
 */
function delayBeforeRetentionPollAttempt(attempt) {
  const { initialDelayMs, maxDelayMs, backoffMultiplier, jitterMaxMs } =
    RETENTION_POLL_AFTER_CHECKOUT;
  const raw =
    initialDelayMs * Math.pow(backoffMultiplier, Math.max(0, attempt));
  const capped = Math.min(raw, maxDelayMs);
  const jitter =
    jitterMaxMs > 0 ? Math.floor(Math.random() * (jitterMaxMs + 1)) : 0;
  return Math.min(capped + jitter, maxDelayMs + jitterMaxMs);
}

module.exports = {
  RETENTION_POLL_AFTER_CHECKOUT,
  delayBeforeRetentionPollAttempt,
};
