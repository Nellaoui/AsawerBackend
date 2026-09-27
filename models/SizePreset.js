const mongoose = require('mongoose');

const sizePresetSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    // Boucle and pendantif never have a size, so they have no preset.
    enum: ['bracelet', 'bague', 'collier', 'gourmette'],
  },
  availableSizes: [{
    type: String,
    trim: true,
  }],
  availableHeights: [{
    type: String,
    trim: true,
  }],
  // When true every product of this type offers availableSizes, ignoring its
  // own list. Always true for bague and bracelet.
  applyToAll: {
    type: Boolean,
    default: false,
  },
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
