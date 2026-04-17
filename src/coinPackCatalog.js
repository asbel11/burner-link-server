/**
 * CONNECT coin pack definitions (Stripe Price ID + coin amount per pack).
 *
 * - **`CONNECT_COIN_PACKS_JSON`**: JSON array of `{ "packId", "stripePriceId", "coins" }`.
 * - Optional discrete env (merged; discrete wins on same **`packId`**):
 *   **`STRIPE_PRICE_COINS_100`** / **`STRIPE_PRICE_100`** → **`coins_100`** (100 coins), etc.
 *
 * @see docs/v2-coin-wallet-billing.md
 */

const DISCRETE_PACK_DEFS = Object.freeze([
  {
    packId: "coins_100",
    coins: 100,
    envKeys: ["STRIPE_PRICE_COINS_100", "STRIPE_PRICE_100"],
  },
  {
    packId: "coins_300",
    coins: 300,
    envKeys: ["STRIPE_PRICE_COINS_300", "STRIPE_PRICE_300"],
  },
  {
    packId: "coins_1000",
    coins: 1000,
    envKeys: ["STRIPE_PRICE_COINS_1000", "STRIPE_PRICE_1000"],
  },
]);

/**
 * @param {readonly string[]} envKeys
 * @returns {string}
 */
function firstEnvTrimmed(envKeys) {
  for (const k of envKeys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
}

/**
 * @returns {Array<{ packId: string, stripePriceId: string, coins: number }>}
 */
function parseDiscreteCoinPacksFromEnv() {
  const out = [];
  for (const def of DISCRETE_PACK_DEFS) {
    const stripePriceId = firstEnvTrimmed(def.envKeys);
    if (stripePriceId) {
      out.push({
        packId: def.packId,
        stripePriceId,
        coins: def.coins,
      });
    }
  }
  return out;
}

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
 * JSON catalog + discrete env vars; later entries override same **`packId`**.
 * @returns {Array<{ packId: string, stripePriceId: string, coins: number }>}
 */
function getCoinPackCatalog() {
  const fromJson = parseCoinPacksFromEnv();
  const fromDiscrete = parseDiscreteCoinPacksFromEnv();
  const byId = new Map();
  for (const p of fromJson) {
    byId.set(p.packId, p);
  }
  for (const p of fromDiscrete) {
    byId.set(p.packId, p);
  }
  return Array.from(byId.values());
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
  parseDiscreteCoinPacksFromEnv,
};
