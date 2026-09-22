require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const { createDatabaseBackup } = require('../utils/backupService');

const gunzip = promisify(zlib.gunzip);

async function main() {
  const backupPath = process.argv[2] ? path.resolve(process.argv[2]) : '';
  const confirmed = process.argv.includes('--confirm-restore');
  if (!backupPath || !confirmed) {
    throw new Error('Usage: node scripts/restoreBackup.js <backup.json.gz> --confirm-restore');
  }
  const snapshot = EJSON.parse((await gunzip(await fs.readFile(backupPath))).toString('utf8'));
  if (snapshot.format !== 'asawer-mongodb-backup-v1' || !Array.isArray(snapshot.collections)) {
    throw new Error('Unsupported or invalid backup file');
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const safetyBackup = await createDatabaseBackup({ reason: 'before_restore' });
  console.log(`Safety backup created: ${safetyBackup.fileName}`);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const collection of snapshot.collections) {
        if (!collection?.name || !Array.isArray(collection.documents) || collection.name.startsWith('system.')) continue;
        const target = mongoose.connection.db.collection(collection.name);
        await target.deleteMany({}, { session });
        if (collection.documents.length) await target.insertMany(collection.documents, { ordered: true, session });
      }
    });
  } finally {
    await session.endSession();
  }
  console.log(`Restore completed from ${path.basename(backupPath)}`);
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
