# CONNECT Pro — membership (Stripe subscription)

Server-only billing identity is keyed by **`deviceId`** (same anonymous id as chat). This document covers checkout, Stripe webhooks, read-only status, and environment variables. Stripe customer/subscription identifiers are stored server-side and are **not** exposed on messaging routes or the membership status API.

**Deployment checklist (Stripe keys, Checkout URLs, webhooks):** **`docs/connect-server-environment.md`**.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| **`STRIPE_SECRET_KEY`** | For Checkout + webhook subscription API calls | Creates Checkout Sessions and lets **`POST /v2/webhooks/stripe`** load Subscriptions when metadata is on the subscription. |
| **`STRIPE_WEBHOOK_SECRET`** | For webhooks | Verifies **`POST /v2/webhooks/stripe`**. |
| **`STRIPE_PRICE_CONNECT_MEMBERSHIP`** | For membership Checkout | Stripe **Price** ID for the recurring CONNECT Pro product (subscription mode). |
| **`STRIPE_CHECKOUT_SUCCESS_URL`** | Conditional* | Default success URL for Checkout if not sent in the request body. |
| **`STRIPE_CHECKOUT_CANCEL_URL`** | Conditional* | Default cancel URL for Checkout if not sent in the request body. |
| **`CONNECT_MEMBER_RETENTION_TIER`** | Optional | Included room retention tier for **active** members (default **`30_days`**). Must be one of **`7_days`**, **`30_days`**, **`permanent`** if set; invalid values fall back to the default. Same value drives retention overlay on room APIs and the membership status field **`includedRetentionTier`**. |
| **`STRIPE_CUSTOMER_PORTAL_RETURN_URL`** | Conditional* | Default **`return_url`** after the user leaves **Stripe Customer Portal** (manage/cancel subscription). Required for **`POST /v2/billing/create-portal-session`** unless the client sends **`returnUrl`** in the body. |

\* For membership Checkout, **either** pass **`successUrl`** and **`cancelUrl`** in the JSON body **or** set both default URL env vars.

\* For Customer Portal, **either** pass **`returnUrl`** in the portal request body **or** set **`STRIPE_CUSTOMER_PORTAL_RETURN_URL`** on the server.

## Checkout — start subscription

**`POST /v2/billing/create-membership-checkout-session`**

- **Body (JSON):** **`deviceId`** (required), **`successUrl`**, **`cancelUrl`** (optional if env defaults exist).
- **Response (`200`):** **`sessionId`**, **`url`** (hosted Stripe Checkout URL, **`mode: subscription`**).
- **Errors:** **`400`** invalid/missing device or URLs; **`503`** Stripe or price not configured.

Checkout sets metadata on the session and on **`subscription_data.metadata`**:

- **`deviceId`**
- **`connectBilling`:** **`membership`**
- **`membershipTier`:** e.g. **`pro`**

See also: retention one-time Checkout in **`docs/v2-stripe-checkout.md`**.

## Stripe webhooks — membership

Handled **before** retention parsing on **`POST /v2/webhooks/stripe`**. Events that match **membership** subscription metadata (**`connectBilling=membership`**) update **`device_memberships`**; other events fall through to existing retention behavior (**`docs/v2-stripe-webhooks.md`**).

| Event | Effect |
|-------|--------|
| **`checkout.session.completed`** (`mode: subscription`, membership metadata) | Activate: set subscription period end, link **`deviceId`**. |
| **`invoice.paid`** (subscription has membership metadata) | Renew: extend **`membership_active_until`**. |
| **`invoice.payment_failed`** (membership subscription) | Expire membership for that device (immediate lapse). |
| **`customer.subscription.deleted`** (membership metadata) | Expire at subscription **`current_period_end`**. |

Idempotency uses Stripe **`event.id`** in **`membership_stripe_events`**.

## Membership status — mobile refresh after Checkout

**`GET /v2/billing/membership?deviceId=<deviceId>`**

- **Query:** **`deviceId`** (required) — non-empty string (same validation as other V2 routes using device id).
- **Response (`200`):** JSON object (see contract below).
- **Errors:** **`400`** missing/invalid **`deviceId`**.

Use this after returning from Stripe Checkout success URL to refresh CONNECT Pro UI without exposing Stripe ids.

### Membership status response contract

