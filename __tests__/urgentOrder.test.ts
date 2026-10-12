export {};

jest.mock('../utils/workflowNotifications', () => ({
  activeAdminIds: jest.fn(async () => []),
  notifyCaseAssignment: jest.fn(async () => {}),
  notifyFailedPrint: jest.fn(async () => {}),
  notifyOrderBlocked: jest.fn(async () => {}),
  notifyTaskRemoved: jest.fn(async () => {}),
  notifyUser: jest.fn(async () => {}),
  notifyUsers: jest.fn(async () => {})
}));

const Order = require('../models/Order');
const WorkflowCase = require('../models/WorkflowCase');
const { notifyUsers } = require('../utils/workflowNotifications');
const { canNotifyUser } = require('../utils/notificationPolicy');
const router = require('../routes/workflow');

const orderId = '507f1f77bcf86cd799439011';
const customerService = { id: 'cs-user', name: 'Sara', role: 'employee', workRole: 'customer_service' };
const boss = { id: 'boss-user', role: 'employee', workRole: 'boss' };
const waxEmployee = { id: 'wax-user', role: 'employee', workRole: 'wax_print' };

const route = router.stack.find((layer: any) => layer.route?.path === '/orders/:id/urgent' && layer.route.methods.post);
const handle = route.route.stack[route.route.stack.length - 1].handle;
const response = () => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), once: jest.fn() };
  return res;
};
const query = (value: any) => {
  const q: any = {};
  ['select', 'lean'].forEach(name => { q[name] = jest.fn(() => q); });
  q.then = (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject);
  return q;
};

let orderUpdate: jest.SpyInstance;
let caseUpdate: jest.SpyInstance;
beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(Order, 'findById').mockImplementation(() => query({ _id: orderId, orderNumber: 'ASW-1', status: 'pending' }));
  orderUpdate = jest.spyOn(Order, 'updateOne').mockResolvedValue({});
  caseUpdate = jest.spyOn(WorkflowCase, 'updateMany').mockResolvedValue({});
  jest.spyOn(WorkflowCase, 'find').mockImplementation(() => query([{ assignedTo: 'wax-user', requestedName: 'Ring' }]));
});

describe('Urgent orders', () => {
  test('Customer Service marks an order urgent: every open task is urgent and the team is told after the answer', async () => {
    const res = response();
    await handle({ params: { id: orderId }, body: { urgent: true }, user: customerService, app: {} }, res);
    expect(orderUpdate.mock.calls[0][1].$set.urgent).toMatchObject({ on: true, byName: 'Sara' });
    expect(caseUpdate.mock.calls[0][1].$set).toEqual({ priority: 'urgent' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ urgent: expect.objectContaining({ on: true }) }));
    expect(notifyUsers).not.toHaveBeenCalled();
    await res.once.mock.calls[0][1]();
    expect(notifyUsers).toHaveBeenCalledWith({}, ['wax-user'], expect.objectContaining({ type: 'order_urgent' }));
  });

  test('turning it off puts only the urgent tasks back to normal', async () => {
    const res = response();
    await handle({ params: { id: orderId }, body: { urgent: false }, user: boss, app: {} }, res);
    expect(orderUpdate.mock.calls[0][1].$set.urgent.on).toBe(false);
    expect(caseUpdate.mock.calls[0][0]).toMatchObject({ priority: 'urgent' });
    expect(caseUpdate.mock.calls[0][1].$set).toEqual({ priority: 'normal' });
    expect(res.once).not.toHaveBeenCalled();
  });

  test('other employees cannot mark an order urgent', async () => {
    const res = response();
    await handle({ params: { id: orderId }, body: { urgent: true }, user: waxEmployee, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  test('a cancelled order cannot be made urgent', async () => {
    jest.spyOn(Order, 'findById').mockImplementation(() => query({ _id: orderId, status: 'cancelled' }));
    const res = response();
    await handle({ params: { id: orderId }, body: { urgent: true }, user: customerService, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('employees are sent the urgent alert', () => {
    expect(canNotifyUser({ role: 'employee' }, 'order_urgent')).toBe(true);
  });
});
