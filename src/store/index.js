const { openDatabase, resolveDatabaseFilePath } = require("./db");
const { createRoomRepository } = require("./roomRepository");

/**
 * @param {{ dbFilePath?: string }} [opts]
 */
function createRoomStore(opts = {}) {
  const dbFilePath = resolveDatabaseFilePath(opts.dbFilePath);

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
