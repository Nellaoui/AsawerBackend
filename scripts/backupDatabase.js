require('dotenv').config();
const mongoose = require('mongoose');
const { createDatabaseBackup } = require('../utils/backupService');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const backup = await createDatabaseBackup({ reason: 'manual' });
  console.log(JSON.stringify({
    status: backup.status,
    fileName: backup.fileName,
    documents: backup.documentCount,
    checksum: backup.checksum
  }));
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
