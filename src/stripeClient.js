/**
 * Shared Stripe API client (secret key) for Checkout and subscription API calls.
 * Webhook signature verification uses a separate path in stripeWebhook.js.
 */

const Stripe = require("stripe");

const API_VERSION = "2025-02-24.acacia";

/**
 * @returns {import("stripe").Stripe | null}
 */
function getStripeApiClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !String(key).trim()) return null;
  return new Stripe(String(key).trim(), { apiVersion: API_VERSION });
}

module.exports = { getStripeApiClient, API_VERSION };
