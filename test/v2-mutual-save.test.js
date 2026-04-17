const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { createRoomStore } = require("../src/store");

describe("Mutual save (MUTUAL_SAVE_ENABLED)", () => {
  let dbPath;
  let app;
  let prevDb;
  let prevMutual;
  let prevPendingMs;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-ms-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevDb = process.env.DATABASE_PATH;
    prevMutual = process.env.MUTUAL_SAVE_ENABLED;
    prevPendingMs = process.env.MUTUAL_SAVE_PENDING_MS;
    process.env.DATABASE_PATH = dbPath;
    process.env.MUTUAL_SAVE_ENABLED = "1";
    process.env.MUTUAL_SAVE_PENDING_MS = "604800000";

    const store = createRoomStore({ dbFilePath: dbPath });
    store.rooms.createRoomFromV1({
      id: "room-ms",
      inviteCode: "123456",
      creatorDeviceId: "dev-a",
    });
    const j = store.rooms.joinActiveRoomByCode({
      inviteCode: "123456",
      deviceId: "dev-b",
    });
    assert.equal(j.ok, true);

    store.rooms.createRoomFromV1({
      id: "room-solo",
      inviteCode: "999999",
      creatorDeviceId: "dev-solo",
    });

    delete require.cache[require.resolve("../server.js")];
    ({ app } = require("../server.js"));
  });

  after(() => {
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
    if (prevMutual === undefined) delete process.env.MUTUAL_SAVE_ENABLED;
    else process.env.MUTUAL_SAVE_ENABLED = prevMutual;
    if (prevPendingMs === undefined) delete process.env.MUTUAL_SAVE_PENDING_MS;
    else process.env.MUTUAL_SAVE_PENDING_MS = prevPendingMs;
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
          const opts = {
            method,
            headers: {},
          };
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

  test("POST save/request from A → pending", async () => {
    const { status, json } = await request("POST", "/v2/rooms/room-ms/save/request", {
      deviceId: "dev-a",
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.save.state, "pending");
    assert.equal(json.save.requestedByDeviceId, "dev-a");
    assert.equal(json.save.myAction, "requested");
  });

  test("POST save/request idempotent for same requester", async () => {
    const { status, json } = await request("POST", "/v2/rooms/room-ms/save/request", {
      deviceId: "dev-a",
    });
    assert.equal(status, 200);
    assert.equal(json.idempotent, true);
    assert.equal(json.save.state, "pending");
  });

  test("GET list/detail include save state", async () => {
    const { status, json } = await request(
      "GET",
      `/v2/rooms?deviceId=${encodeURIComponent("dev-b")}`,
      null
    );
    assert.equal(status, 200);
    const row = json.rooms.find((r) => r.id === "room-ms");
    assert.ok(row);
    assert.equal(row.save.enabled, true);
    assert.equal(row.save.state, "pending");
    assert.equal(row.save.myAction, "can_respond");

    const d = await request(
      "GET",
      `/v2/rooms/room-ms?deviceId=${encodeURIComponent("dev-b")}`,
      null
    );
    assert.equal(d.status, 200);
    assert.equal(d.json.save.state, "pending");
    assert.equal(d.json.save.myAction, "can_respond");
  });

  test("POST save/respond accept from B → mutual", async () => {
    const { status, json } = await request("POST", "/v2/rooms/room-ms/save/respond", {
      deviceId: "dev-b",
      decision: "accept",
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.save.state, "mutual");
    assert.equal(json.save.myAction, "mutual");
  });

  test("POST save/request when already mutual → alreadyMutual", async () => {
    const { status, json } = await request("POST", "/v2/rooms/room-ms/save/request", {
      deviceId: "dev-a",
    });
    assert.equal(status, 200);
    assert.equal(json.alreadyMutual, true);
    assert.equal(json.save.state, "mutual");
  });

  test("403 wrong_responder when requester tries to respond", async () => {
    const store = createRoomStore({ dbFilePath: dbPath });
    store.rooms.createRoomFromV1({
      id: "room-wr",
      inviteCode: "111222",
      creatorDeviceId: "wa",
    });
    store.rooms.joinActiveRoomByCode({
      inviteCode: "111222",
      deviceId: "wb",
    });
    await request("POST", "/v2/rooms/room-wr/save/request", { deviceId: "wa" });
    const { status, json } = await request("POST", "/v2/rooms/room-wr/save/respond", {
      deviceId: "wa",
      decision: "accept",
    });
    assert.equal(status, 403);
    assert.equal(json.error, "wrong_responder");
  });

  test("decline clears to none", async () => {
    const store = createRoomStore({ dbFilePath: dbPath });
    store.rooms.createRoomFromV1({
      id: "room-dec",
      inviteCode: "333444",
      creatorDeviceId: "da",
    });
    store.rooms.joinActiveRoomByCode({
      inviteCode: "333444",
      deviceId: "db",
    });
    await request("POST", "/v2/rooms/room-dec/save/request", { deviceId: "da" });
    const r = await request("POST", "/v2/rooms/room-dec/save/respond", {
      deviceId: "db",
      decision: "decline",
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.save.state, "none");
    const g = await request(
      "GET",
      `/v2/rooms/room-dec?deviceId=${encodeURIComponent("da")}`,
      null
    );
    assert.equal(g.json.save.state, "none");
  });

  test("403 forbidden when device not linked", async () => {
    const { status } = await request("POST", "/v2/rooms/room-ms/save/request", {
      deviceId: "stranger",
    });
    assert.equal(status, 403);
  });

  test("409 already_pending when peer tries a second request", async () => {
    const store = createRoomStore({ dbFilePath: dbPath });
    store.rooms.createRoomFromV1({
      id: "room-ap",
      inviteCode: "444555",
      creatorDeviceId: "pa",
    });
    store.rooms.joinActiveRoomByCode({
      inviteCode: "444555",
      deviceId: "pb",
    });
    await request("POST", "/v2/rooms/room-ap/save/request", { deviceId: "pa" });
    const { status, json } = await request("POST", "/v2/rooms/room-ap/save/request", {
      deviceId: "pb",
    });
    assert.equal(status, 409);
    assert.equal(json.error, "already_pending");
  });

  test("409 need_two_participants when only one member", async () => {
    const { status, json } = await request("POST", "/v2/rooms/room-solo/save/request", {
      deviceId: "dev-solo",
    });
    assert.equal(status, 409);
    assert.equal(json.error, "need_two_participants");
  });

  test("pending expires to none (short TTL)", async () => {
    process.env.MUTUAL_SAVE_PENDING_MS = "1";
    delete require.cache[require.resolve("../server.js")];
    const { app: app2 } = require("../server.js");

    const store = createRoomStore({ dbFilePath: dbPath });
    store.rooms.createRoomFromV1({
      id: "room-exp",
      inviteCode: "555666",
      creatorDeviceId: "ea",
    });
    store.rooms.joinActiveRoomByCode({
      inviteCode: "555666",
      deviceId: "eb",
    });

    await new Promise((resolve, reject) => {
      const srv = http.createServer(app2);
      srv.listen(0, async () => {
        try {
          const port = srv.address().port;
          await fetch(`http://127.0.0.1:${port}/v2/rooms/room-exp/save/request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId: "ea" }),
          });
          await new Promise((r) => setTimeout(r, 30));
          const res = await fetch(
            `http://127.0.0.1:${port}/v2/rooms/room-exp?deviceId=${encodeURIComponent("ea")}`
          );
          const body = await res.json();
          assert.equal(body.save.state, "none");
        } catch (e) {
          reject(e);
        } finally {
          srv.close();
          process.env.MUTUAL_SAVE_PENDING_MS = "604800000";
          delete require.cache[require.resolve("../server.js")];
          resolve();
        }
      });
      srv.on("error", reject);
    });
  });
});

describe("Mutual save disabled (default)", () => {
  let dbPath;
  let appOff;
  let prevDb;
  let prevMutual;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-ms-off-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevDb = process.env.DATABASE_PATH;
    prevMutual = process.env.MUTUAL_SAVE_ENABLED;
    process.env.DATABASE_PATH = dbPath;
    delete process.env.MUTUAL_SAVE_ENABLED;

    const store = createRoomStore({ dbFilePath: dbPath });
    store.rooms.createRoomFromV1({
      id: "room-off",
      inviteCode: "888777",
      creatorDeviceId: "oa",
    });
    store.rooms.joinActiveRoomByCode({
      inviteCode: "888777",
      deviceId: "ob",
    });

    delete require.cache[require.resolve("../server.js")];
    ({ app: appOff } = require("../server.js"));
  });

  after(() => {
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
    if (prevMutual === undefined) delete process.env.MUTUAL_SAVE_ENABLED;
    else process.env.MUTUAL_SAVE_ENABLED = prevMutual;
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

  test("POST save/request returns 403 when flag off", async () => {
    await new Promise((resolve, reject) => {
      const srv = http.createServer(appOff);
      srv.listen(0, async () => {
        try {
          const port = srv.address().port;
          const res = await fetch(
            `http://127.0.0.1:${port}/v2/rooms/room-off/save/request`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ deviceId: "oa" }),
            }
          );
          assert.equal(res.status, 403);
          const j = await res.json();
          assert.equal(j.mutualSaveEnabled, false);
        } catch (e) {
          reject(e);
        } finally {
          srv.close();
          resolve();
        }
      });
      srv.on("error", reject);
    });
  });

  test("GET detail save.enabled false", async () => {
    await new Promise((resolve, reject) => {
      const srv = http.createServer(appOff);
      srv.listen(0, async () => {
        try {
          const port = srv.address().port;
          const res = await fetch(
            `http://127.0.0.1:${port}/v2/rooms/room-off?deviceId=${encodeURIComponent("oa")}`
          );
          const j = await res.json();
          assert.equal(j.save.enabled, false);
          assert.equal(j.save.state, "none");
        } catch (e) {
          reject(e);
        } finally {
          srv.close();
          resolve();
        }
      });
      srv.on("error", reject);
    });
  });
});
