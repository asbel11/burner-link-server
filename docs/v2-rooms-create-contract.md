# Contract: `POST /v2/rooms/create` (Group-Contract-Lock-1)

Canonical server behavior for **group room creation**.

**Deploy check:** if production returns **404** for this path, see **`docs/deploy-verify-v2-api.md`**. Use **`GET /v2/meta`** to confirm the running server includes the group-room route. Clients should use **`reason`** or **`code`** (same string) for branching; **`error`** is a human-readable message (often identical to the code for machine-style errors).

## Request

- **Content-Type:** `application/json`
- **Keys (camelCase preferred; snake_case aliases accepted):**

| Field | Aliases | Required | Rule |
|-------|---------|----------|------|
| `deviceId` | `device_id` | **yes** | Non-empty string after trim. |
| `inviteCode` | `invite_code` | **yes** | Exactly **6** digits (`/^\d{6}$/`). |
| `memberCap` | `member_cap` | **yes** | Integer within server min/max (defaults **3**–**100**; see env). |
| `roomKind` | `room_kind` | **no** | If present and non-empty, must be **`"group"`** (case-insensitive). This route **only** creates group rooms; **`"direct"`** or any other value → **`400`** `invalid_room_kind`. |

If both camelCase and snake_case are sent for the same field, **camelCase wins**.

There is **no** default for `memberCap`; omitting it yields **`invalid_member_cap`**.

### Example (camelCase)

```json
{
  "deviceId": "device-uuid",
  "inviteCode": "123456",
  "memberCap": 8
}
```

### Example (aliases)

```json
{
  "device_id": "device-uuid",
  "invite_code": "123456",
  "member_cap": 8
}
```

## Success

**HTTP `201`**

```json
{
  "ok": true,
  "roomId": "<uuid>",
  "id": "<uuid>",
  "roomKind": "group",
  "memberCap": 8,
  "inviteCode": "123456"
}
```

## Errors

Every error body includes **`error`**, **`reason`**, and **`code`** (the latter two always equal). Status and `reason` / `code`:

| HTTP | `reason` / `code` | Notes |
|------|-------------------|--------|
| **400** | `invalid_device_id` | Missing/empty `deviceId`. |
| **400** | `invalid_invite_code` | Not a 6-digit string. |
| **400** | `invalid_room_kind` | `roomKind` / `room_kind` set to something other than `group`. |
| **400** | `invalid_member_cap` | Not an integer. |
| **400** | `member_cap_out_of_range` | Includes **`min`** and **`max`**. |
| **403** | `pro_required` | When **`CONNECT_GROUP_ROOMS_REQUIRE_PRO`** is enabled and device is not Pro. |
| **409** | `invite_taken` | Another **active** room already uses this invite code. |
| **400** | `invalid_request` | Rare fallback for unexpected repo failure. |
| **500** | — | `{ "error": "Internal server error" }` only (no `code` in this phase). |

### Examples

**Pro required**

```json
{
  "error": "pro_required",
  "reason": "pro_required",
  "code": "pro_required"
}
```

**Invalid member cap (range)**

```json
{
  "error": "member_cap_out_of_range",
  "reason": "member_cap_out_of_range",
  "code": "member_cap_out_of_range",
  "min": 3,
  "max": 100
}
```

**Invalid room kind**

```json
{
  "error": "This endpoint only creates group rooms; omit roomKind or set it to \"group\".",
  "reason": "invalid_room_kind",
  "code": "invalid_room_kind"
}
```

**Malformed invite code**

```json
{
  "error": "inviteCode must be a 6-digit string",
  "reason": "invalid_invite_code",
  "code": "invalid_invite_code"
}
```

---

## Room full is not a create error

**`POST /v2/rooms/create` does not return “room full”.**  
“Full” is enforced on **join** (e.g. **`POST /sessions/join`**). See **`docs/sessions-join-contract.md`** and **`docs/v2-group-rooms.md`**.
