const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateEncryptedMessageContent,
  getMessagePayloadLimits,
} = require("../src/messagePayloadLimits");

describe("messagePayloadLimits", () => {
  let prevC;
  let prevN;
  let prevF;

  before(() => {
    prevC = process.env.CONNECT_MESSAGE_MAX_CIPHERTEXT_CHARS;
    prevN = process.env.CONNECT_MESSAGE_MAX_NONCE_CHARS;
    prevF = process.env.CONNECT_MESSAGE_MAX_FILENAME_CHARS;
    delete process.env.CONNECT_MESSAGE_MAX_CIPHERTEXT_CHARS;
    delete process.env.CONNECT_MESSAGE_MAX_NONCE_CHARS;
    delete process.env.CONNECT_MESSAGE_MAX_FILENAME_CHARS;
  });

  after(() => {
    if (prevC === undefined) {
      delete process.env.CONNECT_MESSAGE_MAX_CIPHERTEXT_CHARS;
    } else {
      process.env.CONNECT_MESSAGE_MAX_CIPHERTEXT_CHARS = prevC;
    }
    if (prevN === undefined) {
      delete process.env.CONNECT_MESSAGE_MAX_NONCE_CHARS;
    } else {
      process.env.CONNECT_MESSAGE_MAX_NONCE_CHARS = prevN;
    }
    if (prevF === undefined) {
      delete process.env.CONNECT_MESSAGE_MAX_FILENAME_CHARS;
    } else {
      process.env.CONNECT_MESSAGE_MAX_FILENAME_CHARS = prevF;
    }
  });

  test("valid payload", () => {
    const r = validateEncryptedMessageContent(
      { ciphertext: "a", nonce: "b" },
      "x.png"
    );
    assert.equal(r.ok, true);
  });

  test("ciphertext too long", () => {
    const lim = getMessagePayloadLimits().maxCiphertextChars;
    const r = validateEncryptedMessageContent(
      { ciphertext: "x".repeat(lim + 1), nonce: "n" },
      null
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "payload_too_large");
  });

  test("invalid fileName type", () => {
    const r = validateEncryptedMessageContent(
      { ciphertext: "a", nonce: "b" },
      123
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid_payload");
  });
});
