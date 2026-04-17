/**
 * CONNECT call charging — reserve at start, settle at end (Phase Call-Meter-2).
 *
 * @see docs/connect-call-charging.md
 */

const {
  getCallTariffFromEnv,
  ALLOWED_CALL_TYPES,
  computeCoinsForBilledSeconds,
  computeReserveCoinsForEstimatedSeconds,
  defaultMinHoldSeconds,
  MAX_BILLABLE_SECONDS,
  MAX_ESTIMATE_SECONDS,
} = require("./connectCallTariff");
const { COIN_LEDGER_ENTRY_KINDS } = require("./coinEntryKinds");
const {
  walletToResponseJson,
  ledgerEntryToResponseJson,
} = require("./connectCoinSpend");

const MAX_SESSION_ID_LEN = 160;

/**
 * @param {unknown} v
 * @returns {string}
 */
function normalizeCallSessionId(v) {
  if (typeof v !== "string") {
    return "";
  }
  const s = v.trim();
  if (!s || s.length > MAX_SESSION_ID_LEN) {
    return "";
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(s)) {
    return "";
  }
  return s;
}

/**
 * @param {*} coins
 * @param {Record<string, unknown>} body
 * @param {ReturnType<typeof getCallTariffFromEnv>} tariff
 * @returns {{ status: number, json: Record<string, unknown> }}
 */
function processCallChargeStart(coins, body, tariff) {
  const raw = body && typeof body === "object" ? body : {};
  if (!tariff) {
    return {
      status: 503,
      json: {
        error: "Call tariff is not configured (set CONNECT_CALL_TARIFF_JSON)",
        reason: "tariff_not_configured",
      },
    };
  }

  const deviceId = typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    return {
      status: 400,
      json: { error: "Missing or invalid deviceId", reason: "invalid_device" },
    };
  }

  const callSessionId = normalizeCallSessionId(raw.callSessionId);
  if (!callSessionId) {
    return {
      status: 400,
      json: {
        error: "Missing or invalid callSessionId",
        reason: "invalid_call_session_id",
      },
    };
  }

  const callType = typeof raw.callType === "string" ? raw.callType.trim() : "";
  if (!ALLOWED_CALL_TYPES.has(callType)) {
    return {
      status: 400,
      json: {
        error: "callType must be voice or video",
        reason: "unknown_call_type",
      },
    };
  }

  let estimatedSeconds = defaultMinHoldSeconds();
  if (raw.estimatedBillableSeconds !== undefined && raw.estimatedBillableSeconds !== null) {
    const es = Number(raw.estimatedBillableSeconds);
    if (!Number.isInteger(es) || es < 0 || es > MAX_ESTIMATE_SECONDS) {
      return {
        status: 400,
        json: {
          error: "estimatedBillableSeconds must be an integer from 0 to max estimate",
          reason: "invalid_estimated_seconds",
        },
      };
    }
    estimatedSeconds = es;
  }

  const coinsPerSecond =
    callType === "voice"
      ? tariff.voice.coinsPerSecond
      : tariff.video.coinsPerSecond;
  const reserveCoins = computeReserveCoinsForEstimatedSeconds(
    estimatedSeconds,
    callType,
    tariff
  );

  const holdKey = `call:${callSessionId}:hold`;
  const releaseMeta = JSON.stringify({
    callSessionId,
    callType,
    phase: "hold",
    estimatedBillableSeconds: estimatedSeconds,
    tariffVersion: tariff.version,
    coinsPerSecond,
    reserveCoins,
  });

  if (reserveCoins === 0) {
    const w = coins.getWallet(deviceId);
    return {
      status: 200,
      json: {
        ok: true,
        duplicate: false,
        callSessionId,
        callType,
        tariffVersion: tariff.version,
        coinsPerSecond,
        estimatedBillableSeconds: estimatedSeconds,
        reservedCoins: 0,
        holdApplied: false,
        wallet:
          walletToResponseJson(w) ?? {
            deviceId,
            availableCoins: 0,
            reservedCoins: 0,
            spendableCoins: 0,
            updatedAt: null,
          },
      },
    };
  }

  const h = coins.applyReserveHold({
    deviceId,
    amount: reserveCoins,
    idempotencyKey: holdKey,
    metadataJson: releaseMeta,
  });

  if (!h.ok) {
    if (h.reason === "insufficient_funds") {
      const w = coins.getWallet(deviceId);
      return {
        status: 402,
        json: {
          error: "Insufficient spendable coins to reserve estimated call cost",
          reason: "insufficient_funds",
          callSessionId,
          reserveCoins,
          wallet:
            walletToResponseJson(w) ?? {
              deviceId,
              availableCoins: 0,
              reservedCoins: 0,
              spendableCoins: 0,
              updatedAt: null,
            },
        },
      };
    }
    return {
      status: 400,
      json: {
        error: "Could not apply reserve hold",
        reason: h.reason || "reserve_failed",
      },
    };
  }

  return {
    status: 200,
    json: {
      ok: true,
      duplicate: h.duplicate === true,
      callSessionId,
      callType,
      tariffVersion: tariff.version,
      coinsPerSecond,
      estimatedBillableSeconds: estimatedSeconds,
      reservedCoins: reserveCoins,
      holdApplied: true,
      wallet: walletToResponseJson(h.wallet),
    },
  };
}

