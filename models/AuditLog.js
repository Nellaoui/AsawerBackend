const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  category: { type: String, enum: ['inventory', 'workflow', 'machine', 'backup', 'system'], required: true, index: true },
  action: { type: String, required: true, trim: true, maxlength: 120, index: true },
  actorId: { type: mongoose.Schema.Types.Mixed, ref: 'User', default: null, index: true },
  entityType: { type: String, required: true, trim: true, maxlength: 80 },
  entityId: { type: String, required: true, trim: true, maxlength: 160, index: true },
  orderId: { type: String, default: null, index: true },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, immutable: true, index: true }
}, { versionKey: false });

auditLogSchema.index({ category: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

const rejectMutation = next => next(new Error('Audit records are append-only'));
auditLogSchema.pre('updateOne', rejectMutation);
auditLogSchema.pre('updateMany', rejectMutation);
auditLogSchema.pre('findOneAndUpdate', rejectMutation);
auditLogSchema.pre('deleteOne', rejectMutation);
auditLogSchema.pre('deleteMany', rejectMutation);
auditLogSchema.pre('findOneAndDelete', rejectMutation);

module.exports = mongoose.model('AuditLog', auditLogSchema);
