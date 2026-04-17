# CONNECT server — launch gap checklist (1:1 voice-only v1)

This document turns the **Launch-Audit** into operator-facing buckets for **`burner-link-server`** only. Scope assumed: **1:1 rooms**, **voice-only calls**, **no video**, **no groups**; features may include **coins**, **membership**, **retention labels**, and **daily free call allowance**.

Broader roadmap (media, groups, retention jobs, Pro matrix): **`docs/FULL_COMPLETION_SERVER_PLAN.md`**.

---

## 1. Must fix before launch (server + ops)

These are **blocking** for a honest, supportable public deployment at this scope.

| Item | Why | What to do |
|------|-----|------------|
| **Stripe production config** | Checkout and webhooks fail without keys. | Set **`STRIPE_SECRET_KEY`** (live), **`STRIPE_WEBHOOK_SECRET`**, product **Price IDs** (membership, retention tiers, coin packs per **`docs/connect-server-environment.md`**). Register webhook URL **`POST /v2/webhooks/stripe`** in Stripe Dashboard. |
| **Coin pack catalog** | Empty catalog → **`503`** `coin_packs_not_configured`. | Set **`CONNECT_COIN_PACKS_JSON`** and/or discrete **`STRIPE_PRICE_COINS_100`**, **`STRIPE_PRICE_COINS_300`**, **`STRIPE_PRICE_COINS_1000`** (aliases **`STRIPE_PRICE_100`** / `_300` / `_1000`). Mobile coin checkout may use **`POST /v2/billing/coin-pack/create-checkout`** (`app://` return URLs). |
| **Call tariff** | Start/settle return **`503`** without tariff. | Set **`CONNECT_CALL_TARIFF_JSON`** with at least **`voice.coinsPerSecond`**. For **voice-only** launch, **`video.coinsPerSecond`** may be **`0`** (still required by schema). |
| **LiveKit env** | Token route returns **`503`** without project keys. | Set **`LIVEKIT_URL`**, **`LIVEKIT_API_KEY`**, **`LIVEKIT_API_SECRET`** on the API host. |
| **Durable SQLite** | Ephemeral disks lose wallets and rooms. | **`DATABASE_PATH`** on a **persistent volume** (see env doc Railway hints). |
| **Product truth: retention** | **`enforcementNote`** on room APIs states TTL is **not** deleted server-side. | **Do not** market “messages auto-deleted after X” from server enforcement alone. Tier fields are **stored + displayed**; purge is **out of scope** for this server phase (see **`docs/v2-retention.md`**). |
| **Security stance: wallet / billing** | Anyone who knows a **`deviceId`** can hit wallet/spend/call-charge APIs (same as anonymous chat model). | Document for support and legal; treat as **acceptable v1** only if product accepts **device-bound secret** as bearer. Stronger auth is **not** in this checklist. |

---

## 2. Should fix soon after launch

| Item | Notes |
|------|--------|
| **Operational runbooks** | Key rotation, Stripe webhook replay monitoring, LiveKit dashboard alerts. |
| **Rate limiting / abuse** | Optional API gateway or middleware — not required for minimal v1 but reduces cost exposure. |
| **Doc drift sweeps** | Reconcile **`docs/v2-coin-wallet-billing.md`** and env doc whenever routes or env vars change. |
| **`CONNECT_MEMBER_RETENTION_TIER`** | Tune included tier for Pro overlay; defaults documented in **`src/connectMemberRetention.js`**. |

---

## 3. Later / intentionally out of scope (this repo phase)

| Item | Notes |
|------|--------|
| **Message TTL / retention purge jobs** | Would implement actual deletion or read filtering by **`retention_until`** — **not** shipped as enforcement in current code. |
| **Multi-instance / HA** | SQLite single-writer; horizontal scale needs different data layer. |
| **Cryptographic device identity** | Replacing raw **`deviceId`** bearer with signed requests or tokens. |
| **Video calls** | **`POST /v2/calls/livekit-token`** rejects **`callType !== voice`**; tariff **`video`** exists for future billing only. |
| **Group rooms** | **Server foundation:** `room_kind` / `member_cap`, `POST /v2/rooms/create` — **`docs/v2-group-rooms.md`**. Mobile / LiveKit N-way UX still out of band. |

---

## 4. Acceptable v1 launch scope (explicit)

**Acceptable** for a realistic public v1 **if** operators configure Stripe, LiveKit, tariff, DB path, and coin catalog:

- 1:1 chat and voice with **device-scoped** wallet and metered calls.
- Retention and membership **metadata** and **Stripe-driven** entitlements **as implemented**, with **no** automated message expiry.
- **Known limitation:** billing abuse mitigation is **not** server-strong beyond idempotency and ledger correctness.

**Too risky** without extra work:

- Promising **enforced** message deletion by retention tier.
- Treating **`deviceId`** as a secret suitable for **high-value** accounts without client hardening and fraud review.

---

## 5. Recommended next server prompt

**“Phase Retention-Enforce-1: add optional background job + read contract for message TTL aligned with `retention_until` / tier rank; keep idempotent deletes and list semantics documented.”**

(Only when product requires **real** storage enforcement — not required for the v1 scope above.)
