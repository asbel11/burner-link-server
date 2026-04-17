# CONNECT server — environment checklist (Stripe + sessions)

Use this when deploying the **burner-link-server** (Railway, Docker, etc.). Values are read from `process.env` (see `require("dotenv").config()` in `server.js`).

**Launch readiness (1:1 voice-only v1):** operator buckets, acceptable scope, and out-of-scope items — **`docs/LAUNCH_GAP_CHECKLIST.md`**.

**Full product roadmap (media, groups, retention jobs, etc.):** **`docs/FULL_COMPLETION_SERVER_PLAN.md`**.

## Encrypted message payload limits (`POST /messages`, `POST /v2/rooms/:roomId/messages`)

Per-field bounds **after** JSON parse (see **`src/messagePayloadLimits.js`**). Oversized → **`413`** `payload_too_large`; malformed types → **`400`** `invalid_payload`. Independent of Express **`20mb`** body limit.

| Variable | Default | Purpose |
|----------|---------|---------|
| **`CONNECT_MESSAGE_MAX_CIPHERTEXT_CHARS`** | `25000000` | Max length of **`encrypted.ciphertext`** string. |
| **`CONNECT_MESSAGE_MAX_NONCE_CHARS`** | `4096` | Max length of **`encrypted.nonce`**. |
| **`CONNECT_MESSAGE_MAX_FILENAME_CHARS`** | `1024` | Max **`fileName`** length when present. |

See **`docs/connect-media-messages.md`**.

## Object storage — message attachments (S3-compatible)

Required for **`POST /v2/rooms/:roomId/attachments/prepare`** and related routes. Full contract: **`docs/connect-attachments-storage.md`**.

| Variable | Required | Purpose |
|----------|----------|---------|
| **`CONNECT_S3_BUCKET`** (or **`S3_BUCKET`**) | **Yes** (for attachments) | Bucket name. |
| **`CONNECT_S3_REGION`** / **`AWS_REGION`** | **Yes** | Region string. |
| **`CONNECT_S3_ACCESS_KEY_ID`** / **`AWS_ACCESS_KEY_ID`** | **Yes** | Access key. |
| **`CONNECT_S3_SECRET_ACCESS_KEY`** / **`AWS_SECRET_ACCESS_KEY`** | **Yes** | Secret key (server only). |
| **`CONNECT_S3_ENDPOINT`** | No | Non-AWS S3-compatible endpoint (R2, MinIO, …). |
| **`CONNECT_S3_FORCE_PATH_STYLE`** | No | Often `1` with MinIO. |
| **`CONNECT_ATTACHMENT_MAX_BYTES`** | No | Max declared object size (default **524288000**). |
| **`CONNECT_S3_PRESIGN_PUT_SECONDS`** | No | Presigned PUT lifetime (default **900**). |
| **`CONNECT_S3_PRESIGN_GET_SECONDS`** | No | Presigned GET lifetime (default **3600**). |

## Billing identity (wallet / spend / call-charge)

All coin and call-metering APIs key off **`deviceId`** (opaque string). **Knowing `deviceId` is sufficient to read balances and post charges** — same anonymous trust model as chat. There is **no** separate server-side login. Product/support should treat this as a **v1 limitation**; see **`docs/LAUNCH_GAP_CHECKLIST.md`**.

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

**Stripe Dashboard:** create an endpoint pointing to your deployed API path **`/v2/webhooks/stripe`** (full URL, e.g. `https://api.example.com/v2/webhooks/stripe`). Subscribe to events your code handles (Checkout completed, subscription lifecycle, invoices — see **`docs/v2-stripe-webhooks.md`**).

A separate verified-ingestion path exists at **`POST /v2/webhooks/billing`** for non-Stripe retention providers — do not confuse the two URLs.

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

## Mutual save (Room-Save-1A)

| Variable | Default | Purpose |
|----------|---------|---------|
| **`MUTUAL_SAVE_ENABLED`** | **off** | `1` / `true` enables **`POST /v2/rooms/:id/save/request`** and **`.../save/respond`**; **`GET /v2/rooms*`** then exposes full `save` metadata. |
| **`MUTUAL_SAVE_PENDING_MS`** | `604800000` (7d) | Pending request expires back to `none` after this duration. |

See **`docs/v2-mutual-save.md`**.

## Group rooms (`room_kind` / `member_cap`)

| Variable | Default | Purpose |
|----------|---------|---------|
| **`CONNECT_GROUP_ROOMS_REQUIRE_PRO`** | **off** | When `1` / `true`, only devices with **active** CONNECT Pro membership may **`POST /v2/rooms/create`**. |
| **`CONNECT_GROUP_MIN_MEMBER_CAP`** | **3** | Minimum allowed **`memberCap`** for group rooms (must be > 2 to distinguish from 1:1). |
| **`CONNECT_GROUP_MAX_MEMBER_CAP`** | **100** | Maximum allowed **`memberCap`** (clamped server-side to a safe upper bound). |

