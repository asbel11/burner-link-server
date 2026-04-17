# Live chat leave vs session end (Room-Save-1D)

## Summary

| Action | Route | Effect on `rooms.state` | Clears ciphertext? |
|--------|--------|-------------------------|--------------------|
| **End / burn (temporary session)** | `POST /sessions/end` with V1 `sessionId` | `active` → `ended` | Yes (`room_messages`, `room_members` cleared) |
| **Leave live chat UI (saved or unsaved mutual room)** | `POST /v2/rooms/:roomId/leave` | No change — stays **`active`** | No |

**Mutual saved rooms** (after both sides accept save in `docs/v2-mutual-save.md`): the product allows **navigating away** without calling **`/sessions/end`**, so the room must remain **active** and the transcript intact. The leave route is the server-visible signal that **this device** closed the live chat surface.

## `POST /v2/rooms/:roomId/leave`

**Body:** `{ "deviceId": "<same opaque string as V1>" }`

**Success `200`:**

```json
{
  "ok": true,
  "lastLiveChatLeftAt": "2026-04-16T12:00:00.000Z"
}
```

**Semantics**

- Requires a **`device_room_links`** row (same membership model as other V2 routes).
- Sets **`room_members.last_live_chat_left_at`** for that device (epoch ms in DB; ISO in API responses below). Does **not** change `rooms.state`, does **not** delete messages, does **not** remove links.
- **Re-entering** live chat clears the flag:
  - **`POST /sessions/heartbeat`** (same `sessionId` as `roomId`) — `upsertMember` clears `last_live_chat_left_at` while updating `last_seen_at`.
  - **`POST /messages`** or **`POST /v2/rooms/:roomId/messages`** — sender’s leave flag is cleared when a message is appended.

**Errors**

| Status | When |
|--------|------|
| `400` | Invalid `roomId` or `deviceId` |
| `403` | Device not linked to room |
| `404` | Unknown room id, or soft-deleted and device not linked |
| `409` | Room exists but **`state !== 'active'`** (e.g. already ended via `/sessions/end`) |
| `410` | Soft-deleted room for a **linked** device (same as other V2 detail routes) |

## Read APIs: `myPresence`

**`GET /v2/rooms`** and **`GET /v2/rooms/:roomId`** include a viewer-scoped object:

```json
"myPresence": {
  "lastSeenAt": "2026-04-16T11:59:00.000Z",
  "lastLiveChatLeftAt": "2026-04-16T12:00:00.000Z",
  "likelyActiveInLiveChat": false
}
```

- **`lastSeenAt`**: from `room_members.last_seen_at` (heartbeat / join / message touch).
- **`lastLiveChatLeftAt`**: from `room_members.last_live_chat_left_at` after leave, or `null` if never left or cleared by re-entry.
- **`likelyActiveInLiveChat`**: `false` if `lastLiveChatLeftAt` is set **and** there is no `lastSeenAt` strictly **after** that time (heuristic for “probably not in live chat right now”). Not a guarantee; clients may refine with local state.

Peer presence is **not** exposed in this minimal phase (only the requesting device).

## Mobile (next step)

When the user **Leave**s a mutually saved room (without ending the session), call:

`POST /v2/rooms/<roomId>/leave` with `{ deviceId }`

in addition to local navigation. Do **not** call `POST /sessions/end` for that flow.

Temporary sessions that **End session** (burn) should keep using **`POST /sessions/end`** only.

## Related docs

- V1 burn: `docs/session-lifecycle.md`, `docs/v2-room-lifecycle.md`
- Mutual save: `docs/v2-mutual-save.md`
- V2 room API index: `docs/v2-rooms-api.md`
