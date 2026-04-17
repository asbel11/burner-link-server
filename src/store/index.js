const { openDatabase, resolveDatabaseFilePath } = require("./db");
const { createRoomRepository } = require("./roomRepository");
const { createAttachmentRepository } = require("./attachmentRepository");
const { createCoinWalletRepository } = require("./coinWalletRepository");
const { createDeviceMembershipStore } = require("../deviceMembership");
const { createCallFreeAllowance } = require("../callFreeAllowance");
const {
  createS3ClientFromEnv,
  createAttachmentObjectStorage,
} = require("../attachments/s3AttachmentStorage");

/**
 * @param {{ dbFilePath?: string }} [opts]
 */
function createRoomStore(opts = {}) {
  const dbFilePath = resolveDatabaseFilePath(opts.dbFilePath);

  const db = openDatabase(dbFilePath);
  const membership = createDeviceMembershipStore(db);
  const attachments = createAttachmentRepository(db);
  const rooms = createRoomRepository(db, { membership, attachments });
  const coins = createCoinWalletRepository(db);
  const callFree = createCallFreeAllowance(db);

  const s3cfg = createS3ClientFromEnv();
  const attachmentStorage = s3cfg
    ? createAttachmentObjectStorage(s3cfg)
    : null;

  return {
    db,
    rooms,
    membership,
    attachments,
    attachmentStorage,
    coins,
    callFree,
    /** Absolute path used for logs / ops */
    dbFilePath,
  };
}

module.exports = { createRoomStore };
