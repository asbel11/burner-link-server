const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  getEffectiveSessionHeartbeatAutoEnd,
} = require("../src/connectSessionPolicy");

describe("connectSessionPolicy (Phase Fix-1)", () => {
  const keys = [
    "CONNECT_DISABLE_SESSION_AUTO_END",
    "SESSION_HEARTBEAT_AUTO_END",
  ];
  let snapshot;

  beforeEach(() => {
    snapshot = {};
    for (const k of keys) {
      snapshot[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  test("unset CONNECT_DISABLE + SESSION_HEARTBEAT true → effective false (CONNECT default)", () => {
    delete process.env.CONNECT_DISABLE_SESSION_AUTO_END;
    process.env.SESSION_HEARTBEAT_AUTO_END = "1";
    assert.equal(getEffectiveSessionHeartbeatAutoEnd(), false);
  });

  test("CONNECT_DISABLE=0 + SESSION_HEARTBEAT true → effective true (legacy)", () => {
    process.env.CONNECT_DISABLE_SESSION_AUTO_END = "0";
    process.env.SESSION_HEARTBEAT_AUTO_END = "1";
    assert.equal(getEffectiveSessionHeartbeatAutoEnd(), true);
  });

  test("CONNECT_DISABLE unset + SESSION_HEARTBEAT unset → effective false", () => {
    delete process.env.CONNECT_DISABLE_SESSION_AUTO_END;
    delete process.env.SESSION_HEARTBEAT_AUTO_END;
    assert.equal(getEffectiveSessionHeartbeatAutoEnd(), false);
  });
});
