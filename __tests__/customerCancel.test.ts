export {};
jest.mock('../utils/workflowNotifications', () => ({
  notifyCaseAssignment: jest.fn(), notifyTaskRemoved: jest.fn(), notifyUsers: jest.fn(async () => []), activeAdminIds: jest.fn(async () => ['boss-1'])
}));
jest.mock('../utils/pushNotification', () => ({ sendPushToUser: jest.fn(async () => null) }));
const mongoose = require('mongoose');
const Order = require('../models/Order');
const { notifyUsers } = require('../utils/workflowNotifications');
const { sendPushToUser } = require('../utils/pushNotification');
const router = require('../routes/orders');

const handler = (path: string, method: string) => router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const cancel = handler('/:id/cancel', 'put');
const reject = handler('/:id/cancel-request/reject', 'post');
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const customer = { id: '507f1f77bcf86cd799439011', role: 'user', email: 'c@test.com' };
const populated = (doc: any) => ({ ...doc, populate: jest.fn(async function (this: any) { return this; }) });

describe('customer cancel', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

  test('after validation the customer press only sends a cancel request to the boss', async () => {
    jest.spyOn(Order, 'findById').mockResolvedValue({ _id: 'order-1', userId: customer.id, status: 'confirmed' } as any);
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(populated({
      _id: 'order-1', orderNumber: 'ASW-1', userId: customer.id, status: 'confirmed', cancelRequest: { status: 'pending', requestedAt: new Date() }
    }) as any);
    const startSession = jest.spyOn(mongoose, 'startSession');
    const res = response();
    await cancel({ params: { id: 'order-1' }, body: { reason: 'Wrong size' }, user: customer, app: {} }, res);
    await new Promise(resolve => setImmediate(resolve));
    expect(startSession).not.toHaveBeenCalled();
    expect(update.mock.calls[0][1]).toMatchObject({ $set: { cancelRequest: { status: 'pending', reason: 'Wrong size' } } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirmed' }));
    expect(notifyUsers).toHaveBeenCalledWith({}, ['boss-1'], expect.objectContaining({ type: 'cancel_requested' }));
  });

  test('a shipped order can not be cancelled or requested', async () => {
    jest.spyOn(Order, 'findById').mockResolvedValue({ _id: 'order-1', userId: customer.id, status: 'shipped' } as any);
    const update = jest.spyOn(Order, 'findOneAndUpdate');
    const res = response();
    await cancel({ params: { id: 'order-1' }, body: {}, user: customer, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(update).not.toHaveBeenCalled();
  });

  test('refusing a request keeps the order going and tells the customer', async () => {
    const order = { _id: { toString: () => 'order-1' }, userId: customer.id, status: 'confirmed', cancelRequest: { status: 'rejected' } };
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(order as any);
    const res = response();
    await reject({ params: { id: 'order-1' }, body: { note: 'Already printed' }, user: { id: 'boss-1' }, app: {} }, res);
    expect(update.mock.calls[0][0]).toMatchObject({ 'cancelRequest.status': 'pending' });
    expect(res.json).toHaveBeenCalledWith(order);
    expect(sendPushToUser).toHaveBeenCalledWith(expect.anything(), customer.id, 'Cancel request refused', expect.stringContaining('Already printed'), expect.anything());
  });
});
