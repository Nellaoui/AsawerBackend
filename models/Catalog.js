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
    type: mongoose.Schema.Types.Mixed,
    ref: 'User',
    required: true
  },
  allowedUserIds: [{
    type: mongoose.Schema.Types.Mixed,
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

// Helper to normalize possible Mixed values (ObjectId | string | {_id}) to string
function toIdString(val) {
  if (val == null) return '';
  if (typeof val === 'object') {
    if (val._id) return val._id.toString();
    // If somehow a populated user object was stored, try id or _id
    if (val.id) return val.id.toString();
  }
  return val.toString();
}

// Method to check if user has access to this catalog
catalogSchema.methods.hasUserAccess = function(userId) {
  const uid = userId?.toString();
  const owner = toIdString(this.ownerId);

  // Owner always has access
  if (owner && uid && owner === uid) {
    return true;
  }
  
  // Public catalogs are accessible to all
  if (this.isPublic) {
    return true;
  }
  
  // Check if user is in allowed list
  return (this.allowedUserIds || []).some(allowedId => 
    toIdString(allowedId) === uid
  );
};

// Method to check if user can edit this catalog
catalogSchema.methods.canUserEdit = function(userId, userRole) {
  // Admin can edit any catalog
  if (userRole === 'admin') {
    return true;
  }
  
  // Owner can edit their catalog
  return toIdString(this.ownerId) === userId?.toString();
};

// Static method to find catalogs accessible by user
catalogSchema.statics.findAccessibleByUser = function(userId, userRole) {
  if (userRole === 'admin') {
    // Admin can see all catalogs
    return this.find({});
  }

  const uid = userId?.toString();
  const isObjId = mongoose.Types.ObjectId.isValid(uid);
  const oid = isObjId ? new mongoose.Types.ObjectId(uid) : null;

  const orConds = [
    { isPublic: true },
    { ownerId: uid },
    { allowedUserIds: uid },
    { 'ownerId._id': uid },
    { 'allowedUserIds._id': uid },
  ];
  if (oid) {
    orConds.push({ ownerId: oid });
    orConds.push({ allowedUserIds: oid });
    orConds.push({ 'ownerId._id': oid });
    orConds.push({ 'allowedUserIds._id': oid });
  }

  return this.find({ $or: orConds });
};

module.exports = mongoose.model('Catalog', catalogSchema);
