const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

/**
 * Opens SQLite and applies the CONNECT-oriented room schema.
 * `rooms.id` is the only chat id — same as V1 `sessionId` and V2 `roomId` (see docs/v1-v2-id-contract.md).
 */
function openDatabase(dbFilePath) {
  const dir = path.dirname(dbFilePath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbFilePath);
  db.pragma("journal_mode = WAL");
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

module.exports = { openDatabase };
