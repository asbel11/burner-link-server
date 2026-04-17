const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { createRoomStore } = require("../src/store");

describe("POST /v2/rooms/:roomId/messages (HTTP)", () => {
  let dbPath;
  let app;
  let prevDb;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-v2http-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevDb = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = dbPath;

    const store = createRoomStore({ dbFilePath: dbPath });
    store.rooms.createRoomFromV1({
      id: "room-http",
      inviteCode: "989898",
      creatorDeviceId: "dev-q",
    });

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

  function post(urlPath, bodyObj) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(app);
      srv.listen(0, async () => {
        try {
          const port = srv.address().port;
          const body = JSON.stringify(bodyObj);
          const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
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

  test("201 when deviceId is only in query (no body device fields)", async () => {
    const { status, json } = await post(
      `/v2/rooms/room-http/messages?deviceId=${encodeURIComponent("dev-q")}`,
      {
        encrypted: { ciphertext: "c", nonce: "n" },
        type: "text",
      }
    );
    assert.equal(status, 201);
    assert.ok(json && json.id);
  });

  test("201 when device_id is only in JSON body (no query deviceId)", async () => {
    const { status, json } = await post(`/v2/rooms/room-http/messages`, {
      device_id: "dev-q",
      encrypted: { ciphertext: "c2", nonce: "n2" },
      type: "text",
    });
    assert.equal(status, 201);
    assert.ok(json && json.id);
  });

  test("400 when encrypted missing nonce", async () => {
    const { status, json } = await post(
      `/v2/rooms/room-http/messages?deviceId=${encodeURIComponent("dev-q")}`,
      {
        encrypted: { ciphertext: "c" },
        type: "text",
      }
    );
    assert.equal(status, 400);
    assert.match(String(json?.error || ""), /Missing encrypted payload/i);
  });

  test("403 when query deviceId is not linked to room", async () => {
    const { status } = await post(
      `/v2/rooms/room-http/messages?deviceId=${encodeURIComponent("not-linked")}`,
      {
        encrypted: { ciphertext: "c", nonce: "n" },
        type: "text",
      }
    );
    assert.equal(status, 403);
  });
});
