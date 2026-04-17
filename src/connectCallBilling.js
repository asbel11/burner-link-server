/**
 * CONNECT call charging — reserve at start, settle at end (Phase Call-Meter-2).
 * Free daily seconds (Phase Billing-Free-Usage-1) apply before coin debit.
 *
 * @see docs/connect-call-charging.md
 * @see docs/connect-call-free-allowance.md
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
 * Canonical call-charge/start free fields: **`freeSecondsRemaining`** and **`willUseCoins`**
 * (client must not infer coin usage from estimates alone).
 *
 * @param {Record<string, unknown>} freeJson
 * @param {number} paidEstimateSeconds
 */
function augmentCallChargeStartFreeFields(freeJson, paidEstimateSeconds) {
  const rem =
    typeof freeJson.callFreeSecondsRemainingToday === "number"
      ? freeJson.callFreeSecondsRemainingToday
      : 0;
  return {
    ...freeJson,
    freeSecondsRemaining: rem,
    willUseCoins: paidEstimateSeconds > 0,
  };
}

/**
 * @param {*} coins
 * @param {Record<string, unknown>} body
 * @param {ReturnType<typeof getCallTariffFromEnv>} tariff
 * @param {{ callFree?: ReturnType<import("./callFreeAllowance").createCallFreeAllowance> }} [opts]
 * @returns {{ status: number, json: Record<string, unknown> }}
 */
function processCallChargeStart(coins, body, tariff, opts = {}) {
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

  const freeSnap = opts.callFree
    ? opts.callFree.getSnapshot(deviceId)
    : null;
  const remainingFree = freeSnap ? freeSnap.callFreeSecondsRemainingToday : 0;
  const paidEstimateSeconds = Math.max(0, estimatedSeconds - remainingFree);
  const reserveCoins = computeReserveCoinsForEstimatedSeconds(
    paidEstimateSeconds,
    callType,
    tariff
  );

  const holdKey = `call:${callSessionId}:hold`;
  const releaseMeta = JSON.stringify({
    callSessionId,
    callType,
    phase: "hold",
    estimatedBillableSeconds: estimatedSeconds,
    paidEstimateSeconds,
    remainingFreeSecondsBeforeHold: remainingFree,
    tariffVersion: tariff.version,
    coinsPerSecond,
    reserveCoins,
  });

  const baseFreeJson = augmentCallChargeStartFreeFields(
    freeSnap
      ? {
          usageUtcDate: freeSnap.usageUtcDate,
          callFreeSecondsAllowancePerDay: freeSnap.callFreeSecondsAllowancePerDay,
          callFreeSecondsUsedToday: freeSnap.callFreeSecondsUsedToday,
          callFreeSecondsRemainingToday: freeSnap.callFreeSecondsRemainingToday,
          estimatedCoinBillableSeconds: paidEstimateSeconds,
        }
      : {},
    paidEstimateSeconds
  );

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
        ...baseFreeJson,
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
          ...baseFreeJson,
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

  const snapAfter = opts.callFree
    ? opts.callFree.getSnapshot(deviceId)
    : null;
  const freeAfter = augmentCallChargeStartFreeFields(
    snapAfter
      ? {
          usageUtcDate: snapAfter.usageUtcDate,
          callFreeSecondsAllowancePerDay: snapAfter.callFreeSecondsAllowancePerDay,
          callFreeSecondsUsedToday: snapAfter.callFreeSecondsUsedToday,
          callFreeSecondsRemainingToday: snapAfter.callFreeSecondsRemainingToday,
          estimatedCoinBillableSeconds: paidEstimateSeconds,
        }
      : {},
    paidEstimateSeconds
  );

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
      ...freeAfter,
      wallet: walletToResponseJson(h.wallet),
    },
  };
}

/**
 * @param {*} coins
 * @param {Record<string, unknown>} body
 * @param {ReturnType<typeof getCallTariffFromEnv>} tariff
 * @param {{
 *   db?: import("better-sqlite3").Database,
 *   callFree?: ReturnType<import("./callFreeAllowance").createCallFreeAllowance>,
 * }} [opts]
 * @returns {{ status: number, json: Record<string, unknown> }}
 */
