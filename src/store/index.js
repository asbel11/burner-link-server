const { openDatabase, resolveDatabaseFilePath } = require("./db");
const { createRoomRepository } = require("./roomRepository");
const { createDeviceMembershipStore } = require("../deviceMembership");

/**
 * @param {{ dbFilePath?: string }} [opts]
 */
function createRoomStore(opts = {}) {
  const dbFilePath = resolveDatabaseFilePath(opts.dbFilePath);

  const db = openDatabase(dbFilePath);
  const membership = createDeviceMembershipStore(db);
  const rooms = createRoomRepository(db, { membership });

  return {
    db,
    rooms,
    membership,
    /** Absolute path used for logs / ops */
    dbFilePath,
  };
}

module.exports = { createRoomStore };
