const mongoose = require('mongoose');

const backupRunSchema = new mongoose.Schema({
  status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running', index: true },
  fileName: { type: String, default: '', maxlength: 300 },
  filePath: { type: String, default: '', maxlength: 2000 },
  collectionCount: { type: Number, default: 0, min: 0 },
  documentCount: { type: Number, default: 0, min: 0 },
  bytes: { type: Number, default: 0, min: 0 },
  checksum: { type: String, default: '', maxlength: 128 },
  error: { type: String, default: '', maxlength: 2000 },
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null, index: true }
}, { versionKey: false });

backupRunSchema.index({ status: 1, completedAt: -1 });

module.exports = mongoose.model('BackupRun', backupRunSchema);
