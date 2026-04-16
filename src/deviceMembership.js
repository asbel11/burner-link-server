/**
 * CONNECT Phase M2 — device-scoped membership (Stripe subscription) separate from chat identity.
 */

const { getConnectMemberIncludedRetentionTier } = require("./connectMemberRetention");

function nowMs() {
  return Date.now();
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function createDeviceMembershipStore(db) {
  const insertIdempotent = db.prepare(
    `INSERT OR IGNORE INTO membership_stripe_events (event_id, device_id, kind, created_at)
     VALUES (@event_id, @device_id, @kind, @created_at)`
  );

  const stmtMembership = db.prepare(
    `SELECT device_id, membership_tier, membership_active_until, stripe_customer_id, stripe_subscription_id, updated_at
     FROM device_memberships WHERE device_id = ?`
  );

  const upsertMembership = db.prepare(
    `INSERT INTO device_memberships (
       device_id, membership_tier, membership_active_until, stripe_customer_id, stripe_subscription_id, updated_at
     ) VALUES (
       @device_id, @membership_tier, @membership_active_until, @stripe_customer_id, @stripe_subscription_id, @updated_at
     )
     ON CONFLICT(device_id) DO UPDATE SET
       membership_tier = excluded.membership_tier,
       membership_active_until = excluded.membership_active_until,
       stripe_customer_id = COALESCE(excluded.stripe_customer_id, device_memberships.stripe_customer_id),
       stripe_subscription_id = excluded.stripe_subscription_id,
       updated_at = excluded.updated_at`
  );

  const clearSubscription = db.prepare(
    `UPDATE device_memberships SET
       membership_active_until = @membership_active_until,
       stripe_subscription_id = NULL,
       updated_at = @updated_at
     WHERE device_id = @device_id`
  );

  const findBySubscriptionId = db.prepare(
    `SELECT device_id, membership_tier, membership_active_until, stripe_customer_id, stripe_subscription_id, updated_at
     FROM device_memberships WHERE stripe_subscription_id = ?`
  );

  /**
   * @param {string} deviceId
   */
  function isDeviceMember(deviceId) {
    const d = String(deviceId || "").trim();
    if (!d) return false;
    const row = stmtMembership.get(d);
    if (!row) return false;
    const until = row.membership_active_until;
    if (until == null) return false;
    return until > nowMs();
  }

  /**
   * @param {string} deviceId
   */
  function getMembershipRecord(deviceId) {
    const d = String(deviceId || "").trim();
    if (!d) return null;
    const row = stmtMembership.get(d);
    if (!row) return null;
    const until = row.membership_active_until;
    const active = until != null && until > nowMs();
    return {
      deviceId: row.device_id,
      isMember: active,
      membershipTier: row.membership_tier || "pro",
      membershipActiveUntil: until,
      stripeCustomerId: row.stripe_customer_id || null,
      stripeSubscriptionId: row.stripe_subscription_id || null,
    };
  }

  /**
   * @param {{ eventId: string, deviceId: string, stripeCustomerId?: string|null, stripeSubscriptionId: string, periodEndMs: number, tier?: string }}
   */
  function applyActivationOrRenewal(p) {
    const eventId = String(p.eventId || "").trim();
    const deviceId = String(p.deviceId || "").trim();
    if (!eventId || !deviceId || !p.stripeSubscriptionId) {
      return { ok: false, reason: "invalid_input" };
    }
    const tier = String(p.tier || "pro").trim() || "pro";
    const periodEnd = Number(p.periodEndMs);
    if (!Number.isFinite(periodEnd)) {
      return { ok: false, reason: "invalid_period" };
    }

    const t = nowMs();
    const ins = insertIdempotent.run({
      event_id: eventId.slice(0, 256),
      device_id: deviceId,
      kind: "activate_or_renew",
      created_at: t,
    });
    if (ins.changes === 0) {
      const row = stmtMembership.get(deviceId);
      return {
        ok: true,
        duplicate: true,
        record: row ? formatRecord(row) : null,
      };
    }

    upsertMembership.run({
      device_id: deviceId,
      membership_tier: tier,
      membership_active_until: Math.floor(periodEnd),
      stripe_customer_id: p.stripeCustomerId != null ? String(p.stripeCustomerId).trim() : null,
      stripe_subscription_id: String(p.stripeSubscriptionId).trim(),
      updated_at: t,
    });

    const row = stmtMembership.get(deviceId);
    return {
      ok: true,
      duplicate: false,
      record: row ? formatRecord(row) : null,
    };
  }

  /**
   * @param {{ eventId: string, stripeSubscriptionId: string, atMs?: number }}
   */
  function applyExpirationBySubscription(p) {
    const eventId = String(p.eventId || "").trim();
    const subId = String(p.stripeSubscriptionId || "").trim();
    if (!eventId || !subId) {
      return { ok: false, reason: "invalid_input" };
    }

    const t = nowMs();
    const ins = insertIdempotent.run({
      event_id: eventId.slice(0, 256),
      device_id: "",
      kind: "expire",
      created_at: t,
    });
    if (ins.changes === 0) {
      return { ok: true, duplicate: true, expired: false };
    }

    const row = findBySubscriptionId.get(subId);
    if (!row) {
      return { ok: true, expired: false, reason: "unknown_subscription" };
    }

    const at = p.atMs != null && Number.isFinite(p.atMs) ? Math.floor(p.atMs) : t;
    clearSubscription.run({
      device_id: row.device_id,
      membership_active_until: at,
      updated_at: t,
    });

    return {
      ok: true,
      duplicate: false,
      expired: true,
      deviceId: row.device_id,
    };
  }

  /**
   * @param {{ eventId: string, stripeSubscriptionId: string }}
   */
  function applyPaymentFailed(p) {
    return applyExpirationBySubscription({
      eventId: p.eventId,
      stripeSubscriptionId: p.stripeSubscriptionId,
      atMs: nowMs(),
    });
  }

  /**
   * Read model for GET /v2/billing/membership — no Stripe identifiers exposed.
   * @param {string} deviceId
   */
  function getMembershipStatus(deviceId) {
    const dev = String(deviceId || "").trim();
    const includedRetentionTier = getConnectMemberIncludedRetentionTier();
    if (!dev) {
      return null;
    }
    const rec = getMembershipRecord(dev);
    if (!rec) {
      return {
        deviceId: dev,
        isMember: false,
        membershipTier: null,
        membershipActiveUntil: null,
        includedRetentionTier,
        status: "none",
      };
    }
    const untilMs = rec.membershipActiveUntil;
    return {
      deviceId: rec.deviceId,
      isMember: rec.isMember,
      membershipTier: rec.membershipTier,
      membershipActiveUntil:
        untilMs != null && Number.isFinite(Number(untilMs))
          ? new Date(Number(untilMs)).toISOString()
          : null,
      includedRetentionTier,
      status: rec.isMember ? "active" : "inactive",
    };
  }

  return {
    isDeviceMember,
    getMembershipRecord,
    getMembershipStatus,
    applyActivationOrRenewal,
    applyExpirationBySubscription,
    applyPaymentFailed,
  };
}

/**
 * @param {object} row
 */
function formatRecord(row) {
  const until = row.membership_active_until;
  const active = until != null && until > nowMs();
  return {
    deviceId: row.device_id,
    isMember: active,
    membershipTier: row.membership_tier || "pro",
    membershipActiveUntil: until,
    stripeCustomerId: row.stripe_customer_id || null,
    stripeSubscriptionId: row.stripe_subscription_id || null,
  };
}

module.exports = {
  createDeviceMembershipStore,
};
