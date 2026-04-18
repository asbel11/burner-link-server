# CONNECT — full server completion plan (execution table)

Scope: **server repo only**; mobile out of band. Baseline: 1:1 chat, billing, voice, mutual save, coins, Stripe, free call allowance (per prior audits).

---

## 1. Execution table (P0 / P1 / P2)

| Feature | Status | Why incomplete | Backend work required | Mobile dependency | Priority |
|--------|--------|----------------|----------------------|-------------------|----------|
| **Inline E2EE messages (text + image type)** | **Complete** | — | Maintain; payload limits added (**`messagePayloadLimits`**) | Crypto + UX | — |
| **Media at scale (photos/videos/files)** | **Server complete (Media-Storage-1)** | — | Maintain **`room_attachments`**, S3 presigns, **`attachment_id`** on messages, burn delete; optional: CDN, scan | Client upload/finalize/message/download UX | **P1** (mobile) |
| **Message payload abuse / DB growth** | **Improved (P0)** | Was unbounded field length | **`CONNECT_MESSAGE_MAX_*`** + validation + **413** / **400** | None | **P0** (done) |
| **Group rooms** | **Server foundation done; product partial** | Direct cap 2 unchanged; **`room_kind` / `member_cap`**, **`POST /v2/rooms/create`**, join by cap — see **`docs/v2-group-rooms.md`** | **P2:** LiveKit N-way, group UX, billing rules, doc alignment | Full UX | **P2** |
| **Retention enforcement (TTL)** | **Not enforced** | Advisory `retention_until` only | **P1+:** background job + delete strategy + list API contract | Inbox expectations | **P1** |
| **Voice calls** | **Complete for voice** | — | Keep stable | Call UI | — |
| **Video calls** | **Disabled** | **`livekit-token`** rejects non-voice; grants mic only | **Decision:** enable **`callType: video`**, **`TrackSource.CAMERA`**, tariff alignment — **P1** if product wants | Video UI | **P1** (product gate) |
| **LiveKit production** | **Config** | Needs live project | Env + monitoring; server code path is ready for voice | SDK config | **P0 ops** |
| **Pro benefit enforcement** | **Partial** | Mostly retention **overlay** + membership row | **P1:** optional gates (e.g. feature flags per route) once product lists entitlements | Feature flags | **P1** |
| **Wallet / billing identity** | **Weak bearer (`deviceId`)** | By design v1 | **P1+:** signed requests, device keys, rate limits | Registration of keys | **P1** |
| **Stripe / ops** | **Documented** | Drift risk | Keep **`docs/connect-server-environment.md`** aligned with code | Dashboard setup | **P0 ops** |

---

## 2. Media backend — audit summary

