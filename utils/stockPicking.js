const Order = require('../models/Order');
const Product = require('../models/Product');
const StockVariant = require('../models/StockVariant');
const InventoryMovement = require('../models/InventoryMovement');

const fail = (message, statusCode = 409) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
};

// The stock team found the reserved units and took them off the shelf: they
// leave the on-hand count now instead of waiting for the order to ship. The
// order item records what was taken, so a retried completion takes nothing
// twice and shipping or cancelling only handles the rest.
const takePickedStockOffShelf = async ({ workflowCase, actorId, session }) => {
  if (workflowCase.requestType !== 'stock_pick' || !workflowCase.orderId || !workflowCase.orderItemId) return 0;
  const order = await Order.findById(workflowCase.orderId).session(session);
  if (!order || order.inventoryState !== 'reserved') return 0;
  const orderItem = order.items.id(workflowCase.orderItemId);
  if (!orderItem) return 0;

  const alreadyPicked = Number(orderItem.stockPickedQuantity || 0);
  const quantity = Math.min(Number(workflowCase.quantity || 0), Number(orderItem.stockQuantity || 0) - alreadyPicked);
  if (quantity <= 0) return 0;

  // Claim the units on the order first; a concurrent completion finds the
  // count already changed and stops here.
  const claimed = await Order.updateOne(
    {
      _id: order._id,
      inventoryState: 'reserved',
      items: { $elemMatch: { _id: orderItem._id, stockPickedQuantity: alreadyPicked || { $in: [0, null] } } }
    },
    { $set: { 'items.$.stockPickedQuantity': alreadyPicked + quantity } },
    { session }
  );
  if (claimed.modifiedCount !== 1) return 0;

  let onHandBefore;
  if (orderItem.inventoryVariantId) {
    const variant = await StockVariant.findOneAndUpdate(
      { _id: orderItem.inventoryVariantId, reservedQuantity: { $gte: quantity }, onHandQuantity: { $gte: quantity } },
      { $inc: { reservedQuantity: -quantity, onHandQuantity: -quantity } },
      { new: true, session }
    );
    if (!variant) fail('Reserved size stock is inconsistent for this item');
    await Product.updateMany({ _id: { $in: variant.productIds } }, { $inc: { reservedStock: -quantity } }, { session });
    onHandBefore = Number(variant.onHandQuantity || 0) + quantity;
  } else {
    const product = await Product.findOneAndUpdate(
      { _id: orderItem.productId, reservedStock: { $gte: quantity } },
      { $inc: { reservedStock: -quantity } },
      { new: true, session }
    );
    if (!product) fail('Reserved stock is inconsistent for this item');
    onHandBefore = Number(product.stock || 0) + Number(product.reservedStock || 0) + quantity;
  }

  await InventoryMovement.create([{
    productId: orderItem.productId,
    orderId: order._id,
    actorId,
    type: 'remove',
    quantity: -quantity,
    stockBefore: onHandBefore,
    stockAfter: onHandBefore - quantity,
    notes: `Size ${orderItem.size || '-'}: ${quantity} unit(s) picked from the shelf for order ${order.orderNumber || order._id}`
  }], { session });
  return quantity;
};

module.exports = { takePickedStockOffShelf };
