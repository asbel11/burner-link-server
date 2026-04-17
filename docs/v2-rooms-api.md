# CONNECT `/v2/rooms` API

**Reads + lifecycle writes** for CONNECT. The **V1 mobile** contract stays on `/sessions/*` and `/messages/*` unchanged.

- **Canonical id:** `room.id` === `v1SessionId` === V1 `sessionId` — **`docs/v1-v2-id-contract.md`**
- **Open-chat invite availability (list + detail):** **`docs/v2-open-chat-invite.md`**
- **V2 message transport (GET/POST messages):** **`docs/v2-message-transport.md`**
- **Live chat leave (not burn):** **`docs/v2-room-live-chat-leave.md`**
- **Retention (paid history foundation):** **`docs/v2-retention.md`**
- **Lifecycle states, soft delete, reopen, invite rotation:** `docs/v2-room-lifecycle.md`

## Durability (Railway / SQLite)

- Data is only as durable as the SQLite file on disk.
- **Recommended:** set `DATABASE_PATH` to a path on a **mounted Railway volume** (persistent disk), e.g. `/data/burner-link.db`.
- **Default:** `data/burner-link.db` under the app working directory — on a typical PaaS deploy without a volume, the filesystem can be **wiped on redeploy**, so lists/details will be empty or stale after a restart even though the API shape works.
- **Without durable storage:** room list/detail are still useful for the lifetime of the running instance; treat them as **best-effort persistence** until Postgres or a volume is configured.

## Device scoping & membership

- The caller passes **`deviceId`** as an opaque string (same model as V1 `deviceId` in create/join/heartbeat).
- **Membership for V2** is defined by a row in **`device_room_links`**: the server records a link when a device **creates**, **joins**, **heartbeats**, or **posts a message** (non-`unknown` `senderId`) for that room.
- **V1 burn** (`POST /sessions/end`) clears `room_members` and `room_messages` but **does not remove** `device_room_links`, so a device can still **list** and **open detail** for ended rooms (tombstones) while `memberCount` / `messageCount` reflect the burned state (`0`).
- **Live chat leave** (`POST /v2/rooms/:roomId/leave`) records that this device left the **live chat UI** while keeping the room **active** — see **`docs/v2-room-live-chat-leave.md`** (distinct from **`/sessions/end`**).
- **Soft-deleted rooms** (`rooms.deleted_at` set) are hidden from **list**; **detail/messages** return **410** for linked devices (see lifecycle doc). V1 sees the room as gone.

## Active vs ended in lists

- Query **`status`** on `GET /v2/rooms`:
  - `all` (default): active and ended rooms linked to the device.
  - `active`: only `rooms.state = 'active'`.
  - `ended`: only `rooms.state = 'ended'`.
- Sort: **`updated_at` descending**, then `id` descending (most recently touched first).

---

## `GET /v2/rooms`

**Query**

| Param       | Required | Description                                      |
|------------|----------|--------------------------------------------------|
| `deviceId` | yes      | Non-empty string; trims leading/trailing spaces in validation only for empty check (value passed as trimmed to repo). |
| `status`   | no       | `all` (default) \| `active` \| `ended`          |

**Response `200`**

```json
{
  "rooms": [
    {
      "id": "uuid",
      "v1SessionId": "uuid",
      "inviteCode": "123456",
      "state": "active",
      "openChatInviteAvailable": true,
      "openChatInviteUnavailableReason": null,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:01:00.000Z",
      "endedAt": null,
      "lastMessageAt": "2026-01-01T00:00:30.000Z",
      "roomId": "uuid",
      "retentionTier": "default",
      "retentionUntil": null,
      "retentionSource": "server_default",
      "isPaidRetention": false,
      "canExtendRetention": true,
      "enforcementNote": "…",
      "memberCount": 2,
      "messageCount": 4,
      "myPresence": {
        "lastSeenAt": "2026-01-01T00:00:10.000Z",
        "lastLiveChatLeftAt": null,
        "likelyActiveInLiveChat": true
      }
    }
  ]
}
```

- **`myPresence`:** viewer-only heartbeat / leave-live-chat summary — **`docs/v2-room-live-chat-leave.md`**.
- **Retention fields** (`roomId`, `retentionTier`, `retentionUntil`, `retentionSource`, `isPaidRetention`, `canExtendRetention`, `enforcementNote`): same semantics as **`GET /v2/rooms/:roomId/retention`** — see **`docs/v2-retention.md`**. Verified grants: **`docs/v2-billing-ingestion.md`**, Stripe webhooks: **`docs/v2-stripe-webhooks.md`**, Stripe Checkout creation: **`docs/v2-stripe-checkout.md`**, post-return reliability: **`docs/v2-checkout-return-production.md`**.
- **`openChatInviteAvailable` / `openChatInviteUnavailableReason`:** see **`docs/v2-open-chat-invite.md`** (when the V1 live-chat bridge may use **`inviteCode`**).
- **`memberCount`**: live count from `room_members` (after V1 burn, `0`).
- **`messageCount`**: live count from `room_messages` (after V1 burn, `0`).
- Timestamps are **ISO-8601** strings from Unix ms in SQLite.

**Errors**

- `400` — missing/invalid `deviceId`
- `500` — server error

---

## `GET /v2/rooms/:roomId`

**Query**

| Param       | Required |
|------------|----------|
| `deviceId` | yes      |

**Response `200`** — single object (not wrapped):

