/**
 * CONNECT LiveKit access tokens (Phase Call-Arch-2).
 * Voice-only, 1:1; no billing here — use call-charge/start + settle separately.
 *
 * @see docs/connect-livekit-token.md
 */

const crypto = require("crypto");
const { AccessToken, TrackSource } = require("livekit-server-sdk");
const { normalizeCallSessionId } = require("./connectCallBilling");

const MAX_ROOM_ID_LEN = 128;

/**
 * @returns {{ url: string, apiKey: string, apiSecret: string } | null}
 */
function getLiveKitConfigFromEnv() {
  const url = String(process.env.LIVEKIT_URL || "").trim();
  const apiKey = String(process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = String(process.env.LIVEKIT_API_SECRET || "").trim();
  if (!url || !apiKey || !apiSecret) {
    return null;
  }
  return {
    url: normalizeLiveKitWsUrl(url),
    apiKey,
    apiSecret,
  };
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeLiveKitWsUrl(raw) {
  return raw.replace(/\/+$/, "");
}

/**
 * Stable, unguessable LiveKit room name for this CONNECT room + call attempt.
 * Both peers pass the same `roomId` + `callSessionId` → same `roomName`.
 *
 * @param {string} roomId
 * @param {string} callSessionId
 * @returns {string}
 */
function deriveLiveKitRoomName(roomId, callSessionId) {
  const h = crypto
    .createHash("sha256")
    .update(String(roomId), "utf8")
    .update("\n", "utf8")
    .update(String(callSessionId), "utf8")
    .digest("hex");
  return `cl${h.slice(0, 40)}`;
}

/**
 * Opaque LiveKit participant identity (does not expose raw deviceId to peers as plaintext).
 *
 * @param {string} roomId
 * @param {string} callSessionId
 * @param {string} deviceId
 * @returns {string}
 */
function deriveOpaqueParticipantIdentity(roomId, callSessionId, deviceId) {
  const hex = crypto
    .createHash("sha256")
    .update("lkid|", "utf8")
    .update(String(roomId), "utf8")
    .update("|", "utf8")
    .update(String(callSessionId), "utf8")
    .update("|", "utf8")
    .update(String(deviceId), "utf8")
    .digest("hex");
  return `p_${hex.slice(0, 36)}`;
}

/**
 * @returns {number} seconds
 */
function tokenTtlSeconds() {
  const raw = process.env.LIVEKIT_TOKEN_TTL_SECONDS;
  if (raw === undefined || raw === "") {
    return 600;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 60 || n > 86400) {
    return 600;
  }
  return Math.floor(n);
}

/**
 * @param {*} rooms — `createRoomRepository` API
 * @param {Record<string, unknown>} body
 * @returns {Promise<{ status: number, json: Record<string, unknown> }>}
 */
async function processLivekitTokenRequest(rooms, body) {
  const raw = body && typeof body === "object" ? body : {};
  const cfg = getLiveKitConfigFromEnv();
  if (!cfg) {
    return {
      status: 503,
      json: {
        error:
          "LiveKit is not configured (set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)",
        reason: "livekit_not_configured",
      },
    };
  }

  const deviceId = typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    return {
      status: 400,
      json: { error: "Missing or invalid deviceId", reason: "invalid_device" },
    };
  }

  const roomId = typeof raw.roomId === "string" ? raw.roomId.trim() : "";
  if (!roomId || roomId.length > MAX_ROOM_ID_LEN) {
    return {
      status: 400,
      json: { error: "Missing or invalid roomId", reason: "invalid_room_id" },
    };
  }

  const callSessionId = normalizeCallSessionId(raw.callSessionId);
  if (!callSessionId) {
    return {
      status: 400,
      json: {
        error: "Missing or invalid callSessionId",
        reason: "invalid_call_session_id",
      },
    };
  }

  const callType = typeof raw.callType === "string" ? raw.callType.trim() : "";
  if (callType !== "voice") {
    return {
      status: 400,
      json: {
        error: "Only callType voice is supported",
        reason: "unsupported_call_type",
      },
    };
  }

  const detail = rooms.getRoomDetailForDevice(roomId, deviceId);
  if (!detail.ok) {
    if (detail.reason === "forbidden") {
      return {
        status: 403,
        json: {
          error: "Device is not linked to this room",
          reason: "forbidden",
        },
      };
    }
    if (detail.reason === "deleted") {
      return {
        status: 410,
        json: { error: "Room was deleted", reason: "deleted" },
      };
    }
    return {
      status: 404,
      json: { error: "Room not found", reason: "not_found" },
    };
  }

  if (detail.room.state !== "active") {
    return {
      status: 409,
      json: {
        error: "Room is not active",
        reason: "room_not_active",
      },
    };
  }

  const memberCount = detail.room.memberCount;
  if (typeof memberCount !== "number" || memberCount < 2) {
    return {
      status: 403,
      json: {
        error:
          "Both peers must have joined this CONNECT room before starting a call",
        reason: "room_not_ready_for_call",
      },
    };
  }

  const roomName = deriveLiveKitRoomName(roomId, callSessionId);
  const identity = deriveOpaqueParticipantIdentity(
    roomId,
    callSessionId,
    deviceId
  );
  const ttlSec = tokenTtlSeconds();
  const ttlMs = ttlSec * 1000;

  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
    identity,
    ttl: ttlSec,
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: [TrackSource.MICROPHONE],
  });

  let token;
  try {
    token = await at.toJwt();
  } catch (_e) {
    return {
      status: 500,
      json: {
        error: "Could not mint LiveKit token",
        reason: "token_mint_failed",
      },
    };
  }

  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  return {
    status: 200,
    json: {
      token,
      url: cfg.url,
      roomName,
      expiresAt,
      callSessionId,
      callType: "voice",
    },
  };
}

module.exports = {
  getLiveKitConfigFromEnv,
  normalizeLiveKitWsUrl,
  deriveLiveKitRoomName,
  deriveOpaqueParticipantIdentity,
  processLivekitTokenRequest,
  MAX_ROOM_ID_LEN,
};
