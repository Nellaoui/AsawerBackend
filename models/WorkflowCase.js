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

module.exports = mongoose.model('WorkflowCase', workflowCaseSchema);
