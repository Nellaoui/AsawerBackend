export {};

jest.mock('../utils/workflowNotifications', () => ({
  activeAdminIds: jest.fn(async () => ['boss-user']),
  notifyCaseAssignment: jest.fn(async () => {}),
  notifyFailedPrint: jest.fn(async () => {}),
  notifyOrderBlocked: jest.fn(async () => {}),
  notifyTaskRemoved: jest.fn(async () => {}),
  notifyUser: jest.fn(async () => {}),
  notifyUsers: jest.fn(async () => {})
}));

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Notification = require('../models/Notification');
const InventoryMovement = require('../models/InventoryMovement');
const WorkflowCase = require('../models/WorkflowCase');
const { notifyUsers } = require('../utils/workflowNotifications');
const { purgeExpiredArchives, ARCHIVE_PURGE_DAYS } = require('../utils/archivePurge');
const router = require('../routes/workflow');

const orderId = '507f1f77bcf86cd799439011';
const caseId = '507f1f77bcf86cd799439021';
const productId = '507f1f77bcf86cd799439041';
const customerService = { id: 'cs-user', email: 'cs@test.com', role: 'employee', workRole: 'customer_service' };
const boss = { id: 'boss-user', role: 'employee', workRole: 'boss' };
const stockEmployee = { id: '507f1f77bcf86cd7994390bb', email: 'stock@test.com', role: 'employee', workRole: 'stock' };
const DAY = 24 * 60 * 60 * 1000;

const handler = (path: string) => {
  const route = router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods.post);
  return route.route.stack[route.route.stack.length - 1].handle;
};
const archiveOrder = handler('/orders/:id/archive');
const returnOrder = handler('/orders/:id/resume');
const archiveTask = handler('/tasks/:id/archive');
const returnTask = handler('/tasks/:id/resume');
const askToArchive = handler('/tasks/:id/archive-request');
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const query = (value: any) => {
  const q: any = {};
  ['session', 'populate', 'select', 'lean', 'sort', 'limit'].forEach(name => { q[name] = jest.fn(() => q); });
  q.then = (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject);
  return q;
};

