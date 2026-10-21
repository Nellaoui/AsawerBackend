// What the customer app shows as an order's progress. It follows the real
// portal tasks: the order sits at the step of its least advanced product.
const STAGES = ['confirmed', 'in_preparation', 'quality_check', 'packing', 'ready', 'picked_up', 'cancelled'];
const STEP_OF_STATUS = { awaiting_validation: 0, quality_check: 2, packing: 3 };
const SKIPPED_TYPES = ['order_validation', 'pack_order'];

const customerProgress = (order, cases = []) => {
  // Bracelets generated for a sartla are hidden from the customer: their tasks count for the parent product.
  const parentOf = new Map();
  for (const item of order.items || []) {
    if (item.partOfItemId) parentOf.set(String(item._id), String(item.partOfItemId));
  }
  const visibleItems = (order.items || []).filter(item => !item.partOfItemId);
  const base = { stage: 'confirmed', done: 0, total: visibleItems.length };
  if (order.status === 'cancelled') return { ...base, stage: 'cancelled' };
  if (order.status === 'pending') return { ...base, stage: 'pending' };
  if (order.pickedUpAt || ['shipped', 'delivered'].includes(order.status)) return { ...base, stage: 'picked_up', done: base.total };

  const groups = new Map();
  for (const item of cases) {
    if (SKIPPED_TYPES.includes(item.requestType) || ['cancelled', 'rejected'].includes(item.status)) continue;
    const itemId = item.orderItemId ? String(item.orderItemId) : '';
    const key = parentOf.get(itemId) || itemId || String(item.productId || item._id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  if (!groups.size) return order.fulfillmentState === 'ready' ? { ...base, stage: 'ready', done: base.total } : base;

  let done = 0;
  let least = null;
  for (const group of groups.values()) {
    const open = group.filter(item => item.status !== 'completed');
    const wentThroughPacking = group.some(item => (item.history || []).some(entry => entry.fromStatus === 'packing'));
    if (!open.length && wentThroughPacking) { done += 1; continue; }
    // A product with an open task is at the earliest step still open for it.
    let step = 3;
    for (const item of open) step = Math.min(step, STEP_OF_STATUS[item.status] ?? 1);
    least = least === null ? step : Math.min(least, step);
  }
  const total = Math.max(base.total, groups.size);
  if (least === null || order.fulfillmentState === 'ready') return { stage: 'ready', done: total, total };
  const stage = ['confirmed', 'in_preparation', 'quality_check', 'packing'][least];
  return { stage, done, total };
};

const progressForOrders = async (WorkflowCase, orders) => {
  const ids = orders.map(order => order._id);
  const cases = ids.length
    ? await WorkflowCase.find({ orderId: { $in: ids } }).select('orderId orderItemId productId requestType status history.fromStatus').lean()
    : [];
  const byOrder = new Map();
  for (const item of cases) {
    const key = String(item.orderId);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(item);
  }
  return new Map(orders.map(order => [String(order._id), customerProgress(order, byOrder.get(String(order._id)) || [])]));
};

module.exports = { STAGES, customerProgress, progressForOrders };
