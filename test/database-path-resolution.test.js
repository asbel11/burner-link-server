const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveDatabaseFileFromInput } = require("../src/store/db");

describe("resolveDatabaseFileFromInput", () => {
  const cwd = process.cwd();

  test("non-existent path with .db basename is used as file path", () => {
    const p = resolveDatabaseFileFromInput(
      path.join(os.tmpdir(), "ghost-not-created-yet.db"),
      cwd
    );
    assert.match(p, /ghost-not-created-yet\.db$/);
  });

  test("existing directory gets burner-link.db appended", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burner-dbdir-"));
    try {
      const p = resolveDatabaseFileFromInput(dir, cwd);
      assert.equal(p, path.join(dir, "burner-link.db"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trailing slash implies directory for missing path", () => {
    const p = resolveDatabaseFileFromInput("/data/", cwd);
    assert.equal(p, path.join(path.normalize("/data"), "burner-link.db"));
  });

  test("bare /data with no file extension implies directory", () => {
    const p = resolveDatabaseFileFromInput("/data", cwd);
    assert.equal(p, path.join("/data", "burner-link.db"));
  });

  test("explicit file path /data/burner-link.db unchanged when missing", () => {
    const p = resolveDatabaseFileFromInput("/data/burner-link.db", cwd);
    assert.equal(p, path.normalize("/data/burner-link.db"));
  });
});
