const mongoose = require('mongoose');
const { CASE_STATUSES, CASE_TYPES, PRODUCTION_METHODS } = require('../utils/workflowRules');

const dimensionsSchema = new mongoose.Schema({
  width: { type: Number, min: 0, default: null },
  height: { type: Number, min: 0, default: null },
  depth: { type: Number, min: 0, default: null },
  length: { type: Number, min: 0, default: null },
  ringSize: { type: String, trim: true, default: '' },
  unit: { type: String, enum: ['mm'], default: 'mm' }
}, { _id: false });

const historySchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.Mixed, ref: 'User', required: true },
  action: { type: String, trim: true, required: true },
  fromStatus: { type: String, default: null },
  toStatus: { type: String, default: null },
  note: { type: String, trim: true, maxlength: 1000, default: '' },
  queueMinutes: { type: Number, min: 0, default: null },
  workMinutes: { type: Number, min: 0, default: null },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const modelVersionSchema = new mongoose.Schema({
  version: { type: Number, min: 1, required: true },
  fileName: { type: String, trim: true, maxlength: 200, required: true },
  fileUrl: { type: String, trim: true, maxlength: 2000, required: true },
  notes: { type: String, trim: true, maxlength: 1000, default: '' },
  dimensions: { type: dimensionsSchema, default: () => ({}) },
  uploadedBy: { type: mongoose.Schema.Types.Mixed, ref: 'User', required: true },
  isPrintReady: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const reprintPartSchema = new mongoose.Schema({
  code: { type: String, enum: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'], required: true },
  quantity: { type: Number, min: 1, max: 100000, required: true }
}, { _id: false });

const workflowCaseSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
  orderItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
  customerId: { type: mongoose.Schema.Types.Mixed, ref: 'User', default: null },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
  requestType: { type: String, enum: CASE_TYPES, required: true, index: true },
  requestedName: { type: String, trim: true, maxlength: 200, required: true },
  quantity: { type: Number, min: 1, required: true, default: 1 },
  status: { type: String, enum: CASE_STATUSES, required: true, default: 'needs_customer_info', index: true },
  assignedTeam: {
    type: String,
    enum: ['stock', 'customer_service', 'boss', 'wax_print', 'resin_print', 'quality', 'packing', 'none'],
    default: 'customer_service',
    index: true
  },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  taskKind: { type: String, enum: ['order', 'extra'], default: 'order', index: true },
  priority: { type: String, enum: ['low', 'normal', 'urgent'], default: 'normal', index: true },
  deadlineAt: { type: Date, default: null, index: true },
  targetMinutes: { type: Number, min: 1, max: 43200, default: 120 },
  stageQueuedAt: { type: Date, default: Date.now },
  assignedAt: { type: Date, default: null },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  isBlocked: { type: Boolean, default: false, index: true },
  archivedAt: { type: Date, default: null, index: true },
  archivedBy: { type: mongoose.Schema.Types.Mixed, ref: 'User', default: null },
  blockedReason: { type: String, trim: true, maxlength: 1000, default: '' },
  blockedAt: { type: Date, default: null },
  blockedBy: { type: mongoose.Schema.Types.Mixed, ref: 'User', default: null },
  customer: {
    name: { type: String, trim: true, maxlength: 160, default: '' },
    email: { type: String, trim: true, lowercase: true, maxlength: 320, default: '' },
    phone: { type: String, trim: true, maxlength: 60, default: '' }
  },
  requirements: { type: String, trim: true, maxlength: 4000, default: '' },
  referenceUrls: [{ type: String, trim: true, maxlength: 2000 }],
  dimensions: { type: dimensionsSchema, default: () => ({}) },
  productionMethod: { type: String, enum: PRODUCTION_METHODS, default: 'undecided' },
  quote: {
    amount: { type: Number, min: 0, default: null },
    currency: { type: String, trim: true, uppercase: true, maxlength: 3, default: 'MAD' },
    dueDate: { type: Date, default: null }
  },
  customerApproval: { type: String, enum: ['pending', 'approved', 'rejected', 'not_required'], default: 'pending' },
  customerApprovedAt: { type: Date, default: null },
  customerApprovedBy: { type: mongoose.Schema.Types.Mixed, ref: 'User', default: null },
  modelVersions: [modelVersionSchema],
  reprintParts: [reprintPartSchema],
  reprintReason: { type: String, trim: true, maxlength: 1000, default: '' },
  reprintRequestedAt: { type: Date, default: null },
  print: {
    machineId: { type: String, trim: true, maxlength: 120, default: '' },
    sentAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null }
  },
  createdBy: { type: mongoose.Schema.Types.Mixed, ref: 'User', required: true },
  history: [historySchema]
}, { timestamps: true });

workflowCaseSchema.index({ assignedTeam: 1, assignedTo: 1, status: 1, priority: -1, deadlineAt: 1, createdAt: 1 });
workflowCaseSchema.index({ orderId: 1, createdAt: 1 });
workflowCaseSchema.index({ customerId: 1, status: 1, createdAt: -1 });

workflowCaseSchema.pre('save', async function() {
  if (!this.isModified('history')) return;
  let previousCount = 0;
  if (!this.isNew) {
    const previous = await this.constructor.findById(this._id)
      .select('history._id')
      .session(this.$session() || null)
      .lean();
    previousCount = previous?.history?.length || 0;
  }
  this.$locals.newAuditHistory = this.history.slice(previousCount).map(entry => entry.toObject ? entry.toObject() : entry);
});

workflowCaseSchema.post('save', async function(workflowCase, next) {
  try {
    const entries = workflowCase.$locals.newAuditHistory || [];
    if (entries.length) {
      const AuditLog = require('./AuditLog');
      await AuditLog.create(entries.map(entry => ({
        category: 'workflow',
        action: entry.action,
        actorId: entry.actorId,
        entityType: 'workflow_case',
        entityId: String(workflowCase._id),
        orderId: workflowCase.orderId ? String(workflowCase.orderId) : null,
        details: {
          requestedName: workflowCase.requestedName,
          fromStatus: entry.fromStatus,
          toStatus: entry.toStatus,
          assignedTeam: workflowCase.assignedTeam,
          assignedTo: workflowCase.assignedTo ? String(workflowCase.assignedTo) : null,
          productionMethod: workflowCase.productionMethod,
          note: entry.note,
          queueMinutes: entry.queueMinutes,
          workMinutes: entry.workMinutes
        },
        createdAt: entry.createdAt || new Date()
      })), { session: workflowCase.$session() || undefined });
    }
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('WorkflowCase', workflowCaseSchema);
