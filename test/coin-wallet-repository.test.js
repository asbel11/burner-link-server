const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openDatabase } = require("../src/store/db");
const { createCoinWalletRepository } = require("../src/store/coinWalletRepository");
const { COIN_LEDGER_ENTRY_KINDS } = require("../src/coinEntryKinds");

describe("coin wallet repository (Coins-2)", () => {
  let dbPath;
  let coins;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-coins-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    const db = openDatabase(dbPath);
    coins = createCoinWalletRepository(db);
  });

  after(() => {
    try {
      fs.unlinkSync(dbPath);
    } catch (_) {
      /* ignore */
    }
    for (const ext of ["-shm", "-wal"]) {
      try {
        fs.unlinkSync(dbPath + ext);
      } catch (_) {
        /* ignore */
      }
    }
  });

  test("getWallet is null before any write; getOrCreateWallet yields zeros", () => {
    assert.equal(coins.getWallet("dev-a"), null);
    const w = coins.getOrCreateWallet("dev-a");
    assert.equal(w.deviceId, "dev-a");
    assert.equal(w.availableCoins, 0);
    assert.equal(w.reservedCoins, 0);
    assert.equal(w.spendableCoins, 0);
    assert.ok(typeof w.updatedAt === "number");
  });

  test("first credit creates balance and ledger row", () => {
    const r = coins.applyLedgerCredit({
      deviceId: "dev-b",
      amount: 100,
      idempotencyKey: "stripe:evt_credit_1",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
      packId: "coins_100",
    });
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, false);
    assert.equal(r.wallet.availableCoins, 100);
    assert.equal(r.entry.deltaCoins, 100);
    assert.equal(r.entry.balanceAfter, 100);
    assert.equal(r.entry.packId, "coins_100");
  });

  test("multiple credits accumulate", () => {
    coins.applyLedgerCredit({
      deviceId: "dev-c",
      amount: 50,
      idempotencyKey: "k1",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    coins.applyLedgerCredit({
      deviceId: "dev-c",
      amount: 25,
      idempotencyKey: "k2",
      entryKind: COIN_LEDGER_ENTRY_KINDS.ADMIN_ADJUST_CREDIT,
    });
    const w = coins.getWallet("dev-c");
    assert.equal(w.availableCoins, 75);
  });

  test("debit success reduces spendable", () => {
    coins.applyLedgerCredit({
      deviceId: "dev-d",
      amount: 40,
      idempotencyKey: "d-in",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    const r = coins.applyLedgerDebit({
      deviceId: "dev-d",
      amount: 15,
      idempotencyKey: "d-debit-1",
      entryKind: COIN_LEDGER_ENTRY_KINDS.CALL_DEBIT,
      metadataJson: JSON.stringify({ billed_seconds: 60, tariff_version: 1 }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, false);
    assert.equal(r.wallet.availableCoins, 25);
    assert.equal(r.entry.deltaCoins, -15);
  });

  test("debit insufficient funds", () => {
    coins.applyLedgerCredit({
      deviceId: "dev-e",
      amount: 10,
      idempotencyKey: "e-in",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    const r = coins.applyLedgerDebit({
      deviceId: "dev-e",
      amount: 50,
      idempotencyKey: "e-fail",
      entryKind: COIN_LEDGER_ENTRY_KINDS.CALL_DEBIT,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient_funds");
    assert.equal(coins.getWallet("dev-e").availableCoins, 10);
  });

  test("duplicate idempotency key on credit returns duplicate without double balance", () => {
    const key = "dup-credit-key";
    const a = coins.applyLedgerCredit({
      deviceId: "dev-f",
      amount: 20,
      idempotencyKey: key,
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    assert.equal(a.ok, true);
    assert.equal(a.duplicate, false);
    const b = coins.applyLedgerCredit({
      deviceId: "dev-f",
      amount: 20,
      idempotencyKey: key,
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    assert.equal(b.ok, true);
    assert.equal(b.duplicate, true);
    assert.equal(b.wallet.availableCoins, 20);
  });

  test("duplicate idempotency key on debit returns duplicate", () => {
    coins.applyLedgerCredit({
      deviceId: "dev-g",
      amount: 30,
      idempotencyKey: "g-in",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    const key = "dup-debit-key";
    const a = coins.applyLedgerDebit({
      deviceId: "dev-g",
      amount: 5,
      idempotencyKey: key,
      entryKind: COIN_LEDGER_ENTRY_KINDS.CALL_DEBIT,
    });
    const b = coins.applyLedgerDebit({
      deviceId: "dev-g",
      amount: 5,
      idempotencyKey: key,
      entryKind: COIN_LEDGER_ENTRY_KINDS.CALL_DEBIT,
    });
    assert.equal(a.ok, true);
    assert.equal(b.duplicate, true);
    assert.equal(b.wallet.availableCoins, 25);
  });

  test("idempotency key conflict when device differs", () => {
    coins.applyLedgerCredit({
      deviceId: "dev-h1",
      amount: 1,
      idempotencyKey: "shared-bad",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    const r = coins.applyLedgerCredit({
      deviceId: "dev-h2",
      amount: 1,
      idempotencyKey: "shared-bad",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "idempotency_key_conflict");
  });

  test("listLedgerEntries orders newest first", () => {
    const dev = "dev-sort";
    coins.applyLedgerCredit({
      deviceId: dev,
      amount: 1,
      idempotencyKey: "sort-1",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    coins.applyLedgerCredit({
      deviceId: dev,
      amount: 2,
      idempotencyKey: "sort-2",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    const list = coins.listLedgerEntries(dev, { limit: 10 });
    assert.equal(list.length, 2);
    assert.equal(list[0].idempotencyKey, "sort-2");
    assert.equal(list[1].idempotencyKey, "sort-1");
  });

  test("reserve hold then release keeps available unchanged", () => {
    const dev = "dev-rsv";
    coins.applyLedgerCredit({
      deviceId: dev,
      amount: 100,
      idempotencyKey: "rsv-in",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    const h = coins.applyReserveHold({
      deviceId: dev,
      amount: 40,
      idempotencyKey: "hold-1",
    });
    assert.equal(h.ok, true);
    assert.equal(h.wallet.availableCoins, 100);
    assert.equal(h.wallet.reservedCoins, 40);
    assert.equal(h.wallet.spendableCoins, 60);
    const rel = coins.applyReserveRelease({
      deviceId: dev,
      amount: 40,
      idempotencyKey: "rel-1",
    });
    assert.equal(rel.ok, true);
    assert.equal(rel.wallet.reservedCoins, 0);
    assert.equal(rel.wallet.spendableCoins, 100);
  });

  test("debit respects reserved coins (spendable only)", () => {
    const dev = "dev-rsv2";
    coins.applyLedgerCredit({
      deviceId: dev,
      amount: 50,
      idempotencyKey: "rsv2-in",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    });
    coins.applyReserveHold({
      deviceId: dev,
      amount: 45,
      idempotencyKey: "hold-2",
    });
    const d = coins.applyLedgerDebit({
      deviceId: dev,
      amount: 10,
      idempotencyKey: "deb-2",
      entryKind: COIN_LEDGER_ENTRY_KINDS.CALL_DEBIT,
    });
    assert.equal(d.ok, false);
    assert.equal(d.reason, "insufficient_funds");
  });
});
