// Burner Link API: V1 routes preserved; persistence uses CONNECT-oriented "room" tables (SQLite).
//
// ID contract (Phase 7): `rooms.id` === V1 path/body `sessionId` === V2 path `roomId`.
// Same string, different param names. See docs/v1-v2-id-contract.md and src/idContract.js.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createRoomStore } = require("./src/store");
const { handleBillingRetentionPost } = require("./src/billingIngestion");
const { isManualRetentionPostAllowed } = require("./src/retentionManualPolicy");
const { handleStripeWebhookPost } = require("./src/stripeWebhook");
const { getStripeApiClient } = require("./src/stripeClient");
const { createRetentionCheckoutSession } = require("./src/stripeCheckout");
const { createMembershipCheckoutSession } = require("./src/stripeMembershipCheckout");
const { createConnectProPortalSession } = require("./src/stripeCustomerPortal");
const { getCheckoutSessionSyncStatus } = require("./src/stripeCheckoutStatus");
const { getEffectiveSessionHeartbeatAutoEnd } = require("./src/connectSessionPolicy");

function envFlag(name, defaultValue = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

const app = express();
app.use(cors());

const store = createRoomStore();
console.log("Room store (SQLite):", store.dbFilePath);

// Stripe verifies HMAC over the raw JSON bytes — register before express.json().
app.post(
  "/v2/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req, res) => {
    handleStripeWebhookPost(req, res, store.rooms, store.membership).catch((err) => {
      console.error("Error in POST /v2/webhooks/stripe:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    });
  }
);

// Allow larger JSON bodies to support base64 images
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.get("/", (req, res) => {
  res.send("🔥 Burner Link API is live");
});

// Used only when SESSION_HEARTBEAT_AUTO_END is enabled (legacy / opt-in).
const OFFLINE_TIMEOUT_MS = Number(process.env.OFFLINE_TIMEOUT_MS) || 30000;
const INACTIVITY_BEFORE_BURN_MS =
  Number(process.env.INACTIVITY_BEFORE_BURN_MS) || 30000;
// Effective only if CONNECT_DISABLE_SESSION_AUTO_END allows it (see docs/connect-server-environment.md).
const SESSION_HEARTBEAT_AUTO_END = getEffectiveSessionHeartbeatAutoEnd();

console.log(
  `[connect] SESSION_HEARTBEAT_AUTO_END effective=${SESSION_HEARTBEAT_AUTO_END} (CONNECT_DISABLE_SESSION_AUTO_END unset blocks legacy auto-end; see docs/connect-server-environment.md)`
);

// Simple in-memory metrics (reset when server restarts)
const metrics = {
  cameraClicks: 0,
  sessionsCreated: 0,
  devices: new Set(), // unique deviceIds we've seen
};

// Helper to create a random id
function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function isValidDeviceId(deviceId) {
  return typeof deviceId === "string" && deviceId.trim().length > 0;
}

// ---------- Session routes ----------

// Create a new session from a 6-digit code
app.post("/sessions/create", (req, res) => {
  const { code, deviceId } = req.body;

  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Missing or invalid code" });
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "Code must be a 6-digit number" });
  }
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "Missing or invalid deviceId" });
  }

  metrics.sessionsCreated += 1;
  metrics.devices.add(deviceId);

  const sessionId = createId();
  store.rooms.createRoomFromV1({
    id: sessionId,
    inviteCode: code,
    creatorDeviceId: deviceId,
  });

  console.log("Created room (V1 session id)", sessionId, "for code", code, "by", deviceId);
  // `roomId` duplicates `id` — explicit for CONNECT clients; same as V2 :roomId.
  return res.status(201).json({ id: sessionId, roomId: sessionId });
});

