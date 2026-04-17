const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const LOG_PREFIX = "[burner-link db]";

const DEFAULT_DB_FILENAME = "burner-link.db";

/**
 * Turn a path (env or explicit) into a concrete SQLite **file** path.
 * - If it points to an **existing directory** → `{dir}/burner-link.db`
 * - If it points to an **existing file** → use as-is
 * - If it does not exist yet: trailing slash → directory; basename ends with `.db` / `.sqlite` → file; basename has no `.` → directory; otherwise treat as a file path
 *
 * @param {string} rawInput
 * @param {string} cwd
 * @returns {string}
 */
function resolveDatabaseFileFromInput(rawInput, cwd) {
  const trimmed = String(rawInput).trim();
  if (trimmed === "") {
    return path.resolve(cwd, "data", DEFAULT_DB_FILENAME);
  }

  const resolved = path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.resolve(cwd, trimmed);

  let st = null;
  try {
    if (fs.existsSync(resolved)) {
      st = fs.statSync(resolved);
    }
  } catch {
    st = null;
  }

  if (st && st.isDirectory()) {
    return path.join(resolved, DEFAULT_DB_FILENAME);
  }
  if (st && st.isFile()) {
    return resolved;
  }

  if (/[/\\]$/.test(trimmed)) {
    const dirOnly = resolved.replace(/[/\\]+$/, "");
    return path.join(dirOnly, DEFAULT_DB_FILENAME);
  }

  const base = path.basename(resolved);
  if (/\.db$/i.test(base) || /\.sqlite3?$/i.test(base)) {
    return resolved;
  }

  if (!base.includes(".")) {
    return path.join(resolved, DEFAULT_DB_FILENAME);
  }

  return resolved;
}

/**
 * Resolve SQLite file path for local + Railway (and tests via explicitPath).
 * Priority: explicitPath (tests) → DATABASE_PATH → data/burner-link.db under cwd.
 *
 * @param {string|undefined} [explicitPath]
 * @returns {string}
 */
function resolveDatabaseFilePath(explicitPath) {
  const cwd = process.cwd();
  if (explicitPath != null && String(explicitPath).trim() !== "") {
    return resolveDatabaseFileFromInput(String(explicitPath), cwd);
  }
  const env = process.env.DATABASE_PATH;
  if (env != null && String(env).trim() !== "") {
    return resolveDatabaseFileFromInput(String(env), cwd);
  }
  return path.resolve(cwd, "data", DEFAULT_DB_FILENAME);
}

/**
 * @param {string} absDir normalized absolute directory
 */
function isUnderDataMount(absDir) {
  const n = path.normalize(absDir);
  return n === "/data" || n.startsWith("/data/");
}

/**
 * @param {string} dir absolute directory path
 */
function assertDirectoryWritable(dir) {
  const testFile = path.join(
    dir,
    `.burner-link-write-test-${process.pid}-${Date.now()}`
  );
  try {
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
  } catch (err) {
    const railwayHint = isUnderDataMount(dir)
      ? " On Railway, attach a persistent volume mounted at /data (or choose a path under the app directory that is writable)."
      : " Ensure the process user can create files in this directory.";
    const msg = `${LOG_PREFIX} Directory is not writable: ${dir}.${railwayHint} (${err.code || err.name}: ${err.message})`;
    throw new Error(msg);
  }
}

/**
 * Opens SQLite and applies the CONNECT-oriented room schema.
 * `rooms.id` is the only chat id — same as V1 `sessionId` and V2 `roomId` (see docs/v1-v2-id-contract.md).
 */
