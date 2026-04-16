/**
 * Phase M3b — Stripe Customer Portal for CONNECT Pro (manage/cancel subscription).
 */

/**
 * Default return URL when the client does not send `returnUrl`.
 * Must be an absolute https (or http in dev) URL Stripe accepts for `return_url`.
 */
const ENV_PORTAL_RETURN = "STRIPE_CUSTOMER_PORTAL_RETURN_URL";

/**
 * @param {{ returnUrl?: unknown }} body
 * @returns {{ ok: true, returnUrl: string } | { ok: false, reason: string }}
 */
function resolvePortalReturnUrl(body) {
  const raw =
    body &&
    typeof body === "object" &&
    typeof body.returnUrl === "string" &&
    body.returnUrl.trim() !== ""
      ? body.returnUrl.trim()
      : null;
  if (raw) {
    const v = validateHttpUrl(raw);
    if (!v.ok) return { ok: false, reason: v.reason };
    return { ok: true, returnUrl: raw };
  }
  const fromEnv = process.env[ENV_PORTAL_RETURN];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    const u = fromEnv.trim();
    const v = validateHttpUrl(u);
    if (!v.ok) return { ok: false, reason: v.reason };
    return { ok: true, returnUrl: u };
  }
  return { ok: false, reason: "missing_return_url" };
}

/**
 * @param {string} s
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateHttpUrl(s) {
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: "invalid_return_url" };
    }
    return { ok: true };
  } catch (_) {
    return { ok: false, reason: "invalid_return_url" };
  }
}

/**
 * @param {import("stripe").Stripe} stripe
 * @param {object} membershipStore from createDeviceMembershipStore
 * @param {string} deviceId
 * @param {object} body request JSON body
 */
async function createConnectProPortalSession(stripe, membershipStore, deviceId, body) {
  const dev = String(deviceId || "").trim();
  if (!dev) {
    return { ok: false, httpStatus: 400, reason: "invalid_device_id" };
  }

  const rec = membershipStore.getMembershipRecord(dev);
  if (!rec) {
    return { ok: false, httpStatus: 404, reason: "membership_not_found" };
  }
  if (!rec.stripeCustomerId || String(rec.stripeCustomerId).trim() === "") {
    return { ok: false, httpStatus: 404, reason: "stripe_customer_not_linked" };
  }

  const urlRes = resolvePortalReturnUrl(body || {});
  if (!urlRes.ok) {
    return {
      ok: false,
      httpStatus: 400,
      reason: urlRes.reason,
      hint:
        urlRes.reason === "missing_return_url"
          ? `Set ${ENV_PORTAL_RETURN} or pass returnUrl in the request body`
          : undefined,
    };
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: String(rec.stripeCustomerId).trim(),
      return_url: urlRes.returnUrl,
    });
    if (!session || !session.url) {
      return {
        ok: false,
        httpStatus: 502,
        reason: "portal_session_incomplete",
      };
    }
    return { ok: true, url: session.url };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : "stripe_portal_error";
    return {
      ok: false,
      httpStatus: 502,
      reason: "stripe_portal_error",
      detail: msg.slice(0, 500),
    };
  }
}

module.exports = {
  createConnectProPortalSession,
  resolvePortalReturnUrl,
  validateHttpUrl,
  ENV_PORTAL_RETURN,
};
