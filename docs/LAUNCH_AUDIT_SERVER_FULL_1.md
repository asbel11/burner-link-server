# CONNECT backend — full launch audit (Phase Full-Launch-Audit-Server-1)

**Scope:** `burner-link-server` only. **Date context:** reflects codebase + docs at audit time.  
**Purpose:** Single honest **source of truth** for production readiness: complete / partial / ops-blocked / missing / risky.

**Primary docs reviewed:** `docs/LAUNCH_GAP_CHECKLIST.md`, `docs/FULL_COMPLETION_SERVER_PLAN.md`, `docs/connect-server-environment.md`, `docs/v2-retention.md`, `docs/v2-group-rooms.md`, `docs/connect-attachments-storage.md`, `docs/call-tariff-ops-railway.md`, `docs/attachment-storage-ops-railway.md`, `docs/deploy-verify-v2-api.md`, `docs/v2-screenshot-event.md`, `src/livekitConnect.js`, `src/connectCallBilling.js`, `src/groupRoomPolicy.js`, `server.js` (route inventory).

---

## 1. Launch audit by feature area

| Area | Classification | Notes (evidence) |
|------|----------------|------------------|
| **Direct (1:1) rooms — create/join/end/reopen** | **COMPLETE** | V1 `/sessions/*`, `room_kind=direct`, cap 2; burn `endRoomBurnV1`; soft-delete + reopen paths in `roomRepository` + `server.js`. |
| **Group rooms** | **PARTIAL** | **Schema + API:** `room_kind`, `member_cap`, `POST /v2/rooms/create`, join by cap, list/detail fields — **`docs/v2-group-rooms.md`**. **Gaps:** LiveKit/token path still **2-peer–oriented** (`memberCount >= 2` for calls — `livekitConnect.js`); no group-specific billing; mobile UX out of band. **`docs/FULL_COMPLETION_SERVER_PLAN.md` §1 still says “Absent” for groups — doc drift;** treat this audit as current. |
| **Mutual save** | **PARTIAL** | Implemented when **`MUTUAL_SAVE_ENABLED`** — **`src/envFlags.js`**, `requestMutualSaveForDevice` / `respondMutualSaveForDevice`. **Group rooms:** mutual save **disabled** / **403** `group_mutual_save_unsupported`. Default **off** → often **invisible** in prod unless flag on. |
| **Screenshots (`screenshot_event`)** | **COMPLETE** (server) | **`type: "screenshot_event"`** on V1/V2 message POST; no server-side “screenshot ends session” (that was client behavior). **`docs/v2-screenshot-event.md`**. |
| **Attachments / media storage** | **PARTIAL** + **OPS-BLOCKED** in prod | **Code complete:** prepare/finalize/download/cancel, `room_attachments`, burn deletes S3 keys. **`store.attachmentStorage === null`** without S3 env → **503** `storage_not_configured`. **Prod:** blocked until **`CONNECT_S3_*`** (+ R2 endpoint if used) — **`docs/attachment-storage-ops-railway.md`**. |
| **Wallet / coins** | **COMPLETE** (server) | Ledger, wallet API, coin packs, idempotency — subject to **Stripe + catalog env** for purchases. |
| **Membership / CONNECT Pro** | **PARTIAL** | Stripe webhooks, membership store, retention **overlay** for members — **`device_memberships`**. **Not** a full “Pro gates every feature” matrix; **group create** optionally **`CONNECT_GROUP_ROOMS_REQUIRE_PRO`**. |
| **Room retention** | **PARTIAL** + **RISKY** if mis-marketed | Tiers stored, billing ingestion, **`enforcementNote`**: **no TTL purge job** — **`docs/v2-retention.md`**, **`LAUNCH_GAP_CHECKLIST`**. |
| **Call billing** | **COMPLETE** (when configured) | **`CONNECT_CALL_TARIFF_JSON`** required; **503** `tariff_not_configured` if missing/invalid — **`docs/call-tariff-ops-railway.md`**. User reports tariff env **now in prod** → this path **unblocked** for ops. |
| **LiveKit / voice** | **COMPLETE** (when configured) + **OPS-BLOCKED** without LiveKit env | **`LIVEKIT_URL`**, **`LIVEKIT_API_KEY`**, **`LIVEKIT_API_SECRET`**; **503** `livekit_not_configured` if missing. Requires **≥2 room members** for token — **`livekitConnect.js`**. |
| **Video (calls)** | **MISSING** / **DISABLED** | **`callType` must be `voice`** for LiveKit token — **`unsupported_call_type`** for video. Tariff may include **`video.coinsPerSecond`** for future; not a live video product. |
| **Message transport (V1 / V2)** | **COMPLETE** | V1 `/messages`; V2 linked-device POST/GET — **`docs/v2-message-transport.md`**. Payload limits **`CONNECT_MESSAGE_MAX_*`**. |
| **Moderation / safety (server)** | **MISSING** | No report/block/abuse APIs in app code path; **`docs/connect-media-messages.md`** notes no virus scan/moderation. **Trust model:** **`deviceId`** as bearer for wallet/chat (documented as v1 limitation). |

