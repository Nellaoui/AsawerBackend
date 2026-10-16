const mongoose = require('mongoose');

const PLATE_STATUSES = ['open', 'printing', 'finished', 'failed', 'cancelled'];

// One numbered build plate (wax or resin); it may hold products of several orders. The products on it are the workflow
// cases whose print.plateId points here, so there is no second list to keep in step.
const plateSchema = new mongoose.Schema({
  number: { type: Number, required: true, unique: true, min: 1 },
  productionMethod: { type: String, enum: ['wax', 'resin'], required: true },
  status: { type: String, enum: PLATE_STATUSES, default: 'open', index: true },
  machineCode: { type: String, trim: true, maxlength: 120, default: '' },
  createdBy: { type: mongoose.Schema.Types.Mixed, ref: 'User', default: null },
  // The wax employee whose plate it is. Empty on older plates and on resin plates, which any staff of the method can use.
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  sentAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  failedReason: { type: String, trim: true, maxlength: 1000, default: '' }
}, { timestamps: true });

plateSchema.index({ productionMethod: 1, status: 1 });

module.exports = mongoose.model('Plate', plateSchema);
module.exports.PLATE_STATUSES = PLATE_STATUSES;
