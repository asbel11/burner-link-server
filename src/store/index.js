const { openDatabase, resolveDatabaseFilePath } = require("./db");
const { createRoomRepository } = require("./roomRepository");
const { createCoinWalletRepository } = require("./coinWalletRepository");
const { createDeviceMembershipStore } = require("../deviceMembership");
const { createCallFreeAllowance } = require("../callFreeAllowance");

/**
 * @param {{ dbFilePath?: string }} [opts]
 */
function createRoomStore(opts = {}) {
  const dbFilePath = resolveDatabaseFilePath(opts.dbFilePath);

  const db = openDatabase(dbFilePath);
  const membership = createDeviceMembershipStore(db);
  const rooms = createRoomRepository(db, { membership });
  const coins = createCoinWalletRepository(db);
  const callFree = createCallFreeAllowance(db);

  return {
    db,
    rooms,
    membership,
    coins,
    callFree,
    /** Absolute path used for logs / ops */
    dbFilePath,
  };
}

module.exports = { createRoomStore };
