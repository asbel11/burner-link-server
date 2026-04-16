# Session lifecycle (V1 compatibility + room store)

This document matches the current server: V1 **routes** unchanged; persistence is **SQLite** via `src/store/roomRepository.js`. A `sessionId` from the client is the room row `id`.

## Storage

- Rooms and messages live in SQLite (default file `data/burner-link.db`, override with `DATABASE_PATH`). Restart **retains** data unless the file is on ephemeral disk and the host wipes it.
- Internally: `rooms` (invite code, state, timestamps, placeholders), `room_members`, `room_messages`. Routes still speak in “session” terms for mobile compatibility.
- See `docs/connect-room-foundation.md` for the CONNECT-oriented model and migration notes.
- **CONNECT list/detail:** `docs/v2-rooms-api.md` (`GET /v2/rooms*`) — coexistence with V1; **`docs/v1-v2-id-contract.md`** defines `sessionId` === `roomId` === `rooms.id`.

## Creation — `POST /sessions/create`

- Validates 6-digit `code` and `deviceId`.
- Creates a new UUID `sessionId` (room `id`), `state = active`, creator row in `room_members`, timestamps initialized.
- Returns `201 { id: sessionId }`.

## Join — `POST /sessions/join`

- Finds the **oldest** active room where `invite_code` matches the body `code` (`ORDER BY created_at`).
- Enforces at most two distinct `deviceId` values in `participants`; existing participant reconnects without error.
- Returns `404` if no matching active session (wrong code, ended session, or no row).
- Returns `403` if a third distinct device tries to join.

## Status — `GET /sessions/status/:sessionId`

- If no record: `404` body `{ active: false, participants: 0 }` (not a bare 404; JSON with inactive shape).
- If record exists: `{ active, participants }` where `participants` is the count of `room_members` rows (0 when ended/burned).

## Messages — `GET /messages/:sessionId`, `POST /messages`

- Both require a session record with `active === true`.
- Otherwise: **`404`** with `{ error: "Session not found or inactive" }`.
- After a burn/end, messages are removed and the room is inactive, so clients see **404** on message routes — same as unknown `sessionId`. The client may treat 404 as “session gone / burned”; the server does not distinguish these cases on this route.

## Heartbeat — `POST /sessions/heartbeat`

- Validates `sessionId` and `deviceId`; requires an **active** session or returns `404`.
- Adds `deviceId` to `participants` and updates `lastSeen[deviceId]`.
- **Auto-end (optional):** If `SESSION_HEARTBEAT_AUTO_END` is `1` or `true`, the legacy behavior can run: when at least two devices have `lastSeen` entries, if the **other** device’s `lastSeen` is older than `OFFLINE_TIMEOUT_MS` (default 30s) **and** `lastMessageAt` is older than `INACTIVITY_BEFORE_BURN_MS` (default 30s), the server sets `active: false`, clears `messages` and `participants`, and responds `{ ok: true, ended: true }`.
- **Default (CONNECT-aligned):** `SESSION_HEARTBEAT_AUTO_END` is **off**. Heartbeat only refreshes presence; it does **not** end sessions. Sessions end only via explicit `POST /sessions/end` (or loss of the SQLite file on ephemeral hosting).

## End / burn — `POST /sessions/end`

- **Idempotent:** unknown `sessionId` returns **`200`** `{ ok: true, sessionUnknown: true }` (e.g. typo or never created).
- Active session: clears messages and participants, sets `active: false`, returns **`200`** `{ ok: true, ended: true }`.
- Already-ended session (tombstone row still in DB): **`200`** `{ ok: true, alreadyEnded: true }` — no error on duplicate end.
- The room **row** remains in the DB with `state = ended`; messages and members are removed (V1 burn). No TTL sweep job yet.

## Automatic cleanup

- There is **no** background timer or cron. The only server-driven expiry was optional heartbeat auto-end (now off by default).

## What CONNECT will need later

- Persistent room records and listing/reopen APIs separate from “burned” ephemeral sessions.
- Content TTL / retention without deleting the room entity (policy on messages vs room lifecycle).
- Billing and entitlements for retention and features.
- File/media storage and delivery (not base64-in-JSON only).
- Real-time transport (WebSockets/SSE) and voice/video signaling/media servers.

See the migration audit deliverable in-repo or product specs for ordering.
