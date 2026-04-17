#!/usr/bin/env node
/**
 * Phase Group-Deploy-Verify-1: confirm deployed API returns GET /v2/meta with group-room create advertised.
 *
 * Usage:
 *   CONNECT_API_BASE=https://your-service.up.railway.app node scripts/verify-v2-meta.js
 *   node scripts/verify-v2-meta.js https://your-service.up.railway.app
 *
 * Exit 0 = OK; 1 = check failed; 2 = bad usage.
 */

const path = require("path");
try {
  require("dotenv").config({
    path: path.join(__dirname, "..", ".env"),
  });
} catch (_) {
  /* dotenv optional */
}

const baseRaw =
  process.argv[2] ||
  process.env.CONNECT_API_BASE ||
  process.env.API_BASE ||
  "";

function usage() {
  console.error(
    "Set CONNECT_API_BASE or pass the API origin as the first argument, e.g.\n" +
      "  CONNECT_API_BASE=https://xxx.up.railway.app node scripts/verify-v2-meta.js\n" +
      "  node scripts/verify-v2-meta.js https://xxx.up.railway.app"
  );
}

if (!baseRaw || String(baseRaw).trim() === "") {
  usage();
  process.exit(2);
}

let url;
try {
  const u = new URL(baseRaw.trim());
  if (!/^https?:$/i.test(u.protocol)) {
    throw new Error("URL must be http or https");
  }
  u.pathname = "/v2/meta";
  u.search = "";
  u.hash = "";
  url = u.href;
} catch (e) {
  console.error("Invalid URL:", baseRaw, e.message || e);
  usage();
  process.exit(2);
}

async function main() {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (res.status !== 200) {
    console.error(`FAIL: GET ${url} → HTTP ${res.status}`);
    console.error(text.slice(0, 500));
    process.exit(1);
  }

  const available = body?.connect?.postGroupRoomCreate?.available;
  const pathOk =
    body?.connect?.postGroupRoomCreate?.path === "/v2/rooms/create";

  if (available !== true || !pathOk) {
    console.error("FAIL: unexpected JSON shape. Expected connect.postGroupRoomCreate.{ available: true, path: '/v2/rooms/create' }");
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(`OK: GET /v2/meta → 200`);
  console.log(`  service: ${body.service}`);
  console.log(`  version: ${body.version}`);
  console.log(`  connect.postGroupRoomCreate:`, body.connect.postGroupRoomCreate);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  process.exit(1);
});
