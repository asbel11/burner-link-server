const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { openDatabase } = require("../src/store/db");
const { createCoinWalletRepository } = require("../src/store/coinWalletRepository");
const { COIN_LEDGER_ENTRY_KINDS } = require("../src/coinEntryKinds");
const {
  processCallChargeStart,
  processCallChargeSettle,
} = require("../src/connectCallBilling");
const { createCallFreeAllowance } = require("../src/callFreeAllowance");

const TARIFF = Object.freeze({
  version: 2,
  voice: { coinsPerSecond: 1 },
  video: { coinsPerSecond: 3 },
});

describe("applyCallSessionSettlement (repo)", () => {
  let dbPath;
  let coins;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-call-settle-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

  function fund(dev, amount, key) {
    const r = coins.applyLedgerCredit({
      deviceId: dev,
      amount,
      idempotencyKey: key,
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
      packId: "test",
    });
    assert.equal(r.ok, true);
  }

  test("release + debit in one transaction", () => {
    const dev = "dev-rs1";
    const sid = "sess-rs1";
    fund(dev, 200, "f1");
    coins.applyReserveHold({
      deviceId: dev,
      amount: 80,
      idempotencyKey: `call:${sid}:hold`,
    });
    const r = coins.applyCallSessionSettlement({
      deviceId: dev,
      sessionId: sid,
      releaseCoins: 80,
      debitCoins: 25,
      releaseMetadataJson: '{"phase":"rel"}',
      debitMetadataJson: '{"phase":"deb"}',
      debitExternalReference: `call:${sid}`,
    });
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, false);
    assert.equal(r.wallet.availableCoins, 175);
    assert.equal(r.wallet.reservedCoins, 0);
    assert.equal(r.wallet.spendableCoins, 175);
    assert.ok(r.releaseEntry);
    assert.ok(r.debitEntry);
    assert.equal(r.debitEntry.deltaCoins, -25);
  });

  test("duplicate settle returns duplicate", () => {
    const dev = "dev-dup-s";
    const sid = "sess-dup-s";
    fund(dev, 100, "fd");
    const a = coins.applyCallSessionSettlement({
      deviceId: dev,
      sessionId: sid,
      releaseCoins: 0,
      debitCoins: 10,
      debitMetadataJson: "{}",
    });
    assert.equal(a.ok, true);
    const b = coins.applyCallSessionSettlement({
      deviceId: dev,
      sessionId: sid,
      releaseCoins: 0,
      debitCoins: 10,
      debitMetadataJson: "{}",
    });
    assert.equal(b.ok, true);
    assert.equal(b.duplicate, true);
    assert.equal(b.wallet.availableCoins, 90);
  });

  test("insufficient_reserved when releasing more than held", () => {
    const dev = "dev-ir";
    const sid = "sess-ir";
    fund(dev, 50, "fir");
    coins.applyReserveHold({
      deviceId: dev,
      amount: 10,
      idempotencyKey: `call:${sid}:hold`,
    });
    const r = coins.applyCallSessionSettlement({
      deviceId: dev,
      sessionId: sid,
      releaseCoins: 100,
      debitCoins: 0,
      debitMetadataJson: "{}",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient_reserved");
  });

  test("zero release + zero debit inserts settle marker only", () => {
    const dev = "dev-z";
    const sid = "sess-z";
    fund(dev, 10, "fz");
    const r = coins.applyCallSessionSettlement({
      deviceId: dev,
      sessionId: sid,
      releaseCoins: 0,
      debitCoins: 0,
      debitMetadataJson: '{"billedSeconds":0}',
    });
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, false);
    assert.equal(r.wallet.availableCoins, 10);
    assert.equal(r.debitEntry.deltaCoins, 0);
  });
});

