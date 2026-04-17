/**
 * Bounds for encrypted message bodies stored in `room_messages` (ciphertext + nonce).
 * Prevents unbounded SQLite TEXT growth and abuse via oversized JSON fields within Express limits.
 *
 * @see docs/connect-media-messages.md
 */

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.floor(n);
}

/**
 * @returns {{ maxCiphertextChars: number, maxNonceChars: number, maxFileNameChars: number }}
 */
function getMessagePayloadLimits() {
  return {
    maxCiphertextChars: envPositiveInt(
      "CONNECT_MESSAGE_MAX_CIPHERTEXT_CHARS",
      25_000_000
    ),
    maxNonceChars: envPositiveInt("CONNECT_MESSAGE_MAX_NONCE_CHARS", 4096),
    maxFileNameChars: envPositiveInt(
      "CONNECT_MESSAGE_MAX_FILENAME_CHARS",
      1024
    ),
  };
}

/**
 * @param {{ ciphertext: unknown, nonce: unknown }} encrypted
 * @param {unknown} fileName
 * @returns {{ ok: true } | { ok: false, reason: 'invalid_payload' | 'payload_too_large' }}
 */
function validateEncryptedMessageContent(encrypted, fileName) {
  if (
    !encrypted ||
    typeof encrypted !== "object" ||
    typeof encrypted.ciphertext !== "string" ||
    typeof encrypted.nonce !== "string"
  ) {
    return { ok: false, reason: "invalid_payload" };
  }

  const limits = getMessagePayloadLimits();
  if (encrypted.ciphertext.length > limits.maxCiphertextChars) {
    return { ok: false, reason: "payload_too_large" };
  }
  if (encrypted.nonce.length > limits.maxNonceChars) {
    return { ok: false, reason: "payload_too_large" };
  }

  if (fileName != null) {
    if (typeof fileName !== "string") {
      return { ok: false, reason: "invalid_payload" };
    }
    if (fileName.length > limits.maxFileNameChars) {
      return { ok: false, reason: "payload_too_large" };
    }
  }

  return { ok: true };
}

module.exports = {
  getMessagePayloadLimits,
  validateEncryptedMessageContent,
};
