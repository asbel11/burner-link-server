# CONNECT coin wallet billing (Stripe packs — Phase Coins-3)

**Identity:** Balances are **device-bound only** (`deviceId`). Chat remains anonymous; there is **no** link to membership tier, retention purchases, or room billing in the wallet row.

## Coin pack configuration

Set **`CONNECT_COIN_PACKS_JSON`** to a JSON array of objects:

| Field | Type | Meaning |
|-------|------|---------|
| **`packId`** | string | Stable id (e.g. `coins_100`) sent by clients and echoed in Stripe metadata. |
| **`stripePriceId`** | string | Stripe **Price** id (`price_…`) for a **one-time** product. |
| **`coins`** | positive integer | Coins credited on successful payment after webhook processing. |

Example:

```json
[
  { "packId": "coins_100", "stripePriceId": "price_xxx", "coins": 100 },
  { "packId": "coins_500", "stripePriceId": "price_yyy", "coins": 500 }
]
```

Invalid rows are skipped. An empty or missing env value means **no packs** → checkout returns **`503`** `coin_packs_not_configured`.

See also **`docs/connect-server-environment.md`**.

## `POST /v2/billing/create-coin-checkout-session`

**Body (JSON):**

| Field | Required | Notes |
|-------|----------|--------|
| **`deviceId`** | yes | Non-empty string (same opaque id as V2 chat / membership). |
| **`packId`** | yes | Must match a configured pack. |
| **`successUrl`** | no* | Redirect after payment. |
| **`cancelUrl`** | no* | Redirect if user cancels. |

\* Defaults: **`STRIPE_CHECKOUT_SUCCESS_URL`** and **`STRIPE_CHECKOUT_CANCEL_URL`** (same as retention/membership checkout).

**Requires:** **`STRIPE_SECRET_KEY`**. If unset → **`503`** `stripe_not_configured`.

**Success `200`:** `{ sessionId, url, packId, coins }` (plus any fields the implementation merges from the checkout helper).

**Checkout session metadata** (for webhooks and support):

- **`deviceId`**, **`packId`**, **`connectBilling`:** `coin_pack`, **`coinsGranted`:** stringified coin count.

## `POST /v2/webhooks/stripe` (coin pack branch)

Handled **after** membership events and **before** retention entitlement mapping.

On **`checkout.session.completed`** with **`mode: payment`** and **`metadata.connectBilling === "coin_pack"`**:

1. Validates **`deviceId`** and **`packId`** from metadata.
2. Resolves **`coins`** from the **server catalog** for that **`packId`** (not from metadata alone).
3. Optionally rejects if **`coinsGranted`** in metadata does not match the catalog (tamper check).
4. Requires **`payment_status`** to be absent or **`paid`**.
5. Calls **`coins.applyLedgerCredit`** with:
   - **`entryKind`:** `purchase_credit`
   - **`idempotencyKey`:** Stripe **`event.id`**
   - **`packId`**, **`stripeCheckoutSessionId`**, **`stripePaymentIntentId`** when present
   - **`metadataJson`:** small blob including event type and pack id

**Duplicate deliveries** of the same Stripe event id return **`200`** with **`duplicate: true`** and do not increase balance.

Unknown **`packId`** (not in catalog) → **`400`** `invalid_pack_id`.

## `GET /v2/billing/wallet`

**Query:** **`deviceId`** (required, non-empty string).

**`200` when no wallet row yet:**

```json
{
  "deviceId": "...",
  "availableCoins": 0,
  "reservedCoins": 0,
  "spendableCoins": 0,
  "updatedAt": null
}
```

**`200` when wallet exists:** same shape with real balances and **`updatedAt`** as ISO-8601 from server time.

## `POST /v2/billing/spend-coins` (Phase Call-Meter-1)

Applies a **single idempotent debit** using ledger kind **`call_debit`**. Implementation: **`src/connectCoinSpend.js`** → **`coins.applyLedgerDebit`** (no duplicate balance logic).

### Spend model (contract)

| Concern | Rule |
|--------|------|
| **What is charged** | **`amount`** whole coins (positive integer). Optional **`metadata`** object is stored as **`metadata_json`** on the ledger row (e.g. `feature`, `billedSeconds`, `callSessionId` for future voice/video). Optional **`externalReference`** string for correlation. |
| **When it runs** | On demand when the client (or a future internal service) POSTs after usage is known or finalized — e.g. end of a metered segment or call. **Not** tied to chat identity; only **`deviceId`** + idempotency. |
| **Idempotency** | **`idempotencyKey`** is **global** (unique per ledger row). Retrying the **same** key with the **same** `deviceId` returns **`200`** with **`duplicate: true`** and does not double-charge. The **same** key with a **different** `deviceId` → **`409`** `idempotency_key_conflict`. |
| **Insufficient funds** | Debits use **spendable** = `available_coins - reserved_coins`. If spendable &lt; **`amount`**, **`402`** `insufficient_funds` and **no** new ledger row. Response includes current **`wallet`** snapshot when available. |
| **Reserved coins** | **`reserved_coins`** reduces spendable until **`reserve_release`** (repository). This endpoint does **not** call reserve APIs — future call flows may **hold** estimated max, then **debit** actual (and **release** remainder) in separate steps. |

### Request body (JSON)

| Field | Required | Notes |
|-------|----------|--------|
| **`deviceId`** | yes | Same opaque id as wallet / chat. |
| **`amount`** | yes | Positive integer ≤ `1e9`. |
| **`idempotencyKey`** | yes | Non-empty string, max 512 chars. Stable per logical charge (e.g. `call:<sessionId>:finalize`). |
| **`metadata`** | no | Plain JSON object; serialized server-side; max ~8KB. |
| **`externalReference`** | no | String, max 512 chars. |

### Responses

| Status | Meaning |
|--------|---------|
| **`200`** | **`{ ok: true, duplicate?, wallet, entry }`** — success; **`duplicate`** when replayed. |
| **`402`** | **`insufficient_funds`** — cannot afford **`amount`** after reserved coins. |
| **`400`** | Invalid body or debit rejected (`invalid_amount`, `invalid_metadata`, …). |
| **`409`** | **`idempotency_key_conflict`** — key already used for another device. |
| **`500`** | **`invariant_broken`** (should be rare) or server error. |

### Future voice/video path (privacy)

- **Wallet and spend are private server state** keyed by **`deviceId`**. They are **not** shown to other users in chat.
- Call signaling / SFU **must not** expose billing identity: metering can use **opaque session ids** in **`metadata`** / **`externalReference`** without phone, email, or public profile.
- **CONNECT Pro** and **retention** remain separate; this debit only affects **coin** balance.

## Separation from membership and retention

- **Membership** and **retention** flows are unchanged; they remain **device-** or **room-** scoped per their own docs.
- Coin balance **must not** be inferred from Pro status or room retention; clients should read **`GET /v2/billing/wallet`** when they need spendable coins.

## Related docs

- **`docs/connect-coins-wallet-design.md`** — ledger and schema design.
- **`docs/connect-call-charging.md`** — tariff, **`call-charge/start`**, **`call-charge/settle`**, reserve + settlement (Phase Call-Meter-2).
- **`docs/v2-stripe-webhooks.md`** — full webhook pipeline.
- **`docs/v2-connect-membership.md`** — Pro subscription (separate billing path).
- **`src/connectCoinSpend.js`** — spend request validation and HTTP mapping.