let session: any;
beforeEach(() => {
  jest.restoreAllMocks();
  session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

describe('Customer Service archives an order waiting to be confirmed', () => {
  let order: any;
  let validationCase: any;

  beforeEach(() => {
    order = { _id: orderId, status: 'pending', validationStatus: 'pending', operationsArchivedAt: null, archivePurgeAt: null, save: jest.fn() };
    validationCase = { status: 'awaiting_validation', isBlocked: true, history: [], save: jest.fn() };
    jest.spyOn(Order, 'findById').mockImplementation(() => query(order));
    jest.spyOn(WorkflowCase, 'find').mockImplementation(() => query([validationCase]));
  });

  test('it goes to the archive with a date when it is erased', async () => {
    const res = response();
    const before = Date.now();
    await archiveOrder({ params: { id: orderId }, user: customerService, app: {} }, res);

    expect(order.operationsArchivedAt).toBeInstanceOf(Date);
    const purgeIn = order.archivePurgeAt.getTime() - before;
    expect(purgeIn).toBeGreaterThanOrEqual(ARCHIVE_PURGE_DAYS * DAY - 1000);
    expect(purgeIn).toBeLessThanOrEqual(ARCHIVE_PURGE_DAYS * DAY + 1000);
    expect(validationCase.archivedAt).toBeInstanceOf(Date);
    expect(validationCase.archivePurgeAt).toEqual(order.archivePurgeAt);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ archived: true, purgeAt: order.archivePurgeAt }));
  });

  test('Customer Service cannot archive an order that is already confirmed', async () => {
    order.validationStatus = 'approved';
    validationCase.status = 'stock_picking';
    const res = response();
    await archiveOrder({ params: { id: orderId }, user: customerService, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(order.operationsArchivedAt).toBeNull();
  });

  test('stock employees cannot archive', async () => {
    const res = response();
    await archiveOrder({ params: { id: orderId }, user: stockEmployee, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('Customer Service can return it, and then it is no longer erased', async () => {
    order.operationsArchivedAt = new Date();
    order.archivePurgeAt = new Date(Date.now() + DAY);
    validationCase.archivedAt = order.operationsArchivedAt;
    validationCase.archivePurgeAt = order.archivePurgeAt;
    jest.spyOn(WorkflowCase, 'findOne').mockImplementation(() => query(null));
    jest.spyOn(Order, 'updateOne').mockResolvedValue({});
    const res = response();
    await returnOrder({ params: { id: orderId }, user: customerService, app: {} }, res);
    expect(order.operationsArchivedAt).toBeNull();
    expect(order.archivePurgeAt).toBeNull();
    expect(validationCase.archivedAt).toBeNull();
    expect(validationCase.archivePurgeAt).toBeNull();
  });

  test('Customer Service cannot return an order the boss archived', async () => {
    order.operationsArchivedAt = new Date();
    order.archivePurgeAt = null;
    const res = response();
    await returnOrder({ params: { id: orderId }, user: customerService, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(order.operationsArchivedAt).toBeInstanceOf(Date);
  });

  test('the boss can archive a confirmed order an employee asked to archive', async () => {
    order.validationStatus = 'approved';
    validationCase.status = 'printing';
    validationCase.isBlocked = false;
    validationCase.archiveRequest = { requestedAt: new Date(), reason: 'Customer changed their mind' };
    const res = response();
    await archiveOrder({ params: { id: orderId }, user: boss, app: {} }, res);
    expect(order.operationsArchivedAt).toBeInstanceOf(Date);
    // Only incoming orders are erased later.
    expect(order.archivePurgeAt).toBeNull();
    expect(validationCase.archiveRequest).toBeUndefined();
  });
});

describe('an incoming task with no order', () => {
  let task: any;

  beforeEach(() => {
    task = { _id: caseId, orderId: null, status: 'awaiting_validation', requestedName: 'TEST', isBlocked: true, history: [], save: jest.fn() };
    jest.spyOn(WorkflowCase, 'findById').mockImplementation(() => query(task));
  });

  test('Customer Service archives it and returns it', async () => {
    await archiveTask({ params: { id: caseId }, user: customerService }, response());
    expect(task.archivedAt).toBeInstanceOf(Date);
    expect(task.archivePurgeAt).toBeInstanceOf(Date);

    await returnTask({ params: { id: caseId }, user: customerService }, response());
    expect(task.archivedAt).toBeNull();
    expect(task.archivePurgeAt).toBeNull();
    expect(task.isBlocked).toBe(false);
  });
});

describe('an employee asks the boss to archive an order', () => {
  test('the request is saved and the boss is told', async () => {
    const task: any = { _id: caseId, orderId, status: 'stock_picking', requestedName: 'BRA 661', customerId: { name: 'Nadir' }, assignedTo: '507f1f77bcf86cd7994390bb', history: [], save: jest.fn() };
    jest.spyOn(WorkflowCase, 'findById').mockImplementation(() => query(task));
    jest.spyOn(User, 'findById').mockImplementation(() => query({ name: 'Karim' }));
    const res = response();
    await askToArchive({ params: { id: caseId }, body: { reason: 'Duplicate order' }, user: stockEmployee, app: {} }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(task.archiveRequest).toEqual(expect.objectContaining({ requestedBy: '507f1f77bcf86cd7994390bb', requestedByName: 'Karim', reason: 'Duplicate order' }));
    expect(notifyUsers).toHaveBeenCalledWith({}, ['boss-user'], expect.objectContaining({ type: 'archive_requested' }));
  });

  test('a reason is required', async () => {
    const res = response();
    await askToArchive({ params: { id: caseId }, body: { reason: ' ' }, user: stockEmployee, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('archived incoming orders are erased after 14 days', () => {
  test('stock goes back, then the order, its tasks and notifications are erased', async () => {
    const now = new Date();
    const order: any = {
      _id: orderId, status: 'pending', inventoryState: 'reserved', operationsArchivedAt: new Date(now.getTime() - 15 * DAY), operationsArchivedBy: 'cs-user',
      archivePurgeAt: new Date(now.getTime() - DAY),
      items: [{ productId, quantity: 2, stockQuantity: 2, stockPickedQuantity: 0 }]
    };
    jest.spyOn(WorkflowCase, 'find').mockImplementation(() => query([{ _id: 'v1', orderId }, { _id: 'manual', orderId: null }]));
    jest.spyOn(Order, 'findById').mockImplementation(() => query(order));
    jest.spyOn(Product, 'findOneAndUpdate').mockResolvedValue({ _id: productId, stock: 7 });
    jest.spyOn(InventoryMovement, 'create').mockResolvedValue([]);
    jest.spyOn(WorkflowCase, 'deleteMany').mockResolvedValue({});
    jest.spyOn(WorkflowCase, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
    jest.spyOn(Notification, 'deleteMany').mockResolvedValue({});
    jest.spyOn(Order, 'deleteOne').mockResolvedValue({});

    const result = await purgeExpiredArchives(now);

    expect(result).toEqual({ orders: 1, tasks: 1 });
    expect(Product.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: productId, reservedStock: { $gte: 2 } }, { $inc: { stock: 2, reservedStock: -2 } }, expect.anything()
    );
    expect(WorkflowCase.deleteMany).toHaveBeenCalledWith({ orderId }, { session });
    expect(Notification.deleteMany).toHaveBeenCalledWith({ 'data.orderId': orderId }, { session });
    expect(Order.deleteOne).toHaveBeenCalledWith({ _id: orderId }, { session });
    expect(Notification.deleteMany).toHaveBeenCalledWith({ 'data.workflowCaseId': 'manual' });
  });

  test('an order returned from the archive is kept', async () => {
    const now = new Date();
    jest.spyOn(WorkflowCase, 'find').mockImplementation(() => query([{ _id: 'v1', orderId }]));
    jest.spyOn(Order, 'findById').mockImplementation(() => query({ _id: orderId, operationsArchivedAt: null, archivePurgeAt: null }));
    jest.spyOn(Order, 'deleteOne').mockResolvedValue({});
    const result = await purgeExpiredArchives(now);
    expect(result.orders).toBe(0);
    expect(Order.deleteOne).not.toHaveBeenCalled();
  });
});
