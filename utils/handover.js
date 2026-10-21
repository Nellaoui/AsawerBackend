const WorkflowCase = require('../models/WorkflowCase');

const CASE_FIELDS = 'orderId orderItemId productId requestedName quantity status history.fromStatus';

// A product is ready to give when it went through packing and none of its tasks is open.
// Products are grouped like the "X of N ready" message: by order item, else by product.
const buildHandoverState = (order, cases) => {
  const given = new Set((order.handovers || []).flatMap(entry => entry.itemKeys || []));
  const groups = new Map();
  for (const item of cases) {
    const key = String(item.orderItemId || item.productId?._id || item.productId || item._id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const lines = new Map((order.items || []).map(line => [String(line._id), line]));
  const products = [...groups.entries()].map(([key, group]) => {
    const line = lines.get(key);
    const first = group[0];
    return {
      key,
      name: first.requestedName || line?.name || 'Product',
      reference: first.productId?.serialNumber || '',
      size: line?.size || '',
      quantity: line?.quantity || first.quantity || 1,
      ready: group.every(item => item.status === 'completed')
        && group.some(item => (item.history || []).some(entry => entry.fromStatus === 'packing')),
      given: given.has(key)
    };
  });
  const toGive = products.filter(product => product.ready && !product.given);
  return {
    products,
    toGive,
    allGiven: products.length > 0 && products.every(product => product.given),
    weightGrams: (order.packedWeights || []).reduce((sum, entry) => sum + Number(entry.weightGrams || 0), 0)
  };
};

// One query for many orders (the waiting list).
const handoverStates = async (orders) => {
  const ids = orders.map(order => order._id);
  const cases = ids.length ? await WorkflowCase.find({
    orderId: { $in: ids },
    status: { $nin: ['cancelled', 'rejected'] },
    requestType: { $nin: ['order_validation', 'pack_order'] },
    archivedAt: null
  }).select(CASE_FIELDS).populate('productId', 'serialNumber').lean() : [];
  const byOrder = new Map();
  for (const item of cases) {
    const key = String(item.orderId);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(item);
  }
  return new Map(orders.map(order => [String(order._id), buildHandoverState(order, byOrder.get(String(order._id)) || [])]));
};

module.exports = { buildHandoverState, handoverStates };