```json
{
  "id": "uuid",
  "v1SessionId": "uuid",
  "inviteCode": "123456",
  "state": "active",
  "openChatInviteAvailable": true,
  "openChatInviteUnavailableReason": null,
  "createdAt": "...",
  "updatedAt": "...",
  "endedAt": null,
  "lastMessageAt": "...",
  "memberCount": 2,
  "roomId": "uuid",
  "retentionTier": "default",
  "retentionUntil": null,
  "retentionSource": "server_default",
  "isPaidRetention": false,
  "canExtendRetention": true,
  "enforcementNote": "…",
  "messageCount": 4,
  "linkedAt": "2026-01-01T00:00:00.000Z",
  "myPresence": {
    "lastSeenAt": "2026-01-01T00:00:10.000Z",
    "lastLiveChatLeftAt": null,
    "likelyActiveInLiveChat": true
  }
}
```

- **`id`** and **`v1SessionId`** are always the same string — use **`v1SessionId`** when passing to V1 routes (`/messages`, `/sessions/*`) for clarity.
- **`inviteCode` + `openChatInviteAvailable`:** use together for the **Open chat** bridge — **`docs/v2-open-chat-invite.md`**.
- **`linkedAt`**: first time this `deviceId` was linked to the room (create/join/heartbeat/message), best-effort from `device_room_links.linked_at`.

**Errors**

- `400` — invalid `roomId` or `deviceId`
- `403` — `{ "error": "Device is not a member of this room" }` — no `device_room_links` row
- `404` — unknown room id or soft-deleted
- `500` — server error

---

## `GET /v2/rooms/:roomId/messages`

**Query:** `deviceId` (required). Same membership rules as detail (`device_room_links`).

**Response `200`**

Active room (same message objects as V1 `GET /messages/:sessionId`):

```json
{
  "v1SessionId": "uuid",
  "roomState": "active",
  "messages": [
    {
      "id": "...",
      "senderId": "...",
      "type": "text",
      "encrypted": { "ciphertext": "...", "nonce": "..." },
      "fileName": null
    }
  ]
}
```

Ended room (V1 burn cleared ciphertext from DB; transcript is empty):

```json
{
  "roomState": "ended",
  "messages": []
}
```

**Errors**

- `400` — invalid params
- `403` — not a member
- `404` — room not found
- `500` — server error

**Note:** V1 `GET /messages/:sessionId` still returns **`404`** when the room is not active. CONNECT clients should prefer **`/v2/rooms/.../messages`** when they need explicit `roomState` and empty history on tombstones.

## `POST /v2/rooms/:roomId/messages`

**V2-native send** — same **`encrypted`** body and **`201`** response as **`POST /messages`**, but **`roomId` in the path** and **`deviceId` required** with a **`device_room_links`** row. Full contract: **`docs/v2-message-transport.md`**.

---

## Coexistence with V1

| Concern            | V1 | V2 |
|--------------------|----|----|
| Create / join      | `/sessions/create`, `/sessions/join` | — |
| Poll messages      | `/messages/:sessionId` (active only) | `GET /v2/rooms/:id/messages` |
| Send messages      | `POST /messages` | `POST /v2/rooms/:id/messages` (linked device) |
| Room list / detail | — | `/v2/rooms`, `/v2/rooms/:id` |
| Room id            | `sessionId` in V1 paths | same string as `:roomId` |

No V1 paths were renamed or removed in this phase.

---

## Lifecycle writes (Phase 6)

All use **`POST`** with JSON body `{ "deviceId": "<same string as V1>" }`.

### `POST /v2/rooms/:roomId/delete`

Soft-delete. **200** `{ ok: true, deletedAt: "<ISO>" }` or `{ ok: true, alreadyDeleted: true }`. **403** not linked. **404** unknown id.

### `POST /v2/rooms/:roomId/reopen`

Only **ended** (burned) rooms. **200** `{ ok: true, room: { ... } }`. **409** if not ended. **410** if deleted. **403** / **404** as above.

### `POST /v2/rooms/:roomId/leave`

Leave the **live chat UI** without burning the room. **200** `{ ok: true, lastLiveChatLeftAt: "<ISO>" }`. **409** if the room is not active. Full contract: **`docs/v2-room-live-chat-leave.md`**.

### `POST /v2/rooms/:roomId/rotate-invite-code`

Only **active** rooms. **200** includes `inviteCode`, `updatedAt`, `openChatInviteAvailable`, `openChatInviteUnavailableReason`, plus `roomId` / `v1SessionId` — see **`docs/v2-open-chat-invite.md`**. **409** not active. **410** deleted. **503** code allocation failed (retry).

Full semantics: **`docs/v2-room-lifecycle.md`**.

---

## Mutual save (optional — `MUTUAL_SAVE_ENABLED`)

Server truth for **both participants** agreeing to treat a 1:1 room as saved. Default **off**; list/detail always include a **`save`** object (when the flag is off, only `{ "enabled": false, "state": "none" }`).

- **`POST /v2/rooms/:roomId/save/request`** — body `{ "deviceId" }`
- **`POST /v2/rooms/:roomId/save/respond`** — body `{ "deviceId", "decision": "accept" | "decline" }`

Contract and states: **`docs/v2-mutual-save.md`**.

---

## Retention — `GET` / `POST /v2/rooms/:roomId/retention`

Room-level paid retention metadata (manual updates until billing exists). **`deviceId`** query param on **GET**; JSON body on **POST**.

See **`docs/v2-retention.md`** for tiers, schema, and future payment wiring.