---

## 2. Production blockers (must be true for “real” prod)

| Blocker | Type |
|---------|------|
| **Durable `DATABASE_PATH`** (volume) | Ops — ephemeral PaaS disk loses SQLite. |
| **Stripe live (or test) keys + webhook** | Ops — billing/coins/membership. |
| **Coin pack catalog env** | Ops — else coin checkout **503** / misconfig. |
| **`CONNECT_CALL_TARIFF_JSON`** | Ops — was a blocker; **you report fixed** for call-charge. |
| **LiveKit env** | Ops — voice tokens **503** without. |
| **S3-compatible storage** | Ops — attachments **503** until configured (R2/AWS). |
| **Honest retention messaging** | Product/legal — server does **not** enforce message TTL. |

---

## 3. Ops / config blockers (feature works only when env set)

| Config | Effect when missing / invalid |
|--------|--------------------------------|
| **`GET /v2/meta`** | Used to verify deploy revision; no secrets. |
| **`CONNECT_S3_*`** | `attachmentStorage` null; prepare **503** `storage_not_configured`. |
| **LiveKit trio** | **503** `livekit_not_configured`. |
| **`CONNECT_CALL_TARIFF_JSON`** | **503** `tariff_not_configured` on call-charge. |
| **Stripe** | Checkout / portal failures; webhook verification needs **`STRIPE_WEBHOOK_SECRET`**. |
| **`MUTUAL_SAVE_ENABLED`** | Mutual save routes / UI contract off by default. |

---

## 4. Misalignments & risks

| Topic | Risk |
|-------|------|
| **Retention marketing vs truth** | **`enforcementNote`** — tiers are metadata; **no** automated purge — misalignment if launch copy promises auto-delete. |
| **`deviceId` bearer** | Anyone who knows ID can use wallet/call APIs — **`LAUNCH_GAP_CHECKLIST`**. |
| **Group rooms vs LiveKit** | Group rooms in DB ≠ multi-party LiveKit product; token path assumes **2 members minimum** for call, not full N-way SFU design. |
| **`FULL_COMPLETION_SERVER_PLAN.md`** | Execution table **out of date** on group rooms (still says “Absent”) — **misaligns** with implemented `POST /v2/rooms/create`. |
| **Video** | Tariff allows `video` rate; LiveKit **does not** ship video calls — **product/engineering alignment** needed before “video” in UI. |
| **Attachments** | E2EE stated in docs; server stores opaque bytes — OK; **no malware scanning**. |
| **Horizontal scale** | SQLite single-writer — **not** multi-instance HA without migration. |

---

## 5. Prioritized backlog (server / product)

### P0 — must fix or accept explicitly before broad public launch

1. **Ops:** Persistent **`DATABASE_PATH`**, Stripe + webhook, LiveKit, tariff (done per you), coin catalog — **`LAUNCH_GAP_CHECKLIST`**.  
2. **Attachments:** R2/S3 credentials **or** accept **no** large attachments in prod until configured.  
3. **Legal/product:** Retention **wording** matches **`enforcementNote`** (no implied TTL enforcement).  
4. **Security stance:** Document / accept **`deviceId`**-as-secret limitations for v1.

### P1 — should fix soon after launch

1. **Doc sweep:** Align **`FULL_COMPLETION_SERVER_PLAN.md`** with group + media reality.  
2. **Rate limiting / abuse** at edge (optional).  
3. **Retention TTL job** if product requires **real** deletion — **`v2-retention.md`**.  
4. **Pro / feature matrix** if product needs route-level gates.  
5. **Video end-to-end** if product wants video calls (LiveKit + token + mobile).  

### P2 — can wait

1. Multi-region / Postgres.  
2. Signed device requests / stronger auth.  
3. Moderation pipeline.  
4. Full N-way group calling architecture (LiveKit + billing).  

---

## 6. Recommended exact next prompt

**“Using `docs/LAUNCH_AUDIT_SERVER_FULL_1.md` as source of truth: (1) configure R2/S3 and verify `GET /v2/meta` shows `attachmentStorage.configured: true` and run `scripts/verify-attachment-prod.js`; (2) update mobile copy and settings so retention tiers never imply server-side message deletion; (3) reconcile `FULL_COMPLETION_SERVER_PLAN.md` group-room row with shipped `POST /v2/rooms/create`; (4) keep video hidden until LiveKit + `call-charge` support `callType: video` end-to-end.”**
