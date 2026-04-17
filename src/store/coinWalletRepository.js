/**
 * CONNECT prepaid coin wallet + append-only ledger (Phase Coins-2).
 *
 * - Wallet + ledger rows are updated in a single SQLite transaction.
 * - `idempotency_key` is globally unique; duplicate requests return `{ duplicate: true }` without
 *   changing balance (Stripe webhook safe).
 * - Debits require spendable balance: `(available_coins - reserved_coins) >= amount`.
 * - Credits increase `available_coins` only.
 * - Reserve ops: `reserve_hold` / `reserve_release` adjust `reserved_coins` under the same
 *   spendable rules (see inline comments).
 * - `applyCallSessionSettlement`: atomic release + final `call_debit` for call billing (Phase Call-Meter-2).
 *
 * @see docs/connect-coins-wallet-design.md
 */

const crypto = require("crypto");
const {
  COIN_LEDGER_ENTRY_KINDS,
  isValidCoinLedgerEntryKind,
} = require("../coinEntryKinds");

function nowMs() {
  return Date.now();
}

function newLedgerId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function createCoinWalletRepository(db) {
  const insertWalletIgnore = db.prepare(
    `INSERT OR IGNORE INTO device_coin_wallets (
       device_id, available_coins, reserved_coins, updated_at, version
     ) VALUES (@device_id, 0, 0, @updated_at, 0)`
  );

  const selectWallet = db.prepare(
    `SELECT device_id, available_coins, reserved_coins, updated_at, version
     FROM device_coin_wallets WHERE device_id = ?`
  );

  const selectLedgerByKey = db.prepare(
    `SELECT id, device_id, created_at, delta_coins, balance_after, entry_kind,
            idempotency_key, pack_id, stripe_checkout_session_id, stripe_payment_intent_id,
            external_reference, metadata_json
     FROM coin_ledger_entries WHERE idempotency_key = ?`
  );

  const insertLedger = db.prepare(
    `INSERT INTO coin_ledger_entries (
       id, device_id, created_at, delta_coins, balance_after, entry_kind,
       idempotency_key, pack_id, stripe_checkout_session_id, stripe_payment_intent_id,
       external_reference, metadata_json
     ) VALUES (
       @id, @device_id, @created_at, @delta_coins, @balance_after, @entry_kind,
       @idempotency_key, @pack_id, @stripe_checkout_session_id, @stripe_payment_intent_id,
       @external_reference, @metadata_json
     )`
  );

  const updateWalletCredit = db.prepare(
    `UPDATE device_coin_wallets SET
       available_coins = available_coins + @delta,
       updated_at = @updated_at,
       version = version + 1
     WHERE device_id = @device_id`
  );

  const updateWalletDebit = db.prepare(
    `UPDATE device_coin_wallets SET
       available_coins = available_coins - @amount,
       updated_at = @updated_at,
       version = version + 1
     WHERE device_id = @device_id
       AND (available_coins - reserved_coins) >= @amount`
  );

  const updateWalletReserveHold = db.prepare(
    `UPDATE device_coin_wallets SET
       reserved_coins = reserved_coins + @amount,
       updated_at = @updated_at,
       version = version + 1
     WHERE device_id = @device_id
       AND (available_coins - reserved_coins) >= @amount`
  );

  const updateWalletReserveRelease = db.prepare(
    `UPDATE device_coin_wallets SET
       reserved_coins = reserved_coins - @amount,
       updated_at = @updated_at,
       version = version + 1
     WHERE device_id = @device_id
       AND reserved_coins >= @amount`
  );

  const listLedger = db.prepare(
    `SELECT id, device_id, created_at, delta_coins, balance_after, entry_kind,
            idempotency_key, pack_id, stripe_checkout_session_id, stripe_payment_intent_id,
            external_reference, metadata_json
     FROM coin_ledger_entries
     WHERE device_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`
  );

  function normalizeDeviceId(deviceId) {
    return typeof deviceId === "string" ? deviceId.trim() : "";
  }

  function normalizeIdempotencyKey(key) {
    return typeof key === "string" ? key.trim() : "";
  }

  function mapWalletRow(row) {
    if (!row) return null;
    const available = row.available_coins;
    const reserved = row.reserved_coins;
    return {
      deviceId: row.device_id,
      availableCoins: available,
      reservedCoins: reserved,
      spendableCoins: available - reserved,
      updatedAt: row.updated_at,
      version: row.version,
    };
  }

  function mapLedgerRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      deviceId: row.device_id,
      createdAt: row.created_at,
      deltaCoins: row.delta_coins,
      balanceAfter: row.balance_after,
      entryKind: row.entry_kind,
      idempotencyKey: row.idempotency_key,
      packId: row.pack_id,
      stripeCheckoutSessionId: row.stripe_checkout_session_id,
      stripePaymentIntentId: row.stripe_payment_intent_id,
      externalReference: row.external_reference,
      metadataJson: row.metadata_json,
    };
  }

  /**
   * Ensure a wallet row exists (idempotent).
   * @param {string} deviceId
   * @returns {{ deviceId: string, availableCoins: number, reservedCoins: number, spendableCoins: number, updatedAt: number, version: number }}
   */
  function getOrCreateWallet(deviceId) {
    const dev = normalizeDeviceId(deviceId);
    if (!dev) {
      throw new Error("coin wallet: invalid deviceId");
    }
    const t = nowMs();
    insertWalletIgnore.run({ device_id: dev, updated_at: t });
    const row = selectWallet.get(dev);
    return mapWalletRow(row);
  }

  /**
   * @param {string} deviceId
   * @returns {{ deviceId: string, availableCoins: number, reservedCoins: number, spendableCoins: number, updatedAt: number, version: number } | null}
   */
  function getWallet(deviceId) {
    const dev = normalizeDeviceId(deviceId);
    if (!dev) {
      return null;
    }
    const row = selectWallet.get(dev);
    return mapWalletRow(row);
  }

  /**
   * @param {object} p
   * @param {string} p.deviceId
   * @param {number} p.amount positive coin amount
   * @param {string} p.idempotencyKey global unique
   * @param {string} p.entryKind e.g. purchase_credit, admin_adjust_credit
   * @param {string} [p.packId]
   * @param {string} [p.stripeCheckoutSessionId]
   * @param {string} [p.stripePaymentIntentId]
   * @param {string} [p.externalReference]
   * @param {string} [p.metadataJson]
   */
  function applyLedgerCredit(p) {
    const dev = normalizeDeviceId(p.deviceId);
    const key = normalizeIdempotencyKey(p.idempotencyKey);
    const amount = Number(p.amount);
    const kind = p.entryKind;

    if (!dev) {
      return { ok: false, reason: "invalid_device" };
    }
    if (!key) {
      return { ok: false, reason: "invalid_idempotency_key" };
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, reason: "invalid_amount" };
    }
    if (!isValidCoinLedgerEntryKind(kind)) {
      return { ok: false, reason: "invalid_entry_kind" };
    }
    if (
      kind !== COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT &&
      kind !== COIN_LEDGER_ENTRY_KINDS.ADMIN_ADJUST_CREDIT
    ) {
      return { ok: false, reason: "entry_kind_not_credit" };
    }

    const existing = selectLedgerByKey.get(key);
    if (existing) {
      if (existing.device_id !== dev) {
        return { ok: false, reason: "idempotency_key_conflict" };
      }
      const w = selectWallet.get(dev);
      return {
        ok: true,
        duplicate: true,
        wallet: mapWalletRow(w),
        entry: mapLedgerRow(existing),
      };
    }

    const t = nowMs();
    const ledgerId = newLedgerId();

    const runTx = db.transaction(() => {
      insertWalletIgnore.run({ device_id: dev, updated_at: t });
      const before = selectWallet.get(dev);
      if (!before) {
        throw new Error("coin wallet: missing row after insert");
      }
      const newAvailable = before.available_coins + amount;
      updateWalletCredit.run({
        device_id: dev,
        delta: amount,
        updated_at: t,
      });
      insertLedger.run({
        id: ledgerId,
        device_id: dev,
        created_at: t,
        delta_coins: amount,
        balance_after: newAvailable,
        entry_kind: kind,
        idempotency_key: key,
        pack_id: p.packId ?? null,
        stripe_checkout_session_id: p.stripeCheckoutSessionId ?? null,
        stripe_payment_intent_id: p.stripePaymentIntentId ?? null,
        external_reference: p.externalReference ?? null,
        metadata_json: p.metadataJson ?? null,
      });
    });

    try {
      runTx();
    } catch (e) {
      if (String(e.message || e).includes("UNIQUE constraint failed")) {
        const row = selectLedgerByKey.get(key);
        if (row && row.device_id === dev) {
          const w = selectWallet.get(dev);
          return {
            ok: true,
            duplicate: true,
            wallet: mapWalletRow(w),
            entry: mapLedgerRow(row),
          };
        }
        return { ok: false, reason: "idempotency_key_conflict" };
      }
      throw e;
    }

    const w = selectWallet.get(dev);
    const entry = selectLedgerByKey.get(key);
    return {
      ok: true,
      duplicate: false,
      wallet: mapWalletRow(w),
      entry: mapLedgerRow(entry),
    };
  }

  /**
   * Debits reduce `available_coins` only; `reserved_coins` unchanged.
   * @param {object} p
   * @param {string} p.deviceId
   * @param {number} p.amount positive coin amount to subtract
   * @param {string} p.idempotencyKey
   * @param {string} p.entryKind call_debit | admin_adjust_debit
   * @param {string} [p.packId]
   * @param {string} [p.stripeCheckoutSessionId]
   * @param {string} [p.stripePaymentIntentId]
   * @param {string} [p.externalReference]
   * @param {string} [p.metadataJson]
   */
  function applyLedgerDebit(p) {
    const dev = normalizeDeviceId(p.deviceId);
    const key = normalizeIdempotencyKey(p.idempotencyKey);
    const amount = Number(p.amount);
    const kind = p.entryKind;

    if (!dev) {
      return { ok: false, reason: "invalid_device" };
    }
    if (!key) {
      return { ok: false, reason: "invalid_idempotency_key" };
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, reason: "invalid_amount" };
    }
    if (!isValidCoinLedgerEntryKind(kind)) {
      return { ok: false, reason: "invalid_entry_kind" };
    }
    if (
      kind !== COIN_LEDGER_ENTRY_KINDS.CALL_DEBIT &&
      kind !== COIN_LEDGER_ENTRY_KINDS.ADMIN_ADJUST_DEBIT
    ) {
      return { ok: false, reason: "entry_kind_not_debit" };
    }

    const existing = selectLedgerByKey.get(key);
    if (existing) {
      if (existing.device_id !== dev) {
        return { ok: false, reason: "idempotency_key_conflict" };
      }
      const w = selectWallet.get(dev);
      return {
        ok: true,
        duplicate: true,
        wallet: mapWalletRow(w),
        entry: mapLedgerRow(existing),
      };
    }

    const t = nowMs();
    const ledgerId = newLedgerId();

    const runTx = db.transaction(() => {
      insertWalletIgnore.run({ device_id: dev, updated_at: t });
      const before = selectWallet.get(dev);
      if (!before) {
        throw new Error("coin wallet: missing row after insert");
      }
      const spendable = before.available_coins - before.reserved_coins;
      if (spendable < amount) {
        return { err: "insufficient_funds" };
      }
      const newAvailable = before.available_coins - amount;
      if (before.reserved_coins > newAvailable) {
        return { err: "invariant_broken" };
      }
      const n = updateWalletDebit.run({
        device_id: dev,
        amount,
        updated_at: t,
      }).changes;
      if (n !== 1) {
        return { err: "insufficient_funds" };
      }
      insertLedger.run({
        id: ledgerId,
        device_id: dev,
        created_at: t,
        delta_coins: -amount,
        balance_after: newAvailable,
        entry_kind: kind,
        idempotency_key: key,
        pack_id: p.packId ?? null,
        stripe_checkout_session_id: p.stripeCheckoutSessionId ?? null,
        stripe_payment_intent_id: p.stripePaymentIntentId ?? null,
        external_reference: p.externalReference ?? null,
        metadata_json: p.metadataJson ?? null,
      });
      return null;
    });

    try {
      const err = runTx();
      if (err && err.err === "insufficient_funds") {
        return { ok: false, reason: "insufficient_funds" };
      }
      if (err && err.err === "invariant_broken") {
        return { ok: false, reason: "invariant_broken" };
      }
    } catch (e) {
      if (String(e.message || e).includes("UNIQUE constraint failed")) {
        const row = selectLedgerByKey.get(key);
        if (row && row.device_id === dev) {
          const w = selectWallet.get(dev);
          return {
            ok: true,
            duplicate: true,
            wallet: mapWalletRow(w),
            entry: mapLedgerRow(row),
          };
        }
        return { ok: false, reason: "idempotency_key_conflict" };
      }
      throw e;
    }

    const w = selectWallet.get(dev);
    const entry = selectLedgerByKey.get(key);
    return {
      ok: true,
      duplicate: false,
      wallet: mapWalletRow(w),
      entry: mapLedgerRow(entry),
    };
  }

  /**
   * Hold coins for in-flight metering (increases `reserved_coins`).
   * @param {object} p
   * @param {string} p.deviceId
   * @param {number} p.amount
   * @param {string} p.idempotencyKey
   * @param {string} [p.metadataJson]
   */
  function applyReserveHold(p) {
    return applyReserveMutation(p, "hold");
  }

  /**
   * Release a prior hold (decreases `reserved_coins`).
   */
  function applyReserveRelease(p) {
    return applyReserveMutation(p, "release");
  }

  function applyReserveMutation(p, mode) {
    const dev = normalizeDeviceId(p.deviceId);
    const key = normalizeIdempotencyKey(p.idempotencyKey);
    const amount = Number(p.amount);
    const kind =
      mode === "hold"
        ? COIN_LEDGER_ENTRY_KINDS.RESERVE_HOLD
        : COIN_LEDGER_ENTRY_KINDS.RESERVE_RELEASE;

    if (!dev) {
      return { ok: false, reason: "invalid_device" };
    }
    if (!key) {
      return { ok: false, reason: "invalid_idempotency_key" };
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, reason: "invalid_amount" };
    }

    const existing = selectLedgerByKey.get(key);
    if (existing) {
      if (existing.device_id !== dev) {
        return { ok: false, reason: "idempotency_key_conflict" };
      }
      const w = selectWallet.get(dev);
      return {
        ok: true,
        duplicate: true,
        wallet: mapWalletRow(w),
        entry: mapLedgerRow(existing),
      };
    }

    const t = nowMs();
    const ledgerId = newLedgerId();

    const runTx = db.transaction(() => {
      insertWalletIgnore.run({ device_id: dev, updated_at: t });
      const before = selectWallet.get(dev);
      if (!before) {
        throw new Error("coin wallet: missing row after insert");
      }

      let newAvailable = before.available_coins;
      let newReserved = before.reserved_coins;
      let deltaLedger = 0;

      if (mode === "hold") {
        const spendable = before.available_coins - before.reserved_coins;
        if (spendable < amount) {
          return { err: "insufficient_funds" };
        }
        newReserved = before.reserved_coins + amount;
        deltaLedger = 0;
        const n = updateWalletReserveHold.run({
          device_id: dev,
          amount,
          updated_at: t,
        }).changes;
        if (n !== 1) {
          return { err: "insufficient_funds" };
        }
      } else {
        if (before.reserved_coins < amount) {
          return { err: "insufficient_reserved" };
        }
        newReserved = before.reserved_coins - amount;
        const n = updateWalletReserveRelease.run({
          device_id: dev,
          amount,
          updated_at: t,
        }).changes;
        if (n !== 1) {
          return { err: "insufficient_reserved" };
        }
      }

      if (newReserved > newAvailable) {
        return { err: "invariant_broken" };
      }

      insertLedger.run({
        id: ledgerId,
        device_id: dev,
        created_at: t,
        delta_coins: deltaLedger,
        balance_after: newAvailable,
        entry_kind: kind,
        idempotency_key: key,
        pack_id: null,
        stripe_checkout_session_id: null,
        stripe_payment_intent_id: null,
        external_reference: null,
        metadata_json: p.metadataJson ?? null,
      });
      return null;
    });

    try {
      const err = runTx();
      if (err && err.err === "insufficient_funds") {
        return { ok: false, reason: "insufficient_funds" };
      }
      if (err && err.err === "insufficient_reserved") {
        return { ok: false, reason: "insufficient_reserved" };
      }
      if (err && err.err === "invariant_broken") {
        return { ok: false, reason: "invariant_broken" };
      }
    } catch (e) {
      if (String(e.message || e).includes("UNIQUE constraint failed")) {
        const row = selectLedgerByKey.get(key);
        if (row && row.device_id === dev) {
          const w = selectWallet.get(dev);
          return {
            ok: true,
            duplicate: true,
            wallet: mapWalletRow(w),
            entry: mapLedgerRow(row),
          };
        }
        return { ok: false, reason: "idempotency_key_conflict" };
      }
      throw e;
    }

    const w = selectWallet.get(dev);
    const entry = selectLedgerByKey.get(key);
    return {
      ok: true,
      duplicate: false,
      wallet: mapWalletRow(w),
      entry: mapLedgerRow(entry),
    };
  }

  /**
   * @param {string} deviceId
   * @param {{ limit?: number }} [opts]
   * @returns {Array<ReturnType<typeof mapLedgerRow>>}
   */
  function listLedgerEntries(deviceId, opts = {}) {
    const dev = normalizeDeviceId(deviceId);
    if (!dev) {
      return [];
    }
    const limitRaw = opts.limit != null ? Number(opts.limit) : 20;
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));
    const rows = listLedger.all(dev, limit);
    return rows.map(mapLedgerRow);
  }

  /**
   * Atomically settle a call session: optional reserve release + final `call_debit` (possibly 0 coins).
   * Idempotency is keyed by **`call:${sessionId}:settle`** (debit row). Duplicate POSTs return **`duplicate: true`**.
   * **`call:${sessionId}:release`** is written in the same transaction when **`releaseCoins > 0`** (unless already present — recovery).
   *
   * @param {object} p
   * @param {string} p.deviceId
   * @param {string} p.sessionId — used only to derive idempotency keys (caller must normalize)
   * @param {number} p.releaseCoins — coins to release from `reserved_coins` (≥ 0)
   * @param {number} p.debitCoins — coins to debit from available after release (≥ 0)
   * @param {string} [p.releaseMetadataJson]
   * @param {string} [p.debitMetadataJson]
   * @param {string} [p.debitExternalReference]
   */
  function applyCallSessionSettlement(p) {
    const dev = normalizeDeviceId(p.deviceId);
    const sessionId =
      typeof p.sessionId === "string" ? p.sessionId.trim() : "";
    const releaseCoins = Number(p.releaseCoins);
    const debitCoins = Number(p.debitCoins);

    const settleKey = `call:${sessionId}:settle`;
    const releaseKey = `call:${sessionId}:release`;

    if (!dev) {
      return { ok: false, reason: "invalid_device" };
    }
    if (!sessionId) {
      return { ok: false, reason: "invalid_session" };
    }
    if (
      !Number.isInteger(releaseCoins) ||
      releaseCoins < 0 ||
      !Number.isInteger(debitCoins) ||
      debitCoins < 0
    ) {
      return { ok: false, reason: "invalid_amount" };
    }
    const existingSettle = selectLedgerByKey.get(settleKey);
    if (existingSettle) {
      if (existingSettle.device_id !== dev) {
        return { ok: false, reason: "idempotency_key_conflict" };
      }
      const w = selectWallet.get(dev);
      const releaseEntry = selectLedgerByKey.get(releaseKey);
      return {
        ok: true,
        duplicate: true,
        wallet: mapWalletRow(w),
        releaseEntry: releaseEntry ? mapLedgerRow(releaseEntry) : null,
        debitEntry: mapLedgerRow(existingSettle),
      };
    }

    const t = nowMs();

    const runTx = db.transaction(() => {
      insertWalletIgnore.run({ device_id: dev, updated_at: t });
      let w = selectWallet.get(dev);
      if (!w) {
        throw new Error("coin wallet: missing row after insert");
      }

      if (releaseCoins === 0 && debitCoins === 0) {
        const ledgerIdZero = newLedgerId();
        insertLedger.run({
          id: ledgerIdZero,
          device_id: dev,
          created_at: t,
          delta_coins: 0,
          balance_after: w.available_coins,
          entry_kind: COIN_LEDGER_ENTRY_KINDS.CALL_DEBIT,
          idempotency_key: settleKey,
          pack_id: null,
          stripe_checkout_session_id: null,
          stripe_payment_intent_id: null,
          external_reference: p.debitExternalReference ?? null,
          metadata_json: p.debitMetadataJson ?? null,
        });
        return null;
      }

      const releaseRowExisting = selectLedgerByKey.get(releaseKey);

      if (releaseCoins > 0 && !releaseRowExisting) {
        if (w.reserved_coins < releaseCoins) {
          return { err: "insufficient_reserved" };
        }
        const n = updateWalletReserveRelease.run({
          device_id: dev,
          amount: releaseCoins,
          updated_at: t,
        }).changes;
        if (n !== 1) {
          return { err: "insufficient_reserved" };
        }
        w = selectWallet.get(dev);
        const ledgerIdRel = newLedgerId();
        insertLedger.run({
          id: ledgerIdRel,
          device_id: dev,
          created_at: t,
          delta_coins: 0,
          balance_after: w.available_coins,
          entry_kind: COIN_LEDGER_ENTRY_KINDS.RESERVE_RELEASE,
          idempotency_key: releaseKey,
          pack_id: null,
          stripe_checkout_session_id: null,
          stripe_payment_intent_id: null,
          external_reference: null,
          metadata_json: p.releaseMetadataJson ?? null,
        });
      }

      w = selectWallet.get(dev);
      const spendable = w.available_coins - w.reserved_coins;

      if (debitCoins > 0) {
        if (spendable < debitCoins) {
          return { err: "insufficient_funds" };
        }
        const newAvailable = w.available_coins - debitCoins;
        if (w.reserved_coins > newAvailable) {
          return { err: "invariant_broken" };
        }
        const n = updateWalletDebit.run({
          device_id: dev,
          amount: debitCoins,
          updated_at: t,
        }).changes;
        if (n !== 1) {
          return { err: "insufficient_funds" };
        }
        w = selectWallet.get(dev);
      }

      const ledgerIdDebit = newLedgerId();
      insertLedger.run({
        id: ledgerIdDebit,
        device_id: dev,
        created_at: t,
        delta_coins: debitCoins > 0 ? -debitCoins : 0,
        balance_after: w.available_coins,
        entry_kind: COIN_LEDGER_ENTRY_KINDS.CALL_DEBIT,
        idempotency_key: settleKey,
        pack_id: null,
        stripe_checkout_session_id: null,
        stripe_payment_intent_id: null,
        external_reference: p.debitExternalReference ?? null,
        metadata_json: p.debitMetadataJson ?? null,
      });
      return null;
    });

    try {
      const err = runTx();
      if (err && err.err === "insufficient_reserved") {
        return { ok: false, reason: "insufficient_reserved" };
      }
      if (err && err.err === "insufficient_funds") {
        return { ok: false, reason: "insufficient_funds" };
      }
      if (err && err.err === "invariant_broken") {
        return { ok: false, reason: "invariant_broken" };
      }
    } catch (e) {
      if (String(e.message || e).includes("UNIQUE constraint failed")) {
        const row = selectLedgerByKey.get(settleKey);
        if (row && row.device_id === dev) {
          const w = selectWallet.get(dev);
          const releaseEntry = selectLedgerByKey.get(releaseKey);
          return {
            ok: true,
            duplicate: true,
            wallet: mapWalletRow(w),
            releaseEntry: releaseEntry ? mapLedgerRow(releaseEntry) : null,
            debitEntry: mapLedgerRow(row),
          };
        }
        return { ok: false, reason: "idempotency_key_conflict" };
      }
      throw e;
    }

    const wFinal = selectWallet.get(dev);
    const debitEntry = selectLedgerByKey.get(settleKey);
    const releaseEntry = selectLedgerByKey.get(releaseKey);
    return {
      ok: true,
      duplicate: false,
      wallet: mapWalletRow(wFinal),
      releaseEntry: releaseEntry ? mapLedgerRow(releaseEntry) : null,
      debitEntry: debitEntry ? mapLedgerRow(debitEntry) : null,
    };
  }

  return {
    getOrCreateWallet,
    getWallet,
    applyLedgerCredit,
    applyLedgerDebit,
    applyReserveHold,
    applyReserveRelease,
    applyCallSessionSettlement,
    listLedgerEntries,
  };
}

module.exports = { createCoinWalletRepository };
