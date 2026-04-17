/**
 * CONNECT coin spend / debit (Phase Call-Meter-1).
 * Delegates to {@link createCoinWalletRepository}'s `applyLedgerDebit` — no parallel balance logic.
 *
 * @see docs/v2-coin-wallet-billing.md
 */

const { COIN_LEDGER_ENTRY_KINDS } = require("./coinEntryKinds");

const MAX_IDEMPOTENCY_KEY_LEN = 512;
const MAX_EXTERNAL_REF_LEN = 512;
const MAX_AMOUNT = 1_000_000_000;
const MAX_METADATA_JSON_BYTES = 8192;

/**
 * @param {{ updatedAt: number } | null | undefined} w
 * @returns {string | null}
 */
function walletUpdatedAtIso(w) {
  if (!w || w.updatedAt == null) return null;
  return new Date(w.updatedAt).toISOString();
}

/**
 * @param {*} w
 */
function walletToResponseJson(w) {
  if (!w) {
    return null;
  }
  return {
    deviceId: w.deviceId,
    availableCoins: w.availableCoins,
    reservedCoins: w.reservedCoins,
    spendableCoins: w.spendableCoins,
    updatedAt: walletUpdatedAtIso(w),
  };
}

/**
 * @param {*} e
 */
function ledgerEntryToResponseJson(e) {
  if (!e) return null;
  return {
    id: e.id,
    deltaCoins: e.deltaCoins,
    balanceAfter: e.balanceAfter,
    entryKind: e.entryKind,
    idempotencyKey: e.idempotencyKey,
    externalReference: e.externalReference ?? null,
  };
}

/**
 * Validates body and applies a `call_debit` ledger entry (idempotent).
 *
 * Trust model: same as `GET /v2/billing/wallet` — caller must know `deviceId`.
 * Optional server-side signing / internal-only routing can be layered later.
 *
 * @param {*} coins — repository from `createCoinWalletRepository`
 * @param {Record<string, unknown>} body
 * @returns {{ status: number, json: Record<string, unknown> }}
 */
function processCoinSpendRequest(coins, body) {
  const raw = body && typeof body === "object" ? body : {};

  const deviceId =
    typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    return {
      status: 400,
      json: {
        error: "Missing or invalid deviceId",
        reason: "invalid_device",
      },
    };
  }

  const idempotencyKey =
    typeof raw.idempotencyKey === "string"
      ? raw.idempotencyKey.trim()
      : "";
  if (!idempotencyKey) {
    return {
      status: 400,
      json: {
        error: "Missing or invalid idempotencyKey",
        reason: "invalid_idempotency_key",
      },
    };
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LEN) {
    return {
      status: 400,
      json: {
        error: "idempotencyKey is too long",
        reason: "invalid_idempotency_key",
      },
    };
  }

  const amount = raw.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    return {
      status: 400,
      json: {
        error: "amount must be a positive integer",
        reason: "invalid_amount",
      },
    };
  }
  if (amount > MAX_AMOUNT) {
    return {
      status: 400,
      json: {
        error: "amount exceeds maximum",
        reason: "invalid_amount",
      },
    };
  }

  let metadataJson = null;
  if (raw.metadata !== undefined && raw.metadata !== null) {
    if (typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) {
      return {
        status: 400,
        json: {
          error: "metadata must be a plain object",
          reason: "invalid_metadata",
        },
      };
    }
    try {
      metadataJson = JSON.stringify(raw.metadata);
    } catch {
      return {
        status: 400,
        json: {
          error: "metadata could not be serialized",
          reason: "invalid_metadata",
        },
      };
    }
    if (metadataJson.length > MAX_METADATA_JSON_BYTES) {
      return {
        status: 400,
        json: {
          error: "metadata JSON is too large",
          reason: "invalid_metadata",
        },
      };
    }
  }

  let externalReference = null;
  if (raw.externalReference !== undefined && raw.externalReference !== null) {
    if (typeof raw.externalReference !== "string") {
      return {
        status: 400,
        json: {
          error: "externalReference must be a string",
          reason: "invalid_external_reference",
        },
      };
    }
    externalReference = raw.externalReference.trim();
    if (externalReference.length > MAX_EXTERNAL_REF_LEN) {
      return {
        status: 400,
        json: {
          error: "externalReference is too long",
          reason: "invalid_external_reference",
        },
      };
    }
  }

  const r = coins.applyLedgerDebit({
    deviceId,
    amount,
    idempotencyKey,
    entryKind: COIN_LEDGER_ENTRY_KINDS.CALL_DEBIT,
    externalReference,
    metadataJson,
  });

  if (!r.ok) {
    if (r.reason === "insufficient_funds") {
      const w = coins.getWallet(deviceId);
      return {
        status: 402,
        json: {
          error: "Insufficient spendable coins",
          reason: "insufficient_funds",
          wallet: walletToResponseJson(w) ?? {
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
          error: "idempotencyKey already used for a different device",
          reason: "idempotency_key_conflict",
        },
      };
    }
    if (r.reason === "invariant_broken") {
      return {
        status: 500,
        json: {
          error: "Coin wallet invariant violated",
          reason: "invariant_broken",
        },
      };
    }
    return {
      status: 400,
      json: {
        error: "Spend request could not be applied",
        reason: r.reason,
      },
    };
  }

  return {
    status: 200,
    json: {
      ok: true,
      duplicate: r.duplicate === true,
      wallet: walletToResponseJson(r.wallet),
      entry: ledgerEntryToResponseJson(r.entry),
    },
  };
}

module.exports = {
  processCoinSpendRequest,
  walletToResponseJson,
  ledgerEntryToResponseJson,
  MAX_IDEMPOTENCY_KEY_LEN,
  MAX_AMOUNT,
};
