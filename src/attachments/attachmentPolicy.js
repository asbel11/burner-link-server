/**
 * Attachment upload policy (Media-Storage-1).
 * @see docs/connect-attachments-storage.md
 */

const ALLOWED_KINDS = new Set(["image", "video", "file"]);

/**
 * @param {unknown} v
 * @returns {v is 'image'|'video'|'file'}
 */
function isAllowedKind(v) {
  return typeof v === "string" && ALLOWED_KINDS.has(v);
}

function envMaxBytes() {
  const raw = process.env.CONNECT_ATTACHMENT_MAX_BYTES;
  if (raw === undefined || raw === "") {
    return 524_288_000;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 5_368_709_120) {
    return 524_288_000;
  }
  return Math.floor(n);
}

function envPresignPutSeconds() {
  const raw = process.env.CONNECT_S3_PRESIGN_PUT_SECONDS;
  if (raw === undefined || raw === "") {
    return 900;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 60 || n > 3600) {
    return 900;
  }
  return Math.floor(n);
}

function envPresignGetSeconds() {
  const raw = process.env.CONNECT_S3_PRESIGN_GET_SECONDS;
  if (raw === undefined || raw === "") {
    return 3600;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 60 || n > 86400) {
    return 3600;
  }
  return Math.floor(n);
}

/**
 * Loose MIME allowlist by kind (client may encrypt; bytes are opaque to server).
 * @param {string} kind
 * @param {string} mime
 * @returns {boolean}
 */
function mimeAllowedForKind(kind, mime) {
  const m = String(mime || "").trim().toLowerCase();
  if (!m || m.length > 200) {
    return false;
  }
  if (kind === "image") {
    return m.startsWith("image/");
  }
  if (kind === "video") {
    return m.startsWith("video/");
  }
  return true;
}

/**
 * @param {{ kind: string, mimeType: string, sizeBytes: number }}
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validatePrepareBody(p) {
  if (!isAllowedKind(p.kind)) {
    return { ok: false, reason: "invalid_kind" };
  }
  if (typeof p.mimeType !== "string" || !p.mimeType.trim()) {
    return { ok: false, reason: "invalid_mime" };
  }
  if (!mimeAllowedForKind(p.kind, p.mimeType)) {
    return { ok: false, reason: "mime_not_allowed_for_kind" };
  }
  const sz = Number(p.sizeBytes);
  if (!Number.isInteger(sz) || sz < 1) {
    return { ok: false, reason: "invalid_size" };
  }
  if (sz > envMaxBytes()) {
    return { ok: false, reason: "size_too_large" };
  }
  if (
    p.originalFilename != null &&
    (typeof p.originalFilename !== "string" ||
      p.originalFilename.length > 2048)
  ) {
    return { ok: false, reason: "invalid_filename" };
  }
  return { ok: true };
}

module.exports = {
  ALLOWED_KINDS,
  isAllowedKind,
  envMaxBytes,
  envPresignPutSeconds,
  envPresignGetSeconds,
  validatePrepareBody,
  mimeAllowedForKind,
};
