# V2 room message transport (Phase 11)

## 1. Audit: current storage and transport

### Storage (single source of truth)

All application messages live in SQLite **`room_messages`**:

- `id`, `room_id`, `sender_id`, `msg_type`, `ciphertext`, `nonce`, `file_name`, `created_at`
- **Ciphertext** is stored as separate columns (`ciphertext`, `nonce`), not a JSON blob in SQL — the API still exposes **`encrypted: { ciphertext, nonce }`** to match the mobile payload.

### V1 transport today

| Operation | Route | AuthZ model |
|-----------|-------|-------------|
| List | `GET /messages/:sessionId` | Implicit: must know `sessionId`; room must be **active** |
| Send | `POST /messages` | Body `sessionId` + encrypted payload; **no `device_room_links` check** (session id is the secret) |

`appendMessageV1` in the repository writes to **`room_messages`** and updates **`rooms.last_message_at`**.

### V2 read (before Phase 11)

| Operation | Route | AuthZ model |
|-----------|-------|-------------|
| List | `GET /v2/rooms/:roomId/messages?deviceId=` | Requires **`device_room_links`**; returns **`roomState`** + **`messages`** (same decrypted API shape as V1 list) |

Reads use **`listMessagesForDeviceRoom`** — same rows as V1, different visibility rules for **ended** (V2 returns empty list + `roomState`, V1 **404**).

### Is `room_messages` enough for V2 messaging?

**Yes** for this phase: same rows, same **`encrypted`** shape in/out. Nothing new is required in the schema for “true V2” send/read beyond **write** access that respects **`device_room_links`**.

### What was missing before Phase 11?

- A **V2-native POST** that:
  - Puts **`roomId` in the path** (canonical CONNECT URL),
  - Enforces **linked-device** membership for send,
  - Uses the **same** encrypted body as V1 so clients do not redesign crypto.

---

## 2. V2 message contract (Phase 11)

### `GET /v2/rooms/:roomId/messages` (unchanged behavior)

- **Query:** `deviceId` (required)
- **200:** `{ v1SessionId, roomState, messages }` — **`messages`** items match V1 `GET /messages` array elements.

### `POST /v2/rooms/:roomId/messages` (new)

**Path:** `roomId` === `rooms.id` === V1 `sessionId`.

**Body (JSON):**

| Field | Required | Notes |
|-------|----------|--------|
| `deviceId` | yes | Must have **`device_room_links`** row for `(roomId, deviceId)` |
| `encrypted` | yes | `{ ciphertext: string, nonce: string }` — **same as V1** |
| `type` | no | `"text"` (default), `"image"`, `"video"`, `"file"`, or **`"screenshot_event"`** (in-room event; no `attachmentId`) — see **`docs/v2-screenshot-event.md`** |
| `fileName` | no | optional |
| `senderId` | no | If omitted, **`senderId` stored = `deviceId`**. If set, **must equal `deviceId`** (trimmed) |

**201 response:** Same object shape as **`POST /messages`**:

```json
{
  "id": "...",
  "senderId": "...",
  "type": "text",
  "encrypted": { "ciphertext": "...", "nonce": "..." },
  "fileName": null
}
```

**Errors:** `400` validation, `403` not linked, `404` room inactive/deleted (same spirit as V1 “not found or inactive”), `500`.

Implementation calls **`appendMessageForLinkedDevice`** → **`appendMessageV1`** (same insert).

---

## 3. Coexistence and migration

| Layer | Role |
|-------|------|
| **V1** `/messages` | Still the **default live chat** for existing mobile builds; unchanged. |
| **V2** `GET/POST .../v2/rooms/:roomId/messages` | **Native CONNECT** transport; use when app is ready to require **`deviceId`** + link for sends. |

Both read/write the **same** `room_messages` rows for an active room.

### What still blocks full mobile cutover

- Clients must **migrate polling/sending** from V1 URLs to V2 (or run dual-write during transition).
- **Offline**, **read receipts**, **typing**, **pagination**, and **idempotency** are not part of this foundation.
- **No WebSocket/SSE** yet — still request/response.
- V1 send remains **unauthenticated** beyond knowing `sessionId`; V2 send is **stricter** (linked device) — product must align.

---

## 4. References

- **`docs/v1-v2-id-contract.md`** — id equality
- **`docs/v2-rooms-api.md`** — full HTTP catalog
