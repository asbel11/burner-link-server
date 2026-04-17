const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { createRoomStore } = require("../src/store");

describe(
  "POST /v2/rooms/:roomId/leave (live chat leave)",
  { concurrency: false },
  () => {
  let dbPath;
  let app;
  let prevDb;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-leave-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevDb = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = dbPath;

    const store = createRoomStore({ dbFilePath: dbPath });
    store.rooms.createRoomFromV1({
      id: "room-leave",
      inviteCode: "111111",
      creatorDeviceId: "dev-a",
    });
    assert.equal(
      store.rooms.joinActiveRoomByCode({
        inviteCode: "111111",
        deviceId: "dev-b",
      }).ok,
      true
    );

    store.rooms.createRoomFromV1({
      id: "room-ended",
      inviteCode: "222222",
      creatorDeviceId: "dev-c",
    });
    assert.equal(
      store.rooms.joinActiveRoomByCode({
        inviteCode: "222222",
        deviceId: "dev-d",
      }).ok,
      true
    );

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

  test("POST leave keeps room active and sets myPresence (list + detail)", async () => {
    const leave = await request("POST", "/v2/rooms/room-leave/leave", {
      deviceId: "dev-a",
    });
    assert.equal(leave.status, 200);
    assert.equal(leave.json.ok, true);
    assert.ok(leave.json.lastLiveChatLeftAt);

    const list = await request(
      "GET",
      "/v2/rooms?deviceId=" + encodeURIComponent("dev-a")
    );
    assert.equal(list.status, 200);
    const row = list.json.rooms.find((r) => r.id === "room-leave");
    assert.ok(row);
    assert.equal(row.myPresence.lastLiveChatLeftAt, leave.json.lastLiveChatLeftAt);
    assert.equal(row.myPresence.likelyActiveInLiveChat, false);

    const detail = await request(
      "GET",
      "/v2/rooms/room-leave?deviceId=" + encodeURIComponent("dev-a")
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.json.state, "active");
    assert.ok(detail.json.myPresence);
    assert.equal(detail.json.myPresence.lastLiveChatLeftAt, leave.json.lastLiveChatLeftAt);
    assert.equal(detail.json.myPresence.likelyActiveInLiveChat, false);
  });

  test("POST v2 message after leave clears lastLiveChatLeftAt", async () => {
    await request("POST", "/v2/rooms/room-leave/leave", { deviceId: "dev-a" });
    const post = await request("POST", "/v2/rooms/room-leave/messages", {
      deviceId: "dev-a",
      encrypted: { ciphertext: "x", nonce: "n" },
      type: "text",
    });
    assert.equal(post.status, 201);

    const detail = await request(
      "GET",
      "/v2/rooms/room-leave?deviceId=" + encodeURIComponent("dev-a")
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.json.myPresence.lastLiveChatLeftAt, null);
    assert.equal(detail.json.myPresence.likelyActiveInLiveChat, true);
  });

  test("POST /sessions/heartbeat after leave clears leave flag", async () => {
    await request("POST", "/v2/rooms/room-leave/leave", { deviceId: "dev-b" });
    const hb = await request("POST", "/sessions/heartbeat", {
      sessionId: "room-leave",
      deviceId: "dev-b",
    });
    assert.equal(hb.status, 200);
    assert.equal(hb.json.ended, false);

    const detail = await request(
      "GET",
      "/v2/rooms/room-leave?deviceId=" + encodeURIComponent("dev-b")
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.json.myPresence.lastLiveChatLeftAt, null);
    assert.equal(detail.json.myPresence.likelyActiveInLiveChat, true);
  });

  test("POST /sessions/end still burns room (temporary session path)", async () => {
    const end = await request("POST", "/sessions/end", {
      sessionId: "room-ended",
    });
    assert.equal(end.status, 200);
    assert.equal(end.json.ended, true);

    const detail = await request(
      "GET",
      "/v2/rooms/room-ended?deviceId=" + encodeURIComponent("dev-c")
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.json.state, "ended");

    const leave = await request("POST", "/v2/rooms/room-ended/leave", {
      deviceId: "dev-c",
    });
    assert.equal(leave.status, 409);
  });

  test("POST leave on unknown room → 404", async () => {
    const { status } = await request(
      "POST",
      "/v2/rooms/00000000-0000-0000-0000-000000000099/leave",
      { deviceId: "dev-a" }
    );
    assert.equal(status, 404);
  });

  test("POST leave when device not linked → 403", async () => {
    const { status } = await request("POST", "/v2/rooms/room-leave/leave", {
      deviceId: "stranger",
    });
    assert.equal(status, 403);
  });
});
