const mongoose = require('mongoose');

const catalogSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  allowedUserIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  isPublic: {
    type: Boolean,
    default: true // Default to public so users can see catalogs
  },
  products: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
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

// Pre-save middleware to update timestamps
catalogSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Method to check if user has access to this catalog
catalogSchema.methods.hasUserAccess = function(userId) {
  // Owner always has access
  if (this.ownerId.toString() === userId.toString()) {
    return true;
  }
  
  // Public catalogs are accessible to all
  if (this.isPublic) {
    return true;
  }
  
  // Check if user is in allowed list
  return this.allowedUserIds.some(allowedId => 
    allowedId.toString() === userId.toString()
  );
};

// Method to check if user can edit this catalog
catalogSchema.methods.canUserEdit = function(userId, userRole) {
  // Admin can edit any catalog
  if (userRole === 'admin') {
    return true;
  }
  
  // Owner can edit their catalog
  return this.ownerId.toString() === userId.toString();
};

// Static method to find catalogs accessible by user
catalogSchema.statics.findAccessibleByUser = function(userId, userRole) {
  if (userRole === 'admin') {
    // Admin can see all catalogs
    return this.find({});
  }
  
  return this.find({
    $or: [
      { ownerId: userId },
      { isPublic: true },
      { allowedUserIds: userId }
    ]
  });
};

module.exports = mongoose.model('Catalog', catalogSchema);
