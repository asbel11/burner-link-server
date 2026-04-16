# CONNECT room lifecycle (Phase 6)

This document defines **state semantics** and **V2 write routes** on top of SQLite. V1 routes are unchanged.

**Ids:** `roomId` (V2 path) = `sessionId` (V1) = `rooms.id` — **`docs/v1-v2-id-contract.md`**.

**Open-chat invite:** list/detail **`openChatInviteAvailable`** — **`docs/v2-open-chat-invite.md`**.

## States (no separate “archived” column)

| Concept | Storage | Meaning |
|--------|---------|--------|
| **active** | `rooms.state = 'active'` AND `rooms.deleted_at IS NULL` | Chat allowed; V1 session active; join by invite code resolves this room. |
| **ended** | `rooms.state = 'ended'` | V1 **burn** (`POST /sessions/end`) cleared `room_members` and `room_messages`; tombstone kept. `ended_at` set. |
| **deleted** | `rooms.deleted_at` set (soft delete) | **CONNECT-only** hide: excluded from `GET /v2/rooms` lists; detail/messages return **410** for linked devices. **V1** treats the room as **missing** (`getRoomAsV1Session` returns null) so status/messages/heartbeat behave like unknown session. |

**Archived (not implemented):** A per-device “hide from inbox but keep server row unchanged” could use `device_room_links.archived_at` later. Today, **soft delete** is the server-side hide. **Ended** is the burn tombstone. Avoid overloading “archived” as a third `rooms.state` until product needs it.

## Interactions

### V1 `POST /sessions/end`

- Burns **active** rooms: `state → ended`, clears members/messages, keeps `device_room_links`.
- If room is **already ended** → idempotent `alreadyEnded`.
- If room is **soft-deleted** → `200 { ok: true, sessionUnknown: true }` (same as unknown id for V1).

### V2 list `GET /v2/rooms`

- Only rows with **`deleted_at IS NULL`** (ended tombstones still appear when `status` matches).

### V2 detail / messages

- **Ended + not deleted:** detail OK; messages return `roomState: "ended"`, `messages: []`.
- **Deleted + linked device:** **410** `{ error: "Room was deleted" }` (distinct from unknown id **404**).

## Write routes (all require JSON body `{ "deviceId": "..." }`)

| Route | Purpose |
|-------|---------|
| `POST /v2/rooms/:roomId/delete` | Soft-delete. Idempotent: second call → `{ ok: true, alreadyDeleted: true }`. **No undelete API** in this phase (DB row retained for future admin/migration). |
| `POST /v2/rooms/:roomId/reopen` | Only `state = ended` and not deleted. Sets `active`, clears `ended_at`; **messages stay empty** (burn was destructive). Join works again with current `invite_code`. |
| `POST /v2/rooms/:roomId/rotate-invite-code` | Only **active** and **not deleted**. New random 6-digit code; **room id unchanged**; old code no longer matches `findActiveRoomIdByInviteCode`. |

**Authorization:** same as reads — a row in **`device_room_links`** for `(roomId, deviceId)`.

## Invite rotation rules

- **Allowed:** active, not deleted, linked device.
- **Not allowed:** ended (use reopen first if product allows), deleted, or rooms that are not active.
- **Collision:** unlikely; server retries then **503** if exhausted.

## Reopen semantics

- **Implemented:** ended → active shell; transcript does not come back (V1 burn deleted ciphertext).
- **Not implemented:** reopen after soft-delete (would need `deleted_at = NULL` policy and product rules).

## Future auth

- Today **`deviceId`** is an opaque client string. Replacing with accounts will require mapping devices/users and possibly new membership tables; links remain a reasonable migration anchor.

See also: `docs/v2-rooms-api.md` (HTTP details and read routes).
