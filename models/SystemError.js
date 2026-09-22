const mongoose = require('mongoose');

const systemErrorSchema = new mongoose.Schema({
  fingerprint: { type: String, required: true, index: true },
  message: { type: String, required: true, maxlength: 2000 },
  stack: { type: String, default: '', maxlength: 12000 },
  source: { type: String, default: 'application', maxlength: 200, index: true },
  method: { type: String, default: '', maxlength: 20 },
  path: { type: String, default: '', maxlength: 500 },
  actorId: { type: mongoose.Schema.Types.Mixed, ref: 'User', default: null },
  statusCode: { type: Number, default: 500, index: true },
  occurrences: { type: Number, min: 1, default: 1 },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now, index: true },
  resolvedAt: { type: Date, default: null, index: true }
}, { versionKey: false });

systemErrorSchema.index({ resolvedAt: 1, lastSeenAt: -1 });

module.exports = mongoose.model('SystemError', systemErrorSchema);
