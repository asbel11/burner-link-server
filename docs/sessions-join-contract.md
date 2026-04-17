# Contract: `POST /sessions/join` (group + direct)

Joins an **active** room by **6-digit** invite `code`. Same handler for **direct (1:1)** and **group** rooms; the server chooses the room via `invite_code` (oldest active match).

## Request

```json
{
  "code": "123456",
  "deviceId": "device-uuid"
}
```

- **`code`:** required, string, `/^\d{6}$/`.
- **`deviceId`:** required, non-empty string.

Snake_case is **not** accepted on this V1-shaped route (only `code` and `deviceId`).

## Success

**HTTP `200`**

```json
{
  "id": "<roomId>",
  "roomId": "<roomId>"
}
```

## Errors

### Room full

**HTTP `403`**

**Direct (1:1)** — legacy message preserved on **`error`**:

```json
{
  "error": "Session already has two devices connected.",
  "reason": "full",
  "code": "full"
}
```

**Group** — capacity reached:

```json
{
  "error": "Room is full",
  "reason": "full",
  "code": "full",
  "roomKind": "group",
  "memberCap": 8,
  "memberCount": 8
}
```

Branch on **`code === "full"`** or **`reason === "full"`**; use **`roomKind`**, **`memberCap`**, **`memberCount`** only when **`roomKind === "group"`** (direct omits the last three fields).

### Not found / inactive

**HTTP `404`**

```json
{
  "error": "Session not found or inactive"
}
```

(No `code` / `reason` in this phase for this branch.)

### Malformed input

**HTTP `400`** — `{ "error": "Missing or invalid code" }` or `{ "error": "Missing or invalid deviceId" }`.
