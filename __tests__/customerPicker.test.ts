export {};

const Order = require('../models/Order');
const User = require('../models/User');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/workflow');

const listCustomers = (() => {
  const route = router.stack.find((layer: any) => layer.route?.path === '/customers' && layer.route.methods.get);
  return route.route.stack[route.route.stack.length - 1].handle;
})();

const ids = {
  amina: '507f1f77bcf86cd799439021',
  bilal: '507f1f77bcf86cd799439022',
  chaima: '507f1f77bcf86cd799439023',
  order: '507f1f77bcf86cd799439031'
};
const customers = [
  { _id: ids.amina, name: 'Amina', email: 'amina@test.com' },
  { _id: ids.bilal, name: 'Bilal', email: 'bilal@test.com' },
  { _id: ids.chaima, name: 'Chaima', email: 'chaima@test.com' }
];
const query = (result: any) => {
  const chain: any = {};
  ['select', 'sort', 'limit'].forEach(method => { chain[method] = jest.fn(() => chain); });
  chain.lean = jest.fn(async () => result);
  return chain;
};
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

describe('customer picker list', () => {
  beforeEach(() => {
    // Chaima has two open tasks (one linked through her order), Bilal has one, Amina none.
    jest.spyOn(WorkflowCase, 'find').mockReturnValue(query([
      { customerId: ids.bilal },
      { customerId: ids.chaima },
      { customerId: null, orderId: ids.order }
    ]));
    jest.spyOn(Order, 'find').mockReturnValue(query([{ _id: ids.order, userId: ids.chaima }]));
    jest.spyOn(User, 'find').mockImplementation((filter: any) => {
      if (filter._id?.$in) return query(customers.filter(item => filter._id.$in.includes(item._id)));
      const excluded = (filter._id?.$nin || []).map(String);
      return query(customers.filter(item => !excluded.includes(item._id)));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  test('lists customers with open tasks first, busiest first, with their task counts', async () => {
    const res = response();
    await listCustomers({ query: {}, user: { id: 'cs-id', role: 'employee', workRole: 'customer_service' } }, res);
    const list = res.json.mock.calls[0][0];
    expect(list.map((item: any) => [item.name, item.activeTasks])).toEqual([
      ['Chaima', 2],
      ['Bilal', 1],
      ['Amina', 0]
    ]);
    expect(WorkflowCase.find.mock.calls[0][0]).toMatchObject({ taskKind: 'order', archivedAt: null });
  });
});
