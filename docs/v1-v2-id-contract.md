# V1 `sessionId` ↔ V2 `roomId` (canonical id contract)

## Formal rule (Phase 7)

**There is a single canonical identifier** for each chat in this server:

- Stored as **`rooms.id`** (SQLite `TEXT` UUID, or hex fallback from `crypto`).

**Naming only:**

| Surface | Name used | Value |
|---------|-----------|--------|
| V1 path/query/body | `sessionId` | = `rooms.id` |
| V2 path | `roomId` | = `rooms.id` |
| V2 JSON (list/detail) | `id` | = `rooms.id` |

So:

- **`V1 sessionId` and `V2 roomId` are not two different ids** — they are the **same string**, exposed under different parameter names for route legacy.
- **`roomId` is not an alias table or mapping layer** — it is the same column as V1’s session id.

## What the server enforces

- **`POST /sessions/create`** generates one id and inserts **`rooms.id = that id`**; response includes **`{ id, roomId }`** with **both equal** to that string (explicit bridge naming).
- **`POST /sessions/join`** returns **`{ id, roomId }`** with the same duplication for the joined row’s **`rooms.id`**.
- **All V1 handlers** pass that string into the repository as the **room** primary key (`getRoomAsV1Session(sessionId)`, `appendMessageV1({ roomId: sessionId, ... })`, etc.).
- **All V2 handlers** use **`req.params.roomId`** as **`rooms.id`**.

No code path creates a second id for the “same” conversation.

## Mobile integration

- **Safe:** Compare **`GET /v2/rooms` → `rooms[].id`** (or **`v1SessionId`**) to the **`sessionId`** / **`id`** you stored from **`POST /sessions/create`** or **`POST /sessions/join`**. They **must** match character-for-character for the same chat.
- **Safe:** Use that string as **`sessionId`** in **`GET /messages/:sessionId`**, **`POST /messages`** (`sessionId` body), **`POST /sessions/end`**, **`POST /sessions/heartbeat`**, **`GET /sessions/status/:sessionId`** when entering live chat from a V2 room row.

## What stays unsafe until a future transport migration

- **Semantics differ by route family**, not by id:
  - V1 **GET `/messages/:sessionId`** returns **404** when the room is not active (ended burn, soft-deleted, etc.).
  - V2 **`GET /v2/rooms/:roomId/messages`** returns **`roomState`** and may return **410** for soft-deleted rooms linked to the device.
- **Do not** assume the same **HTTP status** across V1 vs V2 for the same logical situation — only the **id** is shared.
- **Soft-deleted** rooms: V1 behaves as **missing**; V2 may return **410** on detail/messages for linked devices. The id is still the same string in the DB, but V1 chat endpoints are blocked.

## Future changes

If the backend ever introduces a separate session-scoped id, it would require a **versioned API** or new fields; this contract documents the **current** single-key model so clients can rely on it until then.

See also: `src/idContract.js`, `docs/v2-rooms-api.md`, `docs/session-lifecycle.md`.
