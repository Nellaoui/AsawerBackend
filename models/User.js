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
    enum: ['user', 'admin'],
    default: 'user'
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
  expoPushTokens: [{
    type: String,
    trim: true
  }],
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
  // Set role based on isAdmin field
  if (this.isAdmin) {
    this.role = 'admin';
  } else {
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