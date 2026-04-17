/**
 * Stripe Checkout (payment mode) for CONNECT coin packs (Phase Coins-3).
 */

const { resolveCheckoutUrls } = require("./stripeCheckout");
const { getCoinPackById, getCoinPackCatalog } = require("./coinPackCatalog");

/**
 * @param {import("stripe").Stripe} stripe
 * @param {{ deviceId: unknown, packId: unknown, successUrl?: unknown, cancelUrl?: unknown }} params
 */
async function createCoinPackCheckoutSession(stripe, params) {
  const deviceId =
    typeof params.deviceId === "string" ? params.deviceId.trim() : "";
  const packId =
    typeof params.packId === "string" ? params.packId.trim() : "";

  if (!deviceId) {
    return { ok: false, reason: "invalid_device_id", httpStatus: 400 };
  }
  if (!packId) {
    return { ok: false, reason: "invalid_pack_id", httpStatus: 400 };
  }

  if (getCoinPackCatalog().length === 0) {
    return {
      ok: false,
      reason: "coin_packs_not_configured",
      httpStatus: 503,
      hint: "Set CONNECT_COIN_PACKS_JSON with at least one pack",
    };
  }

  const pack = getCoinPackById(packId);
  if (!pack) {
    return { ok: false, reason: "unknown_pack_id", httpStatus: 400 };
  }

  const urls = resolveCheckoutUrls(params);
  if (!urls.ok) {
    return { ok: false, reason: urls.reason, httpStatus: 400 };
  }

  const metadata = {
    deviceId,
    packId: pack.packId,
    connectBilling: "coin_pack",
    coinsGranted: String(pack.coins),
  };

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: pack.stripePriceId, quantity: 1 }],
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    client_reference_id: `coin_pack:${deviceId}:${pack.packId}`.slice(0, 500),
    metadata,
    payment_intent_data: {
      metadata: { ...metadata },
    },
  });

  return {
    ok: true,
    sessionId: session.id,
    url: session.url,
    packId: pack.packId,
    coins: pack.coins,
  };
}

module.exports = {
  createCoinPackCheckoutSession,
};
