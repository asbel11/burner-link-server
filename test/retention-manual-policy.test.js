const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { isManualRetentionPostAllowed } = require("../src/retentionManualPolicy");

describe("retentionManualPolicy", () => {
  const saved = {};

  before(() => {
    saved.NODE_ENV = process.env.NODE_ENV;
    saved.ALLOW = process.env.ALLOW_MANUAL_RETENTION_POST;
  });

  after(() => {
    if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.ALLOW === undefined) delete process.env.ALLOW_MANUAL_RETENTION_POST;
    else process.env.ALLOW_MANUAL_RETENTION_POST = saved.ALLOW;
  });

  test("production without flag → manual disabled", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_MANUAL_RETENTION_POST;
    assert.equal(isManualRetentionPostAllowed(), false);
  });

  test("production with ALLOW_MANUAL_RETENTION_POST=1 → enabled", () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_MANUAL_RETENTION_POST = "1";
    assert.equal(isManualRetentionPostAllowed(), true);
  });

  test("test env → enabled without flag", () => {
    process.env.NODE_ENV = "test";
    delete process.env.ALLOW_MANUAL_RETENTION_POST;
    assert.equal(isManualRetentionPostAllowed(), true);
  });
});
