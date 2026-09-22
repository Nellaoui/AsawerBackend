const { teamForStatus } = require('./workflowRules');

const planPrintTask = (product, orderItem) => {
  if (!['wax', 'resin'].includes(orderItem.productionMethod)) {
    const error = new Error(`Choose Wax or Resin for ${product.serialNumber}, size ${orderItem.size || '-'}`);
    error.statusCode = 409;
    throw error;
  }

  // Print files are operated in the manufacturer's app. The portal can link a
  // file when available, but an absent URL is not a reason to hide the task.
  return {
    status: 'ready_to_print',
    assignedTeam: teamForStatus('ready_to_print', orderItem.productionMethod),
    hasPortalModel: product.modelFileStatus === 'print_ready' && Boolean(product.modelFileUrl)
  };
};

const planStockTask = orderItem => {
  const reservedQuantity = Number(orderItem.stockQuantity || 0);
  if (reservedQuantity <= 0) return null;
  return {
    quantity: reservedQuantity,
    requirements: `Collect ${reservedQuantity} reserved unit(s), size ${orderItem.size || '-'}, from stock for this order. ${orderItem.printQuantity || 0} unit(s) also need printing.`
  };
};

module.exports = { planPrintTask, planStockTask };
