export {};

const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/workflow');

const findTasks = (() => {
  const route = router.stack.find((layer: any) => layer.route?.path === '/find' && layer.route.methods.get);
  return route.route.stack[route.route.stack.length - 1].handle;
})();

const ids = {
  order: '507f1f77bcf86cd7994390a1',
  product: '507f1f77bcf86cd7994390b1',
  customer: '507f1f77bcf86cd7994390c1',
  packer: '507f1f77bcf86cd7994390d1',
  caseActive: '507f1f77bcf86cd7994390e1',
  caseDone: '507f1f77bcf86cd7994390e2'
};
const query = (result: any) => {
  const chain: any = {};
  ['select', 'sort', 'limit', 'populate'].forEach(method => { chain[method] = jest.fn(() => chain); });
  chain.lean = jest.fn(async () => result);
  return chain;
};
const distinct = (result: any) => ({ distinct: jest.fn(async () => result) });
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

const cases = [
  {
    _id: ids.caseDone,
    requestType: 'pack_order',
    requestedName: 'Gold ring',
    status: 'completed',
    assignedTeam: 'packing',
    orderId: { _id: ids.order, orderNumber: 'ORD-1042', userId: { _id: ids.customer, name: 'Amina', email: 'amina@test.com' } },
    productId: { _id: ids.product, name: 'Gold ring', serialNumber: 'R-77' },
    assignedTo: { _id: ids.packer, name: 'Youssef' },
    updatedAt: new Date('2026-09-28T10:00:00Z'),
    createdAt: new Date('2026-09-25T10:00:00Z')
  },
  {
    _id: ids.caseActive,
    requestedName: 'Gold ring',
    status: 'printing',
    assignedTeam: 'wax_print',
    orderId: { _id: ids.order, orderNumber: 'ORD-1042', userId: { _id: ids.customer, name: 'Amina', email: 'amina@test.com' } },
    productId: { _id: ids.product, name: 'Gold ring', serialNumber: 'R-77' },
    assignedTo: { _id: ids.packer, name: 'Youssef' },
    print: { machineId: 'WAX-2' },
    isBlocked: true,
    blockedReason: 'Resin empty',
    updatedAt: new Date('2026-09-27T10:00:00Z'),
    createdAt: new Date('2026-09-25T10:00:00Z')
  }
];

describe('find a task across the pipeline', () => {
  let caseFilter: any;
  beforeEach(() => {
    caseFilter = null;
    jest.spyOn(Order, 'find').mockImplementation((filter: any) => {
      if (filter.orderNumber) return query(filter.orderNumber.test('ORD-1042') ? [{ _id: ids.order }] : []);
      if (filter.$expr) return query([{ _id: ids.order }]);
      return distinct([ids.order]);
    });
    jest.spyOn(Product, 'find').mockReturnValue(query([{ _id: ids.product }]));
    jest.spyOn(User, 'find').mockReturnValue(query([]));
    jest.spyOn(WorkflowCase, 'find').mockImplementation((filter: any) => {
      caseFilter = filter;
      return query(cases.map(item => ({ ...item })));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  test('finds tasks by order number and says which stage and team each one is in, open work first', async () => {
    const res = response();
    await findTasks({ query: { q: 'ord-1042' }, user: { id: 'boss-id', role: 'employee', workRole: 'boss' } }, res);
    const { results } = res.json.mock.calls[0][0];
    expect(results.map((item: any) => [item.stage, item.teamLabel, item.assignedTo.name])).toEqual([
      ['Printing', 'Wax printing', 'Youssef'],
      ['Ready / completed', 'Packing', 'Youssef']
    ]);
    expect(results[0]).toMatchObject({ isBlocked: true, blockedReason: 'Resin empty', machineId: 'WAX-2', canOpen: true });
    expect(results[0].customer).toEqual({ name: 'Amina', email: 'amina@test.com' });
    expect(caseFilter.$or).toEqual(expect.arrayContaining([{ orderId: { $in: [ids.order] } }]));
    expect(caseFilter.createdAt).toBeDefined();
  });

  test('a finished stock check or confirmation never reads as a ready order while its product is still printing', async () => {
    const order = cases[1].orderId;
    (WorkflowCase.find as jest.Mock).mockImplementation(() => query([
      { ...cases[1], isBlocked: false, blockedReason: '' },
      { _id: 'stock', requestType: 'stock_pick', requestedName: 'Gold ring', status: 'completed', assignedTeam: 'none', orderId: order, updatedAt: new Date('2026-09-28T10:00:00Z') },
      { _id: 'confirm', requestType: 'order_validation', requestedName: 'Validate order ORD-1042', status: 'completed', assignedTeam: 'none', orderId: order, updatedAt: new Date('2026-09-26T10:00:00Z') },
      { _id: 'quality', requestType: 'print_required', requestedName: 'Gold ring', status: 'completed', assignedTeam: 'none', orderId: order, updatedAt: new Date('2026-09-25T10:00:00Z') },
      { _id: 'extra', taskKind: 'extra', requestType: 'general_task', requestedName: 'Clean display', status: 'completed', assignedTeam: 'none', orderId: order, updatedAt: new Date('2026-09-24T10:00:00Z') }
    ]));
    const res = response();
    await findTasks({ query: { q: 'ord-1042' }, user: { id: 'cs-id', role: 'employee', workRole: 'customer_service' } }, res);
    const { results } = res.json.mock.calls[0][0];
    expect(results.map((item: any) => item.stage)).toEqual(['Printing', 'Stock check done', 'Order confirmed', 'Printed and checked', 'Done']);
  });

  test('matches the short order code the portal shows', async () => {
    const res = response();
    await findTasks({ query: { q: '#7994390A1' }, user: { id: 'boss-id', role: 'employee', workRole: 'boss' } }, res);
    const expr = (Order.find as jest.Mock).mock.calls.find((call: any) => call[0].$expr)[0].$expr;
    expect(expr.$regexMatch.regex).toBe('7994390a1$');
  });

  test('only Customer Service, the boss and administrators can search all tasks', async () => {
    const res = response();
    await findTasks({ query: { q: 'R-77' }, user: { id: 'quality-id', role: 'employee', workRole: 'quality' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(WorkflowCase.find).not.toHaveBeenCalled();
  });

  test('Customer Service can search by customer name', async () => {
    const res = response();
    await findTasks({ query: { q: 'Amina' }, user: { id: 'cs-id', role: 'employee', workRole: 'customer_service' } }, res);
    expect(User.find).toHaveBeenCalled();
    expect(caseFilter.$or).toEqual(expect.arrayContaining([{ 'customer.name': /Amina/i }]));
    expect(res.json.mock.calls[0][0].results[0].canOpen).toBe(true);
  });

  test('ignores searches shorter than two characters', async () => {
    const res = response();
    await findTasks({ query: { q: ' a ' }, user: { id: 'boss-id', role: 'employee', workRole: 'boss' } }, res);
    expect(res.json).toHaveBeenCalledWith({ query: 'a', results: [] });
    expect(WorkflowCase.find).not.toHaveBeenCalled();
  });
});
