// A product taken from stock is finished at the stock check ("completed"), so
// it never reaches Packing on its own like a printed product does. These are
// the order lines that were fully taken from stock and still need a packer.
// A line that also has a print task is packed through that task instead.
const stockLinesNeedingPacking = ({ cases = [], orderItems = [] }) => {
  const pickedByItem = new Map(orderItems.map(item => [String(item._id), Number(item.stockPickedQuantity || 0)]));
  const hasPrintTask = new Set(
    cases
      .filter(item => item.requestType === 'print_required' && !['cancelled', 'rejected'].includes(item.status))
      .map(item => String(item.orderItemId || ''))
  );
  return [...new Set(
    cases
      .filter(item => item.requestType === 'stock_pick' && item.status === 'completed' && item.orderItemId)
      .map(item => String(item.orderItemId))
  )].filter(id => (pickedByItem.get(id) || 0) > 0 && !hasPrintTask.has(id));
};

module.exports = { stockLinesNeedingPacking };
