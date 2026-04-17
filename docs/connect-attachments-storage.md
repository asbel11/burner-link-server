# CONNECT attachments — S3-compatible object storage (Media-Storage-1)

## E2EE honesty

- **Presigned PUT** uploads store **opaque bytes** (`Content-Type: application/octet-stream`). The server **does not** decrypt payloads. Clients should **encrypt file contents before upload** if the product promises end-to-end protection for media.
- **Message rows** still carry **encrypted caption** / metadata in `ciphertext` + `nonce` (same as text messages).
- **Server role:** authorization (linked device, room active), metadata, presigned URLs, lifecycle delete on room burn.

## Environment (S3-compatible)

| Variable | Required | Purpose |
|----------|----------|---------|
| **`CONNECT_S3_BUCKET`** (or **`S3_BUCKET`**) | **Yes** for uploads | Bucket name. |
| **`CONNECT_S3_REGION`** or **`AWS_REGION`** | Yes | e.g. `us-east-1`. |
| **`CONNECT_S3_ACCESS_KEY_ID`** / **`AWS_ACCESS_KEY_ID`** | Yes | API key. |
| **`CONNECT_S3_SECRET_ACCESS_KEY`** / **`AWS_SECRET_ACCESS_KEY`** | Yes | Secret (server only). |
| **`CONNECT_S3_ENDPOINT`** | No | Set for **Cloudflare R2**, **MinIO**, etc. |
| **`CONNECT_S3_FORCE_PATH_STYLE`** | No | `1` for many S3-compatible endpoints. |
| **`CONNECT_ATTACHMENT_MAX_BYTES`** | No | Max declared upload size (default **524288000**). |
| **`CONNECT_S3_PRESIGN_PUT_SECONDS`** | No | PUT URL TTL (default **900**, 60–3600). |
| **`CONNECT_S3_PRESIGN_GET_SECONDS`** | No | GET URL TTL (default **3600**, 60–86400). |

If credentials/bucket are missing, **`POST .../attachments/prepare`** returns **`503`** `storage_not_configured`.

## Supported attachment kinds (prepare → message)

| `kind` (body) | MIME rule (`mimeType`) | Typical use |
|---------------|------------------------|-------------|
| **`image`** | Must start with **`image/`** | JPEG, PNG, WebP, … |
| **`video`** | Must start with **`video/`** | MP4, WebM, … |
| **`file`** | Any non-empty MIME (≤ 200 chars) | PDF, zip, arbitrary |

Declared **`sizeBytes`** must be ≥ 1 and ≤ **`CONNECT_ATTACHMENT_MAX_BYTES`** (default 500 MB cap). **`originalFilename`** optional, ≤ 2048 chars.

## Lifecycle

1. **`POST /v2/rooms/:roomId/attachments/prepare`**  
   Body: `deviceId`, `kind` (`image` \| `video` \| `file`), `mimeType`, `sizeBytes`, optional `originalFilename`.  
   Response: `attachmentId`, `uploadUrl` (presigned PUT), `uploadExpiresInSeconds`, `bucket`, `storageKey` (opaque; for support only).

2. **Client `PUT uploadUrl`** with the **encrypted file body** (binary).

3. **`POST /v2/rooms/:roomId/attachments/:attachmentId/finalize`**  
   Body: `deviceId`. Server **`HeadObject`s** the key and checks size (≤ declared + 5% + 64KB slack). Sets status **`ready`**.

4. **`POST /v2/rooms/:roomId/messages`**  
   Body includes `type` matching `kind`, `attachmentId`, plus usual `encrypted` (caption), optional `fileName`.  
   **`video`** and **`file`** message types **require** a finalized attachment. **`image`** may remain inline-only (legacy) or use attachments.

5. **`GET /v2/rooms/:roomId/attachments/:attachmentId/download-url?deviceId=`**  
   Returns presigned **GET** after the message is sent (attachment status **`linked`**). Any linked room member may request a download URL.

6. **`DELETE /v2/rooms/:roomId/attachments/:attachmentId`**  
   Body: `deviceId`. Cancels **`pending`** uploads and removes the object from storage.

## Room burn / end session

- **`POST /sessions/end`** (V1 burn) and heartbeat auto-end delete **`room_messages`** and **`room_attachments`** rows, then **delete S3 objects** by collected keys (best-effort async delete after DB commit).
- **Soft-delete** (`POST /v2/rooms/:roomId/delete`) does **not** remove messages or attachments in this phase — S3 objects may remain until a future cleanup job.

## SQLite

- Table **`room_attachments`**: metadata + `storage_key` + `status` (`pending` \| `ready` \| `linked`).
- **`room_messages.attachment_id`**: optional FK to the attachment row (unique when set).

## Related

- **`docs/connect-media-messages.md`** — inline vs object storage overview.

---

## Recommended next mobile prompt

**“Implement CONNECT attachment flow in the app: call `POST /v2/rooms/:roomId/attachments/prepare` with `deviceId`, `kind`, `mimeType`, `sizeBytes`; `PUT` encrypted bytes to `uploadUrl` as `application/octet-stream`; `POST .../finalize`; send `POST /v2/rooms/:roomId/messages` with `type` matching `kind`, `attachmentId`, and caption `encrypted`; download via `GET .../attachments/:attachmentId/download-url?deviceId=` after link. Handle `503 storage_not_configured` when the server has no S3 env.”**
