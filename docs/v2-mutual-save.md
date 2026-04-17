# CONNECT mutual save (Room-Save-1A)

Server-side **shared truth** for whether a 1:1 room is **mutually** agreed to be “saved.” This does **not** replace the mobile app’s current **local-only** SecureStore bookmarks (`keptRooms`) until clients are updated: today the app can still show “Your rooms” from local storage without peer consent. When **`MUTUAL_SAVE_ENABLED`** is on, the API exposes that consent state for future UX.

## Principles

- **Temporary by default:** New rooms have `save.state === "none"`.
- **Both participants must agree:** `none` → `pending` (one device requests) → `mutual` (the **other** device accepts). A single request does **not** imply a saved room.
- **Decline:** `pending` → `none` without ending the session or changing message transport.
- **No leave/end changes in this phase:** `/sessions/end` and live messaging are unchanged.

## Feature flag

| Env | Default | Effect |
|-----|---------|--------|
| `MUTUAL_SAVE_ENABLED` | **off** (`false`) | `POST .../save/*` returns **403**; `GET /v2/rooms*` still work; each item’s `save` object shows `{ "enabled": false, "state": "none" }` only. |
| `MUTUAL_SAVE_ENABLED=1` | on | Request/respond endpoints active; `save.enabled` true with full `state` / `myAction` / timestamps. |

Optional: `MUTUAL_SAVE_PENDING_MS` — pending request TTL in milliseconds (default **7 days**). Expired pending rows reset to `none` on the next read or write that touches save state.

## State machine (`rooms.save_state`)

| Value | Meaning |
|-------|---------|
| `none` | No pending request, or declined, or expired pending, or room ended (burn clears save fields). |
| `pending` | One participant requested save; waiting for the **other** linked device to accept or decline. |
| `mutual` | Both participants agreed; room is mutually saved in **server** truth (mobile may still use local flags until migrated). |

Columns (SQLite `rooms`):

- `save_state` — `none` | `pending` | `mutual`
- `save_requested_by_device_id` — requester while `pending`
- `save_requested_at`, `save_responded_at`, `save_pending_expires_at` — integers (epoch ms)

## Endpoints

### `POST /v2/rooms/:roomId/save/request`

Body: `{ "deviceId": "<device id>" }`

- Caller must be linked to the room (`device_room_links`) and the room must be **active** with **exactly two** `room_members` (1:1 product rule).
- Idempotent: same requester calling again while `pending` → **200** `{ ok: true, idempotent: true, save }`.
- If already `mutual` → **200** `{ ok: true, alreadyMutual: true, save }`.
- Does **not** end the room or alter `/messages` routes.

### `POST /v2/rooms/:roomId/save/respond`

Body: `{ "deviceId": "<device id>", "decision": "accept" | "decline" }`

- Only the **non-requesting** participant may respond. The requester gets **403** `wrong_responder` if they try.
- **accept:** `pending` → `mutual`.
- **decline:** `pending` → `none`.

## Read surfaces

`GET /v2/rooms?deviceId=` and `GET /v2/rooms/:roomId?deviceId=` include a **`save`** object on each room:

When the feature flag is **off** (default):

```json
"save": { "enabled": false, "state": "none" }
```

When **on**:

```json
"save": {
  "enabled": true,
  "state": "none",
  "requestedByDeviceId": null,
  "requestedAt": null,
  "respondedAt": null,
  "pendingExpiresAt": null,
  "myAction": "none",
  "peerAction": "none"
}
```

`myAction` is derived for the requesting `deviceId`:

- `none` | `requested` | `can_respond` | `mutual`

## Mobile / next phases

- Use **`save.state === "mutual"`** (with flag on) as **server** eligibility for “saved room” instead of only local toggles.
- Replace unilateral “Keep in Your rooms” with request + incoming prompt using **`myAction`**.
- **Leave vs end:** server-side **leave live chat** (room stays active) is **`POST /v2/rooms/:roomId/leave`** — see **`docs/v2-room-live-chat-leave.md`**. **Burn** remains **`POST /sessions/end`**.
