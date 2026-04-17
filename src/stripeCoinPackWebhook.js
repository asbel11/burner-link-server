/**
 * Stripe `checkout.session.completed` → coin wallet credit (Phase Coins-3).
 * Idempotency: **`event.id`** is the ledger **`idempotency_key`** (globally unique per Stripe).
 */

const { COIN_LEDGER_ENTRY_KINDS } = require("./coinEntryKinds");
const { getCoinPackById } = require("./coinPackCatalog");

/**
 * @param {Record<string, string>|null|undefined} metadata
 * @returns {{ ok: true, deviceId: string, packId: string } | { ok: false, reason: string }}
 */
function extractCoinPackMetadata(metadata) {
  if (metadata == null || typeof metadata !== "object") {
    return { ok: false, reason: "missing_metadata" };
  }
  const connectBilling =
    typeof metadata.connectBilling === "string"
      ? metadata.connectBilling.trim().toLowerCase()
      : "";
  if (connectBilling !== "coin_pack") {
    return { ok: false, reason: "not_coin_pack" };
  }
  const deviceId =
    typeof metadata.deviceId === "string" ? metadata.deviceId.trim() : "";
  const packId =
    typeof metadata.packId === "string" ? metadata.packId.trim() : "";
  if (!deviceId) {
    return { ok: false, reason: "missing_device_id" };
  }
  if (!packId) {
    return { ok: false, reason: "missing_pack_id" };
  }
  return { ok: true, deviceId, packId };
}

/**
 * @param {object} session Stripe Checkout Session
 * @returns {string|null}
 */
function paymentIntentIdFromSession(session) {
  if (!session) {
    return null;
  }
  const pi = session.payment_intent;
  if (typeof pi === "string") {
    return pi;
  }
  if (pi && typeof pi === "object" && typeof pi.id === "string") {
    return pi.id;
  }
  return null;
}

/**
 * @param {object} event Stripe Event
 * @param {{ coins: object }} deps coin wallet repository from `createCoinWalletRepository`
 * @returns {Promise<{ handled: boolean, httpStatus?: number, body?: object }>}
 */
async function processCoinPackStripeEvent(event, deps) {
  const { coins } = deps;
  const eventId = event.id;

  if (event.type !== "checkout.session.completed") {
    return { handled: false };
  }

  const session = event.data && event.data.object;
  if (!session || session.mode !== "payment") {
    return { handled: false };
  }

  const meta = extractCoinPackMetadata(session.metadata);
  if (!meta.ok) {
    return { handled: false };
  }

  const pack = getCoinPackById(meta.packId);
  if (!pack) {
    return {
      handled: true,
      httpStatus: 400,
      body: {
        received: true,
        error: "Unknown or unconfigured coin pack",
        reason: "invalid_pack_id",
        packId: meta.packId,
      },
    };
  }

  const metaCoins = session.metadata && session.metadata.coinsGranted;
  if (
    metaCoins != null &&
    String(metaCoins).trim() !== "" &&
    Number(metaCoins) !== pack.coins
  ) {
    return {
      handled: true,
      httpStatus: 400,
      body: {
        received: true,
        error: "Session metadata coinsGranted does not match server catalog",
        reason: "pack_amount_mismatch",
      },
    };
  }

  if (session.payment_status && session.payment_status !== "paid") {
    return {
      handled: true,
      httpStatus: 400,
      body: {
        received: true,
        error: "Checkout session is not paid",
        reason: "payment_not_paid",
        payment_status: session.payment_status,
      },
    };
  }

  const out = coins.applyLedgerCredit({
    deviceId: meta.deviceId,
    amount: pack.coins,
    idempotencyKey: eventId,
    entryKind: COIN_LEDGER_ENTRY_KINDS.PURCHASE_CREDIT,
    packId: pack.packId,
    stripeCheckoutSessionId:
      typeof session.id === "string" ? session.id : null,
    stripePaymentIntentId: paymentIntentIdFromSession(session),
    externalReference: eventId,
    metadataJson: JSON.stringify({
      stripeEventType: event.type,
      packId: pack.packId,
    }),
  });

  if (!out.ok) {
    return {
      handled: true,
      httpStatus: 400,
      body: {
        received: true,
        error: "Could not apply coin credit",
        reason: out.reason,
      },
    };
  }

  return {
    handled: true,
    httpStatus: 200,
    body: {
      received: true,
      connectBilling: "coin_pack",
      duplicate: Boolean(out.duplicate),
      deviceId: out.wallet.deviceId,
      availableCoins: out.wallet.availableCoins,
      reservedCoins: out.wallet.reservedCoins,
      spendableCoins: out.wallet.spendableCoins,
      creditedCoins: pack.coins,
      packId: pack.packId,
      ledgerEntryId: out.entry && out.entry.id,
    },
  };
}

module.exports = {
  extractCoinPackMetadata,
  processCoinPackStripeEvent,
  paymentIntentIdFromSession,
};
