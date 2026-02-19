const mongoose = require('mongoose');

const claspImageSchema = new mongoose.Schema({
  claspType: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    // e.g. 'FRN', 'MO_PAVE', 'MO_SERTIE', 'MO_SIMPLE', 'SIMPLE'
  },
  imageUrl: {
    type: String,
    required: true,
  },
  label: {
    type: String,
    trim: true,
    default: '',
  },
  createdBy: {
    type: mongoose.Schema.Types.Mixed,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

claspImageSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('ClaspImage', claspImageSchema);
