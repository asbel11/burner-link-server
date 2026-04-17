#!/usr/bin/env node
/**
 * Phase Attachment-Storage-Ops-2: verify deployed API has object storage configured and (optionally) prepare works.
 *
 * Usage:
 *   CONNECT_API_BASE=https://your-api.up.railway.app node scripts/verify-attachment-prod.js
 *
 * Steps:
 *   1) GET /v2/meta — require connect.attachmentStorage.configured === true
 *   2) POST /sessions/create — get roomId
 *   3) POST /v2/rooms/:roomId/attachments/prepare — require 200 + uploadUrl
 *
 * Exit: 0 = all pass; 1 = failure; 2 = missing CONNECT_API_BASE
 */

const path = require("path");
try {
  require("dotenv").config({
    path: path.join(__dirname, "..", ".env"),
  });
} catch (_) {}

const baseRaw =
  process.argv[2] ||
  process.env.CONNECT_API_BASE ||
  process.env.API_BASE ||
  "";

function usage() {
  console.error(
    "Set CONNECT_API_BASE to your Railway API origin, e.g.\n" +
      "  CONNECT_API_BASE=https://xxx.up.railway.app node scripts/verify-attachment-prod.js"
  );
}

if (!baseRaw || String(baseRaw).trim() === "") {
  usage();
  process.exit(2);
}

let origin;
try {
  const u = new URL(baseRaw.trim());
  if (!/^https?:$/i.test(u.protocol)) throw new Error("http or https only");
  origin = u.origin;
} catch (e) {
  console.error("Invalid URL:", baseRaw, e.message || e);
  usage();
  process.exit(2);
}

async function main() {
  const metaUrl = `${origin}/v2/meta`;
  const metaRes = await fetch(metaUrl, { headers: { Accept: "application/json" } });
  const metaText = await metaRes.text();
  let meta;
  try {
    meta = metaText ? JSON.parse(metaText) : null;
  } catch {
    meta = null;
  }

  if (metaRes.status !== 200) {
    console.error(`FAIL: GET /v2/meta → HTTP ${metaRes.status}`);
    console.error(metaText.slice(0, 400));
    process.exit(1);
  }

  const configured = meta?.connect?.attachmentStorage?.configured;
  if (configured !== true) {
    console.error(
      "FAIL: connect.attachmentStorage.configured is not true — S3 env missing on this deploy (CONNECT_S3_BUCKET + CONNECT_S3_ACCESS_KEY_ID + CONNECT_S3_SECRET_ACCESS_KEY)."
    );
    console.error(JSON.stringify(meta, null, 2));
    process.exit(1);
  }

  console.log("OK: GET /v2/meta → attachmentStorage.configured === true");

  const code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  const deviceId = "verify-att-smoke-device";
  const createRes = await fetch(`${origin}/sessions/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code, deviceId }),
  });
  const createText = await createRes.text();
  let createJson;
  try {
    createJson = createText ? JSON.parse(createText) : null;
  } catch {
    createJson = null;
  }

  if (createRes.status !== 201) {
    console.error(`FAIL: POST /sessions/create → HTTP ${createRes.status}`, createText.slice(0, 300));
    process.exit(1);
  }

  const roomId = createJson?.roomId || createJson?.id;
  if (!roomId) {
    console.error("FAIL: no roomId in create response", createText);
    process.exit(1);
  }

  console.log("OK: POST /sessions/create → roomId", roomId);

  const prepRes = await fetch(`${origin}/v2/rooms/${roomId}/attachments/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      deviceId,
      kind: "image",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
    }),
  });
  const prepText = await prepRes.text();
  let prepJson;
  try {
    prepJson = prepText ? JSON.parse(prepText) : null;
  } catch {
    prepJson = null;
  }

  if (prepRes.status !== 200) {
    console.error(`FAIL: POST .../attachments/prepare → HTTP ${prepRes.status}`);
    console.error(prepText.slice(0, 600));
    process.exit(1);
  }

  if (!prepJson?.uploadUrl || !prepJson?.attachmentId) {
    console.error("FAIL: prepare response missing uploadUrl or attachmentId", prepText.slice(0, 400));
    process.exit(1);
  }

  console.log("OK: POST .../attachments/prepare → attachmentId", prepJson.attachmentId);
  console.log("    uploadUrl present:", Boolean(prepJson.uploadUrl));
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  process.exit(1);
});
