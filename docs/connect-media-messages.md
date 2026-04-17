# CONNECT media & file messages — server truth

## Two transport paths

### 1. Inline (legacy / small payloads)

- Messages are rows in **`room_messages`**: **`ciphertext`**, **`nonce`**, **`msg_type`**, optional **`file_name`**.
- **`msg_type`** is typically **`text`** or **`image`** when the client embeds encrypted content (e.g. base64) in **`ciphertext`** / **`nonce`**.
- **Routes:** **`POST /messages`** (V1) and **`POST /v2/rooms/:roomId/messages`** (V2).
- **Limits:** Express JSON body limit (**`20mb`** in `server.js`) and **`src/messagePayloadLimits.js`** / **`CONNECT_MESSAGE_MAX_*`** — see **`docs/connect-server-environment.md`**.

### 2. Object storage (Media-Storage-1) — larger images, video, files

- **S3-compatible** bucket: presigned **PUT** (upload) and **GET** (download).
- Metadata in **`room_attachments`**; messages reference **`room_messages.attachment_id`** (optional, unique when set).
- **`msg_type`** supports **`image`**, **`video`**, and **`file`** when using attachments (see repository **`mapMessageRow`**).
- **Full contract:** **`docs/connect-attachments-storage.md`** (prepare → finalize → message → download-url; burn cleanup).

End-to-end encryption: the server stores **opaque** ciphertext in message rows and **opaque bytes** in object storage (`application/octet-stream` on PUT); clients encrypt before upload when required by product policy.

## What is not implemented

- **CDN** in front of buckets, **virus scanning**, **moderation** — not in this server.
- **Server-side decryption** — not implemented (by design for E2EE).
- **Automatic purge by retention TTL** — messages are not deleted by `retention_until` alone; see **`docs/v2-retention.md`**.

## Retention interaction

- When/if **message TTL purge** exists, it would **`DELETE` from `room_messages`** and reconcile **object** deletes. Until then, **`enforcementNote`** on retention APIs applies.

## Room end / burn

- **`POST /sessions/end`** (V1 burn) deletes **`room_messages`** and **`room_attachments`** for the room and **best-effort deletes** S3 objects for collected keys — see **`docs/connect-attachments-storage.md`**.
- **Soft-delete** (`POST /v2/rooms/:roomId/delete`) does **not** remove messages or attachments in the current phase; objects may remain until a future cleanup job.
