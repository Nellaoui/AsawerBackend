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

describe('Customer Service drops the printing part of a product', () => {
  let order: any;
  let validationCase: any;

  beforeEach(() => {
    const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    order = {
      _id: orderId, orderNumber: 'ASW-1', userId: '507f1f77bcf86cd799439099', validationStatus: 'pending', validationCaseId: 'v1',
      status: 'pending', workflowCaseIds: [], totalAmount: 500,
      items: [
        { _id: 'item-a', productId: productA, name: 'BRA 1', price: 100, quantity: 3, stockQuantity: 2, printQuantity: 1, productionMethod: 'undecided', fulfillmentStatus: 'awaiting_validation' },
        { _id: 'item-b', productId: productB, name: 'BRA 2', price: 100, quantity: 2, stockQuantity: 0, printQuantity: 2, productionMethod: 'undecided', fulfillmentStatus: 'awaiting_validation' }
      ],
      save: jest.fn(),
      populate: jest.fn()
    };
    validationCase = { status: 'awaiting_validation', assignedTo: 'cs-user', history: [], save: jest.fn() };
    jest.spyOn(Order, 'findById').mockImplementation(() => query(order));
    jest.spyOn(WorkflowCase, 'findById').mockImplementation(() => query(validationCase));
    jest.spyOn(WorkflowCase, 'findOne').mockImplementation(() => query(null));
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

  test('the stock part stays, the quantity and total go down, nothing goes to printing', async () => {
    const res = await run({ itemIds: ['item-a'], skipPrintItemIds: ['item-a'] });
    expect(res.status).not.toHaveBeenCalled();
    expect(order.items[0]).toMatchObject({ quantity: 2, stockQuantity: 2, printQuantity: 0, fulfillmentStatus: 'stock_reserved' });
    expect(order.totalAmount).toBe(400);
    const created = (WorkflowCase.create as jest.Mock).mock.calls.flatMap((call: any) => call[0]);
    expect(created.every((doc: any) => doc.requestType !== 'print_required')).toBe(true);
    expect(validationCase.history.some((entry: any) => entry.action === 'print_dropped')).toBe(true);
  });

  test('a product with nothing in stock is removed from the order', async () => {
    const res = await run({ itemIds: ['item-b'], skipPrintItemIds: ['item-b'] });
    expect(res.status).not.toHaveBeenCalled();
    expect(order.items.map((item: any) => item._id)).toEqual(['item-a']);
    expect(order.totalAmount).toBe(300);
  });

  test('dropping every product is refused', async () => {
    order.items.shift();
    const res = await run({ itemIds: ['item-b'], skipPrintItemIds: ['item-b'] });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(order.items).toHaveLength(1);
    expect(order.totalAmount).toBe(500);
  });

  test('a product with nothing to print cannot be dropped', async () => {
    order.items[0].printQuantity = 0;
    order.items[0].stockQuantity = 3;
    const res = await run({ itemIds: ['item-a'], skipPrintItemIds: ['item-a'] });
    expect(res.status).toHaveBeenCalledWith(409);
  });
});
