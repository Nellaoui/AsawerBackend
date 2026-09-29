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
const boss = { id: 'boss-user', role: 'employee', workRole: 'boss' };

const handler = (path: string) => {
  const route = router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods.post);
  return route.route.stack[route.route.stack.length - 1].handle;
};
const correct = handler('/cases/:id/correction');
const remove = handler('/cases/:id/delete');
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const query = (value: any) => {
  const q: any = {};
  ['session', 'populate', 'select', 'lean', 'sort'].forEach(name => { q[name] = jest.fn(() => q); });
  q.then = (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject);
  return q;
};

describe('boss corrects a stock check that was completed by mistake', () => {
  let stockCase: any;
  let order: any;
  let orderItem: any;
  let variant: any;
  let packingTask: any;

  beforeEach(() => {
    const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    // The stock employee marked the single unit as found, so it already left the count.
    stockCase = {
      _id: caseId, orderId, orderItemId: itemId, status: 'completed', requestType: 'stock_pick',
      quantity: 1, assignedTeam: 'stock', assignedTo: 'stock-user', startedAt: new Date(), completedAt: new Date(),
      priority: 'normal', productionMethod: 'undecided', customerId: { name: 'Client' }, print: {},
      history: [
        { action: 'created', toStatus: 'stock_picking' },
        { action: 'status_changed', fromStatus: 'stock_picking', toStatus: 'completed' }
      ],
      save: jest.fn()
    };
    orderItem = { _id: itemId, productId, inventoryVariantId: variantId, size: '54', quantity: 1, stockQuantity: 1, stockPickedQuantity: 1, printQuantity: 0, productionMethod: 'wax' };
    order = {
      _id: orderId, orderNumber: 'ASW-7', userId: 'customer', status: 'confirmed', inventoryState: 'reserved',
      items: { id: (id: string) => (id === itemId ? orderItem : null) },
      workflowCaseIds: { addToSet: jest.fn() }, save: jest.fn()
    };
    variant = { _id: variantId, size: '54', printMethod: 'wax', onHandQuantity: 0, reservedQuantity: 0, productIds: [productId], primaryProductId: productId, save: jest.fn() };
    packingTask = null;
    jest.spyOn(WorkflowCase, 'findById').mockImplementation(() => query(stockCase));
    jest.spyOn(WorkflowCase, 'findOne').mockImplementation((filter: any) => query(filter.requestType === 'pack_order' && filter.status === 'packing' ? packingTask : null));
    jest.spyOn(WorkflowCase, 'find').mockImplementation(() => query([{ status: 'ready_to_print', isBlocked: false }]));
    jest.spyOn(WorkflowCase.prototype, 'save').mockResolvedValue(undefined);
    jest.spyOn(Order, 'findById').mockImplementation(() => query(order));
    jest.spyOn(Order, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(Product, 'findById').mockImplementation(() => query({ _id: productId, name: 'BRA 667', stock: 0, printMethod: 'wax' }));
    jest.spyOn(Product, 'findOneAndUpdate').mockResolvedValue({ _id: productId, stock: 0, reservedStock: 1 });
    jest.spyOn(Product, 'updateMany').mockResolvedValue({});
    jest.spyOn(Product, 'bulkWrite').mockResolvedValue({});
    jest.spyOn(StockVariant, 'findById').mockImplementation(() => query(variant));
    jest.spyOn(StockVariant, 'findOneAndUpdate').mockImplementation(async () => {
      variant.onHandQuantity += 1;
      variant.reservedQuantity += 1;
      return variant;
    });
    jest.spyOn(StockVariant, 'aggregate').mockReturnValue({ session: () => Promise.resolve([]) });
    jest.spyOn(InventoryMovement, 'create').mockResolvedValue([]);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const run = async (body: any, user: any = boss) => {
    const res = response();
    await correct({ params: { id: caseId }, body, user, app: {} }, res);
    return res;
  };
  const lastHistory = () => stockCase.history[stockCase.history.length - 1];

  test('only the boss can correct a task', async () => {
    const res = await run({ stage: 'stock_check', reason: 'Wrong count' }, { id: 'stock-user', role: 'employee', workRole: 'stock' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(stockCase.save).not.toHaveBeenCalled();
  });

  test('a reason is required', async () => {
    const res = await run({ stage: 'stock_check', reason: '  ' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('sends the unit that was never there to printing without taking it off the count twice', async () => {
    const res = await run({ stage: 'printing', shelfCount: 0, reason: 'It was not in stock' });
    expect(res.status).not.toHaveBeenCalled();
    expect(orderItem.stockPickedQuantity).toBe(0);
    expect(orderItem.stockQuantity).toBe(0);
    expect(orderItem.printQuantity).toBe(1);
    expect(StockVariant.findOneAndUpdate).not.toHaveBeenCalled();
    const printCase = (WorkflowCase.prototype.save as jest.Mock).mock.contexts[0];
    expect(printCase.assignedTeam).toBe('wax_print');
    expect(printCase.quantity).toBe(1);
    expect(stockCase.status).toBe('completed');
    expect(lastHistory()).toMatchObject({ actorId: 'boss-user', action: 'boss_correction' });
    expect(lastHistory().note).toContain('1 unit(s) sent to wax printing');
    expect(lastHistory().note).toContain('It was not in stock');
    expect(order.save).toHaveBeenCalled();
  });

  test('putting it back on stock check reopens it and puts the picked unit back as reserved', async () => {
    const res = await run({ stage: 'stock_check', reason: 'Check again' });
    expect(res.status).not.toHaveBeenCalled();
    expect(stockCase.status).toBe('stock_picking');
    expect(stockCase.completedAt).toBeNull();
    expect(stockCase.startedAt).toBeNull();
    expect(Order.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: orderId }),
      { $set: { 'items.$.stockPickedQuantity': 0 } },
      expect.anything()
    );
    expect(variant).toMatchObject({ onHandQuantity: 1, reservedQuantity: 1 });
    expect(lastHistory()).toMatchObject({ actorId: 'boss-user', action: 'boss_correction', fromStatus: 'completed', toStatus: 'stock_picking' });
  });

  test('sets the real shelf count and records it', async () => {
    variant.onHandQuantity = 3;
    const res = await run({ shelfCount: 1, reason: 'Counted the shelf' });
    expect(res.status).not.toHaveBeenCalled();
    expect(variant.onHandQuantity).toBe(1);
    expect(variant.save).toHaveBeenCalled();
    expect(InventoryMovement.create).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'set', stockBefore: 3, stockAfter: 1, actorId: 'boss-user' })],
      expect.anything()
    );
    expect(lastHistory().note).toContain('changed from 3 to 1');
  });

  test('refuses a shelf count below what orders still reserve', async () => {
    const res = await run({ stage: 'stock_check', shelfCount: 0, reason: 'Check again' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].message).toContain('send the missing units to printing');
  });

  test('cancels a packing task that opened too early', async () => {
    packingTask = { _id: 'pack', status: 'packing', assignedTo: 'packer', history: [], save: jest.fn() };
    await run({ stage: 'printing', reason: 'Not in stock' });
    expect(packingTask.status).toBe('cancelled');
    expect(packingTask.history[0]).toMatchObject({ actorId: 'boss-user', action: 'boss_correction' });
  });

  test('refuses a stage the task does not belong to', async () => {
    const res = await run({ stage: 'quality', reason: 'Oops' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toContain('Stock check, Printing, Ready');
  });

  test('marks a stock check done and takes the unit off the shelf', async () => {
    stockCase.status = 'stock_picking';
    orderItem.stockPickedQuantity = 0;
    variant.onHandQuantity = 1;
    variant.reservedQuantity = 1;
    jest.spyOn(StockVariant, 'findOneAndUpdate').mockImplementation(async () => {
      variant.onHandQuantity -= 1;
      variant.reservedQuantity -= 1;
      return variant;
    });
    const res = await run({ stage: 'ready', reason: 'Picked but not clicked' });
    expect(res.status).not.toHaveBeenCalled();
    expect(stockCase.status).toBe('completed');
    expect(variant).toMatchObject({ onHandQuantity: 0, reservedQuantity: 0 });
  });

  test('puts a print task back on printing with its own team', async () => {
    Object.assign(stockCase, { requestType: 'print_required', status: 'quality_check', assignedTeam: 'quality', productionMethod: 'wax' });
    const res = await run({ stage: 'printing', reason: 'Quality passed it by mistake' });
    expect(res.status).not.toHaveBeenCalled();
    expect(stockCase.status).toBe('ready_to_print');
    expect(stockCase.assignedTeam).toBe('wax_print');
    expect(lastHistory()).toMatchObject({ actorId: 'boss-user', action: 'boss_correction', fromStatus: 'quality_check', toStatus: 'ready_to_print' });
  });

  const runDelete = async (body: any, user: any = boss) => {
    const res = response();
    await remove({ params: { id: caseId }, body, user, app: {} }, res);
    return res;
  };

  test('only the boss can delete a task', async () => {
    const res = await runDelete({ reason: 'Duplicate' }, { id: 'stock-user', role: 'employee', workRole: 'stock' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(stockCase.save).not.toHaveBeenCalled();
  });

  test('deleting a finished stock task puts the picked unit back on the shelf', async () => {
    const res = await runDelete({ reason: 'Customer changed the order' });
    expect(res.status).not.toHaveBeenCalled();
    expect(stockCase.status).toBe('cancelled');
    expect(StockVariant.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: variantId }),
      { $inc: { onHandQuantity: 1, reservedQuantity: 0 } },
      expect.anything()
    );
    expect(Order.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: orderId }),
      { $set: { 'items.$.stockQuantity': 0, 'items.$.stockPickedQuantity': 0 } },
      expect.anything()
    );
    expect(lastHistory()).toMatchObject({ actorId: 'boss-user', action: 'boss_deleted', fromStatus: 'completed', toStatus: 'cancelled' });
  });

  test('deleting an open stock task releases its reservation', async () => {
    stockCase.status = 'stock_picking';
    orderItem.stockPickedQuantity = 0;
    variant.reservedQuantity = 1;
    await runDelete({ reason: 'Not needed' });
    expect(StockVariant.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: variantId }),
      { $inc: { onHandQuantity: 0, reservedQuantity: -1 } },
      expect.anything()
    );
  });

  test('an order confirmation cannot be deleted', async () => {
    stockCase.requestType = 'order_validation';
    const res = await runDelete({ reason: 'Oops' });
    expect(res.status).toHaveBeenCalledWith(409);
  });
});
