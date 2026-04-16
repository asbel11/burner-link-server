/**
 * Phase 20 — provider-agnostic billing webhook ingestion for room retention entitlements.
 */

const crypto = require("crypto");
const { normalizeRetentionSource } = require("./retentionContract");

/** Normalized provider keys stored in retention_purchases.idempotency_provider */
const PROVIDER_ALIASES = new Map([
  ["stripe", "stripe"],
  ["revenuecat", "revenuecat"],
  ["revenue_cat", "revenuecat"],
  ["app_store", "app_store"],
  ["apple", "app_store"],
  ["ios", "app_store"],
  ["google_play", "google_play"],
  ["play_store", "google_play"],
  ["google", "google_play"],
  ["android", "google_play"],
]);

const ALLOWED_EVENT_TYPES = new Set([
  "purchase",
  "renewal",
  "subscription_cycle",
  "initial_purchase",
  "non_renewing_purchase",
]);

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeBillingProvider(raw) {
  if (raw == null || typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  if (PROVIDER_ALIASES.has(s)) return PROVIDER_ALIASES.get(s);
  if (/^[a-z0-9_]+$/.test(s) && s.length <= 64) return s;
  return null;
}

/**
 * Maps normalized provider → rooms.retention_source / retention_purchases.source (subset of KNOWN_SOURCES).
 * @param {string} normalizedProvider
 */
function providerToRetentionSource(normalizedProvider) {
  const p = String(normalizedProvider).toLowerCase();
  if (p === "stripe") return "stripe";
  if (p === "revenuecat") return "revenuecat";
  if (p === "app_store") return "app_store";
  if (p === "google_play") return "google_play";
  return normalizeRetentionSource(normalizedProvider);
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, value: object } | { ok: false, reason: string }}
 */
function parseBillingRetentionPayload(body) {
  if (body == null || typeof body !== "object") {
    return { ok: false, reason: "invalid_body" };
  }
  const providerRaw = body.provider;
  const externalTransactionId = body.externalTransactionId;
  const roomId = body.roomId;
  const deviceId = body.deviceId;
  const retentionTier = body.retentionTier;
  const eventType = body.eventType;

  const provider = normalizeBillingProvider(providerRaw);
  if (!provider) {
    return { ok: false, reason: "invalid_provider" };
  }
  if (typeof externalTransactionId !== "string" || externalTransactionId.trim() === "") {
    return { ok: false, reason: "invalid_external_transaction_id" };
  }
  if (typeof roomId !== "string" || roomId.trim() === "") {
    return { ok: false, reason: "invalid_room_id" };
  }
  if (typeof deviceId !== "string" || deviceId.trim() === "") {
    return { ok: false, reason: "invalid_device_id" };
  }
  if (typeof retentionTier !== "string" || retentionTier.trim() === "") {
    return { ok: false, reason: "invalid_retention_tier" };
  }
  if (typeof eventType !== "string" || !ALLOWED_EVENT_TYPES.has(eventType.trim())) {
    return { ok: false, reason: "invalid_event_type" };
  }

  let eventTimeMs = Date.now();
  if (body.eventTime != null) {
    if (typeof body.eventTime === "number" && Number.isFinite(body.eventTime)) {
      eventTimeMs = body.eventTime;
    } else if (typeof body.eventTime === "string" && body.eventTime.trim() !== "") {
      const p = Date.parse(body.eventTime);
      if (!Number.isNaN(p)) eventTimeMs = p;
    }
  }

  return {
    ok: true,
    value: {
      provider,
      externalTransactionId: externalTransactionId.trim().slice(0, 256),
      roomId: roomId.trim(),
      deviceId: deviceId.trim(),
      retentionTier: retentionTier.trim(),
      retentionUntil: body.retentionUntil,
      eventType: eventType.trim(),
      eventTimeMs,
    },
  };
}

