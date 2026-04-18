/**
 * Room repository — internal CONNECT-shaped persistence for what V1 calls a "session".
 *
 * Canonical id: `rooms.id` === every V1 `sessionId` === every V2 path `roomId`
 * (same string; see docs/v1-v2-id-contract.md).
 */

const crypto = require("crypto");
const {
  buildRetentionView,
  normalizeRetentionSource,
  computeCanExtendRetention,
} = require("../retentionContract");
const { getConnectMemberIncludedRetentionTier } = require("../connectMemberRetention");
const {
  validateEncryptedMessageContent,
} = require("../messagePayloadLimits");
const {
  normalizeRoomKind,
  effectiveJoinMemberCap,
  parseGroupMemberCap,
  groupRoomsRequirePro,
  mutualSaveApplicableForRoom,
} = require("../groupRoomPolicy");

/** Legacy alias: direct (1:1) rooms always cap at 2 members. */
const MAX_V1_DEVICES_PER_ROOM = 2;
const INVITE_ROTATE_MAX_ATTEMPTS = 25;

/** Default window for pending save requests (overridable via MUTUAL_SAVE_PENDING_MS). */
const SAVE_PENDING_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;

function savePendingDurationMs() {
  const n = Number(process.env.MUTUAL_SAVE_PENDING_MS);
  return Number.isFinite(n) && n > 0 ? n : SAVE_PENDING_MS_DEFAULT;
}

function nowMs() {
  return Date.now();
}

function mapMessageRow(row) {
  const mt = row.msg_type;
  let type = "text";
  if (mt === "image" || mt === "video" || mt === "file") {
    type = mt;
  } else if (mt === "screenshot_event") {
    type = "screenshot_event";
  } else if (mt === "text") {
    type = "text";
  }
  const out = {
    id: row.id,
    senderId: row.sender_id,
    type,
    encrypted: { ciphertext: row.ciphertext, nonce: row.nonce },
    fileName: row.file_name,
  };
  if (
    row.attachment_id &&
    row.att_mime_type != null &&
    row.att_kind != null
  ) {
    out.attachment = {
      id: row.attachment_id,
      kind: row.att_kind,
      mimeType: row.att_mime_type,
      sizeBytes: row.att_size_bytes,
      originalFilename: row.att_original_filename,
    };
  }
  return out;
}

