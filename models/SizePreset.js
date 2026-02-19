const mongoose = require('mongoose');

const sizePresetSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    enum: ['bracelet', 'bague', 'gourmette'],
  },
  availableSizes: [{
    type: String,
    trim: true,
  }],
  availableHeights: [{
    type: String,
    trim: true,
  }],
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

sizePresetSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('SizePreset', sizePresetSchema);
