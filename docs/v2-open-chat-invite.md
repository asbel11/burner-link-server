# V2 open-chat invite contract (Phase 9)

For the **guarded “Open chat” bridge** from CONNECT room UI into **V1 live chat** (`/sessions/*`, `/messages/*`), the client needs a **machine-readable 6-digit invite code** plus a clear signal that the room is **live** (active).

## Canonical field for the digits

- **`inviteCode`** (string) — always the current value of `rooms.invite_code` on successful **`GET /v2/rooms`** and **`GET /v2/rooms/:roomId`** responses (list items and detail share the same shape for invite-related fields).
- **Rotation:** After **`POST /v2/rooms/:roomId/rotate-invite-code`**, the next **`GET .../detail`** (or list) returns the **new** code immediately — there is no separate “pending” state.

## Availability flags (machine-readable)

Every list item and room detail object includes:

| Field | Type | Meaning |
|-------|------|--------|
| **`openChatInviteAvailable`** | `boolean` | `true` only when the server considers the room **safe for the live-chat bridge**: `state === "active"` **and** `inviteCode` matches **`/^\d{6}$/`**. |
| **`openChatInviteUnavailableReason`** | `string \| null` | `null` when **`openChatInviteAvailable`** is `true`. Otherwise one of: |

**`openChatInviteUnavailableReason` values**

| Value | When |
|-------|------|
| `null` | Bridge available (`openChatInviteAvailable === true`). |
| `room_not_active` | Room is **ended** (V1 burn tombstone, or not reopened) or otherwise not `active`. Invite digits may still be present for display/history, but **do not** use them for the live crypto bridge. |
| `invalid_invite_code_shape` | Room is `active` but `invite_code` in DB is not exactly six digits (unexpected; treat as unavailable until fixed). |

**Soft-deleted rooms:** **`GET /v2/rooms/:roomId`** returns **410** for linked devices — no invite payload (see lifecycle doc).

## Mobile rule (recommended)

Enable **Open chat** only when:

1. **`openChatInviteAvailable === true`**, and  
2. You use **`inviteCode`** as the six-digit secret for your existing V1 crypto bridge.

Do **not** enable the bridge based on **`inviteCode` alone** if **`openChatInviteAvailable`** is `false`, even though **`inviteCode`** may still be populated for ended rooms.

## List vs detail

- **Same contract** for invite fields on **list items** and **detail**: `inviteCode`, `openChatInviteAvailable`, `openChatInviteUnavailableReason`.
- Detail may be slightly fresher if another device rotated the code between calls; rely on **`updatedAt`** if you need to detect change.

## V1 compatibility

- **`POST /sessions/create`** / **`join`** unchanged; invite remains 6-digit for new rooms.
- No V2 message transport in this phase.

See also: **`docs/v2-rooms-api.md`**, **`docs/v1-v2-id-contract.md`**.
