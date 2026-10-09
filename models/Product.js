const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  type: {
    type: String,
    required: true,
    trim: true
  },
  serialNumber: {
    type: String,
    required: true,
    trim: true
  },
  imageUrl: {
    type: String,
    default: 'https://via.placeholder.com/150'
  },
  price: {
    type: Number,
    required: false,
    min: 0,
    default: 0
  },
  canonicalReference: {
    type: String,
    trim: true,
    default: ''
  },
  // Set when this product was folded into another one because the two were the
  // same piece written differently. Kept rather than deleted so an old order
  // still resolves and the merge can be traced.
  mergedInto: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    default: null
  },
  // Set from the portal "Remove from shop" button. The product stays in old
  // orders but customers never see it; isActive is kept false alongside it.
  removedFromShop: {
    type: Boolean,
    default: false
  },
  stockSyncState: {
    type: String,
    enum: ['manual', 'synced', 'needs_details'],
    default: 'manual'
  },
  // `stock` is the quantity currently available to promise to customers.
  // New orders move units from stock to reservedStock until they ship or cancel.
  stock: {
    type: Number,
    min: 0,
    default: 0
  },
  reservedStock: {
    type: Number,
    min: 0,
    default: 0
  },
  lowStockThreshold: {
    type: Number,
    min: 0,
    default: 2
  },
  stockLocation: {
    type: String,
    trim: true,
    default: ''
  },
  fulfillmentPolicy: {
    type: String,
    enum: ['stock_only', 'print_on_demand', 'stock_then_print'],
    default: 'stock_then_print'
  },
  printMethod: {
    type: String,
    enum: ['none', 'wax', 'resin'],
    default: 'none'
  },
  modelFileStatus: {
    type: String,
    enum: ['missing', 'draft', 'print_ready'],
    default: 'missing'
  },
  modelFileName: {
    type: String,
    trim: true,
    default: ''
  },
  modelFileUrl: {
    type: String,
    trim: true,
    default: ''
  },
  modelVersion: {
    type: Number,
    min: 0,
    default: 0
  },
  weight: {
    type: Number,
    min: 0,
    default: 0
  },
  showWeight: {
    type: Boolean,
    default: false
  },
  height: {
    type: Number,
    min: 0,
    default: 0
  },
  showHeight: {
    type: Boolean,
    default: false
  },
  size: {
    type: String,
    trim: true,
    default: null
  },
  availableSizes: [{
    type: String,
    trim: true
  }],
  availableHeights: [{
    type: String,
    trim: true
  }],
  clasp: {
    type: String,
    trim: true,
    default: null
  },
  // Clasps a customer may choose for a gourmette or collier. Empty means
  // every clasp type is offered.
  availableClasps: [{
    type: String,
    trim: true
  }],
  // Sartla only: which bracelets make the set for each count the customer can
  // pick (3, 5 or 7). A count with no list is not offered. `price` 0 means the
  // product price. See utils/sartla.js.
  sartlaSets: [{
    _id: false,
    count: { type: Number, enum: [3, 5, 7], required: true },
    price: { type: Number, min: 0, default: 0 },
    bracelets: [{
      _id: false,
      productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
      reference: { type: String, trim: true, default: '' },
      quantity: { type: Number, min: 1, required: true }
    }]
  }],
  relatedProducts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  }],
  catalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Catalog',
    required: true
  },
  // Raised from the portal when somebody notices a product is wrong or
  // incomplete - a missing photo, the wrong size range, a bad reference.
  // Customer service can raise one without being able to edit the product.
  setupIssue: {
    open: { type: Boolean, default: false },
    note: { type: String, trim: true, default: '' },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reportedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.Mixed,
    ref: 'User',
    required: true
  },
  // Users who can access this product
  accessibleTo: [{
    type: mongoose.Schema.Types.Mixed,
    ref: 'User'
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

productSchema.index({ stock: 1, isActive: 1 });
productSchema.index({ serialNumber: 1 });
productSchema.index({ canonicalReference: 1 });

// Update the updatedAt field before saving
productSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Product', productSchema);
