# CONNECT call charging (tariff + reserve + settle — Phase Call-Meter-2)

**Identity:** All amounts are **device-bound** (`deviceId`). **`callSessionId`** is an opaque string chosen by the client (or future call coordinator); it must not expose phone, email, or public profile. Chat and room APIs do **not** return wallet or call-billing fields.

## Tariff configuration

Set **`CONNECT_CALL_TARIFF_JSON`** to a JSON object:

| Field | Type | Meaning |
|-------|------|---------|
| **`version`** | positive integer | Echoed in ledger **`metadata_json`** for audit (`tariffVersion`). |
| **`voice.coinsPerSecond`** | non-negative integer | Voice rate: **`ceil(billedSeconds * coinsPerSecond)`** coins. |
| **`video.coinsPerSecond`** | non-negative integer | Video rate (same formula). |

Example:

```json
{
  "version": 1,
  "voice": { "coinsPerSecond": 1 },
  "video": { "coinsPerSecond": 2 }
}
```

If unset or invalid JSON / invalid shape → **`GET`** tariff helpers return **`null`** and HTTP **`503`** `tariff_not_configured` on start/settle.

### Optional defaults

| Variable | Default | Purpose |
|----------|---------|---------|
| **`CONNECT_CALL_DEFAULT_MIN_HOLD_SECONDS`** | `120` | When **`POST .../call-charge/start`** omits **`estimatedBillableSeconds`**, reserve size uses **`ceil(defaultMinHoldSeconds * coinsPerSecond)`** coins. |

Caps: estimated seconds and **`billedSeconds`** are bounded (see **`src/connectCallTariff.js`**).

## Daily free seconds (before coins)

See **`docs/connect-call-free-allowance.md`**. **`call-charge/start`** reserves coins only for estimated duration **after** today’s free pool; **`settle`** applies **`billedSeconds`** to free usage first, then coins. **`GET /v2/billing/wallet`** includes **`callFreeSecondsRemainingToday`** (and related fields) for UI.

## Reserve vs final debit

| Concept | Meaning |
|---------|---------|
| **Hold (`reserve_hold`)** | At **start**, optional coins moved into **`reserved_coins`**, reducing **spendable** without reducing **`available_coins`** yet. Idempotency key **`call:<callSessionId>:hold`**. |
| **Release (`reserve_release`)** | At **settle**, some or all of that hold is released (ledger key **`call:<callSessionId>:release`**) so coins return to spendable before the final charge. |
| **Final charge (`call_debit`)** | **`ceil(billedSeconds * rate)`** coins debited from **`available_coins`** after release. Idempotency key **`call:<callSessionId>:settle`**. |

**Settle** runs **release (if `reservedAmount` > 0) then debit** in **one SQLite transaction** via **`applyCallSessionSettlement`** (`src/store/coinWalletRepository.js`).

- If **final cost &lt; hold**: release the **full** `reservedAmount` returned at start, then debit only the actual cost — unused reserve returns to spendable automatically.
- If **final cost &gt; hold**: release the stated reserve, then debit the full cost (must fit **spendable** after release).

**No start hold:** pass **`reservedAmount: 0`** (or omit) on settle — only **`call_debit`** runs (or a **zero-coin** settle marker for 0 seconds / 0 rate).

## Idempotency

| Key pattern | When |
|-------------|------|
| **`call:<id>:hold`** | Start reserve (duplicate start replays without double hold). |
| **`call:<id>:release`** | Release row for that session (written with settle when `reservedAmount` > 0). |
| **`call:<id>:settle`** | Final settlement; **duplicate POST = same response**, no double charge. |

Global uniqueness: same key cannot be reused for a **different** `deviceId` ( **`409`** `idempotency_key_conflict` ).

## HTTP API

### `POST /v2/billing/call-charge/start`

**Body:** **`deviceId`**, **`callSessionId`**, **`callType`** (`voice` \| `video`), optional **`estimatedBillableSeconds`** (integer).

**Success `200`:** `reservedCoins`, `estimatedBillableSeconds`, `holdApplied` (false if rate or estimate yields 0 coins), `wallet`, `tariffVersion`, `coinsPerSecond`.

**`402`:** Insufficient spendable coins for the hold.

### `POST /v2/billing/call-charge/settle`

**Body:** **`deviceId`**, **`callSessionId`**, **`callType`**, **`billedSeconds`** (integer ≥ 0), optional **`reservedAmount`** (non-negative integer — should match **`reservedCoins`** from start when a hold was applied).

**Success `200`:** `finalDebitCoins`, `releasedReserveCoins`, `duplicate`, `wallet`, optional **`releaseEntry`** / **`debitEntry`** summaries.

**`402`:** **`insufficient_funds`** (cannot afford final debit) or **`insufficient_reserved`** (wallet has less reserved than **`reservedAmount`**).

## Mobile / future media usage

1. Generate a random **`callSessionId`** per call attempt; never send it as a chat display name.
2. **Start** before or when metering begins; **settle** when the call ends (or on reconnect with final **`billedSeconds`**).
3. Retry **settle** on network failure — idempotent **`call:<id>:settle`** prevents double billing.
4. Read **`GET /v2/billing/wallet`** if the UI needs balance; do not surface other users’ billing state.

## Related code

- **`src/connectCallTariff.js`** — env tariff + cost math  
- **`src/connectCallBilling.js`** — start/settle validation + metadata  
- **`src/store/coinWalletRepository.js`** — **`applyCallSessionSettlement`**  
- **`docs/connect-livekit-token.md`** — **`POST /v2/calls/livekit-token`** (media access after billing start)  
- **`docs/v2-coin-wallet-billing.md`** — coin packs + simple **`spend-coins`**  
- **`docs/connect-server-environment.md`** — env variable names  
- **`docs/connect-call-free-allowance.md`** — daily free seconds before coin metering  
