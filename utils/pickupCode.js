const Order = require('../models/Order');

const randomCode = () => String(Math.floor(1000 + Math.random() * 9000));

// A code is unique among the orders still waiting to be collected, so the
// counter can find an order from the digits alone. Taken orders free theirs.
const ensurePickupCode = async (orderId) => {
  const order = await Order.findById(orderId).select('fulfillmentState pickupCode pickedUpAt status').lean();
  if (!order || order.fulfillmentState !== 'ready' || order.pickedUpAt || order.status === 'cancelled') return order?.pickupCode || null;
  if (order.pickupCode) return order.pickupCode;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const code = randomCode();
    const taken = await Order.exists({ pickupCode: code, pickedUpAt: null, _id: { $ne: orderId } });
    if (taken) continue;
    const saved = await Order.findOneAndUpdate(
      { _id: orderId, pickupCode: null, pickedUpAt: null },
      { $set: { pickupCode: code } },
      { new: true }
    ).select('pickupCode').lean();
    return saved?.pickupCode || (await Order.findById(orderId).select('pickupCode').lean())?.pickupCode || null;
  }
  return null;
};

module.exports = { ensurePickupCode, randomCode };
