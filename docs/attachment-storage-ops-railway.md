# Attachment storage — production env (Phase Attachment-Storage-Ops-1)

Source of truth in code: **`src/attachments/s3AttachmentStorage.js`** (`createS3ClientFromEnv`) and **`src/store/index.js`** (`attachmentStorage` is `null` when S3 config is incomplete).

## Exact variables that must be set for attachments to work

`createS3ClientFromEnv()` returns **`null`** (and **`store.attachmentStorage`** stays **`null`**) unless **all three** of the following resolve to **non-empty** strings:

| # | Variable (primary) | Alias (same meaning) |
|---|--------------------|----------------------|
| 1 | **`CONNECT_S3_BUCKET`** | **`S3_BUCKET`** |
| 2 | **`CONNECT_S3_ACCESS_KEY_ID`** | **`AWS_ACCESS_KEY_ID`** |
| 3 | **`CONNECT_S3_SECRET_ACCESS_KEY`** | **`AWS_SECRET_ACCESS_KEY`** |

**Region** is **not** part of that gate: **`CONNECT_S3_REGION`** or **`AWS_REGION`** may be omitted; the client defaults region to **`us-east-1`** if both are empty. For **AWS** production you should still set the real bucket region (e.g. `us-west-2`). For **R2**, set region to the value Cloudflare documents for your account (often `auto` or a fixed string per their API).

## Optional but common in production

| Variable | When to set |
|----------|-------------|
| **`CONNECT_S3_REGION`** / **`AWS_REGION`** | Always for AWS; follow R2 docs for R2. |
| **`CONNECT_S3_ENDPOINT`** | **R2**, **MinIO**, DigitalOcean Spaces, etc. (non-AWS endpoint URL). |
| **`CONNECT_S3_FORCE_PATH_STYLE`** | Often **`1`** for MinIO and some S3-compatible APIs. |
| **`CONNECT_ATTACHMENT_MAX_BYTES`** | Override default **524288000** (bytes) if needed. |
| **`CONNECT_S3_PRESIGN_PUT_SECONDS`** | PUT URL TTL (default **900**). |
| **`CONNECT_S3_PRESIGN_GET_SECONDS`** | GET URL TTL (default **3600**). |

## Why the API returns **503** `storage_not_configured`

**Handler:** `handlePrepareAttachment` in **`src/attachments/attachmentHttp.js`** — if **`!store.attachmentStorage`**, response is:

```json
{
  "error": "Object storage is not configured",
  "reason": "storage_not_configured"
}
```

**Cause:** `createS3ClientFromEnv()` returned **`null`** because **at least one** of these is missing or empty after env resolution:

- bucket (**`CONNECT_S3_BUCKET`** / **`S3_BUCKET`**)
- access key id (**`CONNECT_S3_ACCESS_KEY_ID`** / **`AWS_ACCESS_KEY_ID`**)
- secret access key (**`CONNECT_S3_SECRET_ACCESS_KEY`** / **`AWS_SECRET_ACCESS_KEY`**)

Typos, leading/trims, or Railway variables not applied to the **correct service** produce the same **503**.

## Railway-ready checklist

1. **Create** an S3 bucket (AWS) or R2 bucket (Cloudflare) and **note** bucket name, region, and API credentials with permission to **PutObject**, **GetObject**, **HeadObject**, **DeleteObject** on that bucket (and prefix if you use policies).
2. In **Railway → your API service → Variables**, add (use **CONNECT_** names to avoid clashing with unrelated tools that read **`AWS_*`**):

   - **`CONNECT_S3_BUCKET`**
   - **`CONNECT_S3_REGION`** (or **`AWS_REGION`**)
   - **`CONNECT_S3_ACCESS_KEY_ID`**
   - **`CONNECT_S3_SECRET_ACCESS_KEY`**

3. If using **R2** (or another non-AWS endpoint), add:

   - **`CONNECT_S3_ENDPOINT`** = your R2 S3 API endpoint (see Cloudflare docs)
   - Often **`CONNECT_S3_FORCE_PATH_STYLE`** = **`1`** if required by the provider

4. **Redeploy** the service so the process reads the new variables (Railway injects env at start; **`createRoomStore()`** runs once at boot).

5. Confirm **`DATABASE_PATH`** (or default) still points at persistent disk if you rely on durable SQLite — independent of S3 but required for room/attachment rows.

6. **Smoke test** (below). Expect **200** JSON with **`uploadUrl`**, not **503**.

## One smoke test command (prepare)

Replace **`API_BASE`**, **`ROOM_ID`**, and **`DEVICE_ID`** (must match a device **linked** to that room, e.g. creator of a V1 session).

```bash
API_BASE="https://YOUR-RAILWAY-API.up.railway.app"
ROOM_ID="paste-room-uuid"
DEVICE_ID="paste-device-id"

curl -sS -X POST "$API_BASE/v2/rooms/$ROOM_ID/attachments/prepare" \
  -H "Content-Type: application/json" \
  -d "{\"deviceId\":\"$DEVICE_ID\",\"kind\":\"image\",\"mimeType\":\"image/jpeg\",\"sizeBytes\":1024}"
```

**Success:** HTTP **200** and JSON containing **`attachmentId`**, **`uploadUrl`**, **`bucket`**, **`storageKey`**.

**Misconfiguration:** HTTP **503** and **`reason":"storage_not_configured"`** — fix the three required variables and redeploy.

**Quick room + device for smoke:** create a session, then use returned **`roomId`/`id`** as **`ROOM_ID`** and the same **`deviceId`** as **`DEVICE_ID`**:

```bash
API_BASE="https://YOUR-RAILWAY-API.up.railway.app"
CODE=$(printf '%06d' $((RANDOM % 1000000)))
CREATE=$(curl -sS -X POST "$API_BASE/sessions/create" \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"$CODE\",\"deviceId\":\"smoke-att-device\"}")
ROOM_ID=$(echo "$CREATE" | jq -r '.roomId // .id')

curl -sS -X POST "$API_BASE/v2/rooms/$ROOM_ID/attachments/prepare" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"smoke-att-device","kind":"image","mimeType":"image/jpeg","sizeBytes":1024}'
```

*(If you do not have **`jq`**, read **`roomId`** from the first JSON response by hand and export **`ROOM_ID`**.)*

See also **`docs/connect-attachments-storage.md`** and **`docs/connect-server-environment.md`** (Object storage section).

---

## Phase Attachment-Storage-Ops-2 — verify Railway (runtime + smoke)

### Startup (Railway logs)

On boot, the server logs whether **`store.attachmentStorage`** is non-null:

- **`configured (S3 client ready)`** — the three required env vars resolved; prepare can succeed (subject to IAM/bucket policy).
- **`null — POST .../attachments/prepare returns 503`** — missing bucket or keys; fix Railway variables and redeploy.

### HTTP probe (no secrets leaked)

**`GET /v2/meta`** includes:

```json
"connect": {
  "attachmentStorage": { "configured": true }
}
```

**`configured: true`** iff **`store.attachmentStorage != null`** at process start (same condition as successful S3 client creation).

### Automated script (meta + session create + prepare)

```bash
export CONNECT_API_BASE="https://YOUR-RAILWAY-API.up.railway.app"
node scripts/verify-attachment-prod.js
```

**Exit 0** only if: meta shows **`attachmentStorage.configured === true`**, session create **201**, prepare **200** with **`uploadUrl`**. Requires **`jq`** only for human-readable JSON in other docs; this script uses **`fetch`**.

### Manual `curl` (prepare only)

Same as [One smoke test command (prepare)](#one-smoke-test-command-prepare) above.
