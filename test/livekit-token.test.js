const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { createRoomStore } = require("../src/store");
const {
  processLivekitTokenRequest,
  deriveLiveKitRoomName,
} = require("../src/livekitConnect");

const LK_ENV = {
  LIVEKIT_URL: "wss://unit-test.livekit.example",
  LIVEKIT_API_KEY: "APIxxxxxxxx",
  LIVEKIT_API_SECRET:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

describe("deriveLiveKitRoomName", () => {
  test("same roomId + callSessionId → same roomName", () => {
    const a = deriveLiveKitRoomName("room-1", "call-sess-aa");
    const b = deriveLiveKitRoomName("room-1", "call-sess-aa");
    assert.equal(a, b);
    assert.ok(a.startsWith("cl"));
    assert.equal(a.length, 42);
  });

  test("different callSessionId → different roomName", () => {
    const a = deriveLiveKitRoomName("room-1", "call-a");
    const b = deriveLiveKitRoomName("room-1", "call-b");
    assert.notEqual(a, b);
  });
});

describe("processLivekitTokenRequest", () => {
  let dbPath;
  let store;
  let prevLk;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-lk-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevLk = {
      LIVEKIT_URL: process.env.LIVEKIT_URL,
      LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
    };
    Object.assign(process.env, LK_ENV);
    store = createRoomStore({ dbFilePath: dbPath });
    store.rooms.createRoomFromV1({
      id: "room-two",
      inviteCode: "777777",
      creatorDeviceId: "dev-a",
    });
    store.rooms.joinActiveRoomByCode({
      inviteCode: "777777",
      deviceId: "dev-b",
    });
    store.rooms.createRoomFromV1({
      id: "room-one",
      inviteCode: "888888",
      creatorDeviceId: "dev-solo",
    });
    store.rooms.createRoomFromV1({
      id: "room-ended",
      inviteCode: "555555",
      creatorDeviceId: "dev-e1",
    });
    store.rooms.joinActiveRoomByCode({
      inviteCode: "555555",
      deviceId: "dev-e2",
    });
  });

  after(() => {
    for (const k of Object.keys(LK_ENV)) {
      if (prevLk[k] === undefined) delete process.env[k];
      else process.env[k] = prevLk[k];
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

  test("successful token mint", async () => {
    const out = await processLivekitTokenRequest(store.rooms, {
      deviceId: "dev-a",
      roomId: "room-two",
      callSessionId: "550e8400-e29b-41d4-a716-446655440000",
      callType: "voice",
    });
    assert.equal(out.status, 200);
    assert.ok(typeof out.json.token === "string");
    assert.ok(out.json.token.length > 20);
    assert.equal(out.json.url, LK_ENV.LIVEKIT_URL);
    assert.equal(
      out.json.roomName,
      deriveLiveKitRoomName(
        "room-two",
        "550e8400-e29b-41d4-a716-446655440000"
      )
    );
    assert.ok(typeof out.json.expiresAt === "string");
    assert.equal(out.json.callType, "voice");
  });

  test("unauthorized device", async () => {
    const out = await processLivekitTokenRequest(store.rooms, {
      deviceId: "stranger",
      roomId: "room-two",
      callSessionId: "550e8400-e29b-41d4-a716-446655440001",
      callType: "voice",
    });
    assert.equal(out.status, 403);
    assert.equal(out.json.reason, "forbidden");
  });

  test("room not ready (only one member)", async () => {
    const out = await processLivekitTokenRequest(store.rooms, {
      deviceId: "dev-solo",
      roomId: "room-one",
      callSessionId: "550e8400-e29b-41d4-a716-446655440002",
      callType: "voice",
    });
    assert.equal(out.status, 403);
    assert.equal(out.json.reason, "room_not_ready_for_call");
  });

  test("room not active", async () => {
    const now = Date.now();
    store.db
      .prepare(
        `UPDATE rooms SET state = 'ended', ended_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(now, now, "room-ended");
    const out = await processLivekitTokenRequest(store.rooms, {
      deviceId: "dev-e1",
      roomId: "room-ended",
      callSessionId: "550e8400-e29b-41d4-a716-446655440003",
      callType: "voice",
    });
    assert.equal(out.status, 409);
    assert.equal(out.json.reason, "room_not_active");
  });

  test("livekit_not_configured", async () => {
    delete process.env.LIVEKIT_URL;
    const out = await processLivekitTokenRequest(store.rooms, {
      deviceId: "dev-a",
      roomId: "room-two",
      callSessionId: "550e8400-e29b-41d4-a716-446655440004",
      callType: "voice",
    });
    process.env.LIVEKIT_URL = LK_ENV.LIVEKIT_URL;
    assert.equal(out.status, 503);
    assert.equal(out.json.reason, "livekit_not_configured");
  });

  test("malformed callSessionId", async () => {
    const out = await processLivekitTokenRequest(store.rooms, {
      deviceId: "dev-a",
      roomId: "room-two",
      callSessionId: "bad id spaces",
      callType: "voice",
    });
    assert.equal(out.status, 400);
    assert.equal(out.json.reason, "invalid_call_session_id");
  });

  test("video callType rejected", async () => {
    const out = await processLivekitTokenRequest(store.rooms, {
      deviceId: "dev-a",
      roomId: "room-two",
      callSessionId: "550e8400-e29b-41d4-a716-446655440005",
      callType: "video",
    });
    assert.equal(out.status, 400);
    assert.equal(out.json.reason, "unsupported_call_type");
  });

  test("repeated token requests same session", async () => {
    const body = {
      deviceId: "dev-b",
      roomId: "room-two",
      callSessionId: "550e8400-e29b-41d4-a716-446655440006",
      callType: "voice",
    };
    const a = await processLivekitTokenRequest(store.rooms, body);
    const b = await processLivekitTokenRequest(store.rooms, body);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.json.roomName, b.json.roomName);
    assert.ok(a.json.token.length > 20);
    assert.ok(b.json.token.length > 20);
  });
});

describe("POST /v2/calls/livekit-token (HTTP)", () => {
  let dbPath;
  let app;
  let prevDb;
  let prevLk;

  before(() => {
    dbPath = path.join(
      os.tmpdir(),
      `burner-lk-http-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    prevDb = process.env.DATABASE_PATH;
    prevLk = {
      LIVEKIT_URL: process.env.LIVEKIT_URL,
      LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
    };
    process.env.DATABASE_PATH = dbPath;
    Object.assign(process.env, LK_ENV);
    const seed = createRoomStore({ dbFilePath: dbPath });
    seed.rooms.createRoomFromV1({
      id: "room-http",
      inviteCode: "666666",
      creatorDeviceId: "http-a",
    });
    seed.rooms.joinActiveRoomByCode({
      inviteCode: "666666",
      deviceId: "http-b",
    });
    delete require.cache[require.resolve("../server.js")];
    ({ app } = require("../server.js"));
  });

  after(() => {
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
    for (const k of Object.keys(LK_ENV)) {
      if (prevLk[k] === undefined) delete process.env[k];
      else process.env[k] = prevLk[k];
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

  function post(body) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(app);
      srv.listen(0, async () => {
        try {
          const port = srv.address().port;
          const res = await fetch(`http://127.0.0.1:${port}/v2/calls/livekit-token`, {
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

  test("HTTP returns token", async () => {
    const { status, json } = await post({
      deviceId: "http-a",
      roomId: "room-http",
      callSessionId: "11111111-1111-1111-1111-111111111111",
      callType: "voice",
    });
    assert.equal(status, 200);
    assert.ok(json.token);
  });

  test("HTTP 503 when LiveKit env missing", async () => {
    delete process.env.LIVEKIT_API_SECRET;
    delete require.cache[require.resolve("../server.js")];
    const { app: app2 } = require("../server.js");
    const srv = http.createServer(app2);
    await new Promise((resolve, reject) => {
      srv.listen(0, async () => {
        try {
          const port = srv.address().port;
          const res = await fetch(`http://127.0.0.1:${port}/v2/calls/livekit-token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              deviceId: "http-a",
              roomId: "room-http",
              callSessionId: "22222222-2222-2222-2222-222222222222",
              callType: "voice",
            }),
          });
          const json = await res.json();
          assert.equal(res.status, 503);
          assert.equal(json.reason, "livekit_not_configured");
        } catch (e) {
          reject(e);
        } finally {
          srv.close();
          process.env.LIVEKIT_API_SECRET = LK_ENV.LIVEKIT_API_SECRET;
          delete require.cache[require.resolve("../server.js")];
          resolve();
        }
      });
      srv.on("error", reject);
    });
  });
});
