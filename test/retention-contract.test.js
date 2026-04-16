const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRetentionView,
  normalizeRetentionSource,
  computeCanExtendRetention,
} = require("../src/retentionContract");

describe("retentionContract", () => {
  test("normalizeRetentionSource", () => {
    assert.equal(normalizeRetentionSource(null), "server_default");
    assert.equal(normalizeRetentionSource("  MANUAL  "), "manual");
    assert.equal(normalizeRetentionSource("Stripe"), "stripe");
    assert.equal(normalizeRetentionSource("custom_vendor"), "custom_vendor");
  });

  test("computeCanExtendRetention — active default", () => {
    assert.equal(
      computeCanExtendRetention({
        id: "r",
        state: "active",
        deleted_at: null,
        retention_tier: "default",
      }),
      true
    );
  });

  test("computeCanExtendRetention — ended room", () => {
    assert.equal(
      computeCanExtendRetention({
        id: "r",
        state: "ended",
        deleted_at: null,
        retention_tier: "30_days",
      }),
      false
    );
  });

  test("computeCanExtendRetention — permanent", () => {
    assert.equal(
      computeCanExtendRetention({
        id: "r",
        state: "active",
        deleted_at: null,
        retention_tier: "permanent",
      }),
      false
    );
  });

  test("buildRetentionView shape", () => {
    const v = buildRetentionView(
      {
        id: "rid",
        retention_tier: "7_days",
        retention_until: 1_700_000_000_000,
        retention_source: "manual",
        state: "active",
        deleted_at: null,
      },
      { toIso: (ms) => (ms == null ? null : new Date(ms).toISOString()) }
    );
    assert.equal(v.roomId, "rid");
    assert.equal(v.retentionTier, "7_days");
    assert.equal(v.isPaidRetention, true);
    assert.equal(v.canExtendRetention, true);
    assert.match(v.enforcementNote, /TTL/);
  });
});
