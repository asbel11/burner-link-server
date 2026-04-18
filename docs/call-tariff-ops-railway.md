# Call tariff — production ops (Phase Call-Tariff-Ops-1)

Source of truth: **`src/connectCallTariff.js`** (`getCallTariffFromEnv`, `normalizeTariffOrThrow`) and **`src/connectCallBilling.js`** (`processCallChargeStart` / `processCallChargeSettle`).

## 1. Required env vars (voice billing works)

| Variable | Required for `call-charge/*` | Meaning |
|----------|------------------------------|---------|
| **`CONNECT_CALL_TARIFF_JSON`** | **Yes** | Single-line JSON string (see below). If **unset**, **empty**, **invalid JSON**, or **fails shape/rate validation**, tariff is **`null`** → **503** on start/settle. |

**Optional:**

| Variable | Default | Meaning |
|----------|---------|---------|
| **`CONNECT_CALL_DEFAULT_MIN_HOLD_SECONDS`** | `120` | Used when **`POST .../call-charge/start`** omits **`estimatedBillableSeconds`**. |

Daily free seconds (if used): **`CONNECT_FREE_CALL_SECONDS_PER_DAY`** and related — see **`docs/connect-call-free-allowance.md`**.

## 2. Exact `CONNECT_CALL_TARIFF_JSON` shape

Parsed by **`normalizeTariffOrThrow`**:

- **`version`** — positive integer (defaults to **1** if missing/invalid).
- **`voice`** — object with **`coinsPerSecond`**: non-negative **integer**, ≤ 1_000_000.
- **`video`** — object with **`coinsPerSecond`**: non-negative **integer**, ≤ 1_000_000 (**required** by parser even for voice-only).

Costs: **`Math.ceil(billedSeconds * coinsPerSecond)`** per **`connectCallTariff.js`**.

### Voice-only production example (recommended)

Set **`video.coinsPerSecond`** to **`0`** so **`callType: "video"`** on start/settle cannot charge coins while **`POST /v2/calls/livekit-token`** remains **voice-only** (see **`docs/connect-livekit-token.md`**).

```json
{"version":1,"voice":{"coinsPerSecond":1},"video":{"coinsPerSecond":0}}
```

**Railway:** paste as **one line** in the variable value (no unescaped newlines), or use Railway’s JSON editor if available.

## 3. Missing / invalid tariff — exact HTTP response

When **`getCallTariffFromEnv()`** returns **`null`** (missing env, bad JSON, or invalid rates/shape), both:

- **`POST /v2/billing/call-charge/start`**
- **`POST /v2/billing/call-charge/settle`**

return:

- **HTTP `503`**
- **Body:**

```json
{
  "error": "Call tariff is not configured (set CONNECT_CALL_TARIFF_JSON)",
  "reason": "tariff_not_configured"
}
```

*(Client copy may say “call billing unavailable” or “call pricing not configured” — the **server** string is **`error`** above; branch on **`reason === "tariff_not_configured"`**.)*

## 4. Video rate for voice-only launch

- **Tariff:** Keep **`video.coinsPerSecond: 0`** so accidental **`callType: "video"`** does not debit coins.
- **LiveKit:** **`POST /v2/calls/livekit-token`** is **voice-only**; video tracks are not granted — see **`src/livekitConnect.js`** / **`docs/connect-livekit-token.md`**.

## 5. Production checklist (Railway)

1. Set **`CONNECT_CALL_TARIFF_JSON`** on the **same service** that runs **`server.js`**.
2. **Redeploy** (or restart) so `process.env` is read at runtime (`getCallTariffFromEnv()` is called per request — no stale cache, but env must be present after deploy).
3. Run the smoke **`curl`** below; expect **200** from **start**, not **503**.

## 6. Smoke test — `POST /v2/billing/call-charge/start`

Replace **`API_BASE`** with your Railway URL. **`callSessionId`** must match **`^[A-Za-z0-9._:-]+$`** (see **`normalizeCallSessionId`**).

```bash
API_BASE="https://YOUR-RAILWAY-API.up.railway.app"

curl -sS -X POST "$API_BASE/v2/billing/call-charge/start" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "smoke-device-call",
    "callSessionId": "smoke-call-1",
    "callType": "voice",
    "estimatedBillableSeconds": 60
  }'
```

- **Success (tariff OK, sufficient wallet):** **200** with **`ok`**, **`tariffVersion`**, **`coinsPerSecond`**, **`reservedCoins`**, **`wallet`**, etc.
- **Tariff missing:** **503** + **`reason: "tariff_not_configured"`**.
- **Insufficient coins for hold:** **402** (see **`docs/connect-call-charging.md`**).

Full contract: **`docs/connect-call-charging.md`**.