| Field | Type | Description |
|-------|------|-------------|
| **`deviceId`** | string | Echo of the query device id. |
| **`isMember`** | boolean | **`true`** iff **`membership_active_until`** is set and in the future. |
| **`membershipTier`** | string \| null | e.g. **`pro`** when a row exists; **`null`** if the device has never had a membership row. |
| **`membershipActiveUntil`** | string \| null | ISO-8601 UTC end of current paid period, or last recorded boundary when inactive; **`null`** if never subscribed. |
| **`includedRetentionTier`** | string | Tier included with active membership for room retention overlay (from **`CONNECT_MEMBER_RETENTION_TIER`**, default **`30_days`**). Always present so the client can show “what Pro includes” even when **`status`** is **`none`**. |
| **`status`** | string | **`none`** — no row; never subscribed. **`active`** — paid period active. **`inactive`** — row exists but period ended or was expired by webhook. |

Stripe **`customer`** / **`subscription`** ids are **not** included in this response.

### Example — active

```json
{
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "isMember": true,
  "membershipTier": "pro",
  "membershipActiveUntil": "2026-05-16T12:00:00.000Z",
  "includedRetentionTier": "30_days",
  "status": "active"
}
```

### Example — never subscribed

```json
{
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "isMember": false,
  "membershipTier": null,
  "membershipActiveUntil": null,
  "includedRetentionTier": "30_days",
  "status": "none"
}
```

## Customer Portal — manage or cancel (Stripe hosted)

**`POST /v2/billing/create-portal-session`**

Opens Stripe **Customer Portal** so the user can update payment method, cancel, or resume subscription (per your [Stripe Dashboard](https://dashboard.stripe.com/settings/billing/portal) configuration).

### Request body (JSON)

| Field | Required | Description |
|-------|----------|-------------|
| **`deviceId`** | yes | Same anonymous id as chat; must have completed membership Checkout at least once so **`stripe_customer_id`** is stored. |
| **`returnUrl`** | conditional* | Absolute **`http://`** or **`https://`** URL where Stripe redirects the user **after** they leave the portal (e.g. deep link or web route in your app). |

\* **Either** send **`returnUrl`** **or** configure **`STRIPE_CUSTOMER_PORTAL_RETURN_URL`** on the server. If both are missing, **`400`** **`reason: missing_return_url`**.

### Successful response (`200`)

```json
{
  "url": "https://billing.stripe.com/p/session/..."
}
```

Open **`url`** in an in-app browser / WebView; when the user finishes, Stripe sends them to **`returnUrl`**.

### Errors

| Status | `reason` (typical) | Meaning |
|--------|-------------------|---------|
| **`400`** | **`invalid_device_id`** | Missing/empty **`deviceId`**. |
| **`400`** | **`missing_return_url`** / **`invalid_return_url`** | No valid portal return URL (set env or pass **`returnUrl`**). |
| **`404`** | **`membership_not_found`** | No row in **`device_memberships`** for this device (never subscribed via membership Checkout). |
| **`404`** | **`stripe_customer_not_linked`** | Row exists but **`stripe_customer_id`** was never set (complete Checkout once). |
| **`502`** | **`stripe_portal_error`** | Stripe API error (e.g. portal not activated in Dashboard, invalid customer). Response may include **`detail`**. |
| **`503`** | **`stripe_not_configured`** | **`STRIPE_SECRET_KEY`** not set. |

### Production notes

- Enable and configure **Customer Portal** in Stripe (**Settings → Billing → Customer portal**): allowed actions, products, cancellation behavior, etc.
- Use **HTTPS** **`returnUrl`** in production; Stripe validates the URL shape server-side.
- Treat **`returnUrl`** as untrusted input only in the sense of validation: the server checks it is a valid **`http:`** / **`https:`** URL. Your app should still only pass URLs you control (or fixed deep links).
- After the user returns from the portal, call **`GET /v2/billing/membership`** to refresh CONNECT Pro UI (webhooks update entitlement asynchronously).

## Retention overlay

When **`isMember`** is **`true`**, room list/detail/retention GET responses apply the included tier per **`docs/v2-retention.md`** and server **`retentionViewForDevice`** (source **`connect_membership`** when the overlay applies).

## Anonymity

- No email or account id is required for chat or for membership APIs.
- **`deviceId`** is the only client-supplied identity on **`GET /v2/billing/membership`** and **`POST /v2/billing/create-portal-session`** (Stripe resolves the linked customer server-side).
