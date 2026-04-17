# CONNECT room foundation (Phase 4)

## Why the old in-memory model blocked CONNECT

- **Single process heap:** `sessions` was a plain object keyed by id; no cross-instance sharing, no durability across deploys or crashes.
- **Session === chat lifecycle:** Ending a session cleared messages and participants in one step, conflating *room existence* with *message retention* — CONNECT needs those decoupled for TTL, reopen, and list views.
- **No timestamps or audit columns:** No `created_at` / `updated_at` / `ended_at` / `deleted_at` for policy, support, or migrations.
- **No query surface:** No SQL for “rooms for this user”, pagination, or partial message expiry without loading entire graphs into RAM.

See `server.js` (routes) and `src/store/roomRepository.js` (persistence) for the current split.

## Minimal CONNECT room model (implemented in SQLite)

| Concept | Storage | Notes |
|--------|---------|--------|
| **Room identity** | `rooms.id` (TEXT UUID) | Same value as V1 `sessionId` and V2 `:roomId` — see **`docs/v1-v2-id-contract.md`**. |
| **Invite code** | `rooms.invite_code` | 6-digit V1 `code`; future may allow rotation or links. |
| **Active vs ended (burn)** | `rooms.state` (`active` \| `ended`) + `rooms.ended_at` | V1 “burn” = `ended` + message/member rows deleted. |
| **CONNECT soft delete (future)** | `rooms.deleted_at` | Nullable; list APIs can hide deleted rooms without dropping history once retention exists. |
| **Members** | `room_members` | `device_id`, `joined_at`, `last_seen_at` — V1 still caps distinct devices at 2 in join logic. Cleared on V1 burn. |
| **Device ↔ room (CONNECT list)** | `device_room_links` | Survives V1 burn so `GET /v2/rooms` can still find tombstones for devices that participated. Populated on create/join/heartbeat and when posting with a non-`unknown` `senderId`. |
| **Messages** | `room_messages` | Separate table; future TTL can `DELETE` rows without removing the `rooms` row. |
| **Timestamps** | `created_at`, `updated_at`, `last_message_at` on `rooms`; `created_at` on messages | `updated_at` bumped on join/heartbeat/message. |
| **Retention (Phase 17+)** | `rooms.retention_tier`, `retention_until`, `retention_source`; table **`retention_purchases`** | See **`docs/v2-retention.md`**; TTL enforcement not running yet. |
| **Placeholders** | `schema_version` | Versioning for future migrations. |

## Persistence choice: SQLite (`better-sqlite3`)

- **Why not JSON file:** Concurrent writes and indexing are awkward; harder to evolve message-level TTL and room lists safely.
- **Why SQLite first:** One file (`data/burner-link.db` by default), minimal ops overhead, SQL migrations friendly, easy later move to Postgres by mirroring the same logical schema.
- **Railway / PaaS caveat:** Ephemeral disks reset unless a volume is mounted; durability is **best-effort** until Postgres or a volume is added.
- **Concrete `DATABASE_PATH` examples:**
  - Local default: `data/burner-link.db` (relative to process cwd).
  - Railway + volume: mount e.g. `/data` and set `DATABASE_PATH=/data/burner-link.db` in service variables.
  - Ephemeral deploy (no volume): same env unset → DB under cwd; **redeploy wipes file** → all V1/V2 data gone.
- **`/v2/rooms*`** only reflects durable history if the SQLite file survives; see `docs/v2-rooms-api.md`.

## What changed in this step

- Introduced `src/store/db.js` (schema), `src/store/roomRepository.js` (queries), `src/store/index.js` (`createRoomStore`).
- `server.js` uses the repository for all former `sessions[...]` behavior; **HTTP paths and JSON shapes for V1 are unchanged.**
- Added `.gitignore` for `data/*.db` and local `.env`.

## Phase 5–6: CONNECT room API (reads + lifecycle)

- **Read:** `GET /v2/rooms`, `GET /v2/rooms/:roomId`, `GET /v2/rooms/:roomId/messages` — `docs/v2-rooms-api.md`.
- **Writes:** `POST /v2/rooms/:roomId/delete`, `.../reopen`, `.../rotate-invite-code` — `docs/v2-room-lifecycle.md`.
- **Mutual save (optional, `MUTUAL_SAVE_ENABLED`):** columns on `rooms` + `POST .../save/request` / `.../save/respond` — `docs/v2-mutual-save.md` (1:1 / `direct` only).
- **Group rooms:** `rooms.room_kind` (`direct` \| `group`), `rooms.member_cap`, `POST /v2/rooms/create` — `docs/v2-group-rooms.md`.
- V1 routes unchanged.

## What remains before mobile can consume “true” rooms end-to-end

- **Write APIs:** reopen, archive, invite rotation, multi-device policy beyond V1’s cap of 2.
- **Identity:** `device_id` is still an opaque string from the client; no accounts or multi-device room ownership model.
- **Retention / TTL:** Message deletion independent of `rooms.state`; `deleted_at` vs `ended_at` product rules.
- **Realtime + media + calls:** Out of scope for this foundation.

## Environment

| Variable | Purpose |
|----------|---------|
| `DATABASE_PATH` | Optional absolute or relative path to the SQLite file (default `data/burner-link.db`). |
| `CONNECT_DISABLE_SESSION_AUTO_END`, `SESSION_HEARTBEAT_AUTO_END`, `OFFLINE_TIMEOUT_MS`, `INACTIVITY_BEFORE_BURN_MS` | Heartbeat auto-end policy: **`docs/connect-server-environment.md`** and **`docs/session-lifecycle.md`**. CONNECT defaults disable legacy auto-end when unset. |
