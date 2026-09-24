export {};

jest.mock('../utils/workflowNotifications', () => ({
  notifyCaseAssignment: jest.fn(async () => {}),
  notifyFailedPrint: jest.fn(async () => {}),
  notifyOrderBlocked: jest.fn(async () => {}),
  notifyTaskRemoved: jest.fn(async () => {})
}));

const mongoose = require('mongoose');
const Order = require('../models/Order');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/workflow');

const orderId = '507f1f77bcf86cd799439011';
const handler = (path: string) => {
  const route = router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods.post);
  return route.route.stack[route.route.stack.length - 1].handle;
};
const archive = handler('/orders/:id/archive');
const resume = handler('/orders/:id/resume');
const createCase = handler('/cases');
const transition = handler('/cases/:id/transition');
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const request = () => ({ params: { id: orderId }, user: { id: 'manager-id', role: 'admin', isAdmin: true }, app: {} });

describe('blocked order archive and resume', () => {
  let session: any;
  let order: any;
  let cases: any[];

  beforeEach(() => {
    session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    order = { _id: orderId, operationsArchivedAt: null, operationsArchivedBy: null, save: jest.fn() };
    cases = [
      { isBlocked: true, status: 'quality_check', history: [], save: jest.fn() },
      { isBlocked: false, status: 'stock_picking', history: [], save: jest.fn() }
    ];
    jest.spyOn(Order, 'findById').mockReturnValue({ session: jest.fn(async () => order) } as any);
    jest.spyOn(WorkflowCase, 'find').mockReturnValue({ session: jest.fn(async () => cases) } as any);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test('archives every task of a blocked order and preserves its history', async () => {
    const res = response();
    await archive(request(), res);
    expect(res.json).toHaveBeenCalledWith({ orderId, archived: true });
    expect(order.operationsArchivedAt).toBeInstanceOf(Date);
    expect(cases.every(item => item.archivedAt instanceof Date)).toBe(true);
    expect(cases.every(item => item.history[0].action === 'order_archived')).toBe(true);
    expect(cases.every(item => item.save.mock.calls[0][0].session === session)).toBe(true);
    expect(session.endSession).toHaveBeenCalled();
  });

  test('does not archive an order that has no blocked active task', async () => {
    cases[0].isBlocked = false;
    const res = response();
    await archive(request(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(order.save).not.toHaveBeenCalled();
    expect(cases[0].save).not.toHaveBeenCalled();
  });

  test('does not add new tasks to an archived order', async () => {
    order.operationsArchivedAt = new Date();
    (Order.findById as jest.Mock).mockResolvedValue(order);
    const create = jest.spyOn(WorkflowCase, 'create');
    const res = response();
    await createCase({ ...request(), body: { orderId, requestedName: 'Replacement part', quantity: 1 } }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(create).not.toHaveBeenCalled();
  });

  test('resuming returns archived tasks to the queue and clears their block', async () => {
    order.operationsArchivedAt = new Date();
    cases.forEach(item => { item.archivedAt = new Date(); item.archivedBy = 'manager-id'; item.assignedTo = 'employee-id'; });
    cases[0].blockedReason = 'Material missing';
    (WorkflowCase.find as jest.Mock).mockImplementation((query: any) => query.archivedAt
      ? { session: jest.fn(async () => cases) }
      : { select: jest.fn(async () => cases) });
    jest.spyOn(Order, 'updateOne').mockResolvedValue({} as any);
    const res = response();
    await resume(request(), res);
    expect(res.json).toHaveBeenCalledWith({ orderId, archived: false });
    expect(order.operationsArchivedAt).toBeNull();
    expect(cases[0].isBlocked).toBe(false);
    expect(cases[0].blockedReason).toBe('');
    expect(cases[0].stageQueuedAt).toBeInstanceOf(Date);
    expect(cases.every(item => item.archivedAt === null)).toBe(true);
    expect(cases.every(item => item.history[0].action === 'order_resumed')).toBe(true);
  });
});

describe('quality reprint request', () => {
  let workflowCase: any;

  beforeEach(() => {
    workflowCase = {
      _id: orderId,
      orderId: null,
      status: 'quality_check',
      assignedTeam: 'wax_print',
      assignedTo: 'manager-id',
      productionMethod: 'wax',
      priority: 'normal',
      quantity: 3,
      print: { machineId: 'OLD', sentAt: new Date(), startedAt: new Date(), completedAt: new Date() },
      history: [],
      save: jest.fn()
    };
    const populatedQuery = { populate: jest.fn().mockReturnThis() };
    jest.spyOn(WorkflowCase, 'findById')
      .mockResolvedValueOnce(workflowCase)
      .mockReturnValueOnce(populatedQuery as any);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test('sends only named parts and quantities to the printer queue', async () => {
    const res = response();
    await transition({ ...request(), body: {
      status: 'ready_to_print',
      reprintParts: [{ code: 'A', quantity: 2 }, { code: 'F', quantity: 1 }],
      note: 'Two clasps failed inspection'
    } }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(workflowCase.status).toBe('ready_to_print');
    expect(workflowCase.reprintParts).toEqual([{ code: 'A', quantity: 2 }, { code: 'F', quantity: 1 }]);
    expect(workflowCase.reprintReason).toBe('Two clasps failed inspection');
    expect(workflowCase.print.machineId).toBe('');
    expect(workflowCase.history[0].note).toMatch(/A x2, F x1/);
    expect(workflowCase.save).toHaveBeenCalled();
  });

  test('refuses a quality reprint without specified parts', async () => {
    const res = response();
    await transition({ ...request(), body: { status: 'ready_to_print', note: 'Poor finish' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(workflowCase.save).not.toHaveBeenCalled();
  });
});
