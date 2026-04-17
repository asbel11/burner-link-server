# CONNECT daily free call allowance (Billing-Free-Usage-1)

Each **`deviceId`** receives **`CONNECT_FREE_CALL_SECONDS_PER_DAY`** seconds (default **180**) of **voice/video call duration per UTC calendar day** that are **not** charged in coins. Coin tariff applies only to **remaining** billable seconds after free is applied.

**Wallet, membership, and Stripe flows are unchanged** — this only affects **`call-charge/start`**, **`call-charge/settle`**, and **`GET /v2/billing/wallet`** (extra read-only fields).

---

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| **`CONNECT_FREE_CALL_SECONDS_PER_DAY`** | **`180`** | Non-negative integer; clamped to **0–86400** if invalid. **`0`** disables free seconds (all billable time uses coins). |

**Day boundary:** **`usage_utc_date`** is **`YYYY-MM-DD`** in **UTC** (same as `new Date().toISOString().slice(0, 10)`).

---

## Storage

Table **`device_daily_call_free_usage`**: **`device_id`**, **`usage_utc_date`**, **`free_seconds_used`**, **`updated_at`**.  
`free_seconds_used` increases when **`settle`** applies seconds against the free pool (up to the daily cap).

---

## Start (`POST /v2/billing/call-charge/start`)

- Reads today’s remaining free seconds: **`callFreeSecondsRemainingToday`**.
- **Coin reserve** is computed only for **paid** estimated seconds:  
  **`paidEstimateSeconds = max(0, estimatedBillableSeconds - callFreeSecondsRemainingToday)`**  
  **`reserveCoins = ceil(paidEstimateSeconds * coinsPerSecond)`** (same formula as before, on the paid slice).

Response adds (when the server has the allowance store):

- **`usageUtcDate`**, **`callFreeSecondsAllowancePerDay`**, **`callFreeSecondsUsedToday`**, **`callFreeSecondsRemainingToday`**
- **`estimatedCoinBillableSeconds`** (= **`paidEstimateSeconds`**)

---

## Settle (`POST /v2/billing/call-charge/settle`)

In one database transaction:

1. Apply **`billedSeconds`** against today’s free pool (increment **`free_seconds_used`**; cap at allowance).
2. **`coinBillableSeconds = billedSeconds - freeSecondsApplied`**
3. **`finalDebitCoins = ceil(coinBillableSeconds * rate)`**
4. Existing **`applyCallSessionSettlement`** (reserve release + coin debit).

Response includes **`freeSecondsApplied`**, **`coinBillableSeconds`**, **`finalDebitCoins`**, and the same **`callFree*`** fields as wallet after the operation.

**Idempotent settle:** If the settle ledger row already exists, **no** additional free seconds are consumed (duplicate response only).

---

## Wallet (`GET /v2/billing/wallet`)

Same coin fields as before, plus:

| Field | Meaning |
|-------|---------|
| **`usageUtcDate`** | UTC date key for today’s counter |
| **`callFreeSecondsAllowancePerDay`** | From env (default 180) |
| **`callFreeSecondsUsedToday`** | Seconds already applied from free pool today |
| **`callFreeSecondsRemainingToday`** | **`allowance - used`** |

**Mobile:** Show **“Free today: X seconds remaining”** using **`callFreeSecondsRemainingToday`** only — **do not** derive usage on the client.

---

## Related

- **`src/callFreeAllowance.js`**
- **`docs/connect-call-charging.md`**
