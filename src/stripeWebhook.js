/**
 * Phase 21 — Stripe-signed webhooks → same retention entitlement path as generic billing.
 */

const Stripe = require("stripe");
const { ALLOWED_BILLING_TIERS } = require("./store/roomRepository");
const {
  applyRetentionEntitlementFromNormalizedInput,
  respondWithEntitlementResult,
} = require("./billingIngestion");
const { getStripeApiClient, API_VERSION } = require("./stripeClient");
const { processMembershipStripeEvent } = require("./stripeMembershipWebhook");
const { processCoinPackStripeEvent } = require("./stripeCoinPackWebhook");

/** Stripe client for webhook verification only (API key unused for constructEvent). */
function stripeForWebhooks() {
  const key =
    process.env.STRIPE_SECRET_KEY ||
    process.env.STRIPE_WEBHOOK_VERIFICATION_KEY ||
    "sk_test_webhook_verification_placeholder_not_for_charges";
  return new Stripe(key, { apiVersion: API_VERSION });
}

/** Optional: subscription.retrieve for invoice.paid when metadata is only on subscription. */
function stripeForApi() {
  return getStripeApiClient();
}

/**
 * @param {Record<string, string>|null|undefined} metadata
 * @returns {{ ok: true, roomId: string, deviceId: string, retentionTier: string, retentionUntil?: string } | { ok: false, reason: string }}
 */
function extractRetentionMetadata(metadata) {
  if (metadata == null || typeof metadata !== "object") {
    return { ok: false, reason: "missing_stripe_metadata" };
  }
  const roomId =
    typeof metadata.roomId === "string" ? metadata.roomId.trim() : "";
  const deviceId =
    typeof metadata.deviceId === "string" ? metadata.deviceId.trim() : "";
  let retentionTier =
    typeof metadata.retentionTier === "string"
      ? metadata.retentionTier.trim().toLowerCase()
      : "";
  if (!roomId || !deviceId || !retentionTier) {
    return { ok: false, reason: "missing_stripe_metadata" };
  }
  if (!ALLOWED_BILLING_TIERS.has(retentionTier)) {
    return { ok: false, reason: "invalid_retention_tier" };
  }
  const out = { ok: true, roomId, deviceId, retentionTier };
  if (
    metadata.retentionUntil != null &&
    String(metadata.retentionUntil).trim() !== ""
  ) {
    out.retentionUntil = String(metadata.retentionUntil).trim();
  }
  return out;
}

/**
 * @param {object} meta
 * @param {string} eventId Stripe event.id (evt_…)
 * @param {number} eventTimeMs
 * @param {'purchase'|'renewal'|'subscription_cycle'} billingEventType
 * @param {string} stripeEventType
 */
function toNormalizedEntitlementInput(
  meta,
  eventId,
  eventTimeMs,
  billingEventType,
  stripeEventType
) {
  return {
    provider: "stripe",
    externalTransactionId: eventId.slice(0, 256),
    roomId: meta.roomId,
    deviceId: meta.deviceId,
    retentionTier: meta.retentionTier,
    retentionUntil: meta.retentionUntil,
    eventType: billingEventType,
    eventTimeMs,
    stripeEventType,
  };
}

/**
 * @param {object} event Stripe Event
 * @returns {Promise<{ kind: 'ignore' } | { kind: 'reject', status?: number, error: string, reason: string } | { kind: 'apply', value: object }>}
 */
async function mapStripeEventToEntitlementInput(event) {
  const eventId = event.id;
  const eventTimeMs = (typeof event.created === "number" ? event.created : 0) * 1000;

  if (event.type === "checkout.session.completed") {
    const session = event.data && event.data.object;
    const mode = session && session.mode;
    const meta = extractRetentionMetadata(session && session.metadata);
    if (!meta.ok) {
      if (mode === "subscription") {
        return { kind: "ignore" };
      }
      return {
        kind: "reject",
        status: 400,
        error: "Checkout session missing required retention metadata",
        reason: meta.reason,
      };
    }
    return {
      kind: "apply",
      value: toNormalizedEntitlementInput(
        meta,
        eventId,
        eventTimeMs,
        "purchase",
        event.type
      ),
    };
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data && event.data.object;
    let meta = extractRetentionMetadata(invoice && invoice.metadata);

    if (!meta.ok && invoice && typeof invoice.subscription === "string") {
      const client = stripeForApi();
      if (client) {
        try {
          const sub = await client.subscriptions.retrieve(invoice.subscription);
          meta = extractRetentionMetadata(sub.metadata);
        } catch (_) {
          meta = { ok: false, reason: "missing_stripe_metadata" };
        }
      }
    }

    if (!meta.ok) {
      return {
        kind: "reject",
        status: 400,
        error:
          "Invoice missing retention metadata (set on invoice or subscription, or configure STRIPE_SECRET_KEY for subscription lookup)",
        reason: meta.reason,
      };
    }

    const billingType =
      invoice && invoice.billing_reason === "subscription_cycle"
        ? "subscription_cycle"
        : "renewal";

    return {
      kind: "apply",
      value: toNormalizedEntitlementInput(
        meta,
        eventId,
        eventTimeMs,
        billingType,
        event.type
      ),
    };
  }

  return { kind: "ignore" };
}

/**
 * POST /v2/webhooks/stripe — req.body must be raw Buffer (express.raw).
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {{ applyBillingRetentionEntitlement: Function }} rooms
 * @param {object} membership device membership store (see src/deviceMembership.js)
 * @param {object} coins coin wallet repository (see src/store/coinWalletRepository.js)
 */
async function handleStripeWebhookPost(req, res, rooms, membership, coins) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (secret == null || String(secret).trim() === "") {
    return res.status(503).json({
      error: "Stripe webhook not configured",
      reason: "stripe_webhook_not_configured",
    });
  }

  const sig = req.headers["stripe-signature"];
  if (typeof sig !== "string" || sig.trim() === "") {
    return res.status(400).json({
      error: "Missing Stripe-Signature header",
      reason: "missing_signature",
    });
  }

  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(500).json({
      error: "Server misconfiguration: Stripe route expects raw body",
      reason: "raw_body_required",
    });
  }

  let event;
  try {
    const stripe = stripeForWebhooks();
    event = stripe.webhooks.constructEvent(rawBody, sig, secret.trim());
  } catch (_err) {
    return res.status(400).json({
      error: "Invalid Stripe webhook signature",
      reason: "invalid_signature",
    });
  }

  const membershipOutcome = await processMembershipStripeEvent(event, {
    membership,
    stripe: stripeForApi(),
  });
  if (membershipOutcome.handled) {
    return res
      .status(membershipOutcome.httpStatus || 200)
      .json(membershipOutcome.body);
  }

  const coinOutcome = await processCoinPackStripeEvent(event, { coins });
  if (coinOutcome.handled) {
    return res
      .status(coinOutcome.httpStatus || 200)
      .json(coinOutcome.body);
  }

  const mapped = await mapStripeEventToEntitlementInput(event);
  if (mapped.kind === "ignore") {
    return res.status(200).json({
      received: true,
      ignored: true,
      type: event.type,
    });
  }
  if (mapped.kind === "reject") {
    return res.status(mapped.status || 400).json({
      error: mapped.error,
      reason: mapped.reason,
    });
  }

  const out = applyRetentionEntitlementFromNormalizedInput(rooms, mapped.value);
  return respondWithEntitlementResult(res, out);
}

module.exports = {
  handleStripeWebhookPost,
  mapStripeEventToEntitlementInput,
  extractRetentionMetadata,
  stripeForWebhooks,
};