function processCallChargeSettle(coins, body, tariff, opts = {}) {
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

  const settleKey = `call:${callSessionId}:settle`;
  const existingDebit = coins.getLedgerEntryByIdempotencyKey(settleKey);
  if (existingDebit) {
    if (existingDebit.deviceId !== deviceId) {
      return {
        status: 409,
        json: {
          error: "settle idempotency key already used for another device",
          reason: "idempotency_key_conflict",
        },
      };
    }
    const w = coins.getWallet(deviceId);
    const releaseKey = `call:${callSessionId}:release`;
    const rel = coins.getLedgerEntryByIdempotencyKey(releaseKey);
    let meta = {};
    try {
      if (existingDebit.metadataJson) {
        meta = JSON.parse(existingDebit.metadataJson);
      }
    } catch (_) {
      /* ignore */
    }
    const finalDebitCoins = Math.max(0, -(existingDebit.deltaCoins || 0));
    const snap = opts.callFree ? opts.callFree.getSnapshot(deviceId) : null;
    return {
      status: 200,
      json: {
        ok: true,
        duplicate: true,
        callSessionId,
        callType,
        billedSeconds: bs,
        tariffVersion: meta.tariffVersion ?? tariff.version,
        releasedReserveCoins: reservedAmount,
        finalDebitCoins,
        freeSecondsApplied: meta.freeSecondsApplied,
        coinBillableSeconds: meta.coinBillableSeconds,
        ...(snap
          ? {
              usageUtcDate: snap.usageUtcDate,
              callFreeSecondsAllowancePerDay: snap.callFreeSecondsAllowancePerDay,
              callFreeSecondsUsedToday: snap.callFreeSecondsUsedToday,
              callFreeSecondsRemainingToday: snap.callFreeSecondsRemainingToday,
            }
          : {}),
        wallet:
          walletToResponseJson(w) ?? {
            deviceId,
            availableCoins: 0,
            reservedCoins: 0,
            spendableCoins: 0,
            updatedAt: null,
          },
        releaseEntry: rel ? ledgerEntryToResponseJson(rel) : null,
        debitEntry: ledgerEntryToResponseJson(existingDebit),
      },
    };
  }

  const releaseCoins = reservedAmount;

  const runSettlement = (debitCoins, debitMetaObj, releaseMetaStr) => {
    const releaseMeta = releaseCoins > 0 ? releaseMetaStr : null;
    const debitMeta = JSON.stringify(debitMetaObj);
    return coins.applyCallSessionSettlement({
      deviceId,
      sessionId: callSessionId,
      releaseCoins,
      debitCoins,
      releaseMetadataJson: releaseMeta,
      debitMetadataJson: debitMeta,
      debitExternalReference: `call:${callSessionId}`,
    });
  };

  if (!opts.callFree || !opts.db) {
    const debitCoins = computeCoinsForBilledSeconds(bs, callType, tariff);
    const releaseMeta = JSON.stringify({
      callSessionId,
      callType,
      phase: "reserve_release",
      releasedCoins: releaseCoins,
      tariffVersion: tariff.version,
    });
    const debitMeta = {
      callSessionId,
      callType,
      billedSeconds: bs,
      tariffVersion: tariff.version,
      reservedAmount: releaseCoins,
      finalDebitCoins: debitCoins,
      freeSecondsApplied: 0,
      coinBillableSeconds: bs,
    };
    const r = runSettlement(debitCoins, debitMeta, releaseMeta);
    return finishSettleResponse(r, {
      coins,
      deviceId,
      callSessionId,
      callType,
      bs,
      releaseCoins,
      debitCoins,
      freeSecondsApplied: 0,
      coinBillableSeconds: bs,
      callFreeSnapshot: null,
      tariff,
    });
  }

  let alloc;
  let debitCoins;
  try {
    opts.db.transaction(() => {
      alloc = opts.callFree.consumeAgainstAllowanceInTransaction(deviceId, bs);
      debitCoins = computeCoinsForBilledSeconds(
        alloc.coinBillableSeconds,
        callType,
        tariff
      );
      const releaseMeta = JSON.stringify({
        callSessionId,
        callType,
        phase: "reserve_release",
        releasedCoins: releaseCoins,
        tariffVersion: tariff.version,
      });
      const debitMeta = {
        callSessionId,
        callType,
        billedSeconds: bs,
        tariffVersion: tariff.version,
        reservedAmount: releaseCoins,
        finalDebitCoins: debitCoins,
        freeSecondsApplied: alloc.freeSecondsApplied,
        coinBillableSeconds: alloc.coinBillableSeconds,
      };
      const r = runSettlement(debitCoins, debitMeta, releaseMeta);
      if (!r.ok) {
        const err = new Error("SETTLE_FAIL");
        err.settleReason = r.reason;
        throw err;
      }
    })();
  } catch (e) {
    if (e && e.settleReason) {
      const r = { ok: false, reason: e.settleReason };
      return finishSettleResponse(r, {
        coins,
        deviceId,
        callSessionId,
        callType,
        bs,
        releaseCoins,
        debitCoins: debitCoins ?? 0,
        freeSecondsApplied: alloc?.freeSecondsApplied,
        coinBillableSeconds: alloc?.coinBillableSeconds,
        callFreeSnapshot: opts.callFree.getSnapshot(deviceId),
        tariff,
      });
    }
    throw e;
  }

  const snap = opts.callFree.getSnapshot(deviceId);
  return finishSettleResponse(
    { ok: true, duplicate: false },
    {
      coins,
      deviceId,
      callSessionId,
      callType,
      bs,
      releaseCoins,
      debitCoins,
      freeSecondsApplied: alloc.freeSecondsApplied,
      coinBillableSeconds: alloc.coinBillableSeconds,
      callFreeSnapshot: snap,
      tariff,
    }
  );
}