| Layer | Status |
|-------|--------|
| **Schema** | **`room_messages`**: `ciphertext`, `nonce`, `msg_type`, `file_name`, optional **`attachment_id`**. **`room_attachments`**: metadata + `storage_key` + lifecycle **`status`**. |
| **Upload API** | **`POST /v2/rooms/:roomId/attachments/prepare`** → presigned PUT; **`.../finalize`** — see **`docs/connect-attachments-storage.md`**. |
| **Storage provider** | **S3-compatible** (AWS, R2, MinIO, …) via **`src/attachments/s3AttachmentStorage.js`**. |
| **Validation** | Inline: **`validateEncryptedMessageContent`**. Attachments: **`attachmentPolicy.validatePrepareBody`** (kind, MIME, size). |
| **Types** | **`mapMessageRow`** exposes **`text`**, **`image`**, **`video`**, **`file`**; **`video`**/**`file`** posts require finalized attachment when using object path. |

**Mobile / ops next:** wire clients to prepare/finalize/message/download; configure bucket and env.

---

## 3. Group rooms — required server changes (plan only)

1. Replace or parameterize **`MAX_V1_DEVICES_PER_ROOM`** (env? `room_type === 'group'` ?).  
2. **Join:** invite code or invite links; cap members; optional roles.  
3. **Messages:** same **`room_messages`**, **`appendMessageForLinkedDevice`** already link-based — scales to N members if links exist.  
4. **LiveKit:** multi-participant room; token grants for N identities; **SFU** load — product/ops.  
5. **Billing / Pro:** product decision — **not** in schema today.

**Not implemented in this phase** — foundation is **2-user**-oriented.

---

## 4. Pro benefits — enforcement truth

| Benefit | Class |
|---------|--------|
| **Membership row + GET /v2/billing/membership** | Already enforced (read model) |
| **Retention tier overlay for members** | Already enforced (view model on list/detail) |
| **Message history length (TTL)** | **Not implemented** — not enforced |
| **Coins / wallet** | **Not Pro-gated** — device-bound only |
| **Calls** | **Not Pro-gated** — link + tariff + wallet |
| **Groups** | **N/A** — no groups |
| **Media quotas** | **Not Pro-gated** — only global payload limits |

**Easy next:** optional **`requirePro`** middleware once routes and product rules are fixed (**P1**).

---

## 5. Retention enforcement — recommendation

**Do not implement automatic purge in this repo phase** without: legal retention policy, backup strategy, and mobile UX for disappearing history.

**User-facing limitation (already documented):** **`enforcementNote`** — tiers are **metadata**; messages are **not** auto-deleted by TTL in the current server.

**When implementing:** batch job on **`retention_until`** / tier windows, **`DELETE` from `room_messages`**, tombstone or empty list on **`GET`**, sync rules for external media (**P1** project).

---

## 6. Billing / wallet hardening — action list

| Stage | Action |
|-------|--------|
| **Now (v1)** | Accept **`deviceId`** bearer; document; optional rate limit at gateway |
| **Next** | Short-lived **session tokens** or HMAC-signed bodies per device key |
| **Scale** | User accounts + OAuth or pairing; fraud detection; separate payment identity |

---

## 7. Calls / provider — remaining server work

| Topic | State |
|-------|--------|
| **Voice** | **Ready** with LiveKit env + **`call-charge/*`** + **`callType: voice`** |
| **Video** | **Disabled in `processLivekitTokenRequest`** — enable + camera grant + billing **`callType: video`** end-to-end (**P1**) |
| **Production** | **Ops:** LiveKit dashboard, TURN if needed, key rotation |

---

## 8. Implemented in this phase (server)

- **`src/messagePayloadLimits.js`** — configurable max sizes; reasons **`payload_too_large`**, **`invalid_payload`**.  
- **`roomRepository.appendMessageV1`** — validates before write; returns structured **`reason`**.  
- **`server.js`** — **413** / **400** for V1 and V2 message posts.  
- **Media-Storage-1:** **`room_attachments`**, **`attachmentRepository`**, **`attachmentHttp`**, S3 presigns, **`appendMessageForLinkedDevice`** with **`attachmentId`**, burn-time S3 delete — **`docs/connect-attachments-storage.md`**.  
- **Docs:** this file, **`docs/connect-media-messages.md`**, env notes in **`connect-server-environment.md`**.

---

## 9. Recommended next server prompt

*Media-Storage-1 server path is implemented; prefer mobile/ops prompts.*

**Example (ops):** configure **`CONNECT_S3_*`** on staging, verify **`POST .../attachments/prepare`** returns **`503`** when unset and **`200`** when configured.

**Example (mobile):** **`docs/connect-attachments-storage.md`** — section *Recommended next mobile prompt*.

---

## 10. Phase Media-Storage-1 — server deliverable summary

| Item | Location |
|------|----------|
| Contract | **`docs/connect-attachments-storage.md`** |
| MIME / kinds | **`src/attachments/attachmentPolicy.js`** (`image` → `image/*`, `video` → `video/*`, `file` → any) |
| Routes | **`server.js`** — `/v2/rooms/:roomId/attachments/*` |
| Tests | **`test/attachments.test.js`** |
