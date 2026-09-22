const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const BackupRun = require('../models/BackupRun');
const AuditLog = require('../models/AuditLog');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const backupDirectory = () => path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
const safeTimestamp = date => date.toISOString().replaceAll(':', '-').replaceAll('.', '-');

const createDatabaseBackup = async ({ reason = 'scheduled', actorId = null } = {}) => {
  if (mongoose.connection.readyState !== 1) throw new Error('Database is not connected');
  const startedAt = new Date();
  const run = await BackupRun.create({ status: 'running', startedAt });
  try {
    const collections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
    const snapshot = {
      format: 'asawer-mongodb-backup-v1',
      createdAt: startedAt,
      database: mongoose.connection.name,
      reason,
      collections: []
    };
    for (const { name } of collections.filter(item => !item.name.startsWith('system.')).sort((a, b) => a.name.localeCompare(b.name))) {
      const documents = await mongoose.connection.db.collection(name).find({}).toArray();
      snapshot.collections.push({ name, documents });
    }
    const encoded = Buffer.from(EJSON.stringify(snapshot, { relaxed: false }), 'utf8');
    const compressed = await gzip(encoded, { level: 9 });
    const directory = backupDirectory();
    await fs.mkdir(directory, { recursive: true });
    const fileName = `asawer-${safeTimestamp(startedAt)}.json.gz`;
    const finalPath = path.join(directory, fileName);
    const temporaryPath = `${finalPath}.tmp`;
    await fs.writeFile(temporaryPath, compressed, { flag: 'wx' });
    await fs.rename(temporaryPath, finalPath);
    const decoded = EJSON.parse((await gunzip(await fs.readFile(finalPath))).toString('utf8'));
    if (decoded.format !== snapshot.format || decoded.collections.length !== snapshot.collections.length) {
      throw new Error('Backup verification failed');
    }
    const completedAt = new Date();
    const checksum = crypto.createHash('sha256').update(compressed).digest('hex');
    run.status = 'completed';
    run.fileName = fileName;
    run.filePath = finalPath;
    run.bytes = compressed.length;
    run.collectionCount = snapshot.collections.length;
    run.documentCount = snapshot.collections.reduce((sum, item) => sum + item.documents.length, 0);
    run.checksum = checksum;
    run.completedAt = completedAt;
    await run.save();
    await AuditLog.create({
      category: 'backup', action: 'database_backup_completed', actorId,
      entityType: 'backup', entityId: String(run._id),
      details: { reason, fileName, checksum, bytes: compressed.length, collectionCount: run.collectionCount, documentCount: run.documentCount }
    });
    return run;
  } catch (error) {
    run.status = 'failed';
    run.error = String(error.message || error).slice(0, 2000);
    run.completedAt = new Date();
    await run.save().catch(() => {});
    throw error;
  }
};

let backupTimer = null;
const startBackupScheduler = () => {
  if (backupTimer || process.env.DISABLE_AUTOMATIC_BACKUPS === 'true') return;
  const hours = Math.max(Number(process.env.BACKUP_INTERVAL_HOURS || 24), 1);
  const intervalMs = hours * 60 * 60 * 1000;
  const run = () => createDatabaseBackup({ reason: 'scheduled' }).catch(error => console.error('Automatic database backup failed:', error));
  backupTimer = setInterval(run, intervalMs);
  backupTimer.unref?.();
};

module.exports = { backupDirectory, createDatabaseBackup, startBackupScheduler };
