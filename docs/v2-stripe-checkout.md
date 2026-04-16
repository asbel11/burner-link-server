# Stripe Checkout — retention purchases (Phase 22)

For **CONNECT Pro** subscription checkout (**`POST /v2/billing/create-membership-checkout-session`**) and membership webhooks/status, see **`docs/v2-connect-membership.md`**.

## Route

**`POST /v2/rooms/:roomId/billing/create-checkout-session`**

Creates a **Stripe Checkout Session** in **`payment`** mode (one-time charge per tier). After payment, Stripe sends **`checkout.session.completed`** to **`POST /v2/webhooks/stripe`**, which grants retention using the same metadata contract as **`docs/v2-stripe-webhooks.md`**.

## Request body (JSON)

| Field | Required | Description |
|-------|----------|-------------|
| **`deviceId`** | yes | Must already be linked to the room (`device_room_links`). |
| **`retentionTier`** | yes | **`7_days`**, **`30_days`**, or **`permanent`**. |
| **`retentionUntil`** | no | Optional string passed through to session metadata (webhook parser). |
| **`successUrl`** | conditional* | Where Stripe redirects after successful payment. |
| **`cancelUrl`** | conditional* | Where Stripe redirects if the user cancels. |

\* **Either** provide **both** `successUrl` and `cancelUrl` in the body **or** set both env vars **`STRIPE_CHECKOUT_SUCCESS_URL`** and **`STRIPE_CHECKOUT_CANCEL_URL`**. If one side is missing, the server returns **`400`** **`reason: missing_checkout_urls`**.

Stripe allows placeholders such as `{CHECKOUT_SESSION_ID}` in URLs (see [Stripe docs](https://docs.stripe.com/payments/checkout/custom-success-page)).

## Successful response (`200`)

```json
{
  "sessionId": "cs_test_...",
  "url": "https://checkout.stripe.com/c/pay/cs_test_...",
  "roomId": "<same as path>",
  "retentionTier": "30_days"
}
```

## Access rules

- Room must exist, not soft-deleted, and **`state === 'active'`**.
- Caller must be **linked** to the room (same model as other V2 room routes).
- Ended or deleted rooms: **`409`** / **`410`** as appropriate; unlinked device: **`403`**.

## Environment variables

### Required for this endpoint

| Variable | Purpose |
|----------|---------|
| **`STRIPE_SECRET_KEY`** | `sk_test_…` / `sk_live_…` — creates Checkout Sessions via the Stripe API. Without it, **`503`** **`stripe_not_configured`**. |

### Price IDs (per tier)

Each tier must map to a **one-time** Stripe Price ID (Dashboard → Product catalog → create Prices with **one-time** billing).

| Env var | Tier |
|---------|------|
| **`STRIPE_PRICE_RETENTION_7_DAYS`** | `7_days` |
| **`STRIPE_PRICE_RETENTION_30_DAYS`** | `30_days` |
| **`STRIPE_PRICE_RETENTION_PERMANENT`** | `permanent` |

If the tier is valid but the env var is unset, **`503`** **`reason: price_not_configured`** and **`envKey`** names the missing variable.

### Optional default redirect URLs

| Variable | Purpose |
|----------|---------|
| **`STRIPE_CHECKOUT_SUCCESS_URL`** | Default success URL if not sent in the body. |
| **`STRIPE_CHECKOUT_CANCEL_URL`** | Default cancel URL if not sent in the body. |

### Webhook (unchanged)

| Variable | Purpose |
|----------|---------|
| **`STRIPE_WEBHOOK_SECRET`** | Verifies **`POST /v2/webhooks/stripe`**. |

## Payment model (this phase)

- **Mode:** **`payment`** — single charge, not a recurring subscription.
- **Renewals:** Later you can add subscription Prices and **`mode: subscription`**; today all three tiers are **one-time** purchases so **`checkout.session.completed`** is sufficient for entitlement.

## Metadata attached to Checkout

The server sets (string values only):

- **`metadata`** on the Checkout Session: **`roomId`**, **`deviceId`**, **`retentionTier`**, and optionally **`retentionUntil`**.
- **`payment_intent_data.metadata`**: same key/value copy for PaymentIntent-level visibility.

**`client_reference_id`:** **`{roomId}:{deviceId}`** (truncated to 500 chars) for support/debug; entitlement still comes from **`metadata`** in the webhook.

## Test vs live

- Use **test** API keys (`sk_test_…`, `whsec_…` from test webhook endpoints) and **test** Price IDs in development.
- Production: **live** keys, **live** Prices, HTTPS **`successUrl` / `cancelUrl`** (or env defaults).

## Checkout session status (Phase 24 — post-return reliability)

**`GET /v2/rooms/:roomId/billing/checkout-session/:sessionId?deviceId=...`**

Returns Stripe **`payment_status`** / session status plus current **`retention`** and **`entitlementInSync`**. Use after redirect so the UI can distinguish **payment complete** vs **webhook still pending**. See **`docs/v2-checkout-return-production.md`**.

## What the mobile app does next (not in this repo)

- Call create-checkout-session with **`deviceId`** and tier, open **`url`** in an in-app browser / custom tab.
- On return, call **`GET .../billing/checkout-session/:sessionId`**, then poll **`GET /v2/rooms/:roomId/retention`** with bounded backoff until the tier matches — see **`docs/v2-checkout-return-production.md`** and **`src/retentionSyncPolicy.js`**.
