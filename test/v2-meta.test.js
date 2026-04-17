const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

describe("GET /v2/meta (deploy probe)", () => {
  let dbPath;
  let app;
  let prevDb;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-meta-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

  test("200 includes postGroupRoomCreate path", async () => {
    await new Promise((resolve, reject) => {
      const srv = http.createServer(app);
      srv.listen(0, async () => {
        let err;
        try {
          const port = srv.address().port;
          const res = await fetch(`http://127.0.0.1:${port}/v2/meta`);
          assert.equal(res.status, 200);
          const json = await res.json();
          assert.equal(json.service, "burner-link-server");
          assert.ok(json.version);
          assert.equal(json.connect.postGroupRoomCreate.path, "/v2/rooms/create");
          assert.equal(json.connect.postGroupRoomCreate.available, true);
          assert.equal(typeof json.connect.attachmentStorage?.configured, "boolean");
        } catch (e) {
          err = e;
        } finally {
          srv.close();
        }
        if (err) reject(err);
        else resolve();
      });
      srv.on("error", reject);
    });
  });
});
