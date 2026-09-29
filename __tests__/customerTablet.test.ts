export {};

jest.mock('../models/User', () => ({ findById: jest.fn(), find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/AuditLog', () => ({ create: jest.fn(), find: jest.fn() }));

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/admin');
const { canUseCustomerTablet } = require('../utils/customerTablet');

// Skip adminAuth (tested elsewhere) and run the remaining handlers in order.
const run = async (method: string, path: string, req: any) => {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  const handlers = layer.route.stack.slice(1).map((s: any) => s.handle);
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn() };
  for (const handle of handlers) {
    let advanced = false;
    await handle(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
};

const owner = { _id: 'admin-1', name: 'Owner', email: 'Owner@Shop.test', isAdmin: true };
const otherAdmin = { _id: 'admin-2', name: 'Other', email: 'other@shop.test', isAdmin: true };
const customerId = '507f1f77bcf86cd799439021';
const customer = (extra = {}) => ({ _id: customerId, name: 'Amina', email: 'amina@test.com', role: 'user', isAdmin: false, isActive: true, ...extra });

describe('customer tablet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(process, 'env', { ...process.env, CUSTOMER_TABLET_ADMINS: ' owner@shop.test , ', JWT_SECRET: 'test-secret' });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test('only the listed admin holds the permission', () => {
    expect(canUseCustomerTablet(owner)).toBe(true);
    expect(canUseCustomerTablet(otherAdmin)).toBe(false);
    expect(canUseCustomerTablet({ ...owner, isAdmin: false })).toBe(false);
    jest.replaceProperty(process, 'env', { ...process.env, CUSTOMER_TABLET_ADMINS: '' });
    expect(canUseCustomerTablet(owner)).toBe(false);
  });

  test('another admin cannot open a customer account', async () => {
    const res = await run('post', '/impersonate/:userId', { user: otherAdmin, params: { userId: customerId } });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(User.findById).not.toHaveBeenCalled();
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  test('a hidden customer cannot be opened', async () => {
    User.findById.mockReturnValue({ select: jest.fn(async () => customer({ hiddenFromTablet: true })) });
    const res = await run('post', '/impersonate/:userId', { user: owner, params: { userId: customerId } });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  test('opening a customer is recorded before the session is handed out', async () => {
    User.findById.mockReturnValue({ select: jest.fn(async () => customer()) });
    const res = await run('post', '/impersonate/:userId', { user: owner, params: { userId: customerId } });
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      category: 'access',
      actorId: 'admin-1',
      entityId: customerId,
      details: expect.objectContaining({ customerName: 'Amina', adminName: 'Owner' })
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, token: expect.any(String) }));
  });

  test('no session is handed out when the record cannot be written', async () => {
    User.findById.mockReturnValue({ select: jest.fn(async () => customer()) });
    AuditLog.create.mockRejectedValueOnce(new Error('db down'));
    const res = await run('post', '/impersonate/:userId', { user: owner, params: { userId: customerId } });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ token: expect.anything() }));
  });

  test('the tablet admin can hide a customer, another admin cannot', async () => {
    User.findById.mockReturnValue({ select: jest.fn(async () => customer()) });
    const denied = await run('patch', '/tablet/customers/:userId', { user: otherAdmin, params: { userId: customerId }, body: { hidden: true } });
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(User.updateOne).not.toHaveBeenCalled();

    const res = await run('patch', '/tablet/customers/:userId', { user: owner, params: { userId: customerId }, body: { hidden: true } });
    expect(User.updateOne).toHaveBeenCalledWith({ _id: customerId }, { $set: { hiddenFromTablet: true } });
    expect(res.json).toHaveBeenCalledWith({ id: customerId, hidden: true });
  });

  test('staff accounts cannot be hidden or listed as customers', async () => {
    User.findById.mockReturnValue({ select: jest.fn(async () => customer({ role: 'employee' })) });
    const res = await run('patch', '/tablet/customers/:userId', { user: owner, params: { userId: customerId }, body: { hidden: true } });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(User.updateOne).not.toHaveBeenCalled();
  });
});
