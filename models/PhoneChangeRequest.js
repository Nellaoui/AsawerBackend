const mongoose = require('mongoose');

// A customer tried to sign in from a phone that is not the one linked to their
// account. The owner (or a staff member allowed to) approves or rejects it.
const phoneChangeRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  deviceId: { type: String, required: true, trim: true },
  deviceName: { type: String, trim: true, default: '' },
  previousDeviceName: { type: String, trim: true, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  attempts: { type: Number, default: 1 },
  lastAttemptAt: { type: Date, default: Date.now },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  decidedAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

// At most one open request per customer.
phoneChangeRequestSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_per_user' }
);

module.exports = mongoose.model('PhoneChangeRequest', phoneChangeRequestSchema);
