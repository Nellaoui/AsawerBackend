export {};

jest.mock('../utils/workflowNotifications', () => ({
  notifyCaseAssignment: jest.fn(async () => {}),
  notifyFailedPrint: jest.fn(async () => {}),
  notifyOrderBlocked: jest.fn(async () => {}),
  notifyTaskRemoved: jest.fn(async () => {}),
  notifyUser: jest.fn(async () => {})
}));
jest.mock('../utils/workflowAssignment', () => ({
  findTeamAssignee: jest.fn(async () => ({ _id: '507f1f77bcf86cd7994390aa' }))
}));

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const StockVariant = require('../models/StockVariant');
const InventoryMovement = require('../models/InventoryMovement');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/workflow');

const caseId = '507f1f77bcf86cd799439021';
const orderId = '507f1f77bcf86cd799439011';
const itemId = '507f1f77bcf86cd799439031';
const productId = '507f1f77bcf86cd799439041';
const variantId = '507f1f77bcf86cd799439051';

const handler = (path: string) => {
  const route = router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods.post);
  return route.route.stack[route.route.stack.length - 1].handle;
};
const stockMissing = handler('/cases/:id/stock-missing');
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
// A query stand-in: chainable like Mongoose, awaitable for the given value.
const query = (value: any) => {
  const q: any = {};
  ['session', 'populate', 'select', 'lean', 'sort'].forEach(name => { q[name] = jest.fn(() => q); });
  q.then = (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject);
  return q;
};

describe('stock team reports units missing from the shelf', () => {
  let stockCase: any;
  let order: any;
  let orderItem: any;

  beforeEach(() => {
    const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    stockCase = {
      _id: caseId, orderId, orderItemId: itemId, status: 'stock_picking', requestType: 'stock_pick',
      quantity: 3, assignedTo: 'stock-user', startedAt: new Date(Date.now() - 60000), priority: 'normal',
      productionMethod: 'undecided', history: [], customerId: { name: 'Client' }, save: jest.fn()
    };
    orderItem = { _id: itemId, productId, inventoryVariantId: variantId, size: '54', quantity: 3, stockQuantity: 3, printQuantity: 0, productionMethod: 'resin' };
    order = {
      _id: orderId, orderNumber: 'ASW-1', userId: 'customer', inventoryState: 'reserved',
      items: { id: (id: string) => (id === itemId ? orderItem : null) },
      workflowCaseIds: { addToSet: jest.fn() }, save: jest.fn()
    };
    jest.spyOn(WorkflowCase, 'findById').mockImplementation(() => query(stockCase));
    jest.spyOn(WorkflowCase, 'findOne').mockImplementation(() => query(null));
    jest.spyOn(WorkflowCase, 'find').mockImplementation(() => query([{ status: 'ready_to_print', isBlocked: false }]));
    jest.spyOn(WorkflowCase.prototype, 'save').mockResolvedValue(undefined);
    jest.spyOn(Order, 'findById').mockImplementation(() => query(order));
    jest.spyOn(Order, 'updateOne').mockResolvedValue({});
    jest.spyOn(Product, 'findById').mockImplementation(() => query({ _id: productId, name: 'BRA 667', stock: 5, printMethod: 'wax' }));
    jest.spyOn(Product, 'updateMany').mockResolvedValue({});
    jest.spyOn(StockVariant, 'findOneAndUpdate').mockResolvedValue({ _id: variantId, productIds: [productId] });
    jest.spyOn(InventoryMovement, 'create').mockResolvedValue([]);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const run = async (quantity: number, user: any = { id: 'stock-user', role: 'employee', workRole: 'stock' }) => {
    const res = response();
    await stockMissing({ params: { id: caseId }, body: { quantity }, user, app: {} }, res);
    return res;
  };

  test('sends every missing unit to printing on the Customer Service route and closes the stock task', async () => {
    const res = await run(3);
    expect(res.status).not.toHaveBeenCalled();
    expect(stockCase.status).toBe('completed');
    expect(orderItem.stockQuantity).toBe(0);
    expect(orderItem.printQuantity).toBe(3);
    const printCase = (WorkflowCase.prototype.save as jest.Mock).mock.contexts[0];
    expect(printCase.productionMethod).toBe('resin');
    expect(printCase.assignedTeam).toBe('resin_print');
    expect(printCase.quantity).toBe(3);
    expect(StockVariant.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: variantId }),
      { $inc: { reservedQuantity: -3, onHandQuantity: -3 } },
      expect.anything()
    );
  });

  test('keeps the stock task open for the units that were found', async () => {
    await run(1);
    expect(stockCase.status).toBe('stock_picking');
    expect(stockCase.quantity).toBe(2);
    expect(orderItem.stockQuantity).toBe(2);
    expect(orderItem.printQuantity).toBe(1);
  });

  test('rejects more units than the task holds', async () => {
    const res = await run(4);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(StockVariant.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('only the stock team can report missing stock', async () => {
    const res = await run(1, { id: 'stock-user', role: 'employee', workRole: 'packing' });
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
