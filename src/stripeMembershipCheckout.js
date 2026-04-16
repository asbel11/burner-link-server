/**
 * Phase M2 — Stripe Checkout (subscription mode) for CONNECT membership.
 */

const { resolveCheckoutUrls } = require("./stripeCheckout");

/**
 * @param {import("stripe").Stripe} stripe
 * @param {{ deviceId: unknown, successUrl?: unknown, cancelUrl?: unknown }} params
 */
async function createMembershipCheckoutSession(stripe, params) {
  const deviceId =
    typeof params.deviceId === "string" ? params.deviceId.trim() : "";
  if (!deviceId) {
    return { ok: false, reason: "invalid_device_id", httpStatus: 400 };
  }

  const priceRaw = process.env.STRIPE_PRICE_CONNECT_MEMBERSHIP;
  if (priceRaw == null || String(priceRaw).trim() === "") {
    return {
      ok: false,
      reason: "price_not_configured",
      httpStatus: 503,
      envKey: "STRIPE_PRICE_CONNECT_MEMBERSHIP",
    };
  }
  const priceId = String(priceRaw).trim();

  const urls = resolveCheckoutUrls(params);
  if (!urls.ok) {
    return { ok: false, reason: urls.reason, httpStatus: 400 };
  }

  const tier = "pro";
  const metadata = {
    deviceId,
    connectBilling: "membership",
    membershipTier: tier,
  };

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    client_reference_id: `membership:${deviceId}`.slice(0, 500),
    metadata,
    subscription_data: {
      metadata: { ...metadata },
    },
  });

  return {
    ok: true,
    sessionId: session.id,
    url: session.url,
  };
}

module.exports = {
  createMembershipCheckoutSession,
};