function openDatabase(dbFilePath) {
  const resolvedPath = path.resolve(dbFilePath);
  const parentDir = path.dirname(resolvedPath);

  const existsBeforeMkdir = fs.existsSync(parentDir);
  console.error(
    `${LOG_PREFIX} startup: cwd=${JSON.stringify(process.cwd())} DATABASE_PATH=${JSON.stringify(process.env.DATABASE_PATH ?? "")} resolvedFile=${JSON.stringify(resolvedPath)} parentDir=${JSON.stringify(parentDir)} existsSync(parentDir)_before_mkdir=${existsBeforeMkdir}`
  );

  try {
    fs.mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    const railwayHint = isUnderDataMount(parentDir)
      ? " On Railway, add a volume mounted at /data (Dashboard → your service → Volumes) and set DATABASE_PATH=/data/burner-link.db, or use a path your user can create (e.g. under the app root)."
      : "";
    throw new Error(
      `${LOG_PREFIX} Could not create database directory ${JSON.stringify(parentDir)}:${railwayHint} (${err.code || err.name}: ${err.message})`
    );
  }

  const existsAfterMkdir = fs.existsSync(parentDir);
  console.error(
    `${LOG_PREFIX} after mkdirSync: existsSync(parentDir)=${existsAfterMkdir}`
  );

  try {
    assertDirectoryWritable(parentDir);
  } catch (err) {
    if (isUnderDataMount(parentDir)) {
      console.error(
        `${LOG_PREFIX} If using /data without a volume, the default Linux filesystem may not allow writing there. Mount a Railway volume at /data or set DATABASE_PATH to a writable path.`
      );
    }
    throw err;
  }

  let db;
  try {
    db = new Database(resolvedPath);
  } catch (err) {
    const railwayHint = isUnderDataMount(parentDir)
      ? " Often caused by a missing or read-only /data volume on Railway. Mount a volume at /data or use e.g. DATABASE_PATH relative to the app."
      : "";
    throw new Error(
      `${LOG_PREFIX} SQLite failed to open ${JSON.stringify(resolvedPath)}:${railwayHint} (${err.code || err.name}: ${err.message})`
    );
  }

  try {
    db.pragma("journal_mode = WAL");
  } catch (err) {
    db.close();
    throw new Error(
      `${LOG_PREFIX} WAL mode failed (directory must be writable for -wal/-shm files): ${err.message}`
    );
  }
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      invite_code TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'ended')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER,
      deleted_at INTEGER,
      last_message_at INTEGER,
      schema_version INTEGER NOT NULL DEFAULT 1,
      retention_tier TEXT,
      retention_until INTEGER,
      retention_source TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rooms_invite_code
      ON rooms (invite_code);

    CREATE INDEX IF NOT EXISTS idx_rooms_state_updated
      ON rooms (state, updated_at);

    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      PRIMARY KEY (room_id, device_id),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS room_messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      msg_type TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      file_name TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_room_messages_room
      ON room_messages (room_id, created_at);

    -- CONNECT list: survives V1 burn (room_members cleared). One row per device that
    -- ever joined/created/heartbeat-touched while the room existed.
    CREATE TABLE IF NOT EXISTS device_room_links (
      room_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      linked_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, device_id),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_device_room_links_device
      ON device_room_links (device_id);

    CREATE INDEX IF NOT EXISTS idx_device_room_links_room
      ON device_room_links (room_id);
  `);

  migrateRoomsRetention(db);
  migrateRetentionPurchasesIdempotency(db);
  migrateDeviceMembership(db);
  migrateCoinWallet(db);
  migrateCallFreeAllowance(db);
  migrateMutualSave(db);
  migrateRoomMemberLiveChatPresence(db);

  // Best-effort backfill for DBs created before device_room_links existed.
  db.exec(`
    INSERT OR IGNORE INTO device_room_links (room_id, device_id, linked_at)
    SELECT room_id, device_id, joined_at FROM room_members;
  `);

  return db;
}

/**
 * Phase 17 — room-level retention columns + audit table (no payment integration yet).
 */
function migrateRoomsRetention(db) {
  const cols = db.prepare(`PRAGMA table_info(rooms)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("retention_until")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN retention_until INTEGER`);
  }
  if (!names.has("retention_source")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN retention_source TEXT`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS retention_purchases (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      tier TEXT NOT NULL,
      retention_until INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',
      note TEXT,
      external_ref TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_retention_purchases_room
      ON retention_purchases (room_id);
    CREATE INDEX IF NOT EXISTS idx_retention_purchases_created
      ON retention_purchases (created_at);
  `);

  db.exec(`
    UPDATE rooms SET retention_tier = 'default' WHERE retention_tier IS NULL;
    UPDATE rooms SET retention_source = 'server_default' WHERE retention_source IS NULL;
  `);
}

/**
 * Phase 20 — idempotent billing events: (idempotency_provider, idempotency_key) unique when key set.
 */
function migrateRetentionPurchasesIdempotency(db) {
  const cols = db.prepare(`PRAGMA table_info(retention_purchases)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("idempotency_provider")) {
    db.exec(`ALTER TABLE retention_purchases ADD COLUMN idempotency_provider TEXT`);
  }
  if (!names.has("idempotency_key")) {
    db.exec(`ALTER TABLE retention_purchases ADD COLUMN idempotency_key TEXT`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_purchases_idempotent
      ON retention_purchases (idempotency_provider, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);
}

/**
 * Phase M2 — CONNECT membership (Stripe subscription) keyed by device_id; billing identity stays server-side.
 */
/**
 * Phase Room-Save-1A — server truth for mutual “save room” (1:1), optional client UX later.
 * @see docs/v2-mutual-save.md
 */
function migrateMutualSave(db) {
  const cols = db.prepare(`PRAGMA table_info(rooms)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("save_state")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN save_state TEXT NOT NULL DEFAULT 'none'`);
  }
  if (!names.has("save_requested_by_device_id")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN save_requested_by_device_id TEXT`);
  }
  if (!names.has("save_requested_at")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN save_requested_at INTEGER`);
  }
  if (!names.has("save_responded_at")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN save_responded_at INTEGER`);
  }
  if (!names.has("save_pending_expires_at")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN save_pending_expires_at INTEGER`);
  }
  db.exec(`
    UPDATE rooms SET save_state = 'none' WHERE save_state IS NULL OR save_state = '';
  `);
}

