const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { createRoomStore } = require("../src/store");
const { createCoinPackCheckoutSession } = require("../src/stripeCoinPackCheckout");
const { COIN_LEDGER_ENTRY_KINDS } = require("../src/coinEntryKinds");

describe("createCoinPackCheckoutSession (unit)", () => {
  let prevPacks;
  let prevSuccess;
  let prevCancel;

  before(() => {
    prevPacks = process.env.CONNECT_COIN_PACKS_JSON;
    prevSuccess = process.env.STRIPE_CHECKOUT_SUCCESS_URL;
    prevCancel = process.env.STRIPE_CHECKOUT_CANCEL_URL;
    process.env.CONNECT_COIN_PACKS_JSON = JSON.stringify([
      { packId: "coins_100", stripePriceId: "price_unit_100", coins: 100 },
    ]);
    process.env.STRIPE_CHECKOUT_SUCCESS_URL = "https://example.com/ok";
    process.env.STRIPE_CHECKOUT_CANCEL_URL = "https://example.com/cancel";
  });

  after(() => {
    if (prevPacks === undefined) delete process.env.CONNECT_COIN_PACKS_JSON;
    else process.env.CONNECT_COIN_PACKS_JSON = prevPacks;
    if (prevSuccess === undefined) delete process.env.STRIPE_CHECKOUT_SUCCESS_URL;
    else process.env.STRIPE_CHECKOUT_SUCCESS_URL = prevSuccess;
    if (prevCancel === undefined) delete process.env.STRIPE_CHECKOUT_CANCEL_URL;
    else process.env.STRIPE_CHECKOUT_CANCEL_URL = prevCancel;
  });

  test("creates session with expected metadata and line item", async () => {
    let captured;
    const stripe = {
      checkout: {
        sessions: {
          create: async (opts) => {
            captured = opts;
            return {
              id: "cs_test_coin",
              url: "https://checkout.stripe.test/coin",
            };
          },
        },
      },
    };
    const out = await createCoinPackCheckoutSession(stripe, {
      deviceId: "dev-unit",
      packId: "coins_100",
    });
    assert.equal(out.ok, true);
    assert.equal(out.sessionId, "cs_test_coin");
    assert.equal(out.url, "https://checkout.stripe.test/coin");
    assert.equal(out.packId, "coins_100");
    assert.equal(out.coins, 100);
    assert.equal(captured.mode, "payment");
    assert.deepEqual(captured.line_items, [
      { price: "price_unit_100", quantity: 1 },
    ]);
    assert.equal(captured.metadata.deviceId, "dev-unit");
    assert.equal(captured.metadata.packId, "coins_100");
    assert.equal(captured.metadata.connectBilling, "coin_pack");
    assert.equal(captured.metadata.coinsGranted, "100");
  });

  test("checkoutReturnNonce is forwarded to Stripe metadata", async () => {
    let captured;
    const stripe = {
      checkout: {
        sessions: {
          create: async (opts) => {
            captured = opts;
            return { id: "cs_nonce", url: "https://checkout.stripe.test/n" };
          },
        },
      },
    };
    const out = await createCoinPackCheckoutSession(stripe, {
      deviceId: "dev-unit",
      packId: "coins_100",
      successUrl: "https://example.com/ok",
      cancelUrl: "https://example.com/cancel",
      checkoutReturnNonce: "nonce-hex",
    });
    assert.equal(out.ok, true);
    assert.equal(out.checkoutReturnNonce, "nonce-hex");
    assert.equal(captured.metadata.checkoutReturnNonce, "nonce-hex");
  });

  test("unknown packId → unknown_pack_id", async () => {
    const stripe = {
      checkout: { sessions: { create: async () => ({ id: "x", url: "y" }) } },
    };
    const out = await createCoinPackCheckoutSession(stripe, {
      deviceId: "dev-unit",
      packId: "nope",
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "unknown_pack_id");
  });

  test("discrete env STRIPE_PRICE_COINS_100 supplies catalog when JSON empty", () => {
    const prevJson = process.env.CONNECT_COIN_PACKS_JSON;
    const prevP = process.env.STRIPE_PRICE_COINS_100;
    process.env.CONNECT_COIN_PACKS_JSON = "[]";
    process.env.STRIPE_PRICE_COINS_100 = "price_from_env";
    delete require.cache[require.resolve("../src/coinPackCatalog.js")];
    const { getCoinPackById: getById } = require("../src/coinPackCatalog");
    try {
      const p = getById("coins_100");
      assert.ok(p);
      assert.equal(p.stripePriceId, "price_from_env");
      assert.equal(p.coins, 100);
    } finally {
      if (prevJson === undefined) delete process.env.CONNECT_COIN_PACKS_JSON;
      else process.env.CONNECT_COIN_PACKS_JSON = prevJson;
      if (prevP === undefined) delete process.env.STRIPE_PRICE_COINS_100;
      else process.env.STRIPE_PRICE_COINS_100 = prevP;
      delete require.cache[require.resolve("../src/coinPackCatalog.js")];
    }
  });

  test("empty catalog → coin_packs_not_configured", async () => {
    const prev = process.env.CONNECT_COIN_PACKS_JSON;
    delete process.env.CONNECT_COIN_PACKS_JSON;
    try {
      const stripe = {
        checkout: { sessions: { create: async () => ({ id: "x", url: "y" }) } },
      };
      const out = await createCoinPackCheckoutSession(stripe, {
        deviceId: "dev-unit",
        packId: "coins_100",
      });
      assert.equal(out.ok, false);
      assert.equal(out.reason, "coin_packs_not_configured");
    } finally {
      if (prev === undefined) delete process.env.CONNECT_COIN_PACKS_JSON;
      else process.env.CONNECT_COIN_PACKS_JSON = prev;
    }
  });
});

describe("Coin pack billing HTTP", () => {
  let dbPath;
  let app;
  let seedStore;
  let prevDb;
  let prevSk;
  let prevPacks;
  let prevSuccess;
  let prevCancel;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-coin-http-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevDb = process.env.DATABASE_PATH;
    prevSk = process.env.STRIPE_SECRET_KEY;
    prevPacks = process.env.CONNECT_COIN_PACKS_JSON;
    prevSuccess = process.env.STRIPE_CHECKOUT_SUCCESS_URL;
    prevCancel = process.env.STRIPE_CHECKOUT_CANCEL_URL;
    process.env.DATABASE_PATH = dbPath;
    process.env.STRIPE_SECRET_KEY = "sk_test_coin_http_placeholder";
    process.env.CONNECT_COIN_PACKS_JSON = JSON.stringify([
      { packId: "coins_100", stripePriceId: "price_http", coins: 100 },
    ]);
    process.env.STRIPE_CHECKOUT_SUCCESS_URL = "https://example.com/ok";
    process.env.STRIPE_CHECKOUT_CANCEL_URL = "https://example.com/cancel";

    seedStore = createRoomStore({ dbFilePath: dbPath });
    seedStore.rooms.createRoomFromV1({
      id: "room-coin",
      inviteCode: "444444",
      creatorDeviceId: "dev-seed",
    });

    delete require.cache[require.resolve("../server.js")];
    ({ app } = require("../server.js"));
  });

  after(() => {
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
    if (prevSk === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevSk;
    if (prevPacks === undefined) delete process.env.CONNECT_COIN_PACKS_JSON;
    else process.env.CONNECT_COIN_PACKS_JSON = prevPacks;
    if (prevSuccess === undefined) delete process.env.STRIPE_CHECKOUT_SUCCESS_URL;
    else process.env.STRIPE_CHECKOUT_SUCCESS_URL = prevSuccess;
    if (prevCancel === undefined) delete process.env.STRIPE_CHECKOUT_CANCEL_URL;
    else process.env.STRIPE_CHECKOUT_CANCEL_URL = prevCancel;
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

  function request(method, urlPath, bodyObj) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(app);
      srv.listen(0, async () => {
        try {
          const port = srv.address().port;
          const opts = { method, headers: {} };
          if (bodyObj != null) {
            opts.headers["Content-Type"] = "application/json";
            opts.body = JSON.stringify(bodyObj);
          }
          const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, opts);
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

  test("GET wallet — new device returns zeros", async () => {
    const { status, json } = await request(
      "GET",
      `/v2/billing/wallet?deviceId=${encodeURIComponent("dev-new-wallet")}`,
      null
    );
    assert.equal(status, 200);
    assert.equal(json.spendableCoins, 0);
    assert.equal(json.reservedCoins, 0);
    assert.equal(json.availableCoins, 0);
    assert.equal(json.deviceId, "dev-new-wallet");
    assert.equal(json.updatedAt, null);
    assert.ok(typeof json.daily_free_reset_at === "string");
  });

  test("GET wallet — after ledger credit", async () => {
    const dev = "dev-funded";
    const cr = seedStore.coins.applyLedgerCredit({
      deviceId: dev,
      amount: 42,
      idempotencyKey: `test_credit_${Date.now()}`,
      entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
      packId: "coins_100",
    });
    assert.equal(cr.ok, true);
    const { status, json } = await request(
      "GET",
      `/v2/billing/wallet?deviceId=${encodeURIComponent(dev)}`,
      null
    );
    assert.equal(status, 200);
    assert.equal(json.spendableCoins, 42);
    assert.equal(json.reservedCoins, 0);
    assert.equal(json.availableCoins, 42);
    assert.ok(typeof json.updatedAt === "string");
  });

  test("POST create-coin-checkout-session — unknown pack", async () => {
    const { status, json } = await request("POST", "/v2/billing/create-coin-checkout-session", {
      deviceId: "dev-a",
      packId: "not_a_pack",
    });
    assert.equal(status, 400);
    assert.equal(json.reason, "unknown_pack_id");
  });

  test("POST coin-pack/create-checkout — unknown pack", async () => {
    const { status, json } = await request("POST", "/v2/billing/coin-pack/create-checkout", {
      deviceId: "dev-a",
      packId: "not_a_pack",
    });
    assert.equal(status, 400);
    assert.equal(json.reason, "unknown_pack_id");
  });

  test("POST create-coin-checkout-session — Stripe not configured", async () => {
    const sk = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    delete require.cache[require.resolve("../server.js")];
    const { app: app2 } = require("../server.js");
    const srv = http.createServer(app2);
    await new Promise((resolve, reject) => {
      srv.listen(0, async () => {
        try {
          const port = srv.address().port;
          const res = await fetch(
            `http://127.0.0.1:${port}/v2/billing/create-coin-checkout-session`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ deviceId: "dev-a", packId: "coins_100" }),
            }
          );
          const json = await res.json();
          assert.equal(res.status, 503);
          assert.equal(json.reason, "stripe_not_configured");
        } catch (e) {
          reject(e);
        } finally {
          srv.close();
          if (sk === undefined) delete process.env.STRIPE_SECRET_KEY;
          else process.env.STRIPE_SECRET_KEY = sk;
          delete require.cache[require.resolve("../server.js")];
          resolve();
        }
      });
      srv.on("error", reject);
    });
  });

  test("POST create-coin-checkout-session — catalog empty", async () => {
    process.env.CONNECT_COIN_PACKS_JSON = "[]";
    delete require.cache[require.resolve("../server.js")];
    const { app: app2 } = require("../server.js");
    const srv = http.createServer(app2);
    await new Promise((resolve, reject) => {
      srv.listen(0, async () => {
        try {
          const port = srv.address().port;
          const res = await fetch(
            `http://127.0.0.1:${port}/v2/billing/create-coin-checkout-session`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ deviceId: "dev-a", packId: "coins_100" }),
            }
          );
          const json = await res.json();
          assert.equal(res.status, 503);
          assert.equal(json.reason, "coin_packs_not_configured");
        } catch (e) {
          reject(e);
        } finally {
          srv.close();
          process.env.CONNECT_COIN_PACKS_JSON = JSON.stringify([
            { packId: "coins_100", stripePriceId: "price_http", coins: 100 },
          ]);
          delete require.cache[require.resolve("../server.js")];
          resolve();
        }
      });
      srv.on("error", reject);
    });
  });
});
