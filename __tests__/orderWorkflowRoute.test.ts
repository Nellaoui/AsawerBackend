const { planPrintTask, planStockTask } = require('../utils/orderWorkflowRoute');

describe('automatic order print routing', () => {
  const product = { serialNumber: 'BRA 396', modelFileStatus: 'missing', modelFileUrl: '' };

  test.each([
    ['wax', 'wax_print'],
    ['resin', 'resin_print'],
  ])('sends a %s order item to the %s employee even without a portal file', (method, team) => {
    expect(planPrintTask(product, { productionMethod: method, size: '54' })).toEqual({
      status: 'ready_to_print',
      assignedTeam: team,
      hasPortalModel: false,
    });
  });

  test('keeps an approved portal file linked when one exists', () => {
    expect(planPrintTask(
      { ...product, modelFileStatus: 'print_ready', modelFileUrl: 'https://example.test/BRA-396.stl' },
      { productionMethod: 'wax', size: '54' },
    ).hasPortalModel).toBe(true);
  });

  test('does not guess Wax or Resin when Customer Service has not chosen one', () => {
    expect(() => planPrintTask(product, { productionMethod: 'undecided', size: '54' }))
      .toThrow('Choose Wax or Resin for BRA 396, size 54');
  });

  test('skips stock picking when no finished stock is reserved', () => {
    const plan = planStockTask({ quantity: 10, stockQuantity: 0, printQuantity: 10, size: '54' });
    expect(plan).toBeNull();
  });

  test('tells stock staff exactly how many reserved pieces to collect', () => {
    const plan = planStockTask({ quantity: 10, stockQuantity: 4, printQuantity: 6, size: '54' });
    expect(plan.quantity).toBe(4);
    expect(plan.requirements).toMatch(/Collect 4 reserved unit\(s\)/);
    expect(plan.requirements).toMatch(/6 unit\(s\) also need printing/);
  });
});