See **`docs/v2-group-rooms.md`**.

## Coin packs

**Routes:**

| Route | Purpose |
|-------|---------|
| **`POST /v2/billing/create-coin-checkout-session`** | Body may include **`successUrl`** / **`cancelUrl`**, or use env defaults below. |
| **`POST /v2/billing/coin-pack/create-checkout`** | Same **`deviceId`** + **`packId`**; server sets Stripe success/cancel to **`app://coin-pack-return?...&cr=<nonce>`** for mobile deep links; response may include **`checkoutReturnNonce`**. |

**Catalog (at least one source required — merged; discrete env overrides JSON on same `packId`):**

| Variable | Required | Purpose |
|----------|----------|---------|
| **`CONNECT_COIN_PACKS_JSON`** | Conditional | JSON array: `{ "packId", "stripePriceId", "coins" }` per pack. |
| **`STRIPE_PRICE_COINS_100`** or **`STRIPE_PRICE_100`** | Conditional | If set → pack **`coins_100`** (100 coins) with this Stripe Price id. |
| **`STRIPE_PRICE_COINS_300`** or **`STRIPE_PRICE_300`** | Conditional | Pack **`coins_300`** (300 coins). |
| **`STRIPE_PRICE_COINS_1000`** or **`STRIPE_PRICE_1000`** | Conditional | Pack **`coins_1000`** (1000 coins). |

If the **merged** catalog is empty → **`503`** `coin_packs_not_configured`.

| Variable | Required | Purpose |
|----------|----------|---------|
| **`STRIPE_SECRET_KEY`** | **Yes** | Creates Checkout Session. |
| **`STRIPE_CHECKOUT_SUCCESS_URL`** / **`STRIPE_CHECKOUT_CANCEL_URL`** | Conditional* | Defaults for **`create-coin-checkout-session`** when URLs omitted in body. **Not** used for **`coin-pack/create-checkout`** (URLs are fixed `app://…`). |

\* See **`docs/v2-coin-wallet-billing.md`** (webhook crediting, **`GET /v2/billing/wallet`**).

## Call charging (`POST /v2/billing/call-charge/start` and `.../settle`)

| Variable | Required | Purpose |
|----------|----------|---------|
| **`CONNECT_CALL_TARIFF_JSON`** | **Yes** (for these routes) | JSON object: **`version`**, **`voice.coinsPerSecond`**, **`video.coinsPerSecond`** (non-negative integers). Invalid or missing → **`503`** `tariff_not_configured`. For **voice-only** public launch, set **`video.coinsPerSecond`** to **`0`** (field is still required by the parser). |
| **`CONNECT_CALL_DEFAULT_MIN_HOLD_SECONDS`** | No | Default **`estimatedBillableSeconds`** when omitted on **start** (default **`120`**). |
| **`CONNECT_FREE_CALL_SECONDS_PER_DAY`** | No | Daily free **call** seconds per **`deviceId`** (UTC calendar day) before coin metering (default **`180`**). Set **`0`** to disable. |

See **`docs/connect-call-charging.md`** and **`docs/connect-call-free-allowance.md`**. **`POST /v2/calls/livekit-token`** accepts **`callType: voice` only** — video calls are not supported server-side regardless of tariff.

## LiveKit media (`POST /v2/calls/livekit-token`)

| Variable | Required | Purpose |
|----------|----------|---------|
| **`LIVEKIT_URL`** | **Yes** | Client WebSocket URL (e.g. `wss://….livekit.cloud`). |
| **`LIVEKIT_API_KEY`** | **Yes** | JWT issuer (`iss`). |
| **`LIVEKIT_API_SECRET`** | **Yes** | HS256 signing secret — **server only**. |
| **`LIVEKIT_TOKEN_TTL_SECONDS`** | No | Access token TTL in seconds (default **600**, allowed **60–86400**). |

If **`LIVEKIT_URL`**, **`LIVEKIT_API_KEY`**, or **`LIVEKIT_API_SECRET`** is unset → **`503`** `livekit_not_configured`.

See **`docs/connect-livekit-token.md`**.

### Included retention tier for CONNECT Pro (API overlay)

| Variable | Default | Purpose |
|----------|---------|---------|
| **`CONNECT_MEMBER_RETENTION_TIER`** | **`30_days`** (if invalid) | Minimum **displayed** retention tier for active members on room list/detail when membership store reports an active subscription. Does **not** delete messages; see **`docs/v2-retention.md`**. |

## What still ends rooms (unchanged)

- Clients calling **`POST /sessions/end`** or any product flow that maps to it.  
- SQLite file loss on ephemeral disks (data loss), not normal “ended” semantics.
