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
- If the device had previously called **`POST /v2/rooms/:roomId/leave`**, heartbeat **clears** the live-chat-leave timestamp (same as sending a message) — see **`docs/v2-room-live-chat-leave.md`**.
- **Auto-end (legacy Burner, opt-in):** If the **effective** `SESSION_HEARTBEAT_AUTO_END` is on, the legacy behavior can run: when at least two devices have `lastSeen` entries, if the **other** device’s `lastSeen` is older than `OFFLINE_TIMEOUT_MS` (default 30s) **and** `lastMessageAt` is older than `INACTIVITY_BEFORE_BURN_MS` (default 30s), the server sets `active: false`, clears `messages` and `participants`, and responds `{ ok: true, ended: true }`.
- **CONNECT default:** `CONNECT_DISABLE_SESSION_AUTO_END` is treated as **on** when unset. That **blocks** `SESSION_HEARTBEAT_AUTO_END` even if a host template set it to `true`, so heartbeat only refreshes presence and does **not** end sessions. To restore old behavior, set `CONNECT_DISABLE_SESSION_AUTO_END=0` **and** `SESSION_HEARTBEAT_AUTO_END=1`. See **`docs/connect-server-environment.md`**.
- **Without legacy auto-end:** Sessions end only via explicit `POST /sessions/end` (or loss of the SQLite file on ephemeral hosting).

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
