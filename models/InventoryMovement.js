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

inventoryMovementSchema.post('save', async function(movement, next) {
  try {
    const AuditLog = require('./AuditLog');
    await AuditLog.create([{
      category: 'inventory',
      action: movement.type,
      actorId: movement.actorId,
      entityType: 'product',
      entityId: String(movement.productId),
      orderId: movement.orderId ? String(movement.orderId) : null,
      details: {
        quantity: movement.quantity,
        stockBefore: movement.stockBefore,
        stockAfter: movement.stockAfter,
        notes: movement.notes
      }
    }], { session: movement.$session() || undefined });
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('InventoryMovement', inventoryMovementSchema);
