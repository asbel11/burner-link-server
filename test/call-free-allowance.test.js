const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openDatabase } = require("../src/store/db");
const { createCoinWalletRepository } = require("../src/store/coinWalletRepository");
const { createCallFreeAllowance } = require("../src/callFreeAllowance");
const {
  processCallChargeStart,
  processCallChargeSettle,
} = require("../src/connectCallBilling");
const { COIN_LEDGER_ENTRY_KINDS } = require("../src/coinEntryKinds");

const TARIFF = Object.freeze({
  version: 1,
  voice: { coinsPerSecond: 1 },
  video: { coinsPerSecond: 3 },
});

describe("daily free call allowance (180s default)", () => {
  let dbPath;
  let db;
  let coins;
  let callFree;
  let prevFree;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-free-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevFree = process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY;
    delete process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY;
    db = openDatabase(dbPath);
    coins = createCoinWalletRepository(db);
    callFree = createCallFreeAllowance(db);
  });

  after(() => {
    if (prevFree === undefined) delete process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY;
    else process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY = prevFree;
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

  function fund(dev, amount, key) {
    coins.applyLedgerCredit({
      deviceId: dev,
      amount,
      idempotencyKey: key,
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
      packId: "test",
    });
  }

  test("start uses no coin reserve when estimate fits in free pool", () => {
    const dev = "dev-fr1";
    fund(dev, 100, "ff1");
    const out = processCallChargeStart(
      coins,
      {
        deviceId: dev,
        callSessionId: "sess-free-1",
        callType: "voice",
        estimatedBillableSeconds: 60,
      },
      TARIFF,
      { callFree }
    );
    assert.equal(out.status, 200);
    assert.equal(out.json.holdApplied, false);
    assert.equal(out.json.reservedCoins, 0);
    assert.equal(out.json.callFreeSecondsRemainingToday, 180);
    assert.equal(out.json.freeSecondsRemaining, 180);
    assert.equal(out.json.willUseCoins, false);
  });

  test("settle consumes free seconds before coins", () => {
    const dev = "dev-fr2";
    fund(dev, 500, "ff2");
    const sid = "sess-free-2";
    const st = processCallChargeStart(
      coins,
      {
        deviceId: dev,
        callSessionId: sid,
        callType: "voice",
        estimatedBillableSeconds: 200,
      },
      TARIFF,
      { callFree }
    );
    assert.equal(st.json.reservedCoins, 20);
    assert.equal(st.json.freeSecondsRemaining, 180);
    assert.equal(st.json.willUseCoins, true);
    const se = processCallChargeSettle(
      coins,
      {
        deviceId: dev,
        callSessionId: sid,
        callType: "voice",
        billedSeconds: 200,
        reservedAmount: 20,
      },
      TARIFF,
      { db, callFree }
    );
    assert.equal(se.status, 200);
    assert.equal(se.json.freeSecondsApplied, 180);
    assert.equal(se.json.coinBillableSeconds, 20);
    assert.equal(se.json.finalDebitCoins, 20);
    assert.equal(se.json.wallet.availableCoins, 480);
    assert.equal(se.json.callFreeSecondsRemainingToday, 0);
  });

  test("duplicate settle does not double-consume free", () => {
    const dev = "dev-fr3";
    fund(dev, 100, "ff3");
    const sid = "sess-free-3";
    processCallChargeStart(
      coins,
      {
        deviceId: dev,
        callSessionId: sid,
        callType: "voice",
        estimatedBillableSeconds: 10,
      },
      TARIFF,
      { callFree }
    );
    const body = {
      deviceId: dev,
      callSessionId: sid,
      callType: "voice",
      billedSeconds: 10,
      reservedAmount: 0,
    };
    const a = processCallChargeSettle(coins, body, TARIFF, { db, callFree });
    const b = processCallChargeSettle(coins, body, TARIFF, { db, callFree });
    assert.equal(a.json.finalDebitCoins, 0);
    assert.equal(a.json.freeSecondsApplied, 10);
    assert.equal(b.json.duplicate, true);
    const snap = callFree.getSnapshot(dev);
    assert.equal(snap.callFreeSecondsUsedToday, 10);
  });

  test("wallet GET includes free snapshot fields", () => {
    const { createRoomStore } = require("../src/store");
    const p = path.join(
      os.tmpdir(),
      `burner-wallet-free-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    const store = createRoomStore({ dbFilePath: p });
    store.coins.applyLedgerCredit({
      deviceId: "w1",
      amount: 1,
      idempotencyKey: "w1c",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
      packId: "p",
    });
    const s = store.callFree.getSnapshot("w1");
    assert.equal(s.callFreeSecondsAllowancePerDay, 180);
    assert.ok(typeof s.usageUtcDate === "string");
    assert.equal(s.daily_free_seconds_used, s.callFreeSecondsUsedToday);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(s.daily_free_reset_at));
    try {
      fs.unlinkSync(p);
    } catch (_) {
      /* ignore */
    }
    for (const ext of ["-shm", "-wal"]) {
      try {
        fs.unlinkSync(p + ext);
      } catch (_) {
        /* ignore */
      }
    }
  });
});
