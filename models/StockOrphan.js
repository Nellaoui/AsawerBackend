const mongoose = require('mongoose');

/**
 * A reference that appeared on a stock worksheet but has no product in the app.
 *
 * These are the rows an employee counted in the workshop that cannot be turned
 * into sellable stock yet, because nobody has created the product. The portal
 * lists them so someone can create the product and clear the row.
 */
const stockOrphanSchema = new mongoose.Schema({
  reference: {
    type: String,
    required: true,
    trim: true
  },
  // "sample" / "sirtie" / "" - the bucket column on the paper sheet.
  bucket: {
    type: String,
    trim: true,
    default: ''
  },
  // Free-form note from the Q-T column: M2, FRN, CA, Dig, cord...
  variant: {
    type: String,
    trim: true,
    default: ''
  },
  sizes: [{ type: String, trim: true }],
  units: {
    type: Number,
    min: 0,
    default: 0
  },
  sourceSheet: {
    type: String,
    trim: true,
    default: ''
  },
  sheetDate: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ['pending', 'resolved', 'ignored'],
    default: 'pending'
  },
  // Set once someone creates the product this row was waiting for.
  resolvedProductId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    default: null
  },
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  batchId: { type: String, trim: true, default: '' }
}, { timestamps: true });

stockOrphanSchema.index(
  { reference: 1, bucket: 1, variant: 1, sourceSheet: 1 },
  { unique: true, name: 'unique_orphan_row' }
);
stockOrphanSchema.index({ status: 1, units: -1 });

module.exports = mongoose.model('StockOrphan', stockOrphanSchema);
