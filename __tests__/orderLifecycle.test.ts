const { planPrintTask, planStockTask } = require('../utils/orderWorkflowRoute');
const { teamForStatus, validateTransition } = require('../utils/workflowRules');

describe.each([
  ['wax', 'wax_print'],
  ['resin', 'resin_print'],
])('%s order lifecycle simulation', (productionMethod, printTeam) => {
  test('routes confirmed work through stock, printing, quality, and packing', () => {
    const item = { quantity: 3, stockQuantity: 1, printQuantity: 2, size: '5.5', productionMethod };
    const product = { serialNumber: 'BRA 539', modelFileStatus: 'missing', modelFileUrl: '' };

    // Customer Service confirmation uses a dedicated endpoint, not a generic task transition.
    expect(validateTransition({ status: 'awaiting_validation' }, 'stock_picking')).toMatch(/cannot move/i);

    const stockTask = planStockTask(item);
    expect(stockTask.quantity).toBe(1);
    expect(teamForStatus('stock_picking')).toBe('stock');
    expect(validateTransition({ status: 'stock_picking' }, 'completed')).toBeNull();

    const printTask = planPrintTask(product, item);
    expect(printTask.assignedTeam).toBe(printTeam);
    expect(printTask.status).toBe('ready_to_print');
    expect(validateTransition({ status: 'ready_to_print', productionMethod }, 'printing')).toBeNull();
    expect(validateTransition({ status: 'printing', productionMethod }, 'quality_check')).toBeNull();
    expect(teamForStatus('quality_check')).toBe('quality');
    expect(validateTransition({ status: 'quality_check', productionMethod }, 'completed')).toBeNull();

    // Packing is created only after the stock and print cases are completed.
    expect(teamForStatus('packing')).toBe('packing');
    expect(validateTransition({ status: 'packing' }, 'completed')).toBeNull();
  });
});