describe("processCallChargeStart / Settle (handlers)", () => {
  let dbPath;
  let coins;
  let db;
  let callFree;
  let prevFreeDay;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-call-hand-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevFreeDay = process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY;
    process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY = "0";
    db = openDatabase(dbPath);
    coins = createCoinWalletRepository(db);
    callFree = createCallFreeAllowance(db);
  });

  after(() => {
    if (prevFreeDay === undefined) {
      delete process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY;
    } else {
      process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY = prevFreeDay;
    }
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

  test("start reserves from estimated seconds", () => {
    const dev = "dev-st1";
    fund(dev, 500, "s1");
    const out = processCallChargeStart(
      coins,
      {
        deviceId: dev,
        callSessionId: "call-a1",
        callType: "voice",
        estimatedBillableSeconds: 60,
      },
      TARIFF,
      { callFree }
    );
    assert.equal(out.status, 200);
    assert.equal(out.json.reservedCoins, 60);
    assert.equal(out.json.holdApplied, true);
    assert.equal(out.json.wallet.reservedCoins, 60);
    assert.equal(out.json.wallet.spendableCoins, 440);
  });

  test("start insufficient funds", () => {
    const dev = "dev-st2";
    fund(dev, 10, "s2");
    const out = processCallChargeStart(
      coins,
      {
        deviceId: dev,
        callSessionId: "call-a2",
        callType: "voice",
        estimatedBillableSeconds: 99999,
      },
      TARIFF,
      { callFree }
    );
    assert.equal(out.status, 402);
    assert.equal(out.json.reason, "insufficient_funds");
  });

  test("settle releases reserve and debits final (bill < reserve)", () => {
    const dev = "dev-se1";
    const sid = "call-settle-1";
    fund(dev, 500, "se1");
    processCallChargeStart(
      coins,
      {
        deviceId: dev,
        callSessionId: sid,
        callType: "voice",
        estimatedBillableSeconds: 100,
      },
      TARIFF,
      { callFree }
    );
    const out = processCallChargeSettle(
      coins,
      {
        deviceId: dev,
        callSessionId: sid,
        callType: "voice",
        billedSeconds: 10,
        reservedAmount: 100,
      },
      TARIFF,
      { db, callFree }
    );
    assert.equal(out.status, 200);
    assert.equal(out.json.finalDebitCoins, 10);
    assert.equal(out.json.releasedReserveCoins, 100);
    assert.equal(out.json.wallet.availableCoins, 490);
    assert.equal(out.json.wallet.reservedCoins, 0);
  });

  test("settle when final debit exceeds prior reserve (still affordable)", () => {
    const dev = "dev-se2";
    const sid = "call-settle-2";
    fund(dev, 500, "se2");
    processCallChargeStart(
      coins,
      {
        deviceId: dev,
        callSessionId: sid,
        callType: "voice",
        estimatedBillableSeconds: 50,
      },
      TARIFF,
      { callFree }
    );
    const out = processCallChargeSettle(
      coins,
      {
        deviceId: dev,
        callSessionId: sid,
        callType: "voice",
        billedSeconds: 400,
        reservedAmount: 50,
      },
      TARIFF,
      { db, callFree }
    );
    assert.equal(out.status, 200);
    assert.equal(out.json.finalDebitCoins, 400);
    assert.equal(out.json.wallet.availableCoins, 100);
  });

  test("duplicate settle", () => {
    const dev = "dev-se3";
    const sid = "call-settle-3";
    fund(dev, 200, "se3");
    const body = {
      deviceId: dev,
      callSessionId: sid,
      callType: "voice",
      billedSeconds: 5,
      reservedAmount: 0,
    };
    const a = processCallChargeSettle(coins, body, TARIFF, { db, callFree });
    const b = processCallChargeSettle(coins, body, TARIFF, { db, callFree });
    assert.equal(a.status, 200);
    assert.equal(a.json.duplicate, false);
    assert.equal(b.status, 200);
    assert.equal(b.json.duplicate, true);
    assert.equal(b.json.wallet.availableCoins, 195);
  });

  test("tariff missing → 503", () => {
    const out = processCallChargeStart(
      coins,
      { deviceId: "x", callSessionId: "c", callType: "voice" },
      null
    );
    assert.equal(out.status, 503);
    assert.equal(out.json.reason, "tariff_not_configured");
  });

  test("unknown call type", () => {
    const out = processCallChargeStart(
      coins,
      { deviceId: "x", callSessionId: "c", callType: "pigeon" },
      TARIFF
    );
    assert.equal(out.status, 400);
    assert.equal(out.json.reason, "unknown_call_type");
  });

  test("invalid billedSeconds", () => {
    const out = processCallChargeSettle(
      coins,
      {
        deviceId: "x",
        callSessionId: "c",
        callType: "voice",
        billedSeconds: 3.5,
        reservedAmount: 0,
      },
      TARIFF
    );
    assert.equal(out.status, 400);
    assert.equal(out.json.reason, "invalid_billed_seconds");
  });
});

describe("POST /v2/billing/call-charge/* (HTTP)", () => {
  let dbPath;
  let seedStore;
  let app;
  let prevDb;
  let prevTariff;
  let prevFreeDay;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-call-http-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevDb = process.env.DATABASE_PATH;
    prevTariff = process.env.CONNECT_CALL_TARIFF_JSON;
    prevFreeDay = process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY;
    process.env.DATABASE_PATH = dbPath;
    process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY = "0";
    process.env.CONNECT_CALL_TARIFF_JSON = JSON.stringify({
      version: 1,
      voice: { coinsPerSecond: 2 },
      video: { coinsPerSecond: 5 },
    });
    const { createRoomStore } = require("../src/store");
    seedStore = createRoomStore({ dbFilePath: dbPath });
    seedStore.coins.applyLedgerCredit({
      deviceId: "http-dev",
      amount: 1000,
      idempotencyKey: "http-seed-credit",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
      packId: "p",
    });
    delete require.cache[require.resolve("../server.js")];
    ({ app } = require("../server.js"));
  });

  after(() => {
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
    if (prevTariff === undefined) delete process.env.CONNECT_CALL_TARIFF_JSON;
    else process.env.CONNECT_CALL_TARIFF_JSON = prevTariff;
    if (prevFreeDay === undefined) {
      delete process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY;
    } else {
      process.env.CONNECT_FREE_CALL_SECONDS_PER_DAY = prevFreeDay;
    }
    delete require.cache[require.resolve("../server.js")];
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

  function post(path, body) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(app);
      srv.listen(0, async () => {
        try {
          const port = srv.address().port;
          const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const json = await res.json();
          resolve({ status: res.status, json });
        } catch (e) {
          reject(e);
        } finally {
          srv.close();
        }
      });
      srv.on("error", reject);
    });
  }

  test("start then settle over HTTP", async () => {
    const sid = `http-call-${Date.now()}`;
    const st = await post("/v2/billing/call-charge/start", {
      deviceId: "http-dev",
      callSessionId: sid,
      callType: "voice",
      estimatedBillableSeconds: 30,
    });
    assert.equal(st.status, 200);
    assert.equal(st.json.holdApplied, true);
    assert.equal(st.json.reservedCoins, 60);
    const se = await post("/v2/billing/call-charge/settle", {
      deviceId: "http-dev",
      callSessionId: sid,
      callType: "voice",
      billedSeconds: 12,
      reservedAmount: 60,
    });
    assert.equal(se.status, 200);
    assert.equal(se.json.finalDebitCoins, 24);
    assert.equal(se.json.releasedReserveCoins, 60);
  });
});
