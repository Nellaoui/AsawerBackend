const Order = require('../models/Order');

// Orders that can still be moved forward, and the steps that end at Completed.
const STEPS = {
  confirmed: ['shipped', 'delivered'],
  picking: ['shipped', 'delivered'],
  packed: ['shipped', 'delivered'],
  shipped: ['delivered']
};

// The last product was given to the customer: the order becomes Completed
// ("delivered"). Going through "shipped" keeps the usual rule that leaves no
// stock reserved for an order that is finished.
const completeOrder = async (orderId, actorId, transition) => {
  const move = transition || require('../routes/orders').transitionOrder;
  const order = await Order.findById(orderId).select('status').lean();
  const steps = STEPS[order?.status];
  if (!steps) return { completed: order?.status === 'delivered', status: order?.status || null };
  for (const next of steps) await move(orderId, next, actorId);
  return { completed: true, status: 'delivered' };
};

module.exports = { completeOrder, STEPS };
