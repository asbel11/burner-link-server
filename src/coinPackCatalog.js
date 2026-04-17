/**
 * CONNECT coin pack definitions (Stripe Price ID + coin amount per pack).
 * Env **`CONNECT_COIN_PACKS_JSON`**: JSON array of `{ "packId", "stripePriceId", "coins" }`.
 *
 * @see docs/v2-coin-wallet-billing.md
 */

/**
 * @returns {Array<{ packId: string, stripePriceId: string, coins: number }>}
 */
function parseCoinPacksFromEnv() {
  const raw = process.env.CONNECT_COIN_PACKS_JSON;
  if (raw == null || String(raw).trim() === "") {
    return [];
  }
  try {
    const arr = JSON.parse(String(raw).trim());
    if (!Array.isArray(arr)) {
      return [];
    }
    const out = [];
    for (const row of arr) {
      if (row == null || typeof row !== "object") {
        continue;
      }
      const packId =
        typeof row.packId === "string" ? row.packId.trim() : "";
      const stripePriceId =
        typeof row.stripePriceId === "string"
          ? row.stripePriceId.trim()
          : "";
      const coins = Number(row.coins);
      if (
        !packId ||
        !stripePriceId ||
        !Number.isInteger(coins) ||
        coins <= 0
      ) {
        continue;
      }
      out.push({ packId, stripePriceId, coins });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * @returns {Array<{ packId: string, stripePriceId: string, coins: number }>}
 */
function getCoinPackCatalog() {
  return parseCoinPacksFromEnv();
}

/**
 * @param {string} packId
 * @returns {{ packId: string, stripePriceId: string, coins: number } | null}
 */
function getCoinPackById(packId) {
  const id = typeof packId === "string" ? packId.trim() : "";
  if (!id) {
    return null;
  }
  return getCoinPackCatalog().find((p) => p.packId === id) || null;
}

module.exports = {
  getCoinPackById,
  getCoinPackCatalog,
  parseCoinPacksFromEnv,
};
