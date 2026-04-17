# V2 room retention (Phase 19–20 — hardened contract + billing ingestion)

**Public launch v1:** message **TTL deletion is not enforced** in this server — tier fields are **stored and returned** with **`enforcementNote`**. Operator-facing scope and marketing alignment — **`docs/LAUNCH_GAP_CHECKLIST.md`**.

## Model

- **Scope:** **Room-level** retention. All messages in a room share the same retention metadata on **`rooms`**. Per-message TTL in SQL can be added later without breaking this contract.
- **Default:** New rooms get **`retention_tier = default`**, **`retention_until = null`**, **`retention_source = server_default`**. No automatic message deletion runs yet (no TTL worker).
- **Tiers (enum):**

| `retentionTier` | Meaning (product) | `retentionUntil` (typical) |
|-----------------|-------------------|----------------------------|
| `default` | No paid pack | `null` |
| `7_days` | Paid / promo — history window | client may omit; server defaults to `now + 7d`, or use body override |
| `30_days` | Paid — longer window | same as `7_days` with 30d window |
| `permanent` | Paid — no time cap | `null` |

- **`isPaidRetention`:** `true` when `retentionTier !== 'default'` (product label only; **no payment verification** in this phase).
- **`enforcementNote`:** Same string on every retention-bearing response. Explains that **`retention_until` is advisory** until a future TTL job exists.

## Normalized response shape (list, detail, GET/POST retention)

These fields are produced by **`src/retentionContract.js`** (`buildRetentionView`) so list, detail, and **`GET` / `POST /v2/rooms/:roomId/retention`** stay aligned.

| Field | Type | Notes |
|-------|------|--------|
| **`roomId`** | string | Same as `id` on room objects |
| **`retentionTier`** | string | `default` \| `7_days` \| `30_days` \| `permanent` |
| **`retentionUntil`** | ISO string \| `null` | Advisory end of window; `null` for `default` / `permanent` or unset |
| **`retentionSource`** | string | Normalized (see below) |
| **`isPaidRetention`** | boolean | `retentionTier !== 'default'` |
| **`canExtendRetention`** | boolean | See **Can extend** below |
| **`enforcementNote`** | string | TTL not enforced server-side in this phase |

**List items** also include `id`, `roomId`, and the rest of the list payload; **detail** includes `id`, `roomId`, etc. Retention keys are identical to the dedicated retention endpoint.

## `retentionSource` normalization

Implemented in **`normalizeRetentionSource`**:

- Known values (case-insensitive): `server_default`, `manual`, `stripe`, `revenuecat`, `app_store`, **`google_play`**.
- Any other non-empty string is **stored/returned as-is** (e.g. future vendor ids) for forward compatibility.
- Empty / missing → `server_default`.

**Manual `POST .../retention`:** Sets **`retention_source = manual`** when allowed (see **Manual route** below).

**Verified billing:** **`POST /v2/webhooks/billing`** (shared secret) and **`POST /v2/webhooks/stripe`** (Stripe **`Stripe-Signature`**) set provider-backed **`retention_source`** (e.g. **`stripe`**). See **`docs/v2-billing-ingestion.md`** and **`docs/v2-stripe-webhooks.md`**.

## `canExtendRetention` (authoritative)

This flag answers: *“May the client show flows to change or purchase retention?”* — not “is the tier technically mutable in SQL.”

| Condition | `canExtendRetention` |
|-----------|---------------------|
| Room **soft-deleted** (`deleted_at` set) | `false` (retention reads **`410`** for linked devices) |
| Room **`state === 'ended'`** | `false` (read-only tombstone; **POST** **`409`** `room_not_active`) |
| **`retentionTier === 'permanent'`** | `false` (no further “extension” in product terms) |
| **`default`**, **`7_days`**, **`30_days`** on an **active**, non-deleted room | `true` |

**Sources:** **`canExtendRetention`** does not change by source; clients may use **`retentionSource`** to show “managed by App Store” vs manual test data.

## Schema

| Location | Purpose |
|----------|---------|
| **`rooms.retention_tier`** | Current tier |
| **`rooms.retention_until`** | Unix ms advisory end; `null` = no wall-clock end |
| **`rooms.retention_source`** | Normalized source string |
| **`retention_purchases`** | Audit log: `id`, `room_id`, `device_id`, `tier`, `retention_until`, `source`, `note`, **`external_ref`**, **`idempotency_provider`**, **`idempotency_key`**, `created_at` |

**Not implemented:** Background deletion of **`room_messages`**; mobile checkout UI; provider-native signature verification (use **`POST /v2/webhooks/billing`** with **`BILLING_WEBHOOK_SECRET`** or a verifying proxy first).

## Write rules — `POST /v2/rooms/:roomId/retention` (manual)

- **Environment:** In **`NODE_ENV=production`**, this route is **disabled** unless **`ALLOW_MANUAL_RETENTION_POST=1`**. Otherwise **`403`** **`reason: manual_retention_disabled`**. Non-production defaults allow manual updates for development.
- **Auth:** Caller must have a **`device_room_links`** row for the room (**`403`** if not). Unlinked devices cannot read or mutate retention.
- **Active only:** **`rooms.state` must be `'active'`**. Ended rooms return **`409`** with **`reason: 'room_not_active'`** (reopen via lifecycle first).
- **Soft-deleted:** Linked device gets **`410`**; mutation also **`410`** with **`reason: 'deleted'`** at repository layer.
- **Tier set:** Exactly one of **`default`**, **`7_days`**, **`30_days`**, **`permanent`** (trimmed). Unknown tier → **`400`** with **`allowed`** list.
- **Transitions:** When enabled, any allowed tier may be set (including **default → paid-like**); **`retention_source`** is always **`manual`** — **not** a verified purchase.
- **`permanent`:** May be set when manual route is enabled (testing / ops).
- **`retentionUntil`:** Optional. For **`7_days` / `30_days`**, if omitted, server sets **`now + window`**. If provided (number ms or parseable ISO), that value is used. **`default`** and **`permanent`** force **`retention_until = null`**.
- **`note`:** Optional string; truncated for storage.
- **`externalRef`:** Optional; trimmed, max **512** chars, stored on **`retention_purchases.external_ref`** for future correlation with payment or subscription ids (not validated beyond length/trim).

## APIs

### `GET /v2/rooms/:roomId/retention?deviceId=...`

- **200:** Normalized retention object (no `ok` wrapper).
- **403** — not linked; **404** — not found; **410** — soft-deleted (linked device).

### `POST /v2/rooms/:roomId/retention`

- **Body:** `{ "deviceId", "retentionTier", "retentionUntil"?: number | string, "note"?: string, "externalRef"?: string }`
- **200:** Same shape as GET.

## List / detail

- **`GET /v2/rooms`** and **`GET /v2/rooms/:roomId`** include the **same** retention fields as above (`roomId`, `retentionTier`, …, `enforcementNote`). **`state`** on list items matches detail for **`canExtendRetention`** computation.

## Verified billing linkage

1. **`POST /v2/webhooks/billing`** — shared-secret ingestion, idempotent grants, provider-backed **`retention_source`**. See **`docs/v2-billing-ingestion.md`**.
2. **Manual `POST .../retention`** — dev/ops only when allowed; sets **`manual`**.
3. **TTL:** A worker uses **`retention_until`** and tier to delete or tombstone old **`room_messages`** — **not** in this repo phase.

## Coexistence

- **V1** and **V2 messaging** unchanged; retention metadata does not alter send/read paths.
