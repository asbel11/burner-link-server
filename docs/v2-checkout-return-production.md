# Checkout return flow — production reliability (Phase 24)

This document hardens the **paid retention** path: Stripe-hosted Checkout → redirect back to the app → entitlement synced via webhook, with **clear client behavior** when the webhook lags.

## 1. Return URL strategy (audit)

### Stripe requirements

- **`success_url`** and **`cancel_url`** must be **absolute URLs** with a **valid scheme** (`https://` for production). Stripe documents this for Checkout Session creation.
- **Custom URL schemes** (`burnerlink://…`) are often used in **development** so the OS opens the app directly. Stripe **accepts** non-HTTPS schemes in many configurations, but **production** should prefer **HTTPS** so:
  - App Links (Android) and Universal Links (iOS) validate against **`https`** host + `/.well-known/` files.
  - Users without the app still land on a real web page (fallback).

### Recommended split

| Environment | Success / cancel URLs |
|-------------|------------------------|
| **Dev** | Custom scheme **or** HTTPS tunnel (ngrok, etc.) for parity testing. |
| **Production** | **HTTPS** on a domain you control, configured for **Universal Links** / **App Links**, with a **fallback** web page that explains how to open the app or deep link. |

### Universal Links / App Links (implementation-ready)

1. Host **`https://yourdomain.com/...`** paths used in `success_url` / `cancel_url`.
2. **iOS:** Apple App Site Association file at `https://yourdomain.com/.well-known/apple-app-site-association` (no extension), signed by HTTPS.
3. **Android:** Digital Asset Links at `https://yourdomain.com/.well-known/assetlinks.json`.
4. Path examples:
   - Success: `https://yourdomain.com/connect/billing/return?result=success&roomId={ROOM}&session_id={CHECKOUT_SESSION_ID}`
   - Cancel: `https://yourdomain.com/connect/billing/return?result=cancel&roomId={ROOM}`

Use placeholders Stripe supports (e.g. `{CHECKOUT_SESSION_ID}`) where applicable; pass **`roomId`** via your app when **building** URLs in the create-checkout-session call (query template your server fills).

### Fallback if app not installed

The HTTPS URL should render a **simple landing page** (“Open in Burner Link” / store links). Do not assume the custom scheme alone is enough for production.

---

## 2. Production return contract (authoritative)

After the user completes or cancels Checkout:

1. **Success / cancel** is determined by **which URL** loaded (success vs cancel), not by guessing.
2. **Payment certainty** (money captured) for success flows:
   - **Primary:** Server **`GET /v2/rooms/:roomId/billing/checkout-session/:sessionId`** (see below) returns Stripe’s **`payment_status`** / **`sessionStatus`** — use this for “Stripe says paid” **before** your DB webhook finishes.
   - **Entitlement certainty:** **`GET /v2/rooms/:roomId/retention`** matches the **purchased tier** (and typically `retentionSource: stripe` after webhook).

3. **Do not** show “Purchase complete” for entitlement until either:
   - **`entitlementInSync: true`** from the checkout-session status response (tier already applied), **or**
   - Bounded retention polling (below) succeeds, **or**
   - You exhaust retries and show **“Still updating — pull to refresh”** (honest state).

---

## 3. Server support: Checkout Session status

**`GET /v2/rooms/:roomId/billing/checkout-session/:sessionId?deviceId=...`**

- Requires the same **linked device** and **active room** as checkout creation.
- Calls Stripe **`checkout.sessions.retrieve`** and verifies **`metadata.roomId`** / **`metadata.deviceId`** match the request (prevents session ID guessing).
- Returns Stripe **`payment_status`**, **`sessionStatus`**, **`expectedRetentionTier`**, current **`retention`** snapshot (same shape as GET retention when allowed), and **`entitlementInSync`** (tier match).
- Use this **immediately after** redirect with **`session_id`** from the success URL so the UI can show **“Processing payment…”** vs **“Updating entitlement…”** accurately.

---

## 4. Client retry / backoff (retention only)

Webhook latency is normal. After you know **`stripePaymentComplete`** (from the endpoint above), poll **`GET /v2/rooms/:roomId/retention`** until:

- `retentionTier === expectedRetentionTier` (from checkout-session response), or  
- **max attempts** reached.

### Recommended constants (exported from `src/retentionSyncPolicy.js`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `initialDelayMs` | 400 | Wait before first retention GET after handling success URL |
| `maxDelayMs` | 6400 | Cap per sleep |
| `maxAttempts` | 14 | Hard stop |
| `backoffMultiplier` | 1.75 | Exponential spacing |
| `jitterMaxMs` | 120 | Random jitter |

Use **`delayBeforeRetentionPollAttempt(attempt)`** (0-based) for sleep duration between attempts.

**Do not** spin in a tight loop; **do not** claim success until tier matches or you show the timeout UX.

---

## 5. UX states (what the user sees)

| State | When |
|-------|------|
| **Opening checkout…** | Before `url` loads. |
| **Processing payment…** | Returned to app; Stripe session not yet `complete` / `paid` (or not yet fetched). |
| **Updating entitlement…** | Stripe shows **paid**, but `entitlementInSync === false` — webhook or DB behind. |
| **You’re all set** | `entitlementInSync === true` or retention poll matched tier. |
| **Payment canceled** | User hit cancel URL or Stripe cancel flow. |
| **Couldn’t confirm yet** | After max poll attempts — offer **pull to refresh** / retry button. |

---

## 6. Test-mode QA checklist (Stripe test cards)

Use **test** API keys and [Stripe test cards](https://docs.stripe.com/testing).

- [ ] Create checkout session (`POST .../create-checkout-session`).
- [ ] Open **`url`**, pay with **`4242 4242 4242 4242`** (success path).
- [ ] Redirect hits **HTTPS** (or dev scheme) success URL with **`session_id`** available.
- [ ] **`GET .../checkout-session/:sessionId`** → `stripePaymentComplete: true`, `expectedRetentionTier` correct.
- [ ] Webhook **`checkout.session.completed`** fires (Dashboard → Developers → Webhooks → events, or `stripe listen`).
- [ ] **`GET .../retention`** → tier updated, `retentionSource` **`stripe`** when applied.
- [ ] Cancel: open checkout, cancel → cancel URL; retention unchanged; UI shows canceled, no success toast.

---

## 7. What still blocks “go live” with real money

- **Live** Stripe keys, **live** Prices, **live** webhook endpoint (HTTPS, no tunnel).
- **Universal Links / App Links** verified on production domain.
- **App Store / Play** compliance review for digital goods if applicable.
- Operational monitoring (webhook failures, 5xx on checkout status).
- Optional: alerting if `entitlementInSync` stays false for N minutes after `stripePaymentComplete`.