// Join an existing active session by code
app.post("/sessions/join", (req, res) => {
  const { code, deviceId } = req.body;

  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Missing or invalid code" });
  }
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "Missing or invalid deviceId" });
  }

  metrics.devices.add(deviceId);

  const joined = store.rooms.joinActiveRoomByCode({ inviteCode: code, deviceId });
  if (!joined.ok) {
    if (joined.reason === "full") {
      return res
        .status(403)
        .json({ error: "Session already has two devices connected." });
    }
    return res.status(404).json({ error: "Session not found or inactive" });
  }

  console.log("Joined room", joined.roomId, "with code", code, "by", deviceId);
  res.json({ id: joined.roomId, roomId: joined.roomId });
});

// End a session and burn its data
app.post("/sessions/end", (req, res) => {
  const { sessionId } = req.body;

  const outcome = store.rooms.endRoomBurnV1(sessionId);
  if (outcome.kind === "unknown") {
    return res.status(200).json({ ok: true, sessionUnknown: true });
  }
  if (outcome.kind === "deleted") {
    // Room exists but was soft-deleted via V2; same idempotent shape as unknown for V1 clients.
    return res.status(200).json({ ok: true, sessionUnknown: true });
  }
  if (outcome.kind === "already_ended") {
    return res.status(200).json({ ok: true, alreadyEnded: true });
  }

  console.log("Ended room (V1 burn)", sessionId);
  res.json({ ok: true, ended: true });
});

