/**
 * Phase 24 — Retrieve Stripe Checkout Session status for a linked device (pre–webhook confirmation).
 */

/**
 * @param {{ getRoomDetailForDevice: Function, getRetentionForLinkedDevice: Function }} rooms
 * @param {import("stripe").Stripe} stripe
 * @param {{ roomId: string, deviceId: string, sessionId: string }} params
 */
async function getCheckoutSessionSyncStatus(rooms, stripe, params) {
  const { roomId, deviceId, sessionId } = params;
  const sid = String(sessionId || "").trim();
  if (!sid || !sid.startsWith("cs_")) {
    return {
      ok: false,
      reason: "invalid_session_id",
      httpStatus: 400,
    };
  }

  const detail = rooms.getRoomDetailForDevice(roomId, deviceId);
  if (!detail.ok) {
    if (detail.reason === "forbidden") {
      return { ok: false, reason: "forbidden", httpStatus: 403 };
    }
    if (detail.reason === "deleted") {
      return { ok: false, reason: "deleted", httpStatus: 410 };
    }
    return { ok: false, reason: "not_found", httpStatus: 404 };
  }

  if (detail.room.state !== "active") {
    return { ok: false, reason: "room_not_active", httpStatus: 409 };
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sid);
  } catch (e) {
    const code = e && e.code;
    if (code === "resource_missing") {
      return { ok: false, reason: "session_not_found", httpStatus: 404 };
    }
    throw e;
  }

  const m = session.metadata || {};
  if (
    String(m.roomId || "").trim() !== roomId ||
    String(m.deviceId || "").trim() !== deviceId
  ) {
    return {
      ok: false,
      reason: "session_metadata_mismatch",
      httpStatus: 403,
    };
  }

  const expectedRetentionTier = String(m.retentionTier || "").trim().toLowerCase();
  const paymentStatus = session.payment_status || "unknown";
  const sessionStatus = session.status || "unknown";

  /** For `mode: payment`, `paid` means the charge succeeded (webhook may still be in flight). */
  const stripePaymentComplete =
    sessionStatus === "complete" && paymentStatus === "paid";

  const retention = rooms.getRetentionForLinkedDevice(roomId, deviceId);
  const retentionOk = retention.ok === true;
  const currentTier = retentionOk
    ? String(retention.retentionTier || "").toLowerCase()
    : null;

  const entitlementInSync =
    retentionOk &&
    expectedRetentionTier !== "" &&
    currentTier === expectedRetentionTier;

  let retentionPayload = null;
  if (retentionOk) {
    const { ok: _drop, ...rest } = retention;
    retentionPayload = rest;
  }

  return {
    ok: true,
    sessionId: session.id,
    paymentStatus,
    sessionStatus,
    expectedRetentionTier:
      expectedRetentionTier === "" ? null : expectedRetentionTier,
    stripePaymentComplete,
    entitlementInSync,
    retention: retentionPayload,
    retentionFetchOk: retentionOk,
  };
}

module.exports = { getCheckoutSessionSyncStatus };
