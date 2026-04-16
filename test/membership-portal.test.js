const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openDatabase } = require("../src/store/db");
const { createDeviceMembershipStore } = require("../src/deviceMembership");
const {
  createConnectProPortalSession,
  resolvePortalReturnUrl,
  ENV_PORTAL_RETURN,
} = require("../src/stripeCustomerPortal");
const { getStripeApiClient } = require("../src/stripeClient");

function mockStripe(url = "https://billing.stripe.com/session/test_1") {
  return {
    billingPortal: {
      sessions: {
        create: async (params) => {
          assert.ok(params.customer);
          assert.ok(params.return_url);
          return { url };
        },
      },
    },
  };
}

describe("Stripe API availability (portal route 503 path)", () => {
  test("getStripeApiClient is null when STRIPE_SECRET_KEY unset", () => {
    const prev = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      assert.equal(getStripeApiClient(), null);
    } finally {
      if (prev === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prev;
    }
  });
});

describe("resolvePortalReturnUrl", () => {
  let prev;

  before(() => {
    prev = process.env[ENV_PORTAL_RETURN];
    delete process.env[ENV_PORTAL_RETURN];
  });

  after(() => {
    if (prev === undefined) delete process.env[ENV_PORTAL_RETURN];
    else process.env[ENV_PORTAL_RETURN] = prev;
  });

  test("body returnUrl overrides env", () => {
    process.env[ENV_PORTAL_RETURN] = "https://app.example.com/default";
    const r = resolvePortalReturnUrl({
      returnUrl: "https://app.example.com/from-body",
    });
    assert.equal(r.ok, true);
    assert.equal(r.returnUrl, "https://app.example.com/from-body");
  });

  test("env default when body omits returnUrl", () => {
    process.env[ENV_PORTAL_RETURN] = "https://app.example.com/after-portal";
    const r = resolvePortalReturnUrl({});
    assert.equal(r.ok, true);
    assert.equal(r.returnUrl, "https://app.example.com/after-portal");
  });

  test("invalid URL → invalid_return_url", () => {
    const r = resolvePortalReturnUrl({ returnUrl: "not-a-url" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid_return_url");
  });
});

describe("createConnectProPortalSession", () => {
  let dbPath;
  let db;
  let membership;
  let prevPortalEnv;

  before(() => {
    prevPortalEnv = process.env[ENV_PORTAL_RETURN];
    process.env[ENV_PORTAL_RETURN] = "https://app.example.com/membership";

    dbPath = path.join(
      os.tmpdir(),
      `burner-portal-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    db = openDatabase(dbPath);
    membership = createDeviceMembershipStore(db);
  });

  after(() => {
    if (prevPortalEnv === undefined) delete process.env[ENV_PORTAL_RETURN];
    else process.env[ENV_PORTAL_RETURN] = prevPortalEnv;

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

  test("active member with stripe_customer_id → portal url", async () => {
    const future = Date.now() + 86400000 * 30;
    membership.applyActivationOrRenewal({
      eventId: "evt_portal_1",
      deviceId: "dev-portal-ok",
      stripeCustomerId: "cus_portal_ok",
      stripeSubscriptionId: "sub_ok",
      periodEndMs: future,
      tier: "pro",
    });
    const stripe = mockStripe();
    const out = await createConnectProPortalSession(
      stripe,
      membership,
      "dev-portal-ok",
      {}
    );
    assert.equal(out.ok, true);
    assert.equal(out.url, "https://billing.stripe.com/session/test_1");
  });

  test("unknown device → membership_not_found", async () => {
    const out = await createConnectProPortalSession(
      mockStripe(),
      membership,
      "dev-unknown-xyz",
      {}
    );
    assert.equal(out.ok, false);
    assert.equal(out.reason, "membership_not_found");
    assert.equal(out.httpStatus, 404);
  });

  test("row without stripe_customer_id → stripe_customer_not_linked", async () => {
    const t = Date.now();
    db.prepare(
      `INSERT INTO device_memberships (
         device_id, membership_tier, membership_active_until, stripe_customer_id, stripe_subscription_id, updated_at
       ) VALUES (?, 'pro', ?, NULL, NULL, ?)`
    ).run("dev-no-cus", t + 99999999, t);

    const out = await createConnectProPortalSession(
      mockStripe(),
      membership,
      "dev-no-cus",
      {}
    );
    assert.equal(out.ok, false);
    assert.equal(out.reason, "stripe_customer_not_linked");
    assert.equal(out.httpStatus, 404);
  });

  test("returnUrl in body overrides env", async () => {
    const future = Date.now() + 86400000 * 30;
    membership.applyActivationOrRenewal({
      eventId: "evt_portal_2",
      deviceId: "dev-override",
      stripeCustomerId: "cus_ov",
      stripeSubscriptionId: "sub_ov",
      periodEndMs: future,
      tier: "pro",
    });
    let seenReturn;
    const stripe = {
      billingPortal: {
        sessions: {
          create: async (params) => {
            seenReturn = params.return_url;
            return { url: "https://billing.stripe.com/session/ov" };
          },
        },
      },
    };
    const out = await createConnectProPortalSession(stripe, membership, "dev-override", {
      returnUrl: "https://app.example.com/custom-return",
    });
    assert.equal(out.ok, true);
    assert.equal(seenReturn, "https://app.example.com/custom-return");
  });

  test("Stripe billingPortal.create throws → stripe_portal_error", async () => {
    const future = Date.now() + 86400000 * 30;
    membership.applyActivationOrRenewal({
      eventId: "evt_portal_err",
      deviceId: "dev-err",
      stripeCustomerId: "cus_err",
      stripeSubscriptionId: "sub_err",
      periodEndMs: future,
      tier: "pro",
    });
    const badStripe = {
      billingPortal: {
        sessions: {
          create: async () => {
            throw new Error("No configuration provided");
          },
        },
      },
    };
    const out = await createConnectProPortalSession(badStripe, membership, "dev-err", {});
    assert.equal(out.ok, false);
    assert.equal(out.reason, "stripe_portal_error");
    assert.equal(out.httpStatus, 502);
  });

  test("missing return URL when env unset → missing_return_url", async () => {
    const saved = process.env[ENV_PORTAL_RETURN];
    delete process.env[ENV_PORTAL_RETURN];
    try {
      const future = Date.now() + 86400000 * 30;
      membership.applyActivationOrRenewal({
        eventId: "evt_portal_3",
        deviceId: "dev-nourl",
        stripeCustomerId: "cus_nu",
        stripeSubscriptionId: "sub_nu",
        periodEndMs: future,
        tier: "pro",
      });
      const out = await createConnectProPortalSession(
        mockStripe(),
        membership,
        "dev-nourl",
        {}
      );
      assert.equal(out.ok, false);
      assert.equal(out.reason, "missing_return_url");
      assert.ok(out.hint);
    } finally {
      if (saved === undefined) delete process.env[ENV_PORTAL_RETURN];
      else process.env[ENV_PORTAL_RETURN] = saved;
    }
  });
});
