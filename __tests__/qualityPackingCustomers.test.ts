export {};

const Order = require('../models/Order');
const User = require('../models/User');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/workflow');

const handler = (() => {
  const route = router.stack.find((layer: any) => layer.route?.path === '/print-customers' && layer.route.methods.get);
  return route.route.stack[route.route.stack.length - 1].handle;
})();
const query = (result: any) => {
  const chain: any = {};
  ['select', 'sort'].forEach(method => { chain[method] = jest.fn(() => chain); });
  chain.lean = jest.fn(async () => result);
  return chain;
};
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const customer = { _id: '507f1f77bcf86cd799439021', name: 'Amina', email: 'amina@test.com' };

describe('customer list for Quality and Packing staff', () => {
  beforeEach(() => {
    jest.spyOn(WorkflowCase, 'find').mockReturnValue(query([{ customerId: customer._id }]));
    jest.spyOn(Order, 'find').mockReturnValue(query([]));
    jest.spyOn(User, 'find').mockReturnValue(query([customer]));
  });
  afterEach(() => jest.restoreAllMocks());

  test.each(['quality', 'packing'])('%s staff get the customers of their own tasks', async workRole => {
    const res = response();
    await handler({ user: { id: 'u1', role: 'employee', workRole } }, res);
    expect(WorkflowCase.find.mock.calls[0][0]).toMatchObject({ assignedTo: 'u1', assignedTeam: workRole });
    expect(res.json).toHaveBeenCalledWith([{ id: customer._id, name: 'Amina', email: 'amina@test.com' }]);
  });

  test('stock staff are still refused', async () => {
    const res = response();
    await handler({ user: { id: 'u2', role: 'employee', workRole: 'stock' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
