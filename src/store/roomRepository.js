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

const MAX_V1_DEVICES_PER_ROOM = 2;
const INVITE_ROTATE_MAX_ATTEMPTS = 25;

function nowMs() {
  return Date.now();
}

function mapMessageRow(row) {
  return {
    id: row.id,
    senderId: row.sender_id,
    type: row.msg_type === "image" ? "image" : "text",
    encrypted: { ciphertext: row.ciphertext, nonce: row.nonce },
    fileName: row.file_name,
  };
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
 * @param {{ membership?: object|null }} [opts]
 */
function createRoomRepository(db, opts = {}) {
  const membership = opts.membership || null;

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
            last_message_at, schema_version, retention_tier, retention_until, retention_source
     FROM rooms WHERE id = ?`
  );

  const stmtActiveRoomIdByCode = db.prepare(
    `SELECT id FROM rooms
     WHERE invite_code = ? AND state = 'active' AND deleted_at IS NULL
     ORDER BY created_at ASC
     LIMIT 1`
  );

  const insertRoom = db.prepare(
    `INSERT INTO rooms (id, invite_code, state, created_at, updated_at, last_message_at,
            retention_tier, retention_until, retention_source)
     VALUES (@id, @invite_code, 'active', @created_at, @updated_at, @last_message_at,
            'default', NULL, 'server_default')`
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
    `INSERT INTO room_members (room_id, device_id, joined_at, last_seen_at)
     VALUES (@room_id, @device_id, @joined_at, @last_seen_at)
     ON CONFLICT(room_id, device_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at`
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
            last_message_at = NULL
     WHERE id = @id AND state = 'active'`
  );

  const updateRoomLastMessage = db.prepare(
    `UPDATE rooms SET last_message_at = @last_message_at, updated_at = @updated_at
     WHERE id = @id AND state = 'active'`
  );

  const insertMessage = db.prepare(
    `INSERT INTO room_messages (id, room_id, sender_id, msg_type, ciphertext, nonce, file_name, created_at)
     VALUES (@id, @room_id, @sender_id, @msg_type, @ciphertext, @nonce, @file_name, @created_at)`
  );

  const selectMessages = db.prepare(
    `SELECT id, sender_id, msg_type, ciphertext, nonce, file_name, created_at
     FROM room_messages WHERE room_id = ? ORDER BY created_at ASC, id ASC`
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
      r.retention_tier,
      r.retention_until,
      r.retention_source,
      (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count,
      (SELECT COUNT(*) FROM room_messages msg WHERE msg.room_id = r.id) AS message_count
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

  function findActiveRoomIdByInviteCode(inviteCode) {
    const row = stmtActiveRoomIdByCode.get(inviteCode);
    return row ? row.id : null;
  }

  /**
   * @returns {{ ok: true, roomId: string } | { ok: false, reason: 'not_found' | 'full' }}
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
        if (n >= MAX_V1_DEVICES_PER_ROOM) {
          return { ok: false, reason: "full" };
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

    const t = nowMs();
    const tx = db.transaction(() => {
      deleteMessages.run(roomId);
      deleteMembers.run(roomId);
      updateRoomEnded.run({ id: roomId, ended_at: t, updated_at: t });
    });
    tx();
    return { kind: "ended" };
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
      const tx2 = db.transaction(() => {
        deleteMessages.run(roomId);
        deleteMembers.run(roomId);
        updateRoomEnded.run({ id: roomId, ended_at: now, updated_at: now });
        // device_room_links intentionally retained for CONNECT room list.
      });
      tx2();
      return { ok: true, ended: true };
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
  }) {
    const room = stmtRoomById.get(roomId);
    if (!room || room.state !== "active" || room.deleted_at != null) {
      return { ok: false };
    }

    const t = nowMs();
    const tx = db.transaction(() => {
      insertMessage.run({
        id: messageId,
        room_id: roomId,
        sender_id: senderId,
        msg_type: type === "image" ? "image" : "text",
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        file_name: fileName,
        created_at: t,
      });
      updateRoomLastMessage.run({
        id: roomId,
        last_message_at: t,
        updated_at: t,
      });
      if (senderId && senderId !== "unknown") {
        linkDeviceToRoom(roomId, senderId, t);
      }
    });
    tx();

    return {
      ok: true,
      message: {
        id: messageId,
        senderId,
        type: type === "image" ? "image" : "text",
        encrypted,
        fileName,
      },
    };
  }

  /**
   * V2 message write: requires `device_room_links` (unlike V1 POST /messages which is sessionId-only).
   * Optional `senderId` must match `deviceId` when provided; default sender is `deviceId`.
   */
  function appendMessageForLinkedDevice({
    roomId,
    deviceId,
    messageId,
    senderId,
    type,
    encrypted,
    fileName,
  }) {
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
    });
    if (!out.ok) {
      return { ok: false, reason: "inactive" };
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
   * @param {{ deviceId: string, status?: string }} p
   */
  function listRoomsForDevice(p) {
    const status = normalizeListStatus(p.status);
    const rows = selectRoomsForDevice.all({
      device_id: p.deviceId,
      status,
    });
    return rows.map((row) => {
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
      };
    });
  }

  /**
   * @returns {{ ok: false, reason: 'not_found'|'forbidden' } | { ok: true, room: object }}
   */
  function getRoomDetailForDevice(roomId, deviceId) {
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

    const bridge = openChatInviteContract(room);

    return {
      ok: true,
      room: {
        id: room.id,
        roomId: room.id,
        v1SessionId: room.id,
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
  };
}

module.exports = {
  createRoomRepository,
  MAX_V1_DEVICES_PER_ROOM,
  ALLOWED_RETENTION_TIERS,
  ALLOWED_BILLING_TIERS,
};
