const path = require("path");
const { openDatabase } = require("./db");
const { createRoomRepository } = require("./roomRepository");

/**
 * @param {{ dbFilePath?: string }} [opts]
 */
function createRoomStore(opts = {}) {
  const dbFilePath =
    opts.dbFilePath ||
    process.env.DATABASE_PATH ||
    path.join(process.cwd(), "data", "burner-link.db");

  const db = openDatabase(dbFilePath);
  const rooms = createRoomRepository(db);

  return {
    db,
    rooms,
    /** Absolute path used for logs / ops */
    dbFilePath,
  };
}

module.exports = { createRoomStore };