/**
 * @param {import("express").Request} req
 * @param {string|undefined} secret
 */
function verifyBillingWebhookSecret(req, secret) {
  if (secret == null || String(secret).length === 0) {
    return { ok: false, reason: "not_configured" };
  }
  let token;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    token = auth.slice(7).trim();
  }
  if (token == null || token === "") {
    const h = req.headers["x-billing-secret"];
    if (typeof h === "string") token = h.trim();
  }
  if (!token) {
    return { ok: false, reason: "unauthorized" };
  }
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(String(secret), "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: true };
}

/**
 * Express handler: POST /v2/webhooks/billing
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {{ applyBillingRetentionEntitlement: Function }} rooms
 */
function handleBillingRetentionPost(req, res, rooms) {
  const vr = verifyBillingWebhookSecret(req, process.env.BILLING_WEBHOOK_SECRET);
  if (vr.reason === "not_configured") {
    return res.status(503).json({
      error: "Billing webhook not configured",
      reason: "billing_not_configured",
    });
  }
  if (!vr.ok) {
    return res.status(401).json({ error: "Unauthorized", reason: "unauthorized" });
  }

  const parsed = parseBillingRetentionPayload(req.body || {});
  if (!parsed.ok) {
    return res.status(400).json({
      error: "Invalid billing payload",
      reason: parsed.reason,
    });
  }

  const out = applyRetentionEntitlementFromNormalizedInput(rooms, parsed.value);
  return respondWithEntitlementResult(res, out);
}

/**
 * Shared path for generic billing JSON and Stripe-verified events.
 * @param {{ applyBillingRetentionEntitlement: Function }} rooms
 * @param {{ provider: string, externalTransactionId: string, roomId: string, deviceId: string, retentionTier: string, retentionUntil?: unknown, eventType: string, eventTimeMs: number, stripeEventType?: string }} input
 */
function applyRetentionEntitlementFromNormalizedInput(rooms, input) {
  const retentionSource = providerToRetentionSource(input.provider);
  const noteObj = {
    eventType: input.eventType,
    eventTimeMs: input.eventTimeMs,
    provider: input.provider,
  };
  if (input.stripeEventType) {
    noteObj.stripeEventType = input.stripeEventType;
  }
  const note = JSON.stringify(noteObj);

  return rooms.applyBillingRetentionEntitlement({
    idempotencyProvider: input.provider,
    idempotencyKey: input.externalTransactionId,
    roomId: input.roomId,
    deviceId: input.deviceId,
    retentionTier: input.retentionTier,
    retentionUntil: input.retentionUntil,
    retentionSource,
    note,
  });
}

/**
 * @param {import("express").Response} res
 * @param {ReturnType<typeof applyRetentionEntitlementFromNormalizedInput>} out
 */
function respondWithEntitlementResult(res, out) {
  if (!out.ok) {
    const map = {
      invalid_tier: 400,
      invalid_idempotency: 400,
      unknown: 404,
      forbidden: 403,
      deleted: 410,
      room_not_active: 409,
      would_downgrade: 409,
    };
    const status = map[out.reason] || 400;
    const messages = {
      would_downgrade:
        "Retention tier would downgrade existing entitlement; rejected",
      room_not_active: "Room is not active",
      forbidden: "Device is not linked to this room",
      deleted: "Room was deleted",
      unknown: "Room not found",
    };
    return res.status(status).json({
      error: messages[out.reason] || "Billing entitlement rejected",
      reason: out.reason,
    });
  }

  const { ok: _drop, ...body } = out;
  return res.status(200).json(body);
}

module.exports = {
  parseBillingRetentionPayload,
  normalizeBillingProvider,
  providerToRetentionSource,
  verifyBillingWebhookSecret,
  handleBillingRetentionPost,
  applyRetentionEntitlementFromNormalizedInput,
  respondWithEntitlementResult,
  ALLOWED_EVENT_TYPES,
};
