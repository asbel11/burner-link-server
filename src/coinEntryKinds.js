/**
 * Normalized `coin_ledger_entries.entry_kind` values (Phase Coins-2).
 * Stripe credits should use `purchase_credit`; future call metering uses `call_debit`, etc.
 *
 * @see docs/connect-coins-wallet-design.md
 */

const COIN_LEDGER_ENTRY_KINDS = Object.freeze({
  PURCHASE_CREDIT: "purchase_credit",
  ADMIN_ADJUST_CREDIT: "admin_adjust_credit",
  ADMIN_ADJUST_DEBIT: "admin_adjust_debit",
  CALL_DEBIT: "call_debit",
  RESERVE_HOLD: "reserve_hold",
  RESERVE_RELEASE: "reserve_release",
});

const ALLOWED_KINDS = new Set(Object.values(COIN_LEDGER_ENTRY_KINDS));

/**
 * @param {string} kind
 * @returns {boolean}
 */
function isValidCoinLedgerEntryKind(kind) {
  return typeof kind === "string" && ALLOWED_KINDS.has(kind);
}

module.exports = {
  COIN_LEDGER_ENTRY_KINDS,
  isValidCoinLedgerEntryKind,
  ALLOWED_KINDS,
};
