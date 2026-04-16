# Stripe webhooks → CONNECT retention (Phase 21)

## Route

- **`POST /v2/webhooks/stripe`**
- **Raw body required:** the server registers this route **before** `express.json()` so Stripe’s HMAC is computed over the **exact** JSON bytes Stripe sent.
- **Signature:** standard **`Stripe-Signature`** header verified with **`STRIPE_WEBHOOK_SECRET`** (`whsec_…` from the Stripe Dashboard or `stripe listen`).

If **`STRIPE_WEBHOOK_SECRET`** is unset or empty → **`503`**, **`reason: stripe_webhook_not_configured`**.

Invalid or missing signature → **`400`**, **`reason: invalid_signature`** or **`missing_signature`**.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| **`STRIPE_WEBHOOK_SECRET`** | yes (route enabled) | Webhook signing secret |
| **`STRIPE_SECRET_KEY`** | optional | `sk_…` — used only to **`subscriptions.retrieve`** on **`invoice.paid`** when invoice metadata is empty but **`invoice.subscription`** is set (renewals with metadata on the subscription). |
| **`STRIPE_WEBHOOK_VERIFICATION_KEY`** | optional | Fallback API key string for constructing the Stripe SDK instance used **only** for `constructEvent` if **`STRIPE_SECRET_KEY`** is unset (must still be a syntactically valid `sk_` test key in practice). |

## Supported Stripe event types

| Event | Behavior |
|-------|----------|
| **`checkout.session.completed`** | Grants/extends retention from **`session.metadata`**. |
| **`invoice.paid`** | Grants/extends from **`invoice.metadata`**, or from **subscription metadata** if **`STRIPE_SECRET_KEY`** is set and metadata was copied onto the Subscription. |
| **All other types** | **`200`** `{ received: true, ignored: true, type }` — no entitlement change. |

### CONNECT Pro membership (subscription)

If the session or subscription carries **`connectBilling=membership`** metadata, the server applies **device-level membership** first (see **`docs/v2-connect-membership.md`**) before the retention rules above. Retention-only Checkout remains **`mode: payment`**; membership Checkout uses **`mode: subscription`**.

## Required metadata (string keys)

Stripe metadata values are **strings**. The server expects:

| Key | Required | Values |
|-----|----------|--------|
| **`roomId`** | yes | CONNECT room id (same as V1 `sessionId`). |
| **`deviceId`** | yes | Device that must already have **`device_room_links`** for that room. |
| **`retentionTier`** | yes | **`7_days`**, **`30_days`**, or **`permanent`** (case-insensitive). |
| **`retentionUntil`** | no | Optional advisory end: Unix **seconds** or **ms** as decimal string, or ISO date string — passed through the same parser as generic billing. |

### Where to attach metadata

- **Checkout (one-time or subscription):** set **`metadata`** on the **Checkout Session** (and, for subscriptions, also set the same keys on **`subscription_data.metadata`** so renewals carry them on the **Subscription** for **`invoice.paid`**).
- **Invoices:** you may set **`metadata`** on the **Invoice** when possible; otherwise ensure **`STRIPE_SECRET_KEY`** is configured and metadata lives on the **Subscription**.

## Idempotency and `retention_purchases`

- **Idempotency key:** Stripe **`event.id`** (e.g. `evt_…`) is stored as **`idempotency_key`** with **`idempotency_provider = stripe`**.
- **Replays:** Stripe retries the **same** event id; the second delivery returns **`200`** with **`duplicate: true`** (same as generic billing).
- **Renewals:** each new invoice payment produces a **new** Stripe event id → a **new** entitlement row; timed tiers **extend** per existing rules (`max` of window for same tier).

## Retention source

Verified Stripe grants set **`rooms.retention_source`** and **`retention_purchases.source`** to **`stripe`** (normalized).

## Relation to generic billing

- **`POST /v2/webhooks/billing`** (shared secret) remains for non-Stripe or internal bridges.
- Both paths call **`applyRetentionEntitlementFromNormalizedInput`** → **`rooms.applyBillingRetentionEntitlement`**.

## Relation to Checkout (Phase 22)

- **`POST /v2/rooms/:roomId/billing/create-checkout-session`** creates hosted Checkout with **`metadata`** matching this document. See **`docs/v2-stripe-checkout.md`**.

## What is still out of scope

- Mobile WebView / in-app browser wiring (server returns **`url`** only).
- Stripe Connect-specific settlement flows.
- TTL deletion of messages.
- Validating that the paying Stripe customer matches **`deviceId`** (trust model: metadata is set only by your trusted checkout backend).
