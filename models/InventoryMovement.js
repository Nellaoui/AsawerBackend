const mongoose = require('mongoose');

const inventoryMovementSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
    index: true
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
    index: true
  },
  actorId: {
    type: mongoose.Schema.Types.Mixed,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['receive', 'remove', 'set', 'damage', 'order_reserved', 'order_released'],
    required: true
  },
  quantity: {
    // Signed change to available stock. Reservations are negative; releases are positive.
    type: Number,
    required: true
  },
  stockBefore: {
    type: Number,
    required: true,
    min: 0
  },
  stockAfter: {
    type: Number,
    required: true,
    min: 0
  },
  notes: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

inventoryMovementSchema.index({ productId: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryMovement', inventoryMovementSchema);
