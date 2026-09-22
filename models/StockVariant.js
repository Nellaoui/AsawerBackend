const mongoose = require('mongoose');

const stockVariantSchema = new mongoose.Schema({
  canonicalReference: {
    type: String,
    required: true,
    trim: true
  },
  displayReference: {
    type: String,
    required: true,
    trim: true
  },
  productIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  }],
  primaryProductId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  printMethod: {
    type: String,
    enum: ['wax', 'resin'],
    required: true
  },
  size: {
    type: String,
    required: true,
    trim: true
  },
  sizeKey: {
    type: String,
    required: true,
    trim: true
  },
  onHandQuantity: {
    type: Number,
    min: 0,
    default: 0
  },
  reservedQuantity: {
    type: Number,
    min: 0,
    default: 0
  },
  // Last quantity read from the worksheet. Future sheet updates are applied as
  // a delta so fulfilled orders are not accidentally restored by a re-sync.
  sourceQuantity: {
    type: Number,
    min: 0,
    default: null
  },
  sourceSheet: {
    type: String,
    enum: ['Wax', 'Resin'],
    required: true
  },
  sourceRows: [{ type: Number, min: 1 }],
  notes: {
    type: String,
    trim: true,
    default: ''
  },
  lastSyncedAt: {
    type: Date,
    default: Date.now
  },
  syncBatchId: {
    type: String,
    trim: true,
    default: ''
  }
}, { timestamps: true });

stockVariantSchema.index(
  { canonicalReference: 1, printMethod: 1, sizeKey: 1 },
  { unique: true, name: 'unique_reference_method_size' }
);
stockVariantSchema.index({ productIds: 1, sizeKey: 1, printMethod: 1 });

stockVariantSchema.virtual('availableQuantity').get(function availableQuantity() {
  return Math.max(Number(this.onHandQuantity || 0) - Number(this.reservedQuantity || 0), 0);
});

stockVariantSchema.set('toJSON', { virtuals: true });
stockVariantSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('StockVariant', stockVariantSchema);
