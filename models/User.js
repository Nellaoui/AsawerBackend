const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    required: false,
    trim: true,
    default: ''
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  role: {
    type: String,
    enum: ['user', 'employee', 'admin'],
    default: 'user'
  },
  workRole: {
    type: String,
    enum: ['general', 'stock', 'customer_service', 'boss', 'wax_print', 'resin_print', 'quality', 'packing'],
    default: 'general'
  },
  forcedProductionMethod: {
    type: String,
    enum: ['automatic', 'wax', 'resin'],
    default: 'automatic'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // Trusted customers the tablet admin chose to keep out of the customer tablet
  // picker; their account cannot be opened from the shop tablet.
  hiddenFromTablet: {
    type: Boolean,
    default: false
  },
  expoPushTokens: [{
    type: String,
    trim: true
  }],
  // One phone per customer account. The first phone that signs in is kept
  // here; another phone needs an approved phone change request.
  boundDeviceId: { type: String, trim: true, default: '' },
  boundDeviceName: { type: String, trim: true, default: '' },
  boundDeviceAt: { type: Date },
  // Staff accounts the owner allowed to approve customers' phone changes.
  canApprovePhoneChanges: { type: Boolean, default: false },
  // Customer activity: last time the app was used and how many visits.
  lastSeenAt: { type: Date },
  visitCount: { type: Number, default: 0 },
  // The start of the quiet period (last order, or sign-up) already reported
  // to the owner, so each customer is reported once per quiet period.
  inactivityReportedFor: { type: Date },
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Sync role field with isAdmin field for consistency
userSchema.pre('save', function(next) {
  // Keep the legacy isAdmin flag compatible while preserving employee accounts.
  if (this.isAdmin) {
    this.role = 'admin';
  } else if (this.role !== 'employee') {
    this.role = 'user';
  }
  next();
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password (supports both hashed and legacy plain-text)
userSchema.methods.comparePassword = async function(candidatePassword) {
  // If stored password looks like a bcrypt hash
  if (this.password && this.password.startsWith('$2')) {
    return bcrypt.compare(candidatePassword, this.password);
  }
  // Legacy plain-text comparison
  return candidatePassword === this.password;
};

module.exports = mongoose.model('User', userSchema);
