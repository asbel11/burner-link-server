# CONNECT prepaid wallet & coins — design (Phase Coins-1)

**Status:** schema + repository (**Phase Coins-2**); Stripe coin-pack Checkout, webhook crediting, and **`GET /v2/billing/wallet`** implemented (**Phase Coins-3** — see **`docs/v2-coin-wallet-billing.md`**). Call metering still out of scope.  
**Scope:** server-first model for anonymous **`deviceId`**-bound balance, ledger, and (later) Stripe-backed pack purchases.  
**Out of scope:** voice/video media implementation, mobile UI, call signaling (metering may use **`applyLedgerDebit`** + ledger metadata).

**Related:** **`docs/v2-connect-membership.md`** (Pro subscription), **`docs/v2-retention.md`** / **`docs/v2-stripe-checkout.md`** (room retention), **`docs/v2-billing-ingestion.md`** (generic retention webhook).

---

## 1. Wallet model (proposed schema)

### 1.1 `device_coin_wallets` (one row per device)

| Column | Type | Notes |
|--------|------|--------|
| **`device_id`** | TEXT PK | Same opaque string as V1/V2 chat & membership. |
| **`available_coins`** | INTEGER NOT NULL | Spendable balance; **≥ 0**. |
| **`reserved_coins`** | INTEGER NOT NULL DEFAULT 0 | Held for in-flight metered usage (future); **≥ 0**, **≤ available** invariant enforced in app logic. |
| **`updated_at`** | INTEGER (ms) | Last mutation. |
| **`version`** | INTEGER NOT NULL DEFAULT 0 | Optional optimistic concurrency for debit-heavy paths later. |

**Derived (API only, not stored):** `spendable_coins = available_coins - reserved_coins` (or define `available` as already net-of-reserve — pick one convention at implementation time and document it; recommended: **`available_coins`** = wallet total credited minus debits; **`reserved_coins`** subtracted only for “soft lock” during a call).

**Simpler launch option:** omit **`reserved_coins`** and **`version`** until metering ships; add columns in a migration when calls debit mid-session.

### 1.2 `coin_ledger_entries` (append-only journal)

Every balance change is a row. The wallet row is updated in the **same transaction** as the ledger insert.

| Column | Type | Notes |
|--------|------|--------|
| **`id`** | TEXT PK (UUID) | |
| **`device_id`** | TEXT NOT NULL | FK logical to wallet. |
| **`created_at`** | INTEGER (ms) NOT NULL | |
| **`delta_coins`** | INTEGER NOT NULL | **+** credit, **−** debit. |
| **`balance_after`** | INTEGER NULL | Snapshot after this row (optional but useful for support/debug). |
| **`entry_kind`** | TEXT NOT NULL | e.g. `purchase_credit`, `admin_adjust`, `call_debit`, `call_refund`, `reserve_hold`, `reserve_release`. |
| **`idempotency_key`** | TEXT NOT NULL | **UNIQUE** (globally or scoped per `device_id` + key — recommend **global unique** for Stripe event ids). |
| **`stripe_checkout_session_id`** | TEXT NULL | When source is Checkout one-time pack. |
| **`stripe_payment_intent_id`** | TEXT NULL | If populated by webhook. |
| **`pack_id`** | TEXT NULL | e.g. `coins_100` — see §2. |
| **`metadata_json`** | TEXT NULL | Small JSON blob (tariff version, call session id, seconds billed, etc.). |

**Rules**

- **Idempotent purchase crediting:** webhook handler does `INSERT` ledger with **`idempotency_key = stripe_event.id`** (or `checkout.session.id` + suffix if one session maps to one credit). On unique conflict, **no second credit**.
- Mirror existing pattern: optional table **`coin_stripe_events (event_id PRIMARY KEY, device_id, kind, created_at)`** with `INSERT OR IGNORE` before applying credit (same idea as **`membership_stripe_events`**).
- **Never** delete ledger rows; corrections use offsetting **`admin_adjust`** (or support tooling) with audit metadata.

### 1.3 Optional: `coin_packs` (catalog) vs config

**Launch-friendly:** define packs in **server config / env** (Price IDs) rather than a DB table:

- `CONNECT_COIN_PACKS_JSON` or discrete env vars `STRIPE_PRICE_COIN_PACK_100`, etc.

**Later:** migrate to `coin_product_catalog` if merchandising grows.

---

## 2. Coin packs (launch-friendly)

Keep a **small** matrix so pricing is easy to explain.

| Pack id | Coins | Indicative price (USD) | Role |
|---------|-------|------------------------|------|
| **`coins_100`** | 100 | ~$0.99 | Try / top-up |
| **`coins_500`** | 500 | ~$3.99 | Better per-coin |
| **`coins_1200`** | 1200 | ~$7.99 | Best value |

Exact prices live in **Stripe Prices**; server maps **`pack_id` → price_id → coins_granted** at Checkout creation and again in webhook validation (grant only what server expects for that Price).