/**
 * @param {*} coins
 * @param {object} p
 */
function finishSettleResponse(r, p) {
  const {
    coins: coinsRepo,
    deviceId,
    callSessionId,
    callType,
    bs,
    releaseCoins,
    debitCoins,
    freeSecondsApplied,
    coinBillableSeconds,
    callFreeSnapshot,
    tariff,
  } = p;

  if (!r.ok) {
    if (r.reason === "insufficient_funds") {
      const w = coinsRepo.getWallet(deviceId);
      return {
        status: 402,
        json: {
          error: "Insufficient spendable coins to settle final charge",
          reason: "insufficient_funds",
          callSessionId,
          finalDebitCoins: debitCoins,
          freeSecondsApplied,
          coinBillableSeconds,
          ...(callFreeSnapshot
            ? {
                usageUtcDate: callFreeSnapshot.usageUtcDate,
                callFreeSecondsAllowancePerDay:
                  callFreeSnapshot.callFreeSecondsAllowancePerDay,
                callFreeSecondsUsedToday: callFreeSnapshot.callFreeSecondsUsedToday,
                callFreeSecondsRemainingToday:
                  callFreeSnapshot.callFreeSecondsRemainingToday,
              }
            : {}),
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
      const w = coinsRepo.getWallet(deviceId);
      return {
        status: 402,
        json: {
          error:
            "Reserved coins on wallet are less than reservedAmount for this session",
          reason: "insufficient_reserved",
          callSessionId,
          reservedAmount: releaseCoins,
          freeSecondsApplied,
          coinBillableSeconds,
          ...(callFreeSnapshot
            ? {
                usageUtcDate: callFreeSnapshot.usageUtcDate,
                callFreeSecondsAllowancePerDay:
                  callFreeSnapshot.callFreeSecondsAllowancePerDay,
                callFreeSecondsUsedToday: callFreeSnapshot.callFreeSecondsUsedToday,
                callFreeSecondsRemainingToday:
                  callFreeSnapshot.callFreeSecondsRemainingToday,
              }
            : {}),
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

  const w = coinsRepo.getWallet(deviceId);
  const settleKey = `call:${callSessionId}:settle`;
  const releaseKey = `call:${callSessionId}:release`;
  const debitEntry = coinsRepo.getLedgerEntryByIdempotencyKey(settleKey);
  const rel = coinsRepo.getLedgerEntryByIdempotencyKey(releaseKey);
  return {
    status: 200,
    json: {
      ok: true,
      duplicate: r.duplicate === true,
      callSessionId,
      callType,
      billedSeconds: bs,
      tariffVersion: tariff ? tariff.version : undefined,
      releasedReserveCoins: releaseCoins,
      finalDebitCoins: debitCoins,
      freeSecondsApplied,
      coinBillableSeconds,
      ...(callFreeSnapshot
        ? {
            usageUtcDate: callFreeSnapshot.usageUtcDate,
            callFreeSecondsAllowancePerDay:
              callFreeSnapshot.callFreeSecondsAllowancePerDay,
            callFreeSecondsUsedToday: callFreeSnapshot.callFreeSecondsUsedToday,
            callFreeSecondsRemainingToday:
              callFreeSnapshot.callFreeSecondsRemainingToday,
          }
        : {}),
      wallet:
        walletToResponseJson(w) ?? {
          deviceId,
          availableCoins: 0,
          reservedCoins: 0,
          spendableCoins: 0,
          updatedAt: null,
        },
      releaseEntry: rel ? ledgerEntryToResponseJson(rel) : null,
      debitEntry: debitEntry ? ledgerEntryToResponseJson(debitEntry) : null,
    },
  };
}

module.exports = {
  normalizeCallSessionId,
  processCallChargeStart,
  processCallChargeSettle,
  MAX_SESSION_ID_LEN,
};
