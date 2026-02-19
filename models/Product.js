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

// Update the updatedAt field before saving
productSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Product', productSchema);