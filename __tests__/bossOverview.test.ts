export {};

const WorkflowCase = require('../models/WorkflowCase');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Machine = require('../models/Machine');
const User = require('../models/User');
const PhoneChangeRequest = require('../models/PhoneChangeRequest');
const router = require('../routes/workflow');
const { buildOverview } = require('../utils/bossOverview');

const query = (value: any) => {
  const q: any = {};
  ['sort', 'limit', 'select', 'lean', 'populate'].forEach(name => { q[name] = jest.fn(() => q); });
  q.then = (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject);
  return q;
};
const now = new Date('2026-10-06T15:00:00Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3600 * 1000);
const line = (orderItemId: string, cases: any[]) => cases.map(item => ({ orderId: 'o1', orderItemId, productionMethod: 'wax', isBlocked: false, createdAt: hoursAgo(50), updatedAt: hoursAgo(1), history: [], ...item }));

describe('boss overview', () => {
  beforeEach(() => {
    const cases = [
      // finished today, finished long ago, still printing, blocked, and a line whose stock check is done but print is open
      ...line('i1', [{ status: 'completed', requestType: 'stock_pick', completedAt: hoursAgo(2) }]),
      ...line('i2', [{ status: 'completed', requestType: 'print_required', completedAt: hoursAgo(24 * 20) }]),
      ...line('i3', [{ status: 'printing', requestType: 'print_required' }]),
      ...line('i4', [{ status: 'quality_check', requestType: 'print_required', isBlocked: true }]),
      ...line('i5', [{ status: 'completed', requestType: 'stock_pick', completedAt: hoursAgo(3) }, { status: 'packing', requestType: 'print_required' }])
    ];
    jest.spyOn(WorkflowCase, 'find').mockImplementation((filter: any) => query(filter.requestType === 'pack_order' ? [{ orderId: 'o2' }] : filter.requestType ? cases : []));
    jest.spyOn(WorkflowCase, 'aggregate').mockResolvedValue([
      { action: 'status_changed', fromStatus: 'printing', toStatus: 'ready_to_print', createdAt: hoursAgo(1) },
      { action: 'status_changed', fromStatus: 'quality_check', toStatus: 'packing', createdAt: hoursAgo(2) }
    ]);
    jest.spyOn(Order, 'find').mockImplementation(() => query([{ userId: 'u1', items: [{ productId: 'p1', name: 'COL 1', quantity: 3, productionMethod: 'wax', printQuantity: 2 }, { productId: 'p2', name: 'BRA 2', quantity: 1 }] }]));
    jest.spyOn(Order, 'countDocuments').mockResolvedValue(4);
    jest.spyOn(Order, 'aggregate').mockResolvedValue([]);
    jest.spyOn(WorkflowCase, 'countDocuments').mockResolvedValue(2);
    jest.spyOn(Product, 'find').mockImplementation(() => query([{ name: 'COL 1', stock: 0 }]));
    jest.spyOn(Product, 'countDocuments').mockResolvedValue(7);
    jest.spyOn(Machine, 'find').mockImplementation(() => query([{ status: 'busy' }, { status: 'available' }, { status: 'failed' }]));
    jest.spyOn(User, 'find').mockImplementation(() => query([]));
    jest.spyOn(User, 'countDocuments').mockResolvedValue(2);
    jest.spyOn(PhoneChangeRequest, 'countDocuments').mockResolvedValue(1);
  });
  afterEach(() => jest.restoreAllMocks());

  test('counts finished products and where the others are', async () => {
    const data = await buildOverview({ range: '7d', now, isLateCase: () => false });
    expect(data.finished.total).toBe(2);
    expect(data.finished.inRange).toBe(1);
    expect(data.finished.series.reduce((sum: number, point: any) => sum + point.value, 0)).toBe(1);
    expect(data.stages).toMatchObject({ wax_print: 1, blocked: 1, packing: 1, quality: 0 });
    expect(data.orders).toEqual({ received: 1, previous: 4, ready: 0, readyPrevious: 0 });
    expect(data.printers.failures).toBe(1);
    expect(data.printing).toEqual({ wax: 2, resin: 0, reprints: 2 });
    expect(data.topCustomers[0].quantity).toBe(4);
    expect(data.finished.previous).toBe(0);
    expect(data.topProducts[0]).toEqual({ name: 'COL 1', quantity: 3 });
    expect(data.printers).toMatchObject({ total: 3, busy: 1, available: 1, problem: 1 });
    expect(data.customers).toMatchObject({ new: 2, ordering: 1, pendingPhones: 1 });
    expect(data.lowStock.total).toBe(7);
  });

  test('today uses hourly buckets', async () => {
    const data = await buildOverview({ range: 'today', now, isLateCase: () => false });
    expect(data.finished.perHour).toBe(true);
    expect(data.finished.series).toHaveLength(13);
  });

  test('only the boss can open it', async () => {
    const route = router.stack.find((layer: any) => layer.route?.path === '/overview');
    const handle = route.route.stack[route.route.stack.length - 1].handle;
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handle({ query: {}, user: { id: 'x', role: 'employee', workRole: 'stock' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('order-level packing', () => {
  test('a stock-only product waits for its order packing task', async () => {
    jest.spyOn(WorkflowCase, 'find').mockImplementation((filter: any) => query(filter.requestType === 'pack_order'
      ? [{ orderId: 'o9' }]
      : filter.requestType ? [{ orderId: 'o9', orderItemId: 'i1', status: 'completed', requestType: 'stock_pick', completedAt: hoursAgo(1), history: [] }] : []));
    jest.spyOn(WorkflowCase, 'aggregate').mockResolvedValue([]);
    jest.spyOn(Order, 'find').mockImplementation(() => query([]));
    jest.spyOn(Order, 'countDocuments').mockResolvedValue(0);
    jest.spyOn(Order, 'aggregate').mockResolvedValue([]);
    jest.spyOn(WorkflowCase, 'countDocuments').mockResolvedValue(0);
    jest.spyOn(Product, 'find').mockImplementation(() => query([]));
    jest.spyOn(Product, 'countDocuments').mockResolvedValue(0);
    jest.spyOn(Machine, 'find').mockImplementation(() => query([]));
    jest.spyOn(User, 'find').mockImplementation(() => query([]));
    jest.spyOn(User, 'countDocuments').mockResolvedValue(0);
    jest.spyOn(PhoneChangeRequest, 'countDocuments').mockResolvedValue(0);
    const data = await buildOverview({ range: 'today', now, isLateCase: () => false });
    expect(data.finished.total).toBe(0);
    expect(data.stages.packing).toBe(1);
    expect(data.orders.ready).toBe(0);
    jest.restoreAllMocks();
  });
});
