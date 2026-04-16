# V2 billing ingestion (Phase 20–21 — verified retention entitlements)

**Stripe (signed webhooks):** see **`docs/v2-stripe-webhooks.md`** — **`POST /v2/webhooks/stripe`** reuses the same entitlement application as this document’s generic route.

## Purpose

`POST /v2/webhooks/billing` is the **first production path** for granting room retention from **verified purchase events**. It is **provider-agnostic**: Stripe, RevenueCat, App Store, Google Play, or future vendors send a normalized JSON body; the server validates auth, **idempotency**, room state, and tier rules, then updates `rooms` and appends **`retention_purchases`**.

This is **not** a checkout UI and **not** a full Stripe SDK integration — only **secure ingestion** of entitlement facts you already verified elsewhere (or in a future thin adapter).

## Authentication

Configure **`BILLING_WEBHOOK_SECRET`** (long random string). Each request must include **one** of:

- `Authorization: Bearer <BILLING_WEBHOOK_SECRET>`
- `X-Billing-Secret: <BILLING_WEBHOOK_SECRET>`

Comparison uses **constant-time** equality on the decoded secret.

If **`BILLING_WEBHOOK_SECRET`** is unset or empty, the endpoint responds **`503`** with **`reason: billing_not_configured`**.

## Request body (minimal contract)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| **`provider`** | string | yes | Vendor id, normalized (e.g. `stripe`, `revenuecat`, `app_store`, `apple` → `app_store`, `google_play`). Unknown lowercase `[a-z0-9_]{2,64}` allowed for forward compatibility. |
| **`externalTransactionId`** | string | yes | Provider transaction / event id — **idempotency key** (max 256 chars after trim). |
| **`roomId`** | string | yes | Target room. |
| **`deviceId`** | string | yes | Must have **`device_room_links`** row for this room. |
| **`retentionTier`** | string | yes | One of **`7_days`**, **`30_days`**, **`permanent`** (billing cannot set `default` via this path). |
| **`retentionUntil`** | number (ms) or ISO string | no | For timed tiers; if omitted, server uses **now + window** for `7_days` / `30_days`. Ignored for `permanent` (`null`). |
| **`eventType`** | string | yes | One of: `purchase`, `renewal`, `subscription_cycle`, `initial_purchase`, `non_renewing_purchase`. |
| **`eventTime`** | number or ISO string | no | Audit only (stored in `retention_purchases.note` JSON). |

## Idempotency

- Table **`retention_purchases`** has **`idempotency_provider`** + **`idempotency_key`** (partial unique index when key is set).
- **`idempotency_key`** = normalized **`provider`** + **`externalTransactionId`** uniqueness: the **same** event redelivered returns **`200`** with **`duplicate: true`** and current retention fields — **no second grant**.
- Concurrent duplicate inserts resolve via **`SQLITE_CONSTRAINT_UNIQUE`** and still return **`duplicate: true`**.

Manual `POST /v2/rooms/:roomId/retention` rows use **`idempotency_key = NULL`** (multiple manual events allowed).

## `retentionSource` after a verified grant

The room’s **`retention_source`** and the purchase row’s **`source`** are set from the normalized provider via **`providerToRetentionSource`**:

| Normalized `provider` | `retentionSource` |
|----------------------|-------------------|
| `stripe` | `stripe` |
| `revenuecat` | `revenuecat` |
| `app_store` | `app_store` |
| `google_play` | `google_play` |
| other `[a-z0-9_]+` | passed through **`normalizeRetentionSource`** (see `docs/v2-retention.md`) |

**`external_ref`** on the purchase row is **`{provider}:{externalTransactionId}`** (truncated to 512 chars).

## Entitlement rules (server)

1. Room must exist, be **active**, not **soft-deleted**, and **`deviceId`** must be **linked**.
2. **Downgrades rejected:** If the new tier’s rank is **lower** than the current tier (`default` &lt; `7_days` &lt; `30_days` &lt; `permanent`), respond **`409`** **`reason: would_downgrade`**.
3. **Upgrade:** Apply new tier and computed **`retention_until`**.
4. **Same tier renewal (timed):** **`retention_until`** = **max(existing, new)** when both are non-null.
5. **`permanent`:** **`retention_until`** = `null`; cannot be “extended” by a lower tier later (downgrade path blocks).

Out-of-order delivery: a **stale** lower-tier event after a higher tier is already applied hits **`would_downgrade`** (safe). A **duplicate** event always hits idempotency first.

## Manual `POST /v2/rooms/:roomId/retention`

- **Production (`NODE_ENV=production`):** manual updates are **disabled** unless **`ALLOW_MANUAL_RETENTION_POST=1`** (or `true` / `yes` / `on`).
- **Non-production:** manual updates are **allowed** by default (developer ergonomics).
- To force-disable everywhere, set production mode and omit the flag — or run with `NODE_ENV=production` and no `ALLOW_MANUAL_RETENTION_POST`.

Disabled manual route returns **`403`** **`reason: manual_retention_disabled`**.

## What remains before “full” paid retention

- **Mobile checkout** and client-side purchase flows.
- **Provider-specific** signature verification (Stripe signing secret, RevenueCat JWT, Apple ASN, etc.) — today only **shared secret**; you can place a reverse proxy or worker that verifies then POSTs here.
- **TTL worker** to enforce **`retention_until`** on messages.
- Stronger **anti-fraud** (bind `deviceId` to purchaser identity, rate limits, etc.).
