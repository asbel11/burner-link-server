# Deploy verification — V2 / group-room API (Railway and others)

## Why you might see `404` / `Cannot POST /v2/rooms/create`

Express returns **HTML** `Cannot POST /v2/rooms/create` when **no route** is registered for that method and path. In this repo, **`POST /v2/rooms/create`** is defined in **`server.js`** (CONNECT V2 block). If production still returns **404**, the running binary is almost certainly **not** this revision:

1. **Stale deploy** — Railway (or another host) is serving an older image/commit **before** group rooms were added. **Redeploy** from the branch that contains `app.post("/v2/rooms/create", ...)`.
2. **Wrong base URL** — The client calls a **different host** (static site, CDN, typo, missing `https`, wrong Railway service).
3. **Path typo** — Must be exactly **`/v2/rooms/create`** (leading slash, no extra prefix unless you put the API behind a reverse proxy that strips paths; if so, the **public** URL must include the correct prefix).

There is **no** feature flag that disables **`POST /v2/rooms/create`** in code: if the process is current, the route exists.

## Automated check (Phase Group-Deploy-Verify-1)

From the **server repo** (requires Node 18+ for global `fetch`):

```bash
export CONNECT_API_BASE="https://YOUR-RAILWAY-SERVICE.up.railway.app"
node scripts/verify-v2-meta.js
# or:
node scripts/verify-v2-meta.js "https://YOUR-RAILWAY-SERVICE.up.railway.app"
```

**Exit 0** only when **`GET /v2/meta`** returns **200** and **`connect.postGroupRoomCreate.available === true`**. Use this **before** further mobile group-room debugging so you know the API host is the right revision.

There is **no** production URL in this repository; pass your real Railway (or other) **origin** (scheme + host, no trailing path required).

## Verify the live server without the mobile app

After deploy, open or `curl`:

```http
GET /v2/meta
```

**200** JSON example:

```json
{
  "service": "burner-link-server",
  "version": "1.0.0",
  "connect": {
    "postGroupRoomCreate": {
      "method": "POST",
      "path": "/v2/rooms/create",
      "available": true
    },
    "attachmentStorage": {
      "configured": true
    }
  }
}
```

**`attachmentStorage.configured`** — **`true`** when S3 env is complete and **`store.attachmentStorage`** is non-null at startup. See **`docs/attachment-storage-ops-railway.md`** (Attachment-Storage-Ops-2).

- If **`GET /v2/meta`** returns **404**, the deployment does **not** include this server version (or the request URL is wrong).
- If **`GET /v2/meta`** returns **200** but **`POST /v2/rooms/create`** returns **404**, report that as abnormal (should not happen on the same base URL for a single Express app).

## Smoke-test group create

```bash
curl -sS -X POST "$API_BASE/v2/rooms/create" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"smoke-device","inviteCode":"123456","memberCap":5}'
```

Expect **201** with `roomKind: "group"` if the code is free and Pro gate is off.

## Contracts

- **`POST /v2/rooms/create`:** **`docs/v2-rooms-create-contract.md`**
- **`POST /sessions/join` (group full, etc.):** **`docs/sessions-join-contract.md`**
