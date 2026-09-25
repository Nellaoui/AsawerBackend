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
const { sendPushToUser } = require('../utils/pushNotification');
const router = require('../routes/orders');

const orderId = '507f1f77bcf86cd799439011';
const productA = '507f1f77bcf86cd799439041';
const productB = '507f1f77bcf86cd799439042';

const validate = (() => {
  const route = router.stack.find((layer: any) => layer.route?.path === '/:id/validate' && layer.route.methods.post);
  return route.route.stack[route.route.stack.length - 1].handle;
})();
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const query = (value: any) => {
  const q: any = {};
  ['session', 'populate', 'select', 'lean'].forEach(name => { q[name] = jest.fn(() => q); });
  q.then = (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject);
  return q;
};

describe('Customer Service confirms references one at a time', () => {
  let order: any;
  let validationCase: any;

  beforeEach(() => {
    const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    order = {
      _id: orderId, orderNumber: 'ASW-1', userId: '507f1f77bcf86cd799439099', validationStatus: 'pending', validationCaseId: 'v1',
      status: 'pending', workflowCaseIds: [],
      items: [
        { _id: 'item-a', productId: productA, name: 'BRA 1', quantity: 1, stockQuantity: 0, printQuantity: 1, productionMethod: 'undecided', fulfillmentStatus: 'awaiting_validation' },
        { _id: 'item-b', productId: productB, name: 'BRA 2', quantity: 1, stockQuantity: 0, printQuantity: 1, productionMethod: 'undecided', fulfillmentStatus: 'awaiting_validation' }
      ],
      save: jest.fn(),
      populate: jest.fn()
    };
    validationCase = { status: 'awaiting_validation', assignedTo: 'cs-user', history: [], save: jest.fn() };
    jest.spyOn(Order, 'findById').mockImplementation(() => query(order));
    jest.spyOn(WorkflowCase, 'findById').mockImplementation(() => query(validationCase));
    jest.spyOn(User, 'findById').mockImplementation(() => query({ forcedProductionMethod: null }));
    jest.spyOn(Product, 'find').mockImplementation(() => query([
      { _id: productA, name: 'BRA 1', serialNumber: 'BRA 1' },
      { _id: productB, name: 'BRA 2', serialNumber: 'BRA 2' }
    ]));
    jest.spyOn(WorkflowCase, 'create').mockImplementation((async (docs: any[]) => docs.map((doc, index) => ({ ...doc, _id: `case-${doc.orderItemId}-${index}` }))) as any);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const run = (body: any) => {
    const res = response();
    return validate({ params: { id: orderId }, body, user: { id: 'cs-user', role: 'employee', workRole: 'customer_service' }, app: {} }, res).then(() => res);
  };

  test('confirming one item sends only that item on and keeps the order waiting', async () => {
    const res = await run({ itemIds: ['item-a'], items: [{ itemId: 'item-a', productionMethod: 'resin' }] });
    expect(res.status).not.toHaveBeenCalled();
    expect(WorkflowCase.create).toHaveBeenCalledTimes(1);
    expect((WorkflowCase.create as jest.Mock).mock.calls[0][0][0]).toMatchObject({ orderItemId: 'item-a', assignedTeam: 'resin_print' });
    expect(order.items[0].fulfillmentStatus).toBe('production');
    expect(order.items[1].fulfillmentStatus).toBe('awaiting_validation');
    expect(validationCase.status).toBe('awaiting_validation');
    expect(order.validationStatus).toBe('pending');
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  test('confirming the last item completes the order', async () => {
    order.items[0].fulfillmentStatus = 'production';
    const res = await run({ itemIds: ['item-b'], items: [{ itemId: 'item-b', productionMethod: 'wax' }] });
    expect(res.status).not.toHaveBeenCalled();
    expect(WorkflowCase.create).toHaveBeenCalledTimes(1);
    expect(validationCase.status).toBe('completed');
    expect(order.validationStatus).toBe('approved');
    expect(order.status).toBe('confirmed');
  });

  test('an item without Wax or Resin cannot be confirmed', async () => {
    const res = await run({ itemIds: ['item-a'], items: [] });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(WorkflowCase.create).not.toHaveBeenCalled();
  });
});
