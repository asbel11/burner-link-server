# CONNECT server — environment checklist (Stripe + sessions)

Use this when deploying the **burner-link-server** (Railway, Docker, etc.). Values are read from `process.env` (see `require("dotenv").config()` in `server.js`).

## Membership Checkout (`POST /v2/billing/create-membership-checkout-session`)

The mobile error **`Stripe API is not configured (set STRIPE_SECRET_KEY)`** means **`getStripeApiClient()`** returned `null`: the Stripe **secret key** is missing or empty in that environment.

| Variable | Required for Checkout | Purpose |
|----------|----------------------|---------|
| **`STRIPE_SECRET_KEY`** | **Yes** | `sk_test_…` / `sk_live_…`. Without it, **all** Stripe API calls fail: membership Checkout, retention Checkout, Customer Portal, and webhook handlers that call `subscriptions.retrieve`. |
| **`STRIPE_PRICE_CONNECT_MEMBERSHIP`** | **Yes** | Stripe **Price** ID for the CONNECT Pro subscription product. Without it → **`503`** `price_not_configured`. |
| **`STRIPE_CHECKOUT_SUCCESS_URL`** | Conditional* | Default redirect after successful payment if not sent in the JSON body. |
| **`STRIPE_CHECKOUT_CANCEL_URL`** | Conditional* | Default redirect if the user cancels Checkout. |

\* **Either** send **`successUrl`** and **`cancelUrl`** in the request body **or** set both env vars. See **`docs/v2-connect-membership.md`**.

### Webhooks (separate from the Checkout error above)

| Variable | Purpose |
|----------|---------|
| **`STRIPE_WEBHOOK_SECRET`** | Verifies **`POST /v2/webhooks/stripe`**. **Does not** satisfy `STRIPE_SECRET_KEY`; Checkout still needs the secret key. |
| **`STRIPE_SECRET_KEY`** | Still needed for membership **`invoice.paid`** / subscription retrieval paths that load the Subscription from Stripe. |

**Summary:** Set **`STRIPE_SECRET_KEY`** and **`STRIPE_PRICE_CONNECT_MEMBERSHIP`** on the same service that serves the API. Configure success/cancel URLs in Stripe Dashboard or env. Configure **`STRIPE_WEBHOOK_SECRET`** for webhooks in addition.

## Customer Portal (`POST /v2/billing/create-portal-session`)

| Variable | Purpose |
|----------|---------|
| **`STRIPE_SECRET_KEY`** | Required (same as above). |
| **`STRIPE_CUSTOMER_PORTAL_RETURN_URL`** | Default **`return_url`** after the user leaves the portal, unless **`returnUrl`** is in the body. |

## Session / room auto-end (V1 heartbeat)

Rooms become **`ended`** when:

1. **`POST /sessions/end`** (explicit burn), or  
2. **`POST /sessions/heartbeat`** with **legacy auto-end** enabled (see below).

There is **no** background cron ending rooms.

### CONNECT default (durable active rooms)

**`CONNECT_DISABLE_SESSION_AUTO_END`** (default when **unset**: **on**)

- When unset or empty, the server **forces** **`SESSION_HEARTBEAT_AUTO_END` off** for heartbeat handling, even if some host template set **`SESSION_HEARTBEAT_AUTO_END=true`**.  
- This matches **CONNECT** product direction: rooms should not disappear because a peer went offline for ~30s.

To re-enable the old Burner-style “stale peer + inactivity burns the session” behavior:

- Set **`CONNECT_DISABLE_SESSION_AUTO_END=0`** (or `false` / `off`), **and**
- Set **`SESSION_HEARTBEAT_AUTO_END=1`** (or `true`).

Optional tuning when legacy auto-end is on:

| Variable | Default | Meaning |
|----------|---------|---------|
| **`OFFLINE_TIMEOUT_MS`** | `30000` | How old the other device’s `last_seen` must be before considered “offline”. |
| **`INACTIVITY_BEFORE_BURN_MS`** | `30000` | How long since **`last_message_at`** before burn is allowed. |

See **`docs/session-lifecycle.md`**.

## What still ends rooms (unchanged)

- Clients calling **`POST /sessions/end`** or any product flow that maps to it.  
- SQLite file loss on ephemeral disks (data loss), not normal “ended” semantics.
