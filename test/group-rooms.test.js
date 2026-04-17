const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { createRoomStore } = require("../src/store");

describe("Group rooms (room_kind / member_cap)", () => {
  let dbPath;
  let store;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-gr-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    store = createRoomStore({ dbFilePath: dbPath });
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

  test("direct room: cap 2 unchanged; third join is full with roomKind direct", () => {
    store.rooms.createRoomFromV1({
      id: "r-direct",
      inviteCode: "111111",
      creatorDeviceId: "a",
    });
    const j1 = store.rooms.joinActiveRoomByCode({
      inviteCode: "111111",
      deviceId: "b",
    });
    assert.equal(j1.ok, true);
    const j2 = store.rooms.joinActiveRoomByCode({
      inviteCode: "111111",
      deviceId: "c",
    });
    assert.equal(j2.ok, false);
    assert.equal(j2.reason, "full");
    assert.equal(j2.roomKind, "direct");
    assert.equal(j2.memberCap, 2);
  });

  test("group room: joins allowed until memberCap; then full", () => {
    const out = store.rooms.createGroupRoomFromConnect({
      id: "r-group",
      inviteCode: "222222",
      creatorDeviceId: "g0",
      memberCap: 4,
    });
    assert.equal(out.ok, true);
    assert.equal(out.memberCap, 4);

    for (let i = 1; i <= 3; i += 1) {
      const j = store.rooms.joinActiveRoomByCode({
        inviteCode: "222222",
        deviceId: `g${i}`,
      });
      assert.equal(j.ok, true, `join g${i}`);
    }
    const full = store.rooms.joinActiveRoomByCode({
      inviteCode: "222222",
      deviceId: "g-overflow",
    });
    assert.equal(full.ok, false);
    assert.equal(full.reason, "full");
    assert.equal(full.roomKind, "group");
    assert.equal(full.memberCap, 4);
    assert.equal(full.memberCount, 4);
  });

  test("mutual save rejected for group rooms", () => {
    store.rooms.createGroupRoomFromConnect({
      id: "r-g2",
      inviteCode: "333333",
      creatorDeviceId: "x0",
      memberCap: 5,
    });
    store.rooms.joinActiveRoomByCode({
      inviteCode: "333333",
      deviceId: "x1",
    });

    const req = store.rooms.requestMutualSaveForDevice("r-g2", "x0");
    assert.equal(req.ok, false);
    assert.equal(req.reason, "group_mutual_save_unsupported");

    const resp = store.rooms.respondMutualSaveForDevice("r-g2", "x1", "accept");
    assert.equal(resp.ok, false);
    assert.equal(resp.reason, "group_mutual_save_unsupported");
  });

  test("list/detail expose roomKind and memberCap", () => {
    const list = store.rooms.listRoomsForDevice({
      deviceId: "g0",
      status: "all",
      mutualSaveEnabled: false,
    });
    const g = list.find((r) => r.id === "r-group");
    assert.ok(g);
    assert.equal(g.roomKind, "group");
    assert.equal(g.memberCap, 4);

    const d = store.rooms.getRoomDetailForDevice("r-direct", "a", {
      mutualSaveEnabled: false,
    });
    assert.equal(d.ok, true);
    assert.equal(d.room.roomKind, "direct");
    assert.equal(d.room.memberCap, 2);
  });

  test("Pro gate: createGroupRoomFromConnect returns pro_required when env requires Pro", () => {
    const prev = process.env.CONNECT_GROUP_ROOMS_REQUIRE_PRO;
    process.env.CONNECT_GROUP_ROOMS_REQUIRE_PRO = "1";

    const out = store.rooms.createGroupRoomFromConnect({
      id: "r-pro",
      inviteCode: "444444",
      creatorDeviceId: "no-pro",
      memberCap: 5,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "pro_required");

    store.membership.applyActivationOrRenewal({
      eventId: "evt-gr-1",
      deviceId: "no-pro",
      stripeSubscriptionId: "sub_gr",
      periodEndMs: Date.now() + 86400000,
    });

    const ok = store.rooms.createGroupRoomFromConnect({
      id: "r-pro-ok",
      inviteCode: "555555",
      creatorDeviceId: "no-pro",
      memberCap: 5,
    });
    assert.equal(ok.ok, true);

    if (prev === undefined) delete process.env.CONNECT_GROUP_ROOMS_REQUIRE_PRO;
    else process.env.CONNECT_GROUP_ROOMS_REQUIRE_PRO = prev;
  });
});

describe("POST /v2/rooms/create (HTTP)", () => {
  let dbPath;
  let app;
  let prevDb;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-gr-http-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevDb = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = dbPath;

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
            json = text ? JSON.parse(text) : null;
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

  test("201 creates group room", async () => {
    const { status, json } = await request("POST", "/v2/rooms/create", {
      deviceId: "http-dev",
      inviteCode: "666666",
      memberCap: 6,
    });
    assert.equal(status, 201);
    assert.equal(json.roomKind, "group");
    assert.equal(json.memberCap, 6);
    assert.ok(json.roomId);
  });

  test("accepts snake_case body keys", async () => {
    const { status, json } = await request("POST", "/v2/rooms/create", {
      device_id: "snake-dev",
      invite_code: "661661",
      member_cap: 5,
    });
    assert.equal(status, 201);
    assert.equal(json.memberCap, 5);
  });

  test("errors include reason and code", async () => {
    const { status, json } = await request("POST", "/v2/rooms/create", {
      deviceId: "e-dev",
      inviteCode: "bad",
      memberCap: 5,
    });
    assert.equal(status, 400);
    assert.equal(json.reason, "invalid_invite_code");
    assert.equal(json.code, "invalid_invite_code");
  });

  test("invalid_room_kind when roomKind is direct", async () => {
    const { status, json } = await request("POST", "/v2/rooms/create", {
      deviceId: "rk-dev",
      inviteCode: "662662",
      memberCap: 5,
      roomKind: "direct",
    });
    assert.equal(status, 400);
    assert.equal(json.code, "invalid_room_kind");
    assert.equal(json.reason, "invalid_room_kind");
  });

  test("member_cap_out_of_range includes min max and code", async () => {
    const { status, json } = await request("POST", "/v2/rooms/create", {
      deviceId: "mc-dev",
      inviteCode: "663663",
      memberCap: 2,
    });
    assert.equal(status, 400);
    assert.equal(json.code, "member_cap_out_of_range");
    assert.equal(typeof json.min, "number");
    assert.equal(typeof json.max, "number");
  });
});

describe("POST /sessions/join group full (HTTP)", () => {
  let dbPath;
  let app;
  let prevDb;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-gr-join-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevDb = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = dbPath;
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
            json = text ? JSON.parse(text) : null;
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

  test("403 full for group includes code reason and caps", async () => {
    await request("POST", "/v2/rooms/create", {
      deviceId: "g0",
      inviteCode: "778877",
      memberCap: 3,
    });
    await request("POST", "/sessions/join", {
      code: "778877",
      deviceId: "g1",
    });
    await request("POST", "/sessions/join", {
      code: "778877",
      deviceId: "g2",
    });
    const { status, json } = await request("POST", "/sessions/join", {
      code: "778877",
      deviceId: "g3",
    });
    assert.equal(status, 403);
    assert.equal(json.code, "full");
    assert.equal(json.reason, "full");
    assert.equal(json.roomKind, "group");
    assert.equal(json.memberCap, 3);
    assert.equal(json.memberCount, 3);
  });
});
