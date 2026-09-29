const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const StockVariant = require('../models/StockVariant');
const InventoryMovement = require('../models/InventoryMovement');

const fail = (message, statusCode = 409) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
};

// Product.stock is the sum of its size stock; keep it in step after any size change.
const recomputeProductStock = async (productIds, session = null) => {
  const ids = productIds.map(id => new mongoose.Types.ObjectId(String(id)));
  const totals = await StockVariant.aggregate([
    { $match: { productIds: { $in: ids } } },
    { $unwind: '$productIds' },
    { $match: { productIds: { $in: ids } } },
    { $group: { _id: '$productIds', onHand: { $sum: '$onHandQuantity' }, reserved: { $sum: '$reservedQuantity' } } }
  ]).session(session);
  if (!totals.length) return;
  await Product.bulkWrite(totals.map(total => ({
    updateOne: {
      filter: { _id: total._id },
      update: { $set: { stock: Math.max(total.onHand - total.reserved, 0), reservedStock: total.reserved } }
    }
  })), { session });
};

// The boss reopened a stock check that was completed by mistake: the units it
// took off the shelf were never really picked, so they go back to on hand and
// stay reserved for the order until the stock team checks again.
const putPickedStockBack = async ({ workflowCase, actorId, session }) => {
  if (workflowCase.requestType !== 'stock_pick' || !workflowCase.orderId || !workflowCase.orderItemId) return 0;
  const order = await Order.findById(workflowCase.orderId).session(session);
  if (!order || order.inventoryState !== 'reserved') return 0;
  const orderItem = order.items.id(workflowCase.orderItemId);
  if (!orderItem) return 0;
  const picked = Number(orderItem.stockPickedQuantity || 0);
  const quantity = Math.min(Number(workflowCase.quantity || 0), picked);
  if (quantity <= 0) return 0;

  const claimed = await Order.updateOne(
    { _id: order._id, inventoryState: 'reserved', items: { $elemMatch: { _id: orderItem._id, stockPickedQuantity: picked } } },
    { $set: { 'items.$.stockPickedQuantity': picked - quantity } },
    { session }
  );
  if (claimed.modifiedCount !== 1) return 0;

  let onHandBefore;
  if (orderItem.inventoryVariantId) {
    const variant = await StockVariant.findOneAndUpdate(
      { _id: orderItem.inventoryVariantId },
      { $inc: { reservedQuantity: quantity, onHandQuantity: quantity } },
      { new: true, session }
    );
    if (!variant) fail('The size stock for this item no longer exists');
    await Product.updateMany({ _id: { $in: variant.productIds } }, { $inc: { reservedStock: quantity } }, { session });
    onHandBefore = Number(variant.onHandQuantity || 0) - quantity;
  } else {
    const product = await Product.findOneAndUpdate(
      { _id: orderItem.productId },
      { $inc: { reservedStock: quantity } },
      { new: true, session }
    );
    if (!product) fail('The product for this order item no longer exists');
    onHandBefore = Number(product.stock || 0) + Number(product.reservedStock || 0) - quantity;
  }

  await InventoryMovement.create([{
    productId: orderItem.productId,
    orderId: order._id,
    actorId,
    type: 'receive',
    quantity,
    stockBefore: Math.max(onHandBefore, 0),
    stockAfter: Math.max(onHandBefore, 0) + quantity,
    notes: `Size ${orderItem.size || '-'}: ${quantity} unit(s) put back, the stock check for order ${order.orderNumber || order._id} was reopened`
  }], { session });
  return quantity;
};

// The boss counted the shelf: set the real on-hand number for one size.
const setShelfCount = async ({ variantId, count, actorId, orderId = null, note = '', session }) => {
  if (!Number.isSafeInteger(count) || count < 0) fail('The shelf count must be a whole number, 0 or more', 400);
  const variant = await StockVariant.findById(variantId).session(session);
  if (!variant) fail('The size stock for this item no longer exists', 404);
  const before = Number(variant.onHandQuantity || 0);
  const reserved = Number(variant.reservedQuantity || 0);
  if (count < reserved) {
    fail(`Size ${variant.size}: ${reserved} unit(s) are still reserved for orders. Enter at least ${reserved}, or send the missing units to printing.`);
  }
  if (before === count) return { size: variant.size, before, after: count };
  variant.onHandQuantity = count;
  await variant.save({ session });
  await InventoryMovement.create([{
    productId: variant.primaryProductId,
    orderId,
    actorId,
    type: 'set',
    quantity: count - before,
    stockBefore: before,
    stockAfter: count,
    notes: `Size ${variant.size} (${variant.printMethod}): boss correction${note ? ` (${note})` : ''}`.slice(0, 500)
  }], { session });
  await recomputeProductStock(variant.productIds.length ? variant.productIds : [variant.primaryProductId], session);
  return { size: variant.size, before, after: count };
};

// The boss deleted a stock task: its units no longer come from stock. Picked
// units go back on the shelf and reserved ones are released for other orders.
const releaseStockTaskUnits = async ({ workflowCase, actorId, session }) => {
  if (workflowCase.requestType !== 'stock_pick' || !workflowCase.orderId || !workflowCase.orderItemId) return 0;
  const order = await Order.findById(workflowCase.orderId).session(session);
  const orderItem = order?.items.id(workflowCase.orderItemId);
  if (!orderItem) return 0;
  const quantity = Math.min(Number(workflowCase.quantity || 0), Number(orderItem.stockQuantity || 0));
  if (quantity <= 0) return 0;
  const alreadyPicked = Number(orderItem.stockPickedQuantity || 0);
  const picked = workflowCase.status === 'completed' ? Math.min(alreadyPicked, quantity) : 0;
  const reserved = quantity - picked;

  if (order.inventoryState === 'reserved') {
    if (orderItem.inventoryVariantId) {
      const variant = await StockVariant.findOneAndUpdate(
        { _id: orderItem.inventoryVariantId, reservedQuantity: { $gte: reserved } },
        { $inc: { onHandQuantity: picked, reservedQuantity: reserved ? -reserved : 0 } },
        { new: true, session }
      );
      if (!variant) fail('Reserved size stock is inconsistent for this item');
      await recomputeProductStock(variant.productIds.length ? variant.productIds : [orderItem.productId], session);
    } else {
      const product = await Product.findOneAndUpdate(
        { _id: orderItem.productId, reservedStock: { $gte: reserved } },
        { $inc: { stock: quantity, reservedStock: -reserved } },
        { new: true, session }
      );
      if (!product) fail('Reserved stock is inconsistent for this item');
    }
    await InventoryMovement.create([{
      productId: orderItem.productId,
      orderId: order._id,
      actorId,
      type: 'order_released',
      quantity,
      stockBefore: 0,
      stockAfter: quantity,
      notes: `Size ${orderItem.size || '-'}: ${quantity} unit(s) released, the boss deleted the stock task for order ${order.orderNumber || order._id}`
    }], { session });
  }
  await Order.updateOne(
    { _id: order._id, 'items._id': orderItem._id },
    { $set: { 'items.$.stockQuantity': Number(orderItem.stockQuantity || 0) - quantity, 'items.$.stockPickedQuantity': Math.max(alreadyPicked - picked, 0) } },
    { session }
  );
  return quantity;
};

module.exports = { putPickedStockBack, recomputeProductStock, releaseStockTaskUnits, setShelfCount };