**Stripe Checkout:** **`mode: payment`**, one-time. Session metadata:

- **`deviceId`**
- **`connectBilling`:** **`coin_pack`**
- **`packId`:** e.g. **`coins_500`**
- **`coinsGranted`:** numeric string (server echo for webhook sanity check)

---

## 3. Prepaid usage (future voice/video) — design only

### 3.1 What the server stores

| Approach | Pros | Cons |
|----------|------|------|
| **Coins only in ledger** | Simple UX; one unit | Need a published **tariff** (coins per minute / per segment). |
| **Seconds + coins in metadata** | Auditable, disputes | More columns / events. |

**Recommendation:** **Ledger in coins**; each debit row’s **`metadata_json`** includes **`billed_seconds`**, **`tariff_version`**, and optional **`call_session_id`**. Server config holds **coins per second** or **coins per started minute** (integer math avoids floats).

### 3.2 Reserved balance (optional, phase 2)

1. **Start call (future):** in a transaction, increase **`reserved_coins`** by **estimate** (or max per minute × cap), decrease spendable for the session; insert ledger **`reserve_hold`** (optional) or only mutate wallet.
2. **End call:** compute actual coins from **`billed_seconds`**; **`reserve_release`** + **`call_debit`** net to final charge; never let **`available_coins`** go negative — reject start if insufficient spendable.

### 3.3 Simple UX

- Show **one balance** in the app: **spendable coins**.
- **Pro (optional later):** members get **discounted tariff** or **monthly included minutes** — still separate tables/flags from wallet balance.

---

## 4. Proposed API surface (minimal)

All routes require validated **`deviceId`** (same as existing billing routes). **No** Stripe secrets or customer ids in responses.

| Method | Path | Status | Purpose |
|--------|------|--------|---------|
| **GET** | **`/v2/billing/wallet?deviceId=`** | **Shipped** | **`availableCoins`**, **`reservedCoins`**, **`spendableCoins`**, **`updatedAt`** (ISO or **`null`** if never touched). See **`docs/v2-coin-wallet-billing.md`**. |
| **POST** | **`/v2/billing/create-coin-checkout-session`** | **Shipped** | Body: **`deviceId`**, **`packId`**, optional **`successUrl`/`cancelUrl`**. Returns **`sessionId`**, **`url`**, **`packId`**, **`coins`**. |
| **GET** | **`/v2/billing/wallet/transactions?deviceId=`** | **Not yet** | Optional: **`limit`** (default 20, max 100). Repository has **`listLedgerEntries`** — HTTP route can be added when mobile needs history. |

**Webhook:** **`POST /v2/webhooks/stripe`** — on **`checkout.session.completed`** with **`metadata.connectBilling=coin_pack`**, validate catalog + metadata; **credit** via **`applyLedgerCredit`** with **`idempotencyKey = event.id`**. Implemented in **`src/stripeCoinPackWebhook.js`** (after membership, before retention).

**Optional later:** **`POST /v2/internal/wallet/adjust`** (ops, guarded by secret) — out of scope for v1.

---

## 5. How purchases map to `deviceId`

1. **Client** calls **`create-coin-checkout-session`** with **`deviceId`** (same anonymous id as chat).
2. Server creates Stripe Checkout Session with **`client_reference_id`** or **`metadata.deviceId`** (and **`metadata.packId`**, **`metadata.connectBilling=coin_pack`**).
3. User pays; Stripe sends **`checkout.session.completed`**.
4. Webhook reads **`metadata.deviceId`** (and validates session belongs to expected pack); runs idempotent credit.
5. **No** email or phone required for chat; Stripe may collect payment method only — **billing identity remains server-side + Stripe**, not exposed to peers.

If **`deviceId`** is missing in metadata, **do not** credit; log and alert (same discipline as membership).

---

## 6. Coexistence: Pro, prepaid wallet, retention

| Concern | Model | Key |
|---------|--------|-----|
| **CONNECT Pro** | Subscription; **`device_memberships`** | **`device_id`** |
| **Prepaid coins** | Balance + ledger; **`device_coin_wallets`** | **`device_id`** |
| **Room retention** | Room-scoped tier / until; **`rooms`**, **`retention_purchases`** | **`device_id`** for purchase attribution + **`room_id`** |

**Compatibility**

- Same **`deviceId`** across all three; **orthogonal products**: Pro does not consume coins for subscription renewal; retention purchases do not change coin balance unless you explicitly bundle a promo later.
- **Future:** Pro could grant **`included_coins_per_month`** (separate grant ledger entries) or **reduced per-minute coin rate** (tariff flag on **`device_memberships`** or env keyed by `isMember`).

---

## 7. Anonymity & safety

