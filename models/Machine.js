const mongoose = require('mongoose');

const MACHINE_STATUSES = ['unknown', 'offline', 'available', 'busy', 'failed', 'maintenance'];
const PRODUCTION_METHODS = ['wax', 'resin'];

const machineSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true, maxlength: 40, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  manufacturer: { type: String, required: true, trim: true, maxlength: 120 },
  model: { type: String, required: true, trim: true, maxlength: 120 },
  serialNumber: { type: String, required: true, unique: true, trim: true, maxlength: 120, index: true },
  macAddress: { type: String, trim: true, uppercase: true, maxlength: 32, default: '' },
  ipAddress: { type: String, required: true, trim: true, maxlength: 64, index: true },
  subnetMask: { type: String, trim: true, maxlength: 64, default: '255.255.255.0' },
  gateway: { type: String, trim: true, maxlength: 64, default: '192.168.1.1' },
  productionMethod: { type: String, enum: PRODUCTION_METHODS, required: true, index: true },
  status: { type: String, enum: MACHINE_STATUSES, default: 'unknown', index: true },
  statusReason: { type: String, trim: true, maxlength: 1000, default: '' },
  statusSource: { type: String, enum: ['manual', 'connector'], default: 'manual' },
  networkStatus: { type: String, enum: ['unknown', 'online', 'offline'], default: 'unknown', index: true },
  currentCaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkflowCase', default: null, index: true },
  lastCheckedAt: { type: Date, default: null, index: true },
  lastSeenAt: { type: Date, default: null, index: true },
  lastStatusChangedAt: { type: Date, default: Date.now },
  enabled: { type: Boolean, default: true, index: true },
  software: { type: mongoose.Schema.Types.Mixed, default: {} },
  notes: { type: String, trim: true, maxlength: 2000, default: '' },
  updatedBy: { type: mongoose.Schema.Types.Mixed, ref: 'User', default: null }
}, { timestamps: true });

machineSchema.index({ productionMethod: 1, status: 1, name: 1 });

module.exports = mongoose.model('Machine', machineSchema);
module.exports.MACHINE_STATUSES = MACHINE_STATUSES;
module.exports.PRODUCTION_METHODS = PRODUCTION_METHODS;