function toIso(ms) {
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

/** @param {'all'|'active'|'ended'} status */
function normalizeListStatus(status) {
  if (status === "active" || status === "ended") return status;
  return "all";
}

function randomSixDigitCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/** Current `rooms.invite_code` is always intended to be 6 digits (V1 create/join). */
function isValidSixDigitInviteCode(s) {
  return typeof s === "string" && /^\d{6}$/.test(s);
}

/**
 * Open-chat bridge (V2 → V1 live chat): requires active room + machine-readable 6-digit code.
 * @param {{ state: string, invite_code: string, deleted_at?: number | null }} room
 */
function openChatInviteContract(room) {
  const deleted = room.deleted_at != null;
  const active = room.state === "active" && !deleted;
  const codeOk = isValidSixDigitInviteCode(room.invite_code);

  if (active && codeOk) {
    return {
      openChatInviteAvailable: true,
      openChatInviteUnavailableReason: null,
    };
  }
  if (active && !codeOk) {
    return {
      openChatInviteAvailable: false,
      openChatInviteUnavailableReason: "invalid_invite_code_shape",
    };
  }
  return {
    openChatInviteAvailable: false,
    openChatInviteUnavailableReason: "room_not_active",
  };
}

/** Room-level paid retention tiers (Phase 17). Message TTL enforcement comes later. */
const ALLOWED_RETENTION_TIERS = new Set([
  "default",
  "7_days",
  "30_days",
  "permanent",
]);

/** Verified billing webhook may only grant paid-like tiers (Phase 20). */
const ALLOWED_BILLING_TIERS = new Set(["7_days", "30_days", "permanent"]);

const TIER_RANK = Object.freeze({
  default: 0,
  "7_days": 1,
  "30_days": 2,
  permanent: 3,
});

function tierRank(tier) {
  return TIER_RANK[tier] ?? 0;
}

function retentionUntilForTier(tier, nowMs) {
  switch (tier) {
    case "default":
      return null;
    case "7_days":
      return nowMs + 7 * 86400000;
    case "30_days":
      return nowMs + 30 * 86400000;
    case "permanent":
      return null;
    default:
      return null;
  }
}

function parseRetentionUntilInput(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Date.parse(raw);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

function retentionView(room) {
  return buildRetentionView(room, { toIso });
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ membership?: object|null, attachments?: object|null }} [opts]
 */
function createRoomRepository(db, opts = {}) {
  const membership = opts.membership || null;
  const attachments = opts.attachments || null;

  /**
   * Effective retention for API responses: CONNECT membership includes a minimum paid tier without coins.
   * @param {object} room rooms row or list row shape with retention_* fields
   * @param {string} deviceId
   */
  function retentionViewForDevice(room, deviceId) {
    const base = retentionView(room);
    const dev = typeof deviceId === "string" ? deviceId.trim() : "";
    if (!membership || !dev || !membership.isDeviceMember(dev)) {
      return base;
    }

    const inc = getConnectMemberIncludedRetentionTier();
    if (!ALLOWED_RETENTION_TIERS.has(inc)) {
      return { ...base, connectMembershipActive: true };
    }

    const curTier = room.retention_tier || "default";
    if (tierRank(inc) <= tierRank(curTier)) {
      return { ...base, connectMembershipActive: true };
    }

    const now = nowMs();
    const until = retentionUntilForTier(inc, now);
    return {
      ...base,
      retentionTier: inc,
      retentionUntil: toIso(until),
      retentionSource: normalizeRetentionSource("connect_membership"),
      isPaidRetention: inc !== "default",
      canExtendRetention: computeCanExtendRetention({
        ...room,
        retention_tier: inc,
      }),
      connectMembershipActive: true,
    };
  }

  const stmtRoomById = db.prepare(
    `SELECT id, invite_code, state, created_at, updated_at, ended_at, deleted_at,
            last_message_at, schema_version, retention_tier, retention_until, retention_source,
            save_state, save_requested_by_device_id, save_requested_at, save_responded_at,
            save_pending_expires_at, room_kind, member_cap
     FROM rooms WHERE id = ?`
  );

  /**
   * If a pending save request passed its expiry, clear back to none (no session end).
   */
  const expireStalePendingSave = db.prepare(
    `UPDATE rooms SET
        save_state = 'none',
        save_requested_by_device_id = NULL,
        save_requested_at = NULL,
        save_pending_expires_at = NULL,
        updated_at = @updated_at
     WHERE id = @id AND save_state = 'pending'
       AND save_pending_expires_at IS NOT NULL
       AND save_pending_expires_at < @now`
  );

  /** Clears expired pending rows in one pass (list/detail reads). */
  const expireAllStalePendingSaves = db.prepare(
    `UPDATE rooms SET
        save_state = 'none',
        save_requested_by_device_id = NULL,
        save_requested_at = NULL,
        save_pending_expires_at = NULL,
        updated_at = @updated_at
     WHERE save_state = 'pending'
       AND save_pending_expires_at IS NOT NULL
       AND save_pending_expires_at < @now`
  );

  const stmtActiveRoomIdByCode = db.prepare(
    `SELECT id FROM rooms
     WHERE invite_code = ? AND state = 'active' AND deleted_at IS NULL
     ORDER BY created_at ASC
     LIMIT 1`
  );

  const insertRoom = db.prepare(
    `INSERT INTO rooms (id, invite_code, state, created_at, updated_at, last_message_at,
            retention_tier, retention_until, retention_source, room_kind, member_cap)
     VALUES (@id, @invite_code, 'active', @created_at, @updated_at, @last_message_at,
            'default', NULL, 'server_default', @room_kind, @member_cap)`
  );

  const insertRetentionPurchase = db.prepare(
    `INSERT INTO retention_purchases (id, room_id, device_id, tier, retention_until, source, note, external_ref, idempotency_provider, idempotency_key, created_at)
     VALUES (@id, @room_id, @device_id, @tier, @retention_until, @source, @note, @external_ref, @idempotency_provider, @idempotency_key, @created_at)`
  );

  const stmtFindIdempotentRetention = db.prepare(
    `SELECT id FROM retention_purchases WHERE idempotency_provider = ? AND idempotency_key = ?`
  );

  const updateRoomRetention = db.prepare(
    `UPDATE rooms SET retention_tier = @retention_tier, retention_until = @retention_until,
            retention_source = @retention_source, updated_at = @updated_at
     WHERE id = @id`
  );

  const upsertMember = db.prepare(
    `INSERT INTO room_members (room_id, device_id, joined_at, last_seen_at, last_live_chat_left_at)
     VALUES (@room_id, @device_id, @joined_at, @last_seen_at, NULL)
     ON CONFLICT(room_id, device_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       last_live_chat_left_at = NULL`
  );

  const updateMemberLiveChatLeave = db.prepare(
    `UPDATE room_members SET last_live_chat_left_at = @t WHERE room_id = @room_id AND device_id = @device_id`
  );

  const insertMemberMinimal = db.prepare(
    `INSERT INTO room_members (room_id, device_id, joined_at, last_seen_at, last_live_chat_left_at)
     VALUES (@room_id, @device_id, @joined_at, @last_seen_at, @left_at)`
  );

  const clearMemberLiveChatLeave = db.prepare(
    `UPDATE room_members SET last_live_chat_left_at = NULL WHERE room_id = ? AND device_id = ?`
  );

  const countDistinctMembers = db.prepare(
    `SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?`
  );

  const listMemberSeen = db.prepare(
    `SELECT device_id, last_seen_at FROM room_members WHERE room_id = ?`
  );

  const deleteMembers = db.prepare(
    `DELETE FROM room_members WHERE room_id = ?`
  );

  const deleteMessages = db.prepare(
    `DELETE FROM room_messages WHERE room_id = ?`
  );

  const updateRoomEnded = db.prepare(
    `UPDATE rooms SET state = 'ended', ended_at = @ended_at, updated_at = @updated_at,
            last_message_at = NULL,
            save_state = 'none',
            save_requested_by_device_id = NULL,
            save_requested_at = NULL,
            save_responded_at = NULL,
            save_pending_expires_at = NULL
     WHERE id = @id AND state = 'active'`
  );

  const updateRoomLastMessage = db.prepare(
    `UPDATE rooms SET last_message_at = @last_message_at, updated_at = @updated_at
     WHERE id = @id AND state = 'active'`
  );

  const insertMessage = db.prepare(
    `INSERT INTO room_messages (id, room_id, sender_id, msg_type, ciphertext, nonce, file_name, created_at, attachment_id)
     VALUES (@id, @room_id, @sender_id, @msg_type, @ciphertext, @nonce, @file_name, @created_at, @attachment_id)`
  );

  const selectMessages = db.prepare(
    `SELECT m.id, m.sender_id, m.msg_type, m.ciphertext, m.nonce, m.file_name, m.created_at, m.attachment_id,
            a.kind AS att_kind, a.mime_type AS att_mime_type, a.size_bytes AS att_size_bytes,
            a.original_filename AS att_original_filename
     FROM room_messages m
     LEFT JOIN room_attachments a ON m.attachment_id = a.id
     WHERE m.room_id = ?
     ORDER BY m.created_at ASC, m.id ASC`
  );

  const countActiveRooms = db.prepare(
    `SELECT COUNT(*) AS c FROM rooms WHERE state = 'active' AND deleted_at IS NULL`
  );

  const updateRoomSoftDelete = db.prepare(
    `UPDATE rooms SET deleted_at = @deleted_at, updated_at = @updated_at
     WHERE id = @id AND deleted_at IS NULL`
  );

  const updateRoomReopen = db.prepare(
    `UPDATE rooms SET state = 'active', ended_at = NULL, updated_at = @updated_at
     WHERE id = @id AND state = 'ended' AND deleted_at IS NULL`
  );

  const updateRoomInviteCode = db.prepare(
    `UPDATE rooms SET invite_code = @invite_code, updated_at = @updated_at
     WHERE id = @id AND state = 'active' AND deleted_at IS NULL`
  );

  const stmtInviteTakenByOtherActive = db.prepare(
    `SELECT 1 AS ok FROM rooms
     WHERE invite_code = ? AND state = 'active' AND deleted_at IS NULL AND id != ?`
  );

  const insertDeviceRoomLink = db.prepare(
    `INSERT INTO device_room_links (room_id, device_id, linked_at)
     VALUES (@room_id, @device_id, @linked_at)
     ON CONFLICT(room_id, device_id) DO NOTHING`
  );

  const hasDeviceRoomLink = db.prepare(
    `SELECT 1 AS ok FROM device_room_links WHERE room_id = ? AND device_id = ?`
  );

  const selectRoomsForDevice = db.prepare(`
    SELECT
      r.id,
      r.invite_code,
      r.state,
      r.created_at,
      r.updated_at,
      r.ended_at,
      r.last_message_at,
      r.room_kind,
      r.member_cap,
      r.retention_tier,
      r.retention_until,
      r.retention_source,
      r.save_state,
      r.save_requested_by_device_id,
      r.save_requested_at,
      r.save_responded_at,
      r.save_pending_expires_at,
      (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count,
      (SELECT COUNT(*) FROM room_messages msg WHERE msg.room_id = r.id) AS message_count,
      (SELECT rm2.last_seen_at FROM room_members rm2
        WHERE rm2.room_id = r.id AND rm2.device_id = @device_id) AS my_last_seen_at,
      (SELECT rm3.last_live_chat_left_at FROM room_members rm3
        WHERE rm3.room_id = r.id AND rm3.device_id = @device_id) AS my_last_live_chat_left_at
    FROM rooms r
    INNER JOIN device_room_links d ON d.room_id = r.id AND d.device_id = @device_id
    WHERE r.deleted_at IS NULL
      AND (
        @status = 'all'
        OR (@status = 'active' AND r.state = 'active')
        OR (@status = 'ended' AND r.state = 'ended')
      )
    ORDER BY r.updated_at DESC, r.id DESC
  `);

  function normalizeSaveStateRaw(raw) {
    if (raw === "pending" || raw === "mutual") return raw;
    return "none";
  }

  /**
   * Compact mutual-save view for GET list/detail. `mutualSaveFeatureEnabled` mirrors env MUTUAL_SAVE_ENABLED.
   * When false, clients only see { enabled: false, state: "none" } — no server save semantics exposed.
   */
  function buildSavePayload(room, viewerDeviceId, mutualSaveFeatureEnabled) {
    const dev = typeof viewerDeviceId === "string" ? viewerDeviceId.trim() : "";
    if (!mutualSaveApplicableForRoom(room, mutualSaveFeatureEnabled)) {
      return { enabled: false, state: "none" };
    }
    if (!room) {
      return { enabled: true, state: "none" };
    }
    const st = normalizeSaveStateRaw(room.save_state);
    const reqBy = room.save_requested_by_device_id || null;
    let myAction = "none";
    if (st === "mutual") {
      myAction = "mutual";
    } else if (st === "pending") {
      if (reqBy && dev && reqBy === dev) {
        myAction = "requested";
      } else if (reqBy && dev && reqBy !== dev) {
        myAction = "can_respond";
      }
    }
    let peerAction = "none";
    if (st === "pending" && reqBy && dev) {
      peerAction = reqBy === dev ? "awaiting_peer" : "pending_incoming";
    } else if (st === "mutual") {
      peerAction = "mutual";
    }
    return {
      enabled: true,
      state: st,
      requestedByDeviceId: reqBy,
      requestedAt: toIso(room.save_requested_at),
      respondedAt: toIso(room.save_responded_at),
      pendingExpiresAt: toIso(room.save_pending_expires_at),
      myAction,
      peerAction,
    };
  }

  /**
   * Viewer-scoped presence for list/detail: heartbeat vs explicit leave-live-chat.
   */
  function buildMyPresencePayload(row) {
    const seen = row.my_last_seen_at;
    const left = row.my_last_live_chat_left_at;
    let likelyActiveInLiveChat = true;
    if (left != null) {
      if (seen == null || seen <= left) {
        likelyActiveInLiveChat = false;
      }
    }
    return {
      lastSeenAt: toIso(seen),
      lastLiveChatLeftAt: toIso(left),
      likelyActiveInLiveChat,
    };
  }

  /**
   * POST /v2/rooms/:roomId/leave — device left live chat UI; room stays active (not POST /sessions/end).
   */
  function leaveLiveChatForLinkedDevice(roomId, deviceId) {
    const dev = typeof deviceId === "string" ? deviceId.trim() : "";
    if (!dev) {
      return { ok: false, reason: "invalid_device" };
    }
    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "not_found" };
    }
    if (room.deleted_at != null) {
      if (hasDeviceRoomLink.get(roomId, dev)) {
        return { ok: false, reason: "deleted" };
      }
      return { ok: false, reason: "not_found" };
    }
    if (!hasDeviceRoomLink.get(roomId, dev)) {
      return { ok: false, reason: "forbidden" };
    }
    if (room.state !== "active") {
      return { ok: false, reason: "room_not_active" };
    }

    const t = nowMs();
    const n = updateMemberLiveChatLeave.run({
      t,
      room_id: roomId,
      device_id: dev,
    }).changes;
    if (n === 0) {
      const link = db
        .prepare(
          `SELECT linked_at FROM device_room_links WHERE room_id = ? AND device_id = ?`
        )
        .get(roomId, dev);
      const ja = link && link.linked_at != null ? link.linked_at : t;
      insertMemberMinimal.run({
        room_id: roomId,
        device_id: dev,
        joined_at: ja,
        last_seen_at: null,
        left_at: t,
      });
    }
    db.prepare(`UPDATE rooms SET updated_at = ? WHERE id = ?`).run(t, roomId);
    return { ok: true, lastLiveChatLeftAt: toIso(t) };
  }

  const updateSaveToPending = db.prepare(
    `UPDATE rooms SET
        save_state = 'pending',
        save_requested_by_device_id = @save_requested_by_device_id,
        save_requested_at = @save_requested_at,
        save_responded_at = NULL,
        save_pending_expires_at = @save_pending_expires_at,
        updated_at = @updated_at
     WHERE id = @id AND state = 'active' AND deleted_at IS NULL AND save_state = 'none'`
  );

  const updateSaveToMutualFromPending = db.prepare(
    `UPDATE rooms SET
        save_state = 'mutual',
        save_requested_by_device_id = NULL,
        save_requested_at = NULL,
        save_responded_at = @save_responded_at,
        save_pending_expires_at = NULL,
        updated_at = @updated_at
     WHERE id = @id AND save_state = 'pending'`
  );

  const updateSaveDeclineFromPending = db.prepare(
    `UPDATE rooms SET
        save_state = 'none',
        save_requested_by_device_id = NULL,
        save_requested_at = NULL,
        save_responded_at = @save_responded_at,
        save_pending_expires_at = NULL,
        updated_at = @updated_at
     WHERE id = @id AND save_state = 'pending'`
  );

  /**
   * POST /v2/rooms/:roomId/save/request — 1:1 only; both devices must be in room_members.
   * @returns {object} result with ok / reason / save
   */
  function requestMutualSaveForDevice(roomId, deviceId) {
    const dev = typeof deviceId === "string" ? deviceId.trim() : "";
    if (!dev) {
      return { ok: false, reason: "invalid_device" };
    }

    const t = nowMs();
    expireAllStalePendingSaves.run({ now: t, updated_at: t });

    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "not_found" };
    }
    if (room.deleted_at != null) {
      if (hasDeviceRoomLink.get(roomId, dev)) {
        return { ok: false, reason: "deleted" };
      }
      return { ok: false, reason: "not_found" };
    }
    if (!hasDeviceRoomLink.get(roomId, dev)) {
      return { ok: false, reason: "forbidden" };
    }
    if (room.state !== "active") {
      return { ok: false, reason: "room_not_active" };
    }

    if (normalizeRoomKind(room.room_kind) === "group") {
      return { ok: false, reason: "group_mutual_save_unsupported" };
    }

    const nMembers = countDistinctMembers.get(roomId).c;
    if (nMembers !== MAX_V1_DEVICES_PER_ROOM) {
      return { ok: false, reason: "need_two_participants" };
    }

    const st = normalizeSaveStateRaw(room.save_state);
    if (st === "mutual") {
      return {
        ok: true,
        alreadyMutual: true,
        save: buildSavePayload(room, dev, true),
      };
    }
    if (st === "pending") {
      if (room.save_requested_by_device_id === dev) {
        const r2 = stmtRoomById.get(roomId);
        return {
          ok: true,
          idempotent: true,
          save: buildSavePayload(r2, dev, true),
        };
      }
      return { ok: false, reason: "already_pending" };
    }

    const exp = t + savePendingDurationMs();
    const n = updateSaveToPending.run({
      id: roomId,
      save_requested_by_device_id: dev,
      save_requested_at: t,
      save_pending_expires_at: exp,
      updated_at: t,
    }).changes;
    if (n === 0) {
      const r3 = stmtRoomById.get(roomId);
      const st2 = normalizeSaveStateRaw(r3.save_state);
      if (st2 === "mutual") {
        return {
          ok: true,
          alreadyMutual: true,
          save: buildSavePayload(r3, dev, true),
        };
      }
      if (st2 === "pending" && r3.save_requested_by_device_id === dev) {
        return {
          ok: true,
          idempotent: true,
          save: buildSavePayload(r3, dev, true),
        };
      }
      return { ok: false, reason: "race_or_invalid_state" };
    }
    const refreshed = stmtRoomById.get(roomId);
    return { ok: true, save: buildSavePayload(refreshed, dev, true) };
  }

  /**
   * POST /v2/rooms/:roomId/save/respond — only the non-requesting participant may respond.
   */
  function respondMutualSaveForDevice(roomId, deviceId, decision) {
    const dev = typeof deviceId === "string" ? deviceId.trim() : "";
    if (!dev) {
      return { ok: false, reason: "invalid_device" };
    }
    const dec = decision === "accept" || decision === "decline" ? decision : null;
    if (!dec) {
      return { ok: false, reason: "invalid_decision" };
    }

    const t = nowMs();
    expireAllStalePendingSaves.run({ now: t, updated_at: t });

    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "not_found" };
    }
    if (room.deleted_at != null) {
      if (hasDeviceRoomLink.get(roomId, dev)) {
        return { ok: false, reason: "deleted" };
      }
      return { ok: false, reason: "not_found" };
    }
    if (!hasDeviceRoomLink.get(roomId, dev)) {
      return { ok: false, reason: "forbidden" };
    }

    if (normalizeRoomKind(room.room_kind) === "group") {
      return { ok: false, reason: "group_mutual_save_unsupported" };
    }

    const st = normalizeSaveStateRaw(room.save_state);
    if (st === "mutual") {
      return { ok: false, reason: "already_mutual" };
    }
    if (st !== "pending") {
      return { ok: false, reason: "not_pending" };
    }

    const requester = room.save_requested_by_device_id;
    if (!requester || requester === dev) {
      return { ok: false, reason: "wrong_responder" };
    }

    if (dec === "accept") {
      const n = updateSaveToMutualFromPending.run({
        id: roomId,
        save_responded_at: t,
        updated_at: t,
      }).changes;
      if (n === 0) {
        return { ok: false, reason: "not_pending" };
      }
      const refreshed = stmtRoomById.get(roomId);
      return { ok: true, save: buildSavePayload(refreshed, dev, true) };
    }

    const n = updateSaveDeclineFromPending.run({
      id: roomId,
      save_responded_at: t,
      updated_at: t,
    }).changes;
    if (n === 0) {
      return { ok: false, reason: "not_pending" };
    }
    const refreshed = stmtRoomById.get(roomId);
    return { ok: true, save: buildSavePayload(refreshed, dev, true) };
  }

  /**
   * Shape compatible with existing route logic: participants as array, active flag, etc.
   */
  function getRoomAsV1Session(roomId) {
    const room = stmtRoomById.get(roomId);
    if (!room) return null;
    // V1: soft-deleted rooms behave as absent (no chat, status 404 shape).
    if (room.deleted_at != null) return null;

    const members = listMemberSeen.all(roomId);
    const lastSeen = {};
    const participants = [];
    for (const m of members) {
      participants.push(m.device_id);
      if (m.last_seen_at != null) {
        lastSeen[m.device_id] = m.last_seen_at;
      }
    }

    const messages =
      room.state === "active"
        ? selectMessages.all(roomId).map(mapMessageRow)
        : [];

    return {
      id: room.id,
      code: room.invite_code,
      active: room.state === "active",
      participants,
      lastSeen,
      lastMessageAt: room.last_message_at,
      _row: room,
    };
  }

  function linkDeviceToRoom(roomId, deviceId, t) {
    insertDeviceRoomLink.run({
      room_id: roomId,
      device_id: deviceId,
      linked_at: t,
    });
  }

  function createRoomFromV1({ id, inviteCode, creatorDeviceId }) {
    const t = nowMs();
    const tx = db.transaction(() => {
      insertRoom.run({
        id,
        invite_code: inviteCode,
        created_at: t,
        updated_at: t,
        last_message_at: t,
        room_kind: "direct",
        member_cap: MAX_V1_DEVICES_PER_ROOM,
      });
      upsertMember.run({
        room_id: id,
        device_id: creatorDeviceId,
        joined_at: t,
        last_seen_at: t,
      });
      linkDeviceToRoom(id, creatorDeviceId, t);
    });
    tx();
  }

  /**
   * CONNECT group room (V2 only). Caller supplies a new room id and a free 6-digit invite code.
   * @returns {{ ok: true, roomId: string, roomKind: 'group', memberCap: number, inviteCode: string } | { ok: false, reason: string, min?: number, max?: number }}
   */
  function createGroupRoomFromConnect({ id, inviteCode, creatorDeviceId, memberCap }) {
    const dev =
      typeof creatorDeviceId === "string" ? creatorDeviceId.trim() : "";
    if (!dev) {
      return { ok: false, reason: "invalid_device" };
    }
    if (!isValidSixDigitInviteCode(inviteCode)) {
      return { ok: false, reason: "invalid_invite_code" };
    }
    const parsed = parseGroupMemberCap(memberCap);
    if (!parsed.ok) {
      return parsed;
    }
    if (groupRoomsRequirePro() && (!membership || !membership.isDeviceMember(dev))) {
      return { ok: false, reason: "pro_required" };
    }
    if (findActiveRoomIdByInviteCode(inviteCode)) {
      return { ok: false, reason: "invite_taken" };
    }

    const t = nowMs();
    const cap = parsed.memberCap;
    const tx = db.transaction(() => {
      insertRoom.run({
        id,
        invite_code: inviteCode,
        created_at: t,
        updated_at: t,
        last_message_at: t,
        room_kind: "group",
        member_cap: cap,
      });
      upsertMember.run({
        room_id: id,
        device_id: dev,
        joined_at: t,
        last_seen_at: t,
      });
      linkDeviceToRoom(id, dev, t);
    });
    tx();
    return {
      ok: true,
      roomId: id,
      roomKind: "group",
      memberCap: cap,
      inviteCode,
    };
  }

  function findActiveRoomIdByInviteCode(inviteCode) {
    const row = stmtActiveRoomIdByCode.get(inviteCode);
    return row ? row.id : null;
  }

  /**
   * @returns {{ ok: true, roomId: string } | { ok: false, reason: 'not_found' | 'full', roomKind?: string, memberCap?: number, memberCount?: number }}
   */
  function joinActiveRoomByCode({ inviteCode, deviceId }) {
    const roomId = findActiveRoomIdByInviteCode(inviteCode);
    if (!roomId) {
      return { ok: false, reason: "not_found" };
    }

    const t = nowMs();
    const runJoin = db.transaction(() => {
      const room = stmtRoomById.get(roomId);
      if (!room || room.state !== "active" || room.deleted_at != null) {
        return { ok: false, reason: "not_found" };
      }

      const existing = db
        .prepare(
          `SELECT 1 FROM room_members WHERE room_id = ? AND device_id = ?`
        )
        .get(roomId, deviceId);

      if (!existing) {
        const n = countDistinctMembers.get(roomId).c;
        const cap = effectiveJoinMemberCap(room);
        if (n >= cap) {
          return {
            ok: false,
            reason: "full",
            roomKind: normalizeRoomKind(room.room_kind),
            memberCap: cap,
            memberCount: n,
          };
        }
      }

      upsertMember.run({
        room_id: roomId,
        device_id: deviceId,
        joined_at: t,
        last_seen_at: t,
      });
      linkDeviceToRoom(roomId, deviceId, t);
      db.prepare(`UPDATE rooms SET updated_at = ? WHERE id = ?`).run(t, roomId);
      return { ok: true, roomId };
    });

    return runJoin();
  }

  function endRoomBurnV1(roomId) {
    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { kind: "unknown" };
    }
    if (room.deleted_at != null) {
      return { kind: "deleted" };
    }
    if (room.state !== "active") {
      return { kind: "already_ended" };
    }

    const s3KeysToDelete =
      attachments != null ? attachments.listStorageKeysForRoom(roomId) : [];

    const t = nowMs();
    const tx = db.transaction(() => {
      deleteMessages.run(roomId);
      if (attachments != null) {
        attachments.deleteByRoom.run(roomId);
      }
      deleteMembers.run(roomId);
      updateRoomEnded.run({ id: roomId, ended_at: t, updated_at: t });
    });
    tx();
    return { kind: "ended", s3KeysToDelete };
  }

  function touchHeartbeatV1({
    roomId,
    deviceId,
    offlineTimeoutMs,
    inactivityBeforeBurnMs,
    sessionHeartbeatAutoEnd,
  }) {
    const room = stmtRoomById.get(roomId);
    if (!room || room.state !== "active" || room.deleted_at != null) {
      return { ok: false, error: "not_found_or_inactive" };
    }

    const t = nowMs();
    const tx = db.transaction(() => {
      upsertMember.run({
        room_id: roomId,
        device_id: deviceId,
        joined_at: t,
        last_seen_at: t,
      });
      linkDeviceToRoom(roomId, deviceId, t);
      db.prepare(`UPDATE rooms SET updated_at = ? WHERE id = ?`).run(t, roomId);
    });
    tx();

    if (!sessionHeartbeatAutoEnd) {
      return { ok: true, ended: false };
    }

    const entries = listMemberSeen.all(roomId);
    if (entries.length < 2) {
      return { ok: true, ended: false };
    }

    const now = nowMs();
    const stale = entries.find(
      (e) =>
        e.device_id !== deviceId &&
        e.last_seen_at != null &&
        now - e.last_seen_at > offlineTimeoutMs
    );

    const refreshed = stmtRoomById.get(roomId);
    const inactiveLongEnough =
      typeof refreshed.last_message_at === "number" &&
      now - refreshed.last_message_at > inactivityBeforeBurnMs;

    if (stale && inactiveLongEnough) {
      const s3KeysToDelete =
        attachments != null ? attachments.listStorageKeysForRoom(roomId) : [];
      const tx2 = db.transaction(() => {
        deleteMessages.run(roomId);
        if (attachments != null) {
          attachments.deleteByRoom.run(roomId);
        }
        deleteMembers.run(roomId);
        updateRoomEnded.run({ id: roomId, ended_at: now, updated_at: now });
        // device_room_links intentionally retained for CONNECT room list.
      });
      tx2();
      return { ok: true, ended: true, s3KeysToDelete };
    }

    return { ok: true, ended: false };
  }

  function appendMessageV1({
    roomId,
    messageId,
    senderId,
    type,
    encrypted,
    fileName,
    attachmentId,
  }) {
    if (type === "screenshot_event") {
      if (attachmentId != null && String(attachmentId).trim() !== "") {
        return { ok: false, reason: "screenshot_event_no_attachments" };
      }
    }

    let attRow = null;
    if (attachmentId != null && String(attachmentId).trim() !== "") {
      const aid = String(attachmentId).trim();
      if (!attachments) {
        return { ok: false, reason: "attachments_not_configured" };
      }
      attRow = attachments.getById(aid);
      if (!attRow || attRow.room_id !== roomId) {
        return { ok: false, reason: "invalid_attachment" };
      }
      if (attRow.device_id !== senderId) {
        return { ok: false, reason: "invalid_attachment" };
      }
      if (attRow.status !== "ready") {
        return { ok: false, reason: "attachment_not_ready" };
      }
      if (attRow.message_id != null) {
        return { ok: false, reason: "attachment_already_linked" };
      }
      const want =
        type === "image" || type === "video" || type === "file"
          ? type
          : "text";
      if (want === "text" || attRow.kind !== want) {
        return { ok: false, reason: "attachment_type_mismatch" };
      }
    }

    const wantType =
      type === "image" || type === "video" || type === "file"
        ? type
        : type === "screenshot_event"
          ? "screenshot_event"
          : "text";
    if (
      (wantType === "video" || wantType === "file") &&
      !attRow
    ) {
      return { ok: false, reason: "attachment_required" };
    }

    const payload = validateEncryptedMessageContent(encrypted, fileName);
    if (!payload.ok) {
      return { ok: false, reason: payload.reason };
    }

    const room = stmtRoomById.get(roomId);
    if (!room || room.state !== "active" || room.deleted_at != null) {
      return { ok: false, reason: "inactive" };
    }

    const msgTypeStored = attRow
      ? attRow.kind
      : type === "screenshot_event"
        ? "screenshot_event"
        : type === "image"
          ? "image"
          : "text";

    const t = nowMs();
    const tx = db.transaction(() => {
      insertMessage.run({
        id: messageId,
        room_id: roomId,
        sender_id: senderId,
        msg_type: msgTypeStored,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        file_name: fileName,
        created_at: t,
        attachment_id: attRow ? attRow.id : null,
      });
      if (attRow) {
        const n = attachments.linkMessage.run({
          id: attRow.id,
          room_id: roomId,
          message_id: messageId,
          device_id: senderId,
        }).changes;
        if (n !== 1) {
          throw new Error("attachment_link_failed");
        }
      }
      updateRoomLastMessage.run({
        id: roomId,
        last_message_at: t,
        updated_at: t,
      });
      if (senderId && senderId !== "unknown") {
        linkDeviceToRoom(roomId, senderId, t);
        clearMemberLiveChatLeave.run(roomId, senderId);
      }
    });
    tx();

    const displayType = attRow
      ? attRow.kind
      : type === "screenshot_event"
        ? "screenshot_event"
        : type === "image"
          ? "image"
          : "text";

    return {
      ok: true,
      message: {
        id: messageId,
        senderId,
        type: displayType,
        encrypted,
        fileName,
        ...(attRow
          ? {
              attachment: {
                id: attRow.id,
                kind: attRow.kind,
                mimeType: attRow.mime_type,
                sizeBytes: attRow.size_bytes,
                originalFilename: attRow.original_filename,
              },
            }
          : {}),
      },
    };
  }

  /**
   * V2 message write: requires `device_room_links` (unlike V1 POST /messages which is sessionId-only).
   * Optional `senderId` must match `deviceId` when provided; default sender is `deviceId`.
   * @returns {{ ok: true, message: object } | { ok: false, reason: 'not_found'|'deleted'|'ended'|'forbidden'|'sender_mismatch'|'inactive'|'payload_too_large'|'invalid_payload' }}
   */
  function appendMessageForLinkedDevice({
    roomId,
    deviceId,
    messageId,
    senderId,
    type,
    encrypted,
    fileName,
    attachmentId,
  }) {
    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "not_found" };
    }
    if (room.deleted_at != null) {
      return { ok: false, reason: "deleted" };
    }
    if (room.state !== "active") {
      return { ok: false, reason: "ended" };
    }
    if (!hasDeviceRoomLink.get(roomId, deviceId)) {
      return { ok: false, reason: "forbidden" };
    }
    const dev = String(deviceId).trim();
    let effectiveSender = dev;
    if (senderId != null && String(senderId).trim() !== "") {
      if (String(senderId).trim() !== dev) {
        return { ok: false, reason: "sender_mismatch" };
      }
      effectiveSender = String(senderId).trim();
    }

    const out = appendMessageV1({
      roomId,
      messageId,
      senderId: effectiveSender,
      type,
      encrypted,
      fileName,
      attachmentId,
    });
    if (!out.ok) {
      return { ok: false, reason: out.reason };
    }
    return out;
  }

  function countActiveRoomsV1() {
    return countActiveRooms.get().c;
  }

  function newRetentionEventId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return crypto.randomBytes(16).toString("hex");
  }

  /**
   * GET retention snapshot for linked device — same shape as list/detail retention fields.
   */
  function getRetentionForLinkedDevice(roomId, deviceId) {
    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "unknown" };
    }
    if (room.deleted_at != null) {
      if (hasDeviceRoomLink.get(roomId, deviceId)) {
        return { ok: false, reason: "deleted" };
      }
      return { ok: false, reason: "unknown" };
    }
    if (!hasDeviceRoomLink.get(roomId, deviceId)) {
      return { ok: false, reason: "forbidden" };
    }
    return {
      ok: true,
      ...retentionViewForDevice(room, deviceId),
    };
  }

  /**
   * Manual retention update (dev / ops). Later: `source` from payment webhooks.
   * @param {{ note?: string|null, retentionUntil?: unknown }} opts
   */
  function setRetentionManualForLinkedDevice(roomId, deviceId, retentionTier, opts = {}) {
    if (!ALLOWED_RETENTION_TIERS.has(retentionTier)) {
      return { ok: false, reason: "invalid_tier" };
    }
    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "unknown" };
    }
    if (room.deleted_at != null) {
      if (hasDeviceRoomLink.get(roomId, deviceId)) {
        return { ok: false, reason: "deleted" };
      }
      return { ok: false, reason: "unknown" };
    }
    if (!hasDeviceRoomLink.get(roomId, deviceId)) {
      return { ok: false, reason: "forbidden" };
    }
    if (room.state !== "active") {
      return { ok: false, reason: "room_not_active" };
    }

    const now = nowMs();
    const parsed = parseRetentionUntilInput(opts.retentionUntil);
    let until = retentionUntilForTier(retentionTier, now);
    if (retentionTier === "default" || retentionTier === "permanent") {
      until = null;
    } else if (parsed !== undefined) {
      until = parsed;
    }

    const note = opts.note != null ? String(opts.note).slice(0, 2000) : null;
    let externalRef = null;
    if (opts.externalRef != null && opts.externalRef !== "") {
      const er = String(opts.externalRef).trim().slice(0, 512);
      externalRef = er || null;
    }

    const tx = db.transaction(() => {
      updateRoomRetention.run({
        id: roomId,
        retention_tier: retentionTier,
        retention_until: until,
        retention_source: normalizeRetentionSource("manual"),
        updated_at: now,
      });
      insertRetentionPurchase.run({
        id: newRetentionEventId(),
        room_id: roomId,
        device_id: deviceId,
        tier: retentionTier,
        retention_until: until,
        source: "manual",
        note,
        external_ref: externalRef,
        idempotency_provider: null,
        idempotency_key: null,
        created_at: now,
      });
    });
    tx();

    const refreshed = stmtRoomById.get(roomId);
    return {
      ok: true,
      ...retentionView(refreshed),
    };
  }

  /**
   * Verified billing entitlement (webhook). Idempotent on (idempotency_provider, idempotency_key).
   * @param {{ idempotencyProvider: string, idempotencyKey: string, roomId: string, deviceId: string, retentionTier: string, retentionUntil?: unknown, retentionSource: string, note?: string|null }} p
   */
  function applyBillingRetentionEntitlement(p) {
    const retentionTier = p.retentionTier;
    if (!ALLOWED_BILLING_TIERS.has(retentionTier)) {
      return { ok: false, reason: "invalid_tier" };
    }

    const idemProvider = String(p.idempotencyProvider).trim().toLowerCase();
    const idemKey = String(p.idempotencyKey).trim();
    if (!idemProvider || !idemKey || idemKey.length > 256) {
      return { ok: false, reason: "invalid_idempotency" };
    }

    const roomId = p.roomId;
    const deviceId = p.deviceId;
    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "unknown" };
    }
    if (room.deleted_at != null) {
      if (hasDeviceRoomLink.get(roomId, deviceId)) {
        return { ok: false, reason: "deleted" };
      }
      return { ok: false, reason: "unknown" };
    }
    if (!hasDeviceRoomLink.get(roomId, deviceId)) {
      return { ok: false, reason: "forbidden" };
    }
    if (room.state !== "active") {
      return { ok: false, reason: "room_not_active" };
    }

    if (stmtFindIdempotentRetention.get(idemProvider, idemKey)) {
      return {
        ok: true,
        duplicate: true,
        ...retentionViewForDevice(room, deviceId),
      };
    }

    const currentTier = room.retention_tier || "default";
    const curRank = tierRank(currentTier);
    const newRank = tierRank(retentionTier);

    if (newRank < curRank) {
      return { ok: false, reason: "would_downgrade" };
    }

    const now = nowMs();
    const parsed = parseRetentionUntilInput(p.retentionUntil);
    let until;

    if (retentionTier === "permanent") {
      until = null;
    } else {
      const candidate =
        parsed !== undefined ? parsed : retentionUntilForTier(retentionTier, now);
      if (newRank === curRank && currentTier !== "permanent") {
        const curUntil = room.retention_until;
        if (curUntil != null && candidate != null) {
          until = Math.max(curUntil, candidate);
        } else {
          until = candidate ?? curUntil ?? retentionUntilForTier(retentionTier, now);
        }
      } else {
        until = candidate;
      }
    }

    const src = normalizeRetentionSource(p.retentionSource);
    const note =
      p.note != null ? String(p.note).slice(0, 2000) : null;
    const externalRef = `${idemProvider}:${idemKey}`.slice(0, 512);

    const runWrite = () => {
      const tx = db.transaction(() => {
        updateRoomRetention.run({
          id: roomId,
          retention_tier: retentionTier,
          retention_until: until,
          retention_source: src,
          updated_at: now,
        });
        insertRetentionPurchase.run({
          id: newRetentionEventId(),
          room_id: roomId,
          device_id: deviceId,
          tier: retentionTier,
          retention_until: until,
          source: src,
          note,
          external_ref: externalRef,
          idempotency_provider: idemProvider,
          idempotency_key: idemKey,
          created_at: now,
        });
      });
      tx();
    };

    try {
      runWrite();
    } catch (e) {
      const code = e && e.code;
      if (
        code === "SQLITE_CONSTRAINT_UNIQUE" ||
        (e && String(e.message).includes("UNIQUE constraint failed"))
      ) {
        const r = stmtRoomById.get(roomId);
        if (r) {
          return {
            ok: true,
            duplicate: true,
            ...retentionViewForDevice(r, deviceId),
          };
        }
      }
      throw e;
    }

    const refreshed = stmtRoomById.get(roomId);
    return {
      ok: true,
      duplicate: false,
      ...retentionViewForDevice(refreshed, deviceId),
    };
  }

  /**
   * Rooms the device has ever been linked to (create/join/heartbeat), excluding soft-deleted rows.
   * @param {{ deviceId: string, status?: string, mutualSaveEnabled?: boolean }} p
   */
  function listRoomsForDevice(p) {
    const status = normalizeListStatus(p.status);
    const t = nowMs();
    expireAllStalePendingSaves.run({ now: t, updated_at: t });
    const msEnabled = p.mutualSaveEnabled === true;
    const rows = selectRoomsForDevice.all({
      device_id: p.deviceId,
      status,
    });
    return rows.map((row) => {
      const rk = normalizeRoomKind(row.room_kind);
      const cap =
        typeof row.member_cap === "number" && row.member_cap >= 2
          ? row.member_cap
          : rk === "direct"
            ? MAX_V1_DEVICES_PER_ROOM
            : 2;
      const bridge = openChatInviteContract({
        state: row.state,
        invite_code: row.invite_code,
        deleted_at: null,
      });
      const roomMini = {
        id: row.id,
        state: row.state,
        deleted_at: null,
        retention_tier: row.retention_tier,
        retention_until: row.retention_until,
        retention_source: row.retention_source,
      };
      return {
        id: row.id,
        roomId: row.id,
        // Same as id; V1 live chat sessionId (see docs/v1-v2-id-contract.md).
        v1SessionId: row.id,
        roomKind: rk,
        memberCap: cap,
        inviteCode: row.invite_code,
        state: row.state,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        endedAt: toIso(row.ended_at),
        lastMessageAt: toIso(row.last_message_at),
        memberCount: row.member_count,
        messageCount: row.message_count,
        ...retentionViewForDevice(roomMini, p.deviceId),
        ...bridge,
        save: buildSavePayload(row, p.deviceId, msEnabled),
        myPresence: buildMyPresencePayload(row),
      };
    });
  }

  /**
   * @param {{ mutualSaveEnabled?: boolean }} [opts]
   * @returns {{ ok: false, reason: 'not_found'|'forbidden' } | { ok: true, room: object }}
   */
  function getRoomDetailForDevice(roomId, deviceId, opts = {}) {
    const t = nowMs();
    expireAllStalePendingSaves.run({ now: t, updated_at: t });
    const msEnabled = opts.mutualSaveEnabled === true;

    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "not_found" };
    }
    if (room.deleted_at != null) {
      if (hasDeviceRoomLink.get(roomId, deviceId)) {
        return { ok: false, reason: "deleted" };
      }
      return { ok: false, reason: "not_found" };
    }
    if (!hasDeviceRoomLink.get(roomId, deviceId)) {
      return { ok: false, reason: "forbidden" };
    }

    const memberCount = countDistinctMembers.get(roomId).c;
    const messageCount = db
      .prepare(`SELECT COUNT(*) AS c FROM room_messages WHERE room_id = ?`)
      .get(roomId).c;

    const linkRow = db
      .prepare(
        `SELECT linked_at FROM device_room_links WHERE room_id = ? AND device_id = ?`
      )
      .get(roomId, deviceId);

    const memRow = db
      .prepare(
        `SELECT last_seen_at, last_live_chat_left_at FROM room_members WHERE room_id = ? AND device_id = ?`
      )
      .get(roomId, deviceId);

    const bridge = openChatInviteContract(room);

    const myPresence = buildMyPresencePayload({
      my_last_seen_at: memRow ? memRow.last_seen_at : null,
      my_last_live_chat_left_at: memRow ? memRow.last_live_chat_left_at : null,
    });

    const rkDetail = normalizeRoomKind(room.room_kind);
    const capDetail =
      typeof room.member_cap === "number" && room.member_cap >= 2
        ? room.member_cap
        : rkDetail === "direct"
          ? MAX_V1_DEVICES_PER_ROOM
          : 2;

    return {
      ok: true,
      room: {
        id: room.id,
        roomId: room.id,
        v1SessionId: room.id,
        roomKind: rkDetail,
        memberCap: capDetail,
        inviteCode: room.invite_code,
        state: room.state,
        createdAt: toIso(room.created_at),
        updatedAt: toIso(room.updated_at),
        endedAt: toIso(room.ended_at),
        lastMessageAt: toIso(room.last_message_at),
        memberCount,
        messageCount,
        linkedAt: linkRow ? toIso(linkRow.linked_at) : null,
        ...retentionViewForDevice(room, deviceId),
        ...bridge,
        save: buildSavePayload(room, deviceId, msEnabled),
        myPresence,
      },
    };
  }

  /**
   * @returns {{ ok: false, reason: 'not_found'|'forbidden' } | { ok: true, roomState: 'active'|'ended', messages: ReturnType<typeof mapMessageRow>[] }}
   */
  function listMessagesForDeviceRoom(roomId, deviceId) {
    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "not_found" };
    }
    if (room.deleted_at != null) {
      if (hasDeviceRoomLink.get(roomId, deviceId)) {
        return { ok: false, reason: "deleted" };
      }
      return { ok: false, reason: "not_found" };
    }
    if (!hasDeviceRoomLink.get(roomId, deviceId)) {
      return { ok: false, reason: "forbidden" };
    }
    if (room.state !== "active") {
      return { ok: true, roomState: "ended", messages: [] };
    }
    const messages = selectMessages.all(roomId).map(mapMessageRow);
    return { ok: true, roomState: "active", messages };
  }

  /**
   * CONNECT soft-delete: hides room from V2 lists; V1 behaves as missing session.
   * Irreversible via API in this phase (no undelete). Row retained for audit.
   */
  function softDeleteRoomForDevice(roomId, deviceId) {
    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "unknown" };
    }
    if (!hasDeviceRoomLink.get(roomId, deviceId)) {
      return { ok: false, reason: "forbidden" };
    }
    if (room.deleted_at != null) {
      return { ok: true, alreadyDeleted: true };
    }

    const t = nowMs();
    const n = updateRoomSoftDelete.run({
      id: roomId,
      deleted_at: t,
      updated_at: t,
    }).changes;
    if (n === 0) {
      return { ok: true, alreadyDeleted: true };
    }
    return { ok: true, deletedAt: toIso(t) };
  }

  /**
   * Reopen a V1-burned (ended) room: shell becomes active again; transcript stays empty.
   * Does not apply to soft-deleted rows.
   */
  function reopenEndedRoomForDevice(roomId, deviceId) {
    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "unknown" };
    }
    if (!hasDeviceRoomLink.get(roomId, deviceId)) {
      return { ok: false, reason: "forbidden" };
    }
    if (room.deleted_at != null) {
      return { ok: false, reason: "room_deleted" };
    }
    if (room.state !== "ended") {
      return { ok: false, reason: "not_ended" };
    }

    const t = nowMs();
    const n = updateRoomReopen.run({ id: roomId, updated_at: t }).changes;
    if (n === 0) {
      return { ok: false, reason: "not_ended" };
    }
    const refreshed = stmtRoomById.get(roomId);
    const bridge = openChatInviteContract(refreshed);
    return {
      ok: true,
      room: {
        id: refreshed.id,
        v1SessionId: refreshed.id,
        inviteCode: refreshed.invite_code,
        state: refreshed.state,
        createdAt: toIso(refreshed.created_at),
        updatedAt: toIso(refreshed.updated_at),
        endedAt: toIso(refreshed.ended_at),
        lastMessageAt: toIso(refreshed.last_message_at),
        ...bridge,
      },
    };
  }

  /**
   * New 6-digit invite code for an active, non-deleted room. Old code stops matching join lookup.
   */
  function rotateInviteCodeForDevice(roomId, deviceId) {
    const room = stmtRoomById.get(roomId);
    if (!room) {
      return { ok: false, reason: "unknown" };
    }
    if (!hasDeviceRoomLink.get(roomId, deviceId)) {
      return { ok: false, reason: "forbidden" };
    }
    if (room.deleted_at != null) {
      return { ok: false, reason: "room_deleted" };
    }
    if (room.state !== "active") {
      return { ok: false, reason: "not_active" };
    }

    const t = nowMs();
    let newCode = null;
    for (let i = 0; i < INVITE_ROTATE_MAX_ATTEMPTS; i += 1) {
      const candidate = randomSixDigitCode();
      if (!stmtInviteTakenByOtherActive.get(candidate, roomId)) {
        newCode = candidate;
        break;
      }
    }
    if (!newCode) {
      return { ok: false, reason: "code_collision" };
    }

    updateRoomInviteCode.run({
      id: roomId,
      invite_code: newCode,
      updated_at: t,
    });
    const refreshed = stmtRoomById.get(roomId);
    const bridge = openChatInviteContract(refreshed);
    return {
      ok: true,
      inviteCode: newCode,
      updatedAt: toIso(t),
      ...bridge,
    };
  }

  return {
    getRoomAsV1Session,
    createRoomFromV1,
    createGroupRoomFromConnect,
    findActiveRoomIdByInviteCode,
    joinActiveRoomByCode,
    endRoomBurnV1,
    touchHeartbeatV1,
    appendMessageV1,
    appendMessageForLinkedDevice,
    countActiveRoomsV1,
    listRoomsForDevice,
    getRoomDetailForDevice,
    listMessagesForDeviceRoom,
    softDeleteRoomForDevice,
    reopenEndedRoomForDevice,
    rotateInviteCodeForDevice,
    getRetentionForLinkedDevice,
    setRetentionManualForLinkedDevice,
    applyBillingRetentionEntitlement,
    requestMutualSaveForDevice,
    respondMutualSaveForDevice,
    leaveLiveChatForLinkedDevice,
  };
}

module.exports = {
  createRoomRepository,
  MAX_V1_DEVICES_PER_ROOM,
  ALLOWED_RETENTION_TIERS,
  ALLOWED_BILLING_TIERS,
};
