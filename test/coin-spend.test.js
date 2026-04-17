const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { openDatabase } = require("../src/store/db");
const { createCoinWalletRepository } = require("../src/store/coinWalletRepository");
const { COIN_LEDGER_ENTRY_KINDS } = require("../src/coinEntryKinds");
const { processCoinSpendRequest } = require("../src/connectCoinSpend");

describe("processCoinSpendRequest (unit)", () => {
  let dbPath;
  let coins;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-spend-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

  test("successful debit", () => {
    const dev = "dev-spend-ok";
    fund(dev, 50, "fund-1");
    const out = processCoinSpendRequest(coins, {
      deviceId: dev,
      amount: 12,
      idempotencyKey: "usage-1",
      metadata: { feature: "test_feature", billedSeconds: 60 },
    });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.equal(out.json.duplicate, false);
    assert.equal(out.json.wallet.spendableCoins, 38);
    assert.equal(out.json.entry.deltaCoins, -12);
    assert.equal(out.json.entry.entryKind, "call_debit");
  });

  test("insufficient funds", () => {
    const dev = "dev-poor";
    fund(dev, 5, "fund-poor");
    const out = processCoinSpendRequest(coins, {
      deviceId: dev,
      amount: 10,
      idempotencyKey: "too-much",
    });
    assert.equal(out.status, 402);
    assert.equal(out.json.reason, "insufficient_funds");
    assert.equal(out.json.wallet.spendableCoins, 5);
  });

  test("duplicate idempotency key replays without double debit", () => {
    const dev = "dev-dup";
    fund(dev, 100, "fund-dup");
    const body = {
      deviceId: dev,
      amount: 7,
      idempotencyKey: "stable-key-1",
    };
    const a = processCoinSpendRequest(coins, body);
    assert.equal(a.status, 200);
    assert.equal(a.json.duplicate, false);
    assert.equal(a.json.wallet.spendableCoins, 93);
    const b = processCoinSpendRequest(coins, body);
    assert.equal(b.status, 200);
    assert.equal(b.json.duplicate, true);
    assert.equal(b.json.wallet.spendableCoins, 93);
  });

  test("idempotency key conflict for different device", () => {
    fund("dev-x", 20, "fx");
    fund("dev-y", 20, "fy");
    const out1 = processCoinSpendRequest(coins, {
      deviceId: "dev-x",
      amount: 1,
      idempotencyKey: "shared-conflict",
    });
    assert.equal(out1.status, 200);
    const out2 = processCoinSpendRequest(coins, {
      deviceId: "dev-y",
      amount: 1,
      idempotencyKey: "shared-conflict",
    });
    assert.equal(out2.status, 409);
    assert.equal(out2.json.reason, "idempotency_key_conflict");
  });

  test("invalid amount", () => {
    const dev = "dev-inv-amt";
    fund(dev, 10, "fa");
    assert.equal(
      processCoinSpendRequest(coins, {
        deviceId: dev,
        amount: 0,
        idempotencyKey: "a0",
      }).status,
      400
    );
    assert.equal(
      processCoinSpendRequest(coins, {
        deviceId: dev,
        amount: -3,
        idempotencyKey: "a-",
      }).status,
      400
    );
    assert.equal(
      processCoinSpendRequest(coins, {
        deviceId: dev,
        amount: 3.5,
        idempotencyKey: "af",
      }).status,
      400
    );
    assert.equal(
      processCoinSpendRequest(coins, {
        deviceId: dev,
        amount: "5",
        idempotencyKey: "as",
      }).status,
      400
    );
  });

  test("invalid metadata (array)", () => {
    const dev = "dev-meta";
    fund(dev, 5, "fm");
    const out = processCoinSpendRequest(coins, {
      deviceId: dev,
      amount: 1,
      idempotencyKey: "m1",
      metadata: [1, 2],
    });
    assert.equal(out.status, 400);
    assert.equal(out.json.reason, "invalid_metadata");
  });

  test("reserved coins reduce spendable for spend", () => {
    const dev = "dev-rsv-spend";
    fund(dev, 100, "fr");
    const h = coins.applyReserveHold({
      deviceId: dev,
      amount: 70,
      idempotencyKey: "hold-spend-test",
    });
    assert.equal(h.ok, true);
    assert.equal(h.wallet.spendableCoins, 30);

    const too = processCoinSpendRequest(coins, {
      deviceId: dev,
      amount: 40,
      idempotencyKey: "sp-1",
    });
    assert.equal(too.status, 402);

    const ok = processCoinSpendRequest(coins, {
      deviceId: dev,
      amount: 25,
      idempotencyKey: "sp-2",
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.wallet.availableCoins, 75);
    assert.equal(ok.json.wallet.reservedCoins, 70);
    assert.equal(ok.json.wallet.spendableCoins, 5);
  });
});

describe("POST /v2/billing/spend-coins (HTTP)", () => {
  let dbPath;
  let seedStore;
  let app;
  let prevDb;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-spend-http-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevDb = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = dbPath;
    seedStore = createRoomStoreForSpendHttp();
    delete require.cache[require.resolve("../server.js")];
    ({ app } = require("../server.js"));
  });

  after(() => {
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
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

  function createRoomStoreForSpendHttp() {
    const { createRoomStore } = require("../src/store");
    return createRoomStore({ dbFilePath: dbPath });
  }

  function request(bodyObj) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(app);
      srv.listen(0, async () => {
        try {
          const port = srv.address().port;
          const res = await fetch(`http://127.0.0.1:${port}/v2/billing/spend-coins`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bodyObj),
          });
          const text = await res.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            json = { _raw: text };
          }
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

  test("HTTP — successful spend returns wallet + entry", async () => {
    const dev = "http-spend-1";
    seedStore.coins.applyLedgerCredit({
      deviceId: dev,
      amount: 80,
      idempotencyKey: "http-fund-1",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
      packId: "p",
    });
    const { status, json } = await request({
      deviceId: dev,
      amount: 15,
      idempotencyKey: "http-use-1",
      externalReference: "call_sess_abc",
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.wallet.spendableCoins, 65);
    assert.equal(json.entry.externalReference, "call_sess_abc");
  });

  test("HTTP — duplicate POST same idempotency key", async () => {
    const dev = "http-dup";
    seedStore.coins.applyLedgerCredit({
      deviceId: dev,
      amount: 20,
      idempotencyKey: "http-fund-d",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
      packId: "p",
    });
    const body = { deviceId: dev, amount: 3, idempotencyKey: "idem-http" };
    const a = await request(body);
    const b = await request(body);
    assert.equal(a.status, 200);
    assert.equal(a.json.duplicate, false);
    assert.equal(b.status, 200);
    assert.equal(b.json.duplicate, true);
    assert.equal(b.json.wallet.spendableCoins, 17);
  });

  test("HTTP — 402 insufficient funds", async () => {
    const dev = "http-402";
    seedStore.coins.applyLedgerCredit({
      deviceId: dev,
      amount: 4,
      idempotencyKey: "http-f402",
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
      packId: "p",
    });
    const { status, json } = await request({
      deviceId: dev,
      amount: 100,
      idempotencyKey: "big",
    });
    assert.equal(status, 402);
    assert.equal(json.reason, "insufficient_funds");
  });

  test("HTTP — missing deviceId", async () => {
    const { status, json } = await request({
      amount: 1,
      idempotencyKey: "k",
    });
    assert.equal(status, 400);
    assert.equal(json.reason, "invalid_device");
  });
});
