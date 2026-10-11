export {};

jest.mock('../utils/workflowNotifications', () => ({
  notifyCaseAssignment: jest.fn(async () => {}),
  notifyTaskRemoved: jest.fn(async () => {})
}));
jest.mock('../utils/workflowAssignment', () => ({
  findTeamAssignee: jest.fn(async () => ({ _id: '507f1f77bcf86cd7994390aa' }))
}));
jest.mock('../utils/pushNotification', () => ({ sendPushToUser: jest.fn(async () => {}) }));

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/orders');

const idOne = '507f1f77bcf86cd799439011';
const idTwo = '507f1f77bcf86cd799439012';
const productA = '507f1f77bcf86cd799439041';

const route = router.stack.find((layer: any) => layer.route?.path === '/validate-many' && layer.route.methods.post);
const validateMany = route.route.stack[route.route.stack.length - 1].handle;
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const query = (value: any) => {
  const q: any = {};
  ['session', 'populate', 'select', 'lean'].forEach(name => { q[name] = jest.fn(() => q); });
  q.then = (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject);
  return q;
};
const makeOrder = (id: string, status = 'pending') => ({
  _id: id, orderNumber: 'ASW-' + id.slice(-2), userId: '507f1f77bcf86cd799439099', validationStatus: status, validationCaseId: 'v-' + id,
  status: 'pending', workflowCaseIds: [],
  items: [{ _id: 'item-' + id, productId: productA, name: 'BRA 1', quantity: 1, stockQuantity: 0, printQuantity: 1, productionMethod: 'undecided', fulfillmentStatus: 'awaiting_validation' }],
  save: jest.fn(), populate: jest.fn()
});

describe('Customer Service confirms many orders at once', () => {
  let orders: Record<string, any>;
  beforeEach(() => {
    const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    orders = { [idOne]: makeOrder(idOne), [idTwo]: makeOrder(idTwo, 'approved') };
    jest.spyOn(Order, 'findById').mockImplementation(((id: string) => query(orders[String(id)])) as any);
    jest.spyOn(WorkflowCase, 'findById').mockImplementation(() => query({ status: 'awaiting_validation', assignedTo: 'cs-user', history: [], save: jest.fn() }));
    jest.spyOn(User, 'findById').mockImplementation(() => query({ forcedProductionMethod: null }));
    jest.spyOn(Product, 'find').mockImplementation(() => query([{ _id: productA, name: 'BRA 1', serialNumber: 'BRA 1' }]));
    jest.spyOn(WorkflowCase, 'create').mockImplementation((async (docs: any[]) => docs.map((doc, index) => ({ ...doc, _id: `case-${index}` }))) as any);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const run = (body: any, user: any = { id: 'cs-user', role: 'employee', workRole: 'customer_service' }) => {
    const res = response();
    return validateMany({ body, user, app: {} }, res).then(() => res);
  };

  test('sends every product of the ticked orders to the chosen method and reports the one that cannot go', async () => {
    const res = await run({ orderIds: [idOne, idTwo], productionMethod: 'wax' });
    expect(res.json).toHaveBeenCalledWith({ confirmed: [idOne], failed: [{ orderId: idTwo, message: 'This order is already validated' }] });
    expect(orders[idOne].items[0]).toMatchObject({ productionMethod: 'wax', fulfillmentStatus: 'production' });
    expect((WorkflowCase.create as jest.Mock).mock.calls[0][0][0]).toMatchObject({ assignedTeam: 'wax_print' });
  });

  test('needs Wax or Resin and at least one order', async () => {
    let res = await run({ orderIds: [idOne], productionMethod: 'both' });
    expect(res.status).toHaveBeenCalledWith(400);
    res = await run({ orderIds: [], productionMethod: 'wax' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('only Customer Service or the boss may confirm', async () => {
    const res = await run({ orderIds: [idOne], productionMethod: 'wax' }, { id: 'x', role: 'employee', workRole: 'wax_print' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(orders[idOne].items[0].fulfillmentStatus).toBe('awaiting_validation');
  });
});
