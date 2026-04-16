/**
 * Phase M2 — Stripe subscription events for CONNECT membership (deviceId in subscription metadata).
 */

/**
 * @param {Record<string, string>|null|undefined} metadata
 * @returns {{ ok: true, deviceId: string, tier: string } | { ok: false, reason: string }}
 */
function extractMembershipMetadata(metadata) {
  if (metadata == null || typeof metadata !== "object") {
    return { ok: false, reason: "missing_membership_metadata" };
  }
  const connectBilling =
    typeof metadata.connectBilling === "string"
      ? metadata.connectBilling.trim().toLowerCase()
      : "";
  if (connectBilling !== "membership") {
    return { ok: false, reason: "not_membership" };
  }
  const deviceId =
    typeof metadata.deviceId === "string" ? metadata.deviceId.trim() : "";
  if (!deviceId) {
    return { ok: false, reason: "missing_device_id" };
  }
  const tierRaw =
    typeof metadata.membershipTier === "string"
      ? metadata.membershipTier.trim().toLowerCase()
      : "";
  const tier = tierRaw || "pro";
  return { ok: true, deviceId, tier };
}

/**
 * @param {import("stripe").Stripe|null} stripe
 * @param {string} subscriptionId
 */
async function retrieveSubscription(stripe, subscriptionId) {
  if (!stripe || !subscriptionId) return null;
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} event Stripe Event
 * @param {{ membership: object, stripe: import("stripe").Stripe|null }} deps
 */
async function processMembershipStripeEvent(event, deps) {
  const { membership, stripe } = deps;
  const eventId = event.id;

  if (event.type === "checkout.session.completed") {
    const session = event.data && event.data.object;
    if (!session || session.mode !== "subscription") {
      return { handled: false };
    }
    const mm = extractMembershipMetadata(session.metadata);
    if (!mm.ok) {
      return { handled: false };
    }
    const subId =
      typeof session.subscription === "string" ? session.subscription : null;
    if (!subId) {
      return {
        handled: true,
        httpStatus: 400,
        body: {
          received: true,
          error: "Checkout session missing subscription id",
          reason: "missing_subscription",
        },
      };
    }
    if (!stripe) {
      return {
        handled: true,
        httpStatus: 503,
        body: {
          received: true,
          error: "Stripe API not configured (set STRIPE_SECRET_KEY)",
          reason: "stripe_api_required",
        },
      };
    }
    const sub = await retrieveSubscription(stripe, subId);
    if (!sub || sub.current_period_end == null) {
      return {
        handled: true,
        httpStatus: 400,
        body: {
          received: true,
          error: "Could not load subscription for membership activation",
          reason: "subscription_load_failed",
        },
      };
    }
    const periodEndMs = sub.current_period_end * 1000;
    const cust =
      typeof session.customer === "string" ? session.customer : null;
    const out = membership.applyActivationOrRenewal({
      eventId,
      deviceId: mm.deviceId,
      stripeCustomerId: cust,
      stripeSubscriptionId: subId,
      periodEndMs,
      tier: mm.tier,
    });
    return { handled: true, httpStatus: 200, body: { received: true, ...out } };
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data && event.data.object;
    const subId =
      invoice && typeof invoice.subscription === "string"
        ? invoice.subscription
        : null;
    if (!subId) {
      return { handled: false };
    }
    if (!stripe) {
      return { handled: false };
    }
    const sub = await retrieveSubscription(stripe, subId);
    if (!sub) {
      return { handled: false };
    }
    const mm = extractMembershipMetadata(sub.metadata);
    if (!mm.ok) {
      return { handled: false };
    }
    const periodEndSec =
      invoice && invoice.period_end != null
        ? invoice.period_end
        : sub.current_period_end;
    if (periodEndSec == null) {
      return {
        handled: true,
        httpStatus: 400,
        body: {
          received: true,
          error: "Invoice missing period end",
          reason: "missing_period_end",
        },
      };
    }
    const periodEndMs = periodEndSec * 1000;
    const cust =
      invoice && typeof invoice.customer === "string"
        ? invoice.customer
        : typeof sub.customer === "string"
          ? sub.customer
          : null;
    const out = membership.applyActivationOrRenewal({
      eventId,
      deviceId: mm.deviceId,
      stripeCustomerId: cust,
      stripeSubscriptionId: subId,
      periodEndMs,
      tier: mm.tier,
    });
    return { handled: true, httpStatus: 200, body: { received: true, ...out } };
  }

  if (event.type === "invoice.payment_failed") {
    const invoice = event.data && event.data.object;
    const subId =
      invoice && typeof invoice.subscription === "string"
        ? invoice.subscription
        : null;
    if (!subId) {
      return { handled: false };
    }
    if (!stripe) {
      return { handled: false };
    }
    const sub = await retrieveSubscription(stripe, subId);
    if (!sub) {
      return { handled: false };
    }
    if (!extractMembershipMetadata(sub.metadata).ok) {
      return { handled: false };
    }
    const out = membership.applyPaymentFailed({
      eventId,
      stripeSubscriptionId: subId,
    });
    return { handled: true, httpStatus: 200, body: { received: true, ...out } };
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data && event.data.object;
    if (!sub || !extractMembershipMetadata(sub.metadata).ok) {
      return { handled: false };
    }
    const atMs =
      sub.current_period_end != null ? sub.current_period_end * 1000 : Date.now();
    const out = membership.applyExpirationBySubscription({
      eventId,
      stripeSubscriptionId: sub.id,
      atMs,
    });
    return { handled: true, httpStatus: 200, body: { received: true, ...out } };
  }

  return { handled: false };
}

module.exports = {
  extractMembershipMetadata,
  processMembershipStripeEvent,
};