/**
 * @param {*} coins
 * @param {Record<string, unknown>} body
 * @param {ReturnType<typeof getCallTariffFromEnv>} tariff
 * @returns {{ status: number, json: Record<string, unknown> }}
 */
function processCallChargeSettle(coins, body, tariff) {
  const raw = body && typeof body === "object" ? body : {};
  if (!tariff) {
    return {
      status: 503,
      json: {
        error: "Call tariff is not configured (set CONNECT_CALL_TARIFF_JSON)",
        reason: "tariff_not_configured",
      },
    };
  }

  const deviceId = typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    return {
      status: 400,
      json: { error: "Missing or invalid deviceId", reason: "invalid_device" },
    };
  }

  const callSessionId = normalizeCallSessionId(raw.callSessionId);
  if (!callSessionId) {
    return {
      status: 400,
      json: {
        error: "Missing or invalid callSessionId",
        reason: "invalid_call_session_id",
      },
    };
  }

  const callType = typeof raw.callType === "string" ? raw.callType.trim() : "";
  if (!ALLOWED_CALL_TYPES.has(callType)) {
    return {
      status: 400,
      json: {
        error: "callType must be voice or video",
        reason: "unknown_call_type",
      },
    };
  }

  const bs = raw.billedSeconds;
  if (!Number.isInteger(bs) || bs < 0 || bs > MAX_BILLABLE_SECONDS) {
    return {
      status: 400,
      json: {
        error: "billedSeconds must be an integer from 0 to the configured maximum",
        reason: "invalid_billed_seconds",
      },
    };
  }

  let reservedAmount = 0;
  if (raw.reservedAmount !== undefined && raw.reservedAmount !== null) {
    const ra = Number(raw.reservedAmount);
    if (!Number.isInteger(ra) || ra < 0) {
      return {
        status: 400,
        json: {
          error: "reservedAmount must be a non-negative integer",
          reason: "invalid_reserved_amount",
        },
      };
    }
    reservedAmount = ra;
  }

  const debitCoins = computeCoinsForBilledSeconds(bs, callType, tariff);
  const releaseCoins = reservedAmount;

  const releaseMeta = JSON.stringify({
    callSessionId,
    callType,
    phase: "reserve_release",
    releasedCoins: releaseCoins,
    tariffVersion: tariff.version,
  });

  const debitMeta = JSON.stringify({
    callSessionId,
    callType,
    billedSeconds: bs,
    tariffVersion: tariff.version,
    reservedAmount: releaseCoins,
    finalDebitCoins: debitCoins,
  });

  const r = coins.applyCallSessionSettlement({
    deviceId,
    sessionId: callSessionId,
    releaseCoins,
    debitCoins,
    releaseMetadataJson: releaseCoins > 0 ? releaseMeta : null,
    debitMetadataJson: debitMeta,
    debitExternalReference: `call:${callSessionId}`,
  });

  if (!r.ok) {
    if (r.reason === "insufficient_funds") {
      const w = coins.getWallet(deviceId);
      return {
        status: 402,
        json: {
          error: "Insufficient spendable coins to settle final charge",
          reason: "insufficient_funds",
          callSessionId,
          finalDebitCoins: debitCoins,
          wallet:
            walletToResponseJson(w) ?? {
              deviceId,
              availableCoins: 0,
              reservedCoins: 0,
              spendableCoins: 0,
              updatedAt: null,
            },
        },
      };
    }
    if (r.reason === "insufficient_reserved") {
      const w = coins.getWallet(deviceId);
      return {
        status: 402,
        json: {
          error: "Reserved coins on wallet are less than reservedAmount for this session",
          reason: "insufficient_reserved",
          callSessionId,
          reservedAmount: releaseCoins,
          wallet:
            walletToResponseJson(w) ?? {
              deviceId,
              availableCoins: 0,
              reservedCoins: 0,
              spendableCoins: 0,
              updatedAt: null,
            },
        },
      };
    }
    if (r.reason === "idempotency_key_conflict") {
      return {
        status: 409,
        json: {
          error: "settle idempotency key already used for another device",
          reason: "idempotency_key_conflict",
        },
      };
    }
    return {
      status: 400,
      json: {
        error: "Settlement failed",
        reason: r.reason || "settle_failed",
      },
    };
  }

  return {
    status: 200,
    json: {
      ok: true,
      duplicate: r.duplicate === true,
      callSessionId,
      callType,
      billedSeconds: bs,
      tariffVersion: tariff.version,
      releasedReserveCoins: releaseCoins,
      finalDebitCoins: debitCoins,
      wallet: walletToResponseJson(r.wallet),
      releaseEntry: r.releaseEntry
        ? ledgerEntryToResponseJson(r.releaseEntry)
        : null,
      debitEntry: r.debitEntry ? ledgerEntryToResponseJson(r.debitEntry) : null,
    },
  };
}

module.exports = {
  normalizeCallSessionId,
  processCallChargeStart,
  processCallChargeSettle,
  MAX_SESSION_ID_LEN,
};
