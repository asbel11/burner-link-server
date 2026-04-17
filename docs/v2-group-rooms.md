# CONNECT group rooms (Phase Group-Rooms-1)

Server foundation for **multi-member** rooms alongside existing **direct (1:1)** sessions.

## Data model

| Column | Meaning |
|--------|---------|
| `rooms.room_kind` | `direct` — legacy 1:1, cap **2** members. `group` — N-way chat up to `member_cap`. |
| `rooms.member_cap` | Maximum **distinct** devices in `room_members` for this room. For `direct`, always **2**. For `group`, **≥ 3** (see env bounds). |

**Migration:** existing rows are backfilled to `room_kind = 'direct'` and `member_cap = 2`. Behavior matches the previous implicit two-device limit.

## Creation

| Flow | Route | Room kind |
|------|-------|-----------|
| V1 / legacy CONNECT create | `POST /sessions/create` | Always **`direct`**, cap **2** (unchanged). |
| Group create | `POST /v2/rooms/create` | **`group`** with caller-chosen `memberCap` (within server min/max). |

Body for group create (camelCase; **`device_id` / `invite_code` / `member_cap`** aliases supported — see contract doc):

```json
{
  "deviceId": "opaque-device-id",
  "inviteCode": "123456",
  "memberCap": 8
}
```

**201** includes `roomId`, `roomKind: "group"`, `memberCap`, `inviteCode`.

**Exact API contract (errors, codes, join vs create):** **`docs/v2-rooms-create-contract.md`** and **`docs/sessions-join-contract.md`**.

## Joining and invite behavior

- **Invite surface:** still a **6-digit** `invite_code` on the active room (same as V1).
- **Join path:** `POST /sessions/join` (and any flow that calls `joinActiveRoomByCode`) resolves the **oldest active** room with that code (unchanged ordering).
- **Rule:** a device may join if it is **not** already a member and `count(room_members) < member_cap` (for `direct`, cap is **2**).
- **Full room:** V1 JSON for **direct** full rooms stays: `{ "error": "Session already has two devices connected." }`. For **group** rooms: `403` with `error: "Room is full"`, plus `roomKind`, `memberCap`, `memberCount`.

There is **no** separate “invite token” beyond the numeric code in this phase; share the code out-of-band as today.

## List / detail

`GET /v2/rooms` and `GET /v2/rooms/:roomId` include:

- `roomKind`: `direct` | `group`
- `memberCap`: effective cap for that room

## Mutual save (1:1 only)

Mutual save (`MUTUAL_SAVE_ENABLED`, `POST .../save/request` / `.../respond`) applies only to **`direct`** rooms.

- **Group rooms:** list/detail expose `save.enabled: false`. Requests return **`403`** with `error: "group_mutual_save_unsupported"` until a multi-party save product exists.

## Retention and lifecycle

Group rooms use the **same** room-level retention columns and billing paths as direct rooms (`retention_tier`, `retention_until`, purchases, soft-delete, reopen, etc.). No separate retention namespace in this phase.

## Pro gating (optional)

When **`CONNECT_GROUP_ROOMS_REQUIRE_PRO`** is enabled, only devices with an **active CONNECT Pro** subscription (`device_memberships`, see membership docs) may call **`POST /v2/rooms/create`**. Other devices receive **`403`** with **`reason` / `code`: `pro_required`** (see contract doc).

Default: **off** (group create allowed for any device that passes existing validation).

## Environment

See **`docs/connect-server-environment.md`** (group room variables).