- **Wallet is device-bound**, not user-profile-bound: no requirement for display name, email, or phone to **chat**.
- **Wallet APIs** return balance and transaction types only — **no** linkage to other users’ **`deviceId`** or room content.
- **Chat routes** must **not** echo wallet balance or “rich/poor” signals to peers; any future “premium badge” is a **product decision** and should default **off** for CONNECT anonymity.
- **Stripe** holds payment instrument; server stores **opaque** `device_id` ↔ customer mapping only where needed (reuse **`device_memberships.stripe_customer_id`** pattern if same customer buys packs and membership).

---

## 8. Recommended implementation order

| Phase | Work |
|-------|------|
| **Coins-2 — Schema** | Done: **`device_coin_wallets`**, **`coin_ledger_entries`**, **`createCoinWalletRepository`**, **`src/coinEntryKinds.js`**, tests (**`test/coin-wallet-repository.test.js`**). |
| **Coins-3 — Checkout, webhook, read** | Done: **`POST /v2/billing/create-coin-checkout-session`**, **`GET /v2/billing/wallet`**, **`processCoinPackStripeEvent`** + **`stripeCoinPackCheckout.js`**, tests (**`test/coin-pack-billing.test.js`**, **`test/stripe-webhook.test.js`** coin cases). |
| **Call-Meter-1 — Spend / debit API** | Done: **`POST /v2/billing/spend-coins`** (`call_debit`), **`src/connectCoinSpend.js`**, tests (**`test/coin-spend.test.js`**). See **`docs/v2-coin-wallet-billing.md`**. |
| **Call-Meter-2 — Tariff + reserve + settle** | Done: **`POST /v2/billing/call-charge/start`**, **`POST /v2/billing/call-charge/settle`**, **`CONNECT_CALL_TARIFF_JSON`**, **`applyCallSessionSettlement`**, tests (**`test/call-charge-billing.test.js`**). See **`docs/connect-call-charging.md`**. |
| **Coins-4 — Optional** | **`GET /v2/billing/wallet/transactions`** wrapping **`listLedgerEntries`**; or skip until product needs history in-app. |
| **Call-Meter-3 — Media / signaling (future)** | Wire real **`billedSeconds`** from SFU or client timers; optional auth on billing routes. |

---

## 9. Exact next implementation phase (recommended prompt)

**“Phase Call-Meter-3 (server or client): integrate call duration metering with `call-charge/start` and `call-charge/settle`, or Phase Coins-4: `GET /v2/billing/wallet/transactions` backed by `listLedgerEntries`.”**

---

## 10. Repository contract (Coins-2 — implemented)

Code: **`src/store/coinWalletRepository.js`** (`createCoinWalletRepository(db)`), entry kinds **`src/coinEntryKinds.js`**, exposed as **`createRoomStore().coins`**.

| Method | Purpose |
|--------|---------|
| **`getOrCreateWallet(deviceId)`** | Ensures a wallet row exists; returns **`{ deviceId, availableCoins, reservedCoins, spendableCoins, updatedAt, version }`**. |
| **`getWallet(deviceId)`** | Returns the same shape or **`null`** if never created. |
| **`applyLedgerCredit(params)`** | **`entryKind`:** **`purchase_credit`** \| **`admin_adjust_credit`**. Increases **`available_coins`**. |
| **`applyLedgerDebit(params)`** | **`entryKind`:** **`call_debit`** \| **`admin_adjust_debit`**. Decreases **`available_coins`** if **`available - reserved ≥ amount`**. |
| **`applyReserveHold` / `applyReserveRelease`** | Adjust **`reserved_coins`**; ledger row has **`delta_coins = 0`**; **`balance_after`** is **`available_coins`** after the op. |
| **`applyCallSessionSettlement(params)`** | **Call-Meter-2:** atomic **`call:<sessionId>:release`** (if **`releaseCoins` > 0) + **`call:<sessionId>:settle`** (`call_debit`, possibly 0 coins); duplicate **`settle`** key → **`duplicate: true`**. |
| **`listLedgerEntries(deviceId, { limit? })`** | Newest first; **`limit`** clamped 1–100 (default 20). |

**Idempotency:** **`idempotency_key`** is **globally UNIQUE** in SQLite. A second call with the same key and same **`deviceId`** returns **`{ ok: true, duplicate: true, wallet, entry }`** and **does not** change balance. Same key for a **different** **`deviceId`** → **`{ ok: false, reason: 'idempotency_key_conflict' }`**.

**Crediting from Stripe (next phase):** In **`checkout.session.completed`**, validate metadata, then e.g. **`applyLedgerCredit({ deviceId, amount: coinsGranted, idempotencyKey: event.id, entryKind: 'purchase_credit', packId, stripeCheckoutSessionId: session.id })`**.

**Debiting for calls:** Prefer **`POST /v2/billing/call-charge/settle`** (uses **`applyCallSessionSettlement`**) or, for ad-hoc usage, **`applyLedgerDebit`** / **`POST /v2/billing/spend-coins`** with **`entryKind: 'call_debit'`** and stable idempotency keys. See **`docs/connect-call-charging.md`**.

**Anonymity:** No email/phone; only **`deviceId`** on wallet and ledger rows.
