const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  name: {
    type: String,
    required: true
  },
  size: {
    type: String,
    trim: true
  }
});

const orderSchema = new mongoose.Schema({
  userId: {
    // Mixed allows both ObjectId (real users) and string (test tokens)
    type: mongoose.Schema.Types.Mixed,
    ref: 'User',
    required: true
  },
  catalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Catalog',
    required: true
  },
  items: [orderItemSchema],
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'],
    default: 'pending'
  },
  totalAmount: {
    type: Number,
    required: true,
    min: 0
  },
  notes: {
    type: String,
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Pre-save middleware to update timestamps
orderSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Method to calculate total amount from items
orderSchema.methods.calculateTotal = function() {
  return this.items.reduce((total, item) => {
    return total + (item.price * item.quantity);
  }, 0);
};

// Method to get order summary
orderSchema.methods.getSummary = function() {
  return {
    orderId: this._id,
    totalItems: this.items.reduce((sum, item) => sum + item.quantity, 0),
    totalAmount: this.totalAmount,
    status: this.status,
    createdAt: this.createdAt
  };
};

// Static method to find orders by user
orderSchema.statics.findByUser = function(userId, options = {}) {
  const query = this.find({ userId });
  
  if (options.status) {
    query.where('status').equals(options.status);
  }
  
  if (options.limit) {
    query.limit(options.limit);
  }
  
  // Do NOT populate userId here, because userId may be a string (test token)
  return query
    .sort({ createdAt: -1 })
    .populate('catalogId', 'name')
    .populate('items.productId', 'name imageUrl size serialNumber');
};

// Static method for admin to find all orders with filtering
orderSchema.statics.findWithFilters = function(filters = {}, options = {}) {
  const query = this.find({});
  
  if (filters.status) {
    query.where('status').equals(filters.status);
  }
  
  if (filters.userId) {
    query.where('userId').equals(filters.userId);
  }
  
  if (filters.catalogId) {
    query.where('catalogId').equals(filters.catalogId);
  }
  
  if (filters.dateFrom) {
    query.where('createdAt').gte(filters.dateFrom);
  }
  
  if (filters.dateTo) {
    query.where('createdAt').lte(filters.dateTo);
  }
  
  const page = options.page || 1;
  const limit = options.limit || 20;
  const skip = (page - 1) * limit;
  
  return query
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('catalogId', 'name')
    .populate('items.productId', 'name imageUrl size serialNumber');
};

module.exports = mongoose.model('Order', orderSchema);
