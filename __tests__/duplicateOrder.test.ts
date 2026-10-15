export {};
const Order = require('../models/Order');
const router = require('../routes/orders');

const find = (rows: any[]) => jest.spyOn(Order, 'find').mockReturnValue({ select: () => ({ lean: async () => rows }) } as any);
const line = (extra: any = {}) => ({ productId: 'p1', quantity: 2, size: '18', ...extra });

describe('same order sent twice', () => {
  afterEach(() => jest.restoreAllMocks());

  test('the same cart a moment later is found as a duplicate', async () => {
    find([{ orderNumber: 'ASW-1', items: [{ ...line(), productId: { _id: 'p1' } }, line({ productId: 'p2', quantity: 3, size: '' })] }]);
    const found = await router.findRecentDuplicateOrder('u1', [line({ productId: 'p2', quantity: 3, size: undefined }), line()]);
    expect(found?.orderNumber).toBe('ASW-1');
  });

  test('a different quantity or size is a new order', async () => {
    find([{ orderNumber: 'ASW-1', items: [line()] }]);
    expect(await router.findRecentDuplicateOrder('u1', [line({ quantity: 3 })])).toBeNull();
    expect(await router.findRecentDuplicateOrder('u1', [line({ size: '19' })])).toBeNull();
    expect(await router.findRecentDuplicateOrder('u1', [line(), line({ productId: 'p2' })])).toBeNull();
  });

  test('a sartla with another bracelet count is a new order', async () => {
    find([{ orderNumber: 'ASW-1', items: [line({ braceletCount: 3 })] }]);
    expect(await router.findRecentDuplicateOrder('u1', [line({ braceletCount: 5 })])).toBeNull();
    expect((await router.findRecentDuplicateOrder('u1', [line({ braceletCount: 3 })]))?.orderNumber).toBe('ASW-1');
  });

  test('only recent orders of this customer that are not cancelled are compared', async () => {
    const spy = find([]);
    await router.findRecentDuplicateOrder('u1', [line()]);
    const filter: any = spy.mock.calls[0][0];
    expect(filter.userId).toBe('u1');
    expect(filter.status).toEqual({ $ne: 'cancelled' });
    expect(Date.now() - filter.createdAt.$gte.getTime()).toBeLessThanOrEqual(3 * 60 * 1000 + 1000);
  });
});
