const Product = require('../models/Product');
const StockVariant = require('../models/StockVariant');
const InventoryMovement = require('../models/InventoryMovement');

// Units the stock team already took off the shelf (see utils/stockPicking).
const pickedQuantity = (item) => Math.max(Number(item.stockPickedQuantity || 0), 0);
// Reserved units still on the shelf.
const unpickedQuantity = (item) => Math.max(Number(item.stockQuantity || 0) - pickedQuantity(item), 0);

const quantitiesByProduct = (items) => {
  const quantities = new Map();
  for (const item of items) {
    if (item.inventoryVariantId) continue;
    const productId = String(item.productId?._id || item.productId);
    const quantity = item.stockQuantity === null || item.stockQuantity === undefined
      ? Number(item.quantity)
      : unpickedQuantity(item);
    if (quantity > 0) quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }
  return quantities;
};

const releaseReservedInventory = async (order, actorId, session) => {
  if (order.inventoryState !== 'reserved') return;

  const movements = [];
  // Picked units go back on the shelf: on-hand and available both rise.
  for (const item of order.items) {
    const quantity = Math.min(pickedQuantity(item), Number(item.stockQuantity || 0));
    if (quantity <= 0) continue;
    let stockBefore;
    if (item.inventoryVariantId) {
      const variant = await StockVariant.findOneAndUpdate(
        { _id: item.inventoryVariantId },
        { $inc: { onHandQuantity: quantity } },
        { new: true, session }
      );
      if (!variant) {
        const error = new Error('Picked size inventory is missing; cancellation was stopped');
        error.statusCode = 409;
        throw error;
      }
      await Product.updateMany({ _id: { $in: variant.productIds } }, { $inc: { stock: quantity } }, { session });
      stockBefore = Math.max(variant.onHandQuantity - variant.reservedQuantity - quantity, 0);
    } else {
      const product = await Product.findByIdAndUpdate(item.productId, { $inc: { stock: quantity } }, { new: true, session });
      if (!product) {
        const error = new Error('Picked product no longer exists; cancellation was stopped');
        error.statusCode = 409;
        throw error;
      }
      stockBefore = Math.max(product.stock - quantity, 0);
    }
    movements.push({
      productId: item.productId,
      orderId: order._id,
      actorId,
      type: 'order_released',
      quantity,
      stockBefore,
      stockAfter: stockBefore + quantity,
      notes: `Size ${item.size || '-'}: ${quantity} picked unit(s) returned to the shelf from cancelled order #${String(order._id).slice(-6).toUpperCase()}`
    });
  }
  for (const item of order.items) {
    const quantity = unpickedQuantity(item);
    if (!item.inventoryVariantId || quantity <= 0) continue;
    const variant = await StockVariant.findOneAndUpdate(
      { _id: item.inventoryVariantId, reservedQuantity: { $gte: quantity } },
      { $inc: { reservedQuantity: -quantity } },
      { new: true, session }
    );
    if (!variant) {
      const error = new Error('Reserved size inventory is inconsistent; cancellation was stopped');
      error.statusCode = 409;
      throw error;
    }
    await Product.updateMany(
      { _id: { $in: variant.productIds } },
      { $inc: { stock: quantity, reservedStock: -quantity } },
      { session }
    );
    movements.push({
      productId: item.productId,
      orderId: order._id,
      actorId,
      type: 'order_released',
      quantity,
      stockBefore: Math.max(variant.onHandQuantity - variant.reservedQuantity - quantity, 0),
      stockAfter: Math.max(variant.onHandQuantity - variant.reservedQuantity, 0),
      notes: `Size ${item.size || variant.size} released from cancelled order #${String(order._id).slice(-6).toUpperCase()}`
    });
  }
  for (const [productId, quantity] of quantitiesByProduct(order.items)) {
    const product = await Product.findOneAndUpdate(
      { _id: productId, reservedStock: { $gte: quantity } },
      { $inc: { stock: quantity, reservedStock: -quantity } },
      { new: true, session }
    );

    if (!product) {
      const error = new Error('Reserved inventory is inconsistent; cancellation was stopped');
      error.statusCode = 409;
      throw error;
    }

    movements.push({
      productId,
      orderId: order._id,
      actorId,
      type: 'order_released',
      quantity,
      stockBefore: product.stock - quantity,
      stockAfter: product.stock,
      notes: `Stock released from cancelled order #${String(order._id).slice(-6).toUpperCase()}`
    });
  }

  if (movements.length) {
    await InventoryMovement.create(movements, { session });
  }
  order.inventoryState = 'released';
  order.inventoryReleasedAt = new Date();
};

module.exports = { pickedQuantity, unpickedQuantity, quantitiesByProduct, releaseReservedInventory };
