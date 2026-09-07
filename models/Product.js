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
  relatedProducts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  }],
  catalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Catalog',
    required: true
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

// Update the updatedAt field before saving
productSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Product', productSchema);