// Check basic status of a session (used so the first device can auto-join chat
// when the second device connects).
app.get("/sessions/status/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = store.rooms.getRoomAsV1Session(sessionId);

    if (!session) {
      return res.status(404).json({ active: false, participants: 0 });
    }

    const participants = session.participants.length;

    return res.json({
      active: !!session.active,
      participants,
    });
  } catch (err) {
    console.error("Error in /sessions/status:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Heartbeat route so each device can signal it is still connected. Optional
// legacy behavior: stale peer + inactivity can end the session only if both
// CONNECT_DISABLE_SESSION_AUTO_END allows it and SESSION_HEARTBEAT_AUTO_END is on
// (see docs/session-lifecycle.md and docs/connect-server-environment.md).
app.post("/sessions/heartbeat", (req, res) => {
  try {
    const { sessionId, deviceId } = req.body || {};
    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ error: "Missing or invalid sessionId" });
    }
    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }

    const hb = store.rooms.touchHeartbeatV1({
      roomId: sessionId,
      deviceId,
      offlineTimeoutMs: OFFLINE_TIMEOUT_MS,
      inactivityBeforeBurnMs: INACTIVITY_BEFORE_BURN_MS,
      sessionHeartbeatAutoEnd: SESSION_HEARTBEAT_AUTO_END,
    });

    if (!hb.ok) {
      return res.status(404).json({ error: "Session not found or inactive" });
    }

    if (hb.ended) {
      return res.json({ ok: true, ended: true });
    }

    return res.json({ ok: true, ended: false });
  } catch (err) {
    console.error("Error in /sessions/heartbeat:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Message routes ----------

// Get all messages for a session
app.get("/messages/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  const session = store.rooms.getRoomAsV1Session(sessionId);

  if (!session || !session.active) {
    return res.status(404).json({ error: "Session not found or inactive" });
  }

  res.json(session.messages);
});

// Post a new message (text or image)
app.post("/messages", (req, res) => {
  const { sessionId, senderId, encrypted, type, fileName } = req.body;

  if (
    !encrypted ||
    typeof encrypted !== "object" ||
    !encrypted.ciphertext ||
    !encrypted.nonce
  ) {
    return res.status(400).json({ error: "Missing encrypted payload" });
  }

  const id = createId();

  const inserted = store.rooms.appendMessageV1({
    roomId: sessionId,
    messageId: id,
    senderId: senderId || "unknown",
    type: type === "image" ? "image" : "text",
    encrypted,
    fileName: fileName || null,
  });

  if (!inserted.ok) {
    return res.status(404).json({ error: "Session not found or inactive" });
  }

  const msg = inserted.message;
  console.log("New message in room", sessionId, ":", msg.type, "id", id);

  return res.status(201).json({
    id: msg.id,
    senderId: msg.senderId,
    type: msg.type,
    encrypted: msg.encrypted,
    fileName: msg.fileName,
  });
});

// ---------- CONNECT V2 room routes (device-scoped) ----------
// V1 mobile continues to use /sessions/* and /messages/* only.

// List rooms linked to this device (see docs/v2-rooms-api.md).
// Query: deviceId (required), status=all|active|ended (default all).
app.get("/v2/rooms", (req, res) => {
  try {
    const deviceId = req.query.deviceId;
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }
    const statusRaw = req.query.status;
    const status =
      typeof statusRaw === "string" &&
      (statusRaw === "all" || statusRaw === "active" || statusRaw === "ended")
        ? statusRaw
        : "all";

    const rooms = store.rooms.listRoomsForDevice({
      deviceId: deviceId.trim(),
      status,
    });
    return res.json({ rooms });
  } catch (err) {
    console.error("Error in GET /v2/rooms:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Room detail for a device that has a historical link to the room.
app.get("/v2/rooms/:roomId", (req, res) => {
  try {
    const { roomId } = req.params;
    const deviceId = req.query.deviceId;
    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({ error: "Missing or invalid roomId" });
    }
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }

    const detail = store.rooms.getRoomDetailForDevice(roomId, deviceId.trim());
    if (!detail.ok) {
      if (detail.reason === "forbidden") {
        return res.status(403).json({ error: "Device is not a member of this room" });
      }
      if (detail.reason === "deleted") {
        return res.status(410).json({ error: "Room was deleted" });
      }
      return res.status(404).json({ error: "Room not found" });
    }
    return res.json(detail.room);
  } catch (err) {
    console.error("Error in GET /v2/rooms/:roomId:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Messages for CONNECT clients: same payload shape as V1 GET /messages when active;
// ended rooms return an empty array with explicit roomState (V1 route still 404s).
app.get("/v2/rooms/:roomId/messages", (req, res) => {
  try {
    const { roomId } = req.params;
    const deviceId = req.query.deviceId;
    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({ error: "Missing or invalid roomId" });
    }
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }

    const out = store.rooms.listMessagesForDeviceRoom(roomId, deviceId.trim());
    if (!out.ok) {
      if (out.reason === "forbidden") {
        return res.status(403).json({ error: "Device is not a member of this room" });
      }
      if (out.reason === "deleted") {
        return res.status(410).json({ error: "Room was deleted" });
      }
      return res.status(404).json({ error: "Room not found" });
    }
    return res.json({
      v1SessionId: roomId,
      roomState: out.roomState,
      messages: out.messages,
    });
  } catch (err) {
    console.error("Error in GET /v2/rooms/:roomId/messages:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// V2 native send: same encrypted payload + storage as V1 POST /messages, but room id in path
// and device_room_links required (see docs/v2-message-transport.md).
app.post("/v2/rooms/:roomId/messages", (req, res) => {
  try {
    const { roomId } = req.params;
    const { deviceId, senderId, encrypted, type, fileName } = req.body || {};

    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({ error: "Missing or invalid roomId" });
    }
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }
    if (
      !encrypted ||
      typeof encrypted !== "object" ||
      !encrypted.ciphertext ||
      !encrypted.nonce
    ) {
      return res.status(400).json({ error: "Missing encrypted payload" });
    }

    const id = createId();
    const inserted = store.rooms.appendMessageForLinkedDevice({
      roomId,
      deviceId: deviceId.trim(),
      messageId: id,
      senderId,
      type: type === "image" ? "image" : "text",
      encrypted,
      fileName: fileName || null,
    });

    if (!inserted.ok) {
      if (inserted.reason === "forbidden") {
        return res.status(403).json({ error: "Device is not a member of this room" });
      }
      if (inserted.reason === "sender_mismatch") {
        return res.status(400).json({
          error: "senderId must match deviceId when provided",
        });
      }
      return res.status(404).json({ error: "Session not found or inactive" });
    }

    const msg = inserted.message;
    console.log("V2 POST message room", roomId, ":", msg.type, "id", id);

    return res.status(201).json({
      id: msg.id,
      senderId: msg.senderId,
      type: msg.type,
      encrypted: msg.encrypted,
      fileName: msg.fileName,
    });
  } catch (err) {
    console.error("Error in POST /v2/rooms/:roomId/messages:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Soft-delete (CONNECT): hide from lists; irreversible via API this phase (see docs).
app.post("/v2/rooms/:roomId/delete", (req, res) => {
  try {
    const { roomId } = req.params;
    const { deviceId } = req.body || {};
    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({ error: "Missing or invalid roomId" });
    }
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }

    const out = store.rooms.softDeleteRoomForDevice(roomId, deviceId.trim());
    if (!out.ok) {
      if (out.reason === "forbidden") {
        return res.status(403).json({ error: "Device is not a member of this room" });
      }
      return res.status(404).json({ error: "Room not found" });
    }
    if (out.alreadyDeleted) {
      return res.status(200).json({ ok: true, alreadyDeleted: true });
    }
    return res.status(200).json({ ok: true, deletedAt: out.deletedAt });
  } catch (err) {
    console.error("Error in POST /v2/rooms/:roomId/delete:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Reopen ended (V1-burned) room shell; messages stay empty until new activity.
app.post("/v2/rooms/:roomId/reopen", (req, res) => {
  try {
    const { roomId } = req.params;
    const { deviceId } = req.body || {};
    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({ error: "Missing or invalid roomId" });
    }
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }

    const out = store.rooms.reopenEndedRoomForDevice(roomId, deviceId.trim());
    if (!out.ok) {
      if (out.reason === "forbidden") {
        return res.status(403).json({ error: "Device is not a member of this room" });
      }
      if (out.reason === "room_deleted") {
        return res.status(410).json({ error: "Room was deleted" });
      }
      if (out.reason === "not_ended") {
        return res.status(409).json({ error: "Room is not ended; reopen only applies after burn" });
      }
      return res.status(404).json({ error: "Room not found" });
    }
    return res.status(200).json({ ok: true, room: out.room });
  } catch (err) {
    console.error("Error in POST /v2/rooms/:roomId/reopen:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// New 6-digit invite code; room id unchanged. Active, non-deleted rooms only.
app.post("/v2/rooms/:roomId/rotate-invite-code", (req, res) => {
  try {
    const { roomId } = req.params;
    const { deviceId } = req.body || {};
    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({ error: "Missing or invalid roomId" });
    }
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }

    const out = store.rooms.rotateInviteCodeForDevice(roomId, deviceId.trim());
    if (!out.ok) {
      if (out.reason === "forbidden") {
        return res.status(403).json({ error: "Device is not a member of this room" });
      }
      if (out.reason === "room_deleted") {
        return res.status(410).json({ error: "Room was deleted" });
      }
      if (out.reason === "not_active") {
        return res.status(409).json({
          error: "Invite code can only be rotated for active rooms",
        });
      }
      if (out.reason === "code_collision") {
        return res.status(503).json({ error: "Could not allocate a unique code; retry" });
      }
      return res.status(404).json({ error: "Room not found" });
    }
    return res.status(200).json({
      ok: true,
      roomId,
      v1SessionId: roomId,
      inviteCode: out.inviteCode,
      updatedAt: out.updatedAt,
      openChatInviteAvailable: out.openChatInviteAvailable,
      openChatInviteUnavailableReason: out.openChatInviteUnavailableReason,
    });
  } catch (err) {
    console.error("Error in POST /v2/rooms/:roomId/rotate-invite-code:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- V2 membership checkout (Stripe subscription — Phase M2) ----------

app.post("/v2/billing/create-membership-checkout-session", async (req, res) => {
  try {
    const { deviceId, successUrl, cancelUrl } = req.body || {};
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }

    const stripe = getStripeApiClient();
    if (!stripe) {
      return res.status(503).json({
        error: "Stripe API is not configured (set STRIPE_SECRET_KEY)",
        reason: "stripe_not_configured",
      });
    }

    const out = await createMembershipCheckoutSession(stripe, {
      deviceId: deviceId.trim(),
      successUrl,
      cancelUrl,
    });

    if (!out.ok) {
      if (out.reason === "price_not_configured") {
        return res.status(503).json({
          error: `No Stripe Price ID configured for membership (set ${out.envKey})`,
          reason: "price_not_configured",
          envKey: out.envKey,
        });
      }
      if (out.reason === "missing_checkout_urls") {
        return res.status(400).json({
          error:
            "Provide successUrl and cancelUrl in the JSON body, or set STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL",
          reason: "missing_checkout_urls",
        });
      }
      if (out.reason === "invalid_device_id") {
        return res.status(400).json({ error: "Missing or invalid deviceId" });
      }
      return res.status(out.httpStatus || 400).json({
        error: "Membership checkout session could not be created",
        reason: out.reason,
      });
    }

    const { ok: _ok, ...body } = out;
    return res.status(200).json(body);
  } catch (err) {
    console.error("Error in POST /v2/billing/create-membership-checkout-session:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// CONNECT Pro — Stripe Customer Portal (manage/cancel; Phase M3b)
app.post("/v2/billing/create-portal-session", async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }

    const stripe = getStripeApiClient();
    if (!stripe) {
      return res.status(503).json({
        error: "Stripe API is not configured (set STRIPE_SECRET_KEY)",
        reason: "stripe_not_configured",
      });
    }

    const out = await createConnectProPortalSession(
      stripe,
      store.membership,
      deviceId.trim(),
      req.body || {}
    );

    if (!out.ok) {
      const map = {
        invalid_device_id: 400,
        membership_not_found: 404,
        stripe_customer_not_linked: 404,
        missing_return_url: 400,
        invalid_return_url: 400,
        portal_session_incomplete: 502,
        stripe_portal_error: 502,
      };
      const status = map[out.reason] || out.httpStatus || 400;
      const payload = {
        error:
          out.reason === "membership_not_found"
            ? "No membership record for this device"
            : out.reason === "stripe_customer_not_linked"
              ? "No Stripe customer linked to this device; complete membership checkout first"
              : out.reason === "missing_return_url" || out.reason === "invalid_return_url"
                ? "Invalid or missing return URL for Customer Portal"
                : out.reason === "stripe_portal_error"
                  ? "Could not create Stripe Customer Portal session"
                  : "Could not create portal session",
        reason: out.reason,
      };
      if (out.hint) payload.hint = out.hint;
      if (out.detail) payload.detail = out.detail;
      return res.status(status).json(payload);
    }

    return res.status(200).json({ url: out.url });
  } catch (err) {
    console.error("Error in POST /v2/billing/create-portal-session:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// CONNECT Pro membership status (read-only; deviceId-only identity — Phase M3a)
app.get("/v2/billing/membership", (req, res) => {
  try {
    const deviceId = req.query.deviceId;
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }
    const body = store.membership.getMembershipStatus(deviceId.trim());
    if (body == null) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }
    return res.status(200).json(body);
  } catch (err) {
    console.error("Error in GET /v2/billing/membership:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- V2 billing webhook (verified retention entitlements — see docs/v2-billing-ingestion.md) ----------

app.post("/v2/webhooks/billing", (req, res) => {
  try {
    return handleBillingRetentionPost(req, res, store.rooms);
  } catch (err) {
    console.error("Error in POST /v2/webhooks/billing:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- V2 retention (manual when allowed — see docs/v2-retention.md) ----------

app.get("/v2/rooms/:roomId/retention", (req, res) => {
  try {
    const { roomId } = req.params;
    const deviceId = req.query.deviceId;
    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({ error: "Missing or invalid roomId" });
    }
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }

    const out = store.rooms.getRetentionForLinkedDevice(roomId, deviceId.trim());
    if (!out.ok) {
      if (out.reason === "forbidden") {
        return res.status(403).json({ error: "Device is not a member of this room" });
      }
      if (out.reason === "deleted") {
        return res.status(410).json({ error: "Room was deleted" });
      }
      return res.status(404).json({ error: "Room not found" });
    }
    const { ok: _ok, ...body } = out;
    return res.status(200).json(body);
  } catch (err) {
    console.error("Error in GET /v2/rooms/:roomId/retention:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/v2/rooms/:roomId/retention", (req, res) => {
  try {
    const { roomId } = req.params;
    const { deviceId, retentionTier, retentionUntil, note, externalRef } =
      req.body || {};
    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({ error: "Missing or invalid roomId" });
    }
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }
    if (typeof retentionTier !== "string" || !retentionTier.trim()) {
      return res.status(400).json({ error: "Missing or invalid retentionTier" });
    }

    if (!isManualRetentionPostAllowed()) {
      return res.status(403).json({
        error:
          "Manual retention updates are disabled in this environment. Use POST /v2/webhooks/billing with a verified entitlement, or set ALLOW_MANUAL_RETENTION_POST=1 for ops.",
        reason: "manual_retention_disabled",
      });
    }

    const out = store.rooms.setRetentionManualForLinkedDevice(
      roomId,
      deviceId.trim(),
      retentionTier.trim(),
      { retentionUntil, note, externalRef }
    );
    if (!out.ok) {
      if (out.reason === "invalid_tier") {
        return res.status(400).json({
          error: "Invalid retentionTier",
          allowed: ["default", "7_days", "30_days", "permanent"],
        });
      }
      if (out.reason === "forbidden") {
        return res.status(403).json({ error: "Device is not a member of this room" });
      }
      if (out.reason === "room_not_active") {
        return res.status(409).json({
          error:
            "Retention can only be updated while the room is active (reopen ended rooms first)",
          reason: "room_not_active",
        });
      }
      if (out.reason === "deleted") {
        return res.status(410).json({ error: "Room was deleted" });
      }
      return res.status(404).json({ error: "Room not found" });
    }
    const { ok: _ok2, ...body } = out;
    return res.status(200).json(body);
  } catch (err) {
    console.error("Error in POST /v2/rooms/:roomId/retention:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- V2 Stripe Checkout (retention — see docs/v2-stripe-checkout.md) ----------

app.post("/v2/rooms/:roomId/billing/create-checkout-session", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { deviceId, retentionTier, retentionUntil, successUrl, cancelUrl } =
      req.body || {};
    if (!roomId || typeof roomId !== "string") {
      return res.status(400).json({ error: "Missing or invalid roomId" });
    }
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }
    if (typeof retentionTier !== "string" || !retentionTier.trim()) {
      return res.status(400).json({ error: "Missing or invalid retentionTier" });
    }

    const stripe = getStripeApiClient();
    if (!stripe) {
      return res.status(503).json({
        error: "Stripe API is not configured (set STRIPE_SECRET_KEY)",
        reason: "stripe_not_configured",
      });
    }

    const out = await createRetentionCheckoutSession(store.rooms, stripe, {
      roomId,
      deviceId: deviceId.trim(),
      retentionTier: retentionTier.trim(),
      retentionUntil,
      successUrl,
      cancelUrl,
    });

    if (!out.ok) {
      if (out.reason === "forbidden") {
        return res.status(403).json({
          error: "Device is not a member of this room",
          reason: "forbidden",
        });
      }
      if (out.reason === "deleted") {
        return res.status(410).json({ error: "Room was deleted", reason: "deleted" });
      }
      if (out.reason === "not_found") {
        return res.status(404).json({ error: "Room not found", reason: "not_found" });
      }
      if (out.reason === "room_not_active") {
        return res.status(409).json({
          error:
            "Checkout is only available for active rooms (reopen ended rooms first)",
          reason: "room_not_active",
        });
      }
      if (out.reason === "invalid_tier") {
        return res.status(400).json({
          error: "Invalid retentionTier for paid checkout",
          allowed: out.allowed,
          reason: "invalid_tier",
        });
      }
      if (out.reason === "price_not_configured") {
        return res.status(503).json({
          error: `No Stripe Price ID configured for this tier (set ${out.envKey})`,
          reason: "price_not_configured",
          envKey: out.envKey,
        });
      }
      if (out.reason === "missing_checkout_urls") {
        return res.status(400).json({
          error:
            "Provide successUrl and cancelUrl in the JSON body, or set STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL",
          reason: "missing_checkout_urls",
        });
      }
      return res.status(out.httpStatus || 400).json({
        error: "Checkout session could not be created",
        reason: out.reason,
      });
    }

    const { ok: _ok, ...body } = out;
    return res.status(200).json(body);
  } catch (err) {
    console.error(
      "Error in POST /v2/rooms/:roomId/billing/create-checkout-session:",
      err
    );
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Checkout session status after return (Phase 24 — see docs/v2-checkout-return-production.md)
app.get(
  "/v2/rooms/:roomId/billing/checkout-session/:sessionId",
  async (req, res) => {
    try {
      const { roomId, sessionId } = req.params;
      const deviceId = req.query.deviceId;
      if (!roomId || typeof roomId !== "string") {
        return res.status(400).json({ error: "Missing or invalid roomId" });
      }
      if (!isValidDeviceId(deviceId)) {
        return res.status(400).json({ error: "Missing or invalid deviceId" });
      }
      if (!sessionId || typeof sessionId !== "string") {
        return res.status(400).json({ error: "Missing or invalid sessionId" });
      }

      const stripe = getStripeApiClient();
      if (!stripe) {
        return res.status(503).json({
          error: "Stripe API is not configured (set STRIPE_SECRET_KEY)",
          reason: "stripe_not_configured",
        });
      }

      const out = await getCheckoutSessionSyncStatus(store.rooms, stripe, {
        roomId,
        deviceId: deviceId.trim(),
        sessionId: sessionId.trim(),
      });

      if (!out.ok) {
        if (out.reason === "forbidden") {
          return res.status(403).json({
            error: "Device is not a member of this room",
            reason: "forbidden",
          });
        }
        if (out.reason === "deleted") {
          return res.status(410).json({ error: "Room was deleted", reason: "deleted" });
        }
        if (out.reason === "not_found") {
          return res.status(404).json({ error: "Room not found", reason: "not_found" });
        }
        if (out.reason === "room_not_active") {
          return res.status(409).json({
            error: "Room is not active",
            reason: "room_not_active",
          });
        }
        if (out.reason === "session_metadata_mismatch") {
          return res.status(403).json({
            error: "This Checkout session does not belong to this room/device",
            reason: "session_metadata_mismatch",
          });
        }
        if (out.reason === "session_not_found") {
          return res.status(404).json({
            error: "Checkout session not found in Stripe",
            reason: "session_not_found",
          });
        }
        if (out.reason === "invalid_session_id") {
          return res.status(400).json({
            error: "Invalid Checkout session id (expected cs_…)",
            reason: "invalid_session_id",
          });
        }
        return res.status(out.httpStatus || 400).json({
          error: "Could not load checkout session status",
          reason: out.reason,
        });
      }

      const { ok: _ok2, ...body } = out;
      return res.status(200).json(body);
    } catch (err) {
      console.error(
        "Error in GET /v2/rooms/:roomId/billing/checkout-session/:sessionId:",
        err
      );
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ---------- Metrics routes ----------

// Record that a user tapped the camera icon in the app
app.post("/metrics/camera-click", (req, res) => {
  try {
    const { deviceId } = req.body || {};
    metrics.cameraClicks += 1;
    if (deviceId && typeof deviceId === "string") {
      metrics.devices.add(deviceId);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error in /metrics/camera-click:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Get basic stats about usage
app.get("/metrics/stats", (req, res) => {
  try {
    const activeSessions = store.rooms.countActiveRoomsV1();

    return res.json({
      cameraClicks: metrics.cameraClicks,
      sessionsCreated: metrics.sessionsCreated,
      activeSessions,
      approximateUsers: metrics.devices.size,
    });
  } catch (err) {
    console.error("Error in /metrics/stats:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Start server ----------

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  console.log(`🔥 Burner Link server listening on port ${PORT}`);
});