/**
 * Phase Room-Save-1D — explicit “left live chat UI” without ending the room (`POST /v2/rooms/:id/leave`).
 * @see docs/v2-room-live-chat-leave.md
 */
function migrateRoomMemberLiveChatPresence(db) {
  const cols = db.prepare(`PRAGMA table_info(room_members)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("last_live_chat_left_at")) {
    db.exec(
      `ALTER TABLE room_members ADD COLUMN last_live_chat_left_at INTEGER`
    );
  }
}

function migrateDeviceMembership(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_memberships (
      device_id TEXT PRIMARY KEY,
      membership_tier TEXT NOT NULL DEFAULT 'pro',
      membership_active_until INTEGER,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_device_memberships_subscription
      ON device_memberships (stripe_subscription_id);
    CREATE TABLE IF NOT EXISTS membership_stripe_events (
      event_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

/**
 * Phase Coins-2 — prepaid coin wallet + append-only ledger (`deviceId`-bound).
 * @see docs/connect-coins-wallet-design.md
 */
/**
 * Daily free call seconds per device (UTC calendar day). Billing consumes here before coins.
 * @see docs/connect-call-free-allowance.md
 */
function migrateCallFreeAllowance(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_daily_call_free_usage (
      device_id TEXT NOT NULL,
      usage_utc_date TEXT NOT NULL,
      free_seconds_used INTEGER NOT NULL DEFAULT 0 CHECK (free_seconds_used >= 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (device_id, usage_utc_date)
    );
    CREATE INDEX IF NOT EXISTS idx_call_free_device_date
      ON device_daily_call_free_usage (device_id, usage_utc_date);
  `);
}

function migrateCoinWallet(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_coin_wallets (
      device_id TEXT PRIMARY KEY,
      available_coins INTEGER NOT NULL DEFAULT 0 CHECK (available_coins >= 0),
      reserved_coins INTEGER NOT NULL DEFAULT 0 CHECK (reserved_coins >= 0),
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      CHECK (reserved_coins <= available_coins)
    );
    CREATE TABLE IF NOT EXISTS coin_ledger_entries (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delta_coins INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      entry_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      pack_id TEXT,
      stripe_checkout_session_id TEXT,
      stripe_payment_intent_id TEXT,
      external_reference TEXT,
      metadata_json TEXT,
      FOREIGN KEY (device_id) REFERENCES device_coin_wallets(device_id),
      UNIQUE (idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_coin_ledger_device_created
      ON coin_ledger_entries (device_id, created_at DESC);
  `);
}

module.exports = {
  openDatabase,
  resolveDatabaseFilePath,
  resolveDatabaseFileFromInput,
};
