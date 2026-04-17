const { openDatabase, resolveDatabaseFilePath } = require("./db");
const { createRoomRepository } = require("./roomRepository");
const { createCoinWalletRepository } = require("./coinWalletRepository");
const { createDeviceMembershipStore } = require("../deviceMembership");

/**
 * @param {{ dbFilePath?: string }} [opts]
 */
function createRoomStore(opts = {}) {
  const dbFilePath = resolveDatabaseFilePath(opts.dbFilePath);

  const db = openDatabase(dbFilePath);
  const membership = createDeviceMembershipStore(db);
  const rooms = createRoomRepository(db, { membership });
  const coins = createCoinWalletRepository(db);

  return {
    db,
    rooms,
    membership,
    coins,
    /** Absolute path used for logs / ops */
    dbFilePath,
  };
}

module.exports = { createRoomStore };
