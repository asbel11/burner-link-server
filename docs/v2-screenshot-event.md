# Screenshot as in-room event (Phase Screenshot-Event-And-Attachment-Ops-1)

## Server audit: no “screenshot ends session” in this repo

**`POST /sessions/end`** is only invoked when the **client** calls it. The server does not tie **`/metrics/camera-click`** or any route to session burn. Replacing “screenshot → end session” is a **client change**: stop calling **`/sessions/end`** after capture.

This phase adds a **first-class message type** so the app can record a **non-destructive** in-room event instead of implying burn.

## Message type: `screenshot_event`

| Item | Value |
|------|--------|
| **`type` (request body)** | **`"screenshot_event"`** |
| **Stored `room_messages.msg_type`** | **`screenshot_event`** |
| **Returned `type` (GET messages / POST response)** | **`screenshot_event`** |

## Request shape (V1 and V2)

Same as other encrypted messages: **`encrypted.ciphertext`** and **`encrypted.nonce`** (client-side encrypted opaque strings). **`attachmentId` must be omitted** (not supported for this type).

**V1:** `POST /messages` — body includes **`sessionId`**, **`senderId`**, **`type`: `"screenshot_event"`**, **`encrypted`**, optional **`fileName`**.

**V2:** `POST /v2/rooms/:roomId/messages` — body includes **`deviceId`** (query/header per existing V2 rules), **`type`: `"screenshot_event"`**, **`encrypted`**.

### Recommended client payload (E2EE)

Encrypt a small UTF-8 JSON string (example plaintext before encryption):

```json
{"v":1,"kind":"screenshot_taken","at":"2026-04-16T12:00:00.000Z"}
```

The server **does not parse** this JSON; it stores opaque **`ciphertext`** / **`nonce`**.

## How it appears in message reads

**`GET /messages/:sessionId`** (active session) and **`GET /v2/rooms/:roomId/messages`** return the same message shape as other types:

```json
{
  "id": "…",
  "senderId": "…",
  "type": "screenshot_event",
  "encrypted": { "ciphertext": "…", "nonce": "…" },
  "fileName": null
}
```

Mobile should:

1. Decrypt **`encrypted`** using the same session crypto as text messages.
2. Render a **system-style line** (e.g. “Screenshot captured”) when **`type === "screenshot_event"`**, without treating it as media or ending the room.

## Errors

| `reason` | HTTP |
|----------|------|
| **`screenshot_event_no_attachments`** | **400** — `attachmentId` was sent with **`screenshot_event`** |

## Attachment storage (503) — separate issue

**`503`** **`storage_not_configured`** on **`POST .../attachments/prepare`** means missing S3 env (**`CONNECT_S3_BUCKET`**, **`CONNECT_S3_ACCESS_KEY_ID`**, **`CONNECT_S3_SECRET_ACCESS_KEY`**). It does **not** apply to **`screenshot_event`** messages (no object storage). See **`docs/attachment-storage-ops-railway.md`**.

## Smoke tests

**Screenshot event (V1)** — after creating a session:

```bash
curl -sS -X POST "$API_BASE/messages" -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$ROOM_ID\",\"senderId\":\"$DEVICE_ID\",\"type\":\"screenshot_event\",\"encrypted\":{\"ciphertext\":\"x\",\"nonce\":\"y\"}}"
```

**Attachment prepare** (requires S3 env on server):

```bash
curl -sS -X POST "$API_BASE/v2/rooms/$ROOM_ID/attachments/prepare" \
  -H "Content-Type: application/json" \
  -d "{\"deviceId\":\"$DEVICE_ID\",\"kind\":\"image\",\"mimeType\":\"image/jpeg\",\"sizeBytes\":1024}"
```
