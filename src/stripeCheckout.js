/**
 * Phase 22 — Stripe Checkout Session creation for CONNECT retention (one-time payment mode).
 */

const { ALLOWED_BILLING_TIERS } = require("./store/roomRepository");

/** Env var names per tier — must be Stripe Price IDs (e.g. price_xxx). */
const TIER_PRICE_ENV = Object.freeze({
  "7_days": "STRIPE_PRICE_RETENTION_7_DAYS",
  "30_days": "STRIPE_PRICE_RETENTION_30_DAYS",
  permanent: "STRIPE_PRICE_RETENTION_PERMANENT",
});

/**
 * @param {string} tier
 * @returns {string|null}
 */
function getConfiguredPriceIdForTier(tier) {
  const envName = TIER_PRICE_ENV[tier];
  if (!envName) return null;
  const v = process.env[envName];
  if (v == null || String(v).trim() === "") return null;
  return String(v).trim();
}

/**
 * Resolve success/cancel URLs from body or env (Stripe requires both).
 * @param {{ successUrl?: unknown, cancelUrl?: unknown }} body
 */
function resolveCheckoutUrls(body) {
  const fromBody =
    typeof body.successUrl === "string" &&
    body.successUrl.trim() !== "" &&
    typeof body.cancelUrl === "string" &&
    body.cancelUrl.trim() !== "";
  if (fromBody) {
    return {
      ok: true,
      successUrl: body.successUrl.trim(),
      cancelUrl: body.cancelUrl.trim(),
    };
  }
  const su = process.env.STRIPE_CHECKOUT_SUCCESS_URL;
  const cu = process.env.STRIPE_CHECKOUT_CANCEL_URL;
  if (
    typeof su === "string" &&
    su.trim() !== "" &&
    typeof cu === "string" &&
    cu.trim() !== ""
  ) {
    return { ok: true, successUrl: su.trim(), cancelUrl: cu.trim() };
  }
  return { ok: false, reason: "missing_checkout_urls" };
}

/**
 * @param {{ getRoomDetailForDevice: (roomId: string, deviceId: string) => object }} rooms
 * @param {import("stripe").Stripe} stripe
 * @param {{ roomId: string, deviceId: string, retentionTier: string, retentionUntil?: unknown }} params
 */
async function createRetentionCheckoutSession(rooms, stripe, params) {
  const { roomId, deviceId, retentionTier } = params;
  const tier = String(retentionTier || "").trim().toLowerCase();

  if (!ALLOWED_BILLING_TIERS.has(tier)) {
    return {
      ok: false,
      reason: "invalid_tier",
      httpStatus: 400,
      allowed: ["7_days", "30_days", "permanent"],
    };
  }

  const priceId = getConfiguredPriceIdForTier(tier);
  if (!priceId) {
    const envKey = TIER_PRICE_ENV[tier];
    return {
      ok: false,
      reason: "price_not_configured",
      httpStatus: 503,
      envKey,
    };
  }

  const detail = rooms.getRoomDetailForDevice(roomId, deviceId);
  if (!detail.ok) {
    if (detail.reason === "forbidden") {
      return { ok: false, reason: "forbidden", httpStatus: 403 };
    }
    if (detail.reason === "deleted") {
      return { ok: false, reason: "deleted", httpStatus: 410 };
    }
    return { ok: false, reason: "not_found", httpStatus: 404 };
  }

  if (detail.room.state !== "active") {
    return { ok: false, reason: "room_not_active", httpStatus: 409 };
  }

  const urls = resolveCheckoutUrls(params);
  if (!urls.ok) {
    return { ok: false, reason: urls.reason, httpStatus: 400 };
  }

  /** All paid retention tiers use one-time Checkout (`payment` mode) in this phase. */
  const metadata = {
    roomId: String(roomId),
    deviceId: String(deviceId),
    retentionTier: tier,
  };
  if (
    params.retentionUntil != null &&
    String(params.retentionUntil).trim() !== ""
  ) {
    metadata.retentionUntil = String(params.retentionUntil).trim();
  }

  const clientRef = `${roomId}:${deviceId}`.slice(0, 500);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    client_reference_id: clientRef,
    metadata,
    payment_intent_data: {
      metadata: { ...metadata },
    },
  });

  return {
    ok: true,
    sessionId: session.id,
    url: session.url,
    roomId,
    retentionTier: tier,
  };
}

module.exports = {
  createRetentionCheckoutSession,
  getConfiguredPriceIdForTier,
  resolveCheckoutUrls,
  TIER_PRICE_ENV,
};
