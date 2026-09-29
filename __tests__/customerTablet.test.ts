export {};

jest.mock('jsonwebtoken', () => ({ verify: jest.fn(), sign: jest.fn(() => 'signed-token') }));
jest.mock('../models/User', () => ({ findById: jest.fn(), find: jest.fn(), updateOne: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/AuditLog', () => ({ create: jest.fn(), find: jest.fn() }));

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/admin');
const { adminAuth, operationsAuth, tabletAuth } = require('../middlewares/auth');
const { isTabletAccount } = require('../utils/customerTablet');

const customerId = '507f1f77bcf86cd799439021';
const account = (fields: any) => ({ ...fields, toObject() { return { ...fields }; } });
const tablet = account({ _id: 'tablet-1', name: 'Shop tablet', email: 'Tablet@Shop.test', isAdmin: true, role: 'admin', isActive: true });
const owner = account({ _id: 'admin-1', name: 'Owner', email: 'owner@shop.test', isAdmin: true, role: 'admin', isActive: true });
const customer = (extra = {}) => ({ _id: customerId, name: 'Amina', email: 'amina@test.com', role: 'user', isAdmin: false, isActive: true, ...extra });

// Runs a route's whole middleware chain with `signedIn` as the account behind the token.
const run = async (method: string, path: string, signedIn: any, req: any = {}) => {
  jwt.verify.mockReturnValue({ userId: signedIn._id });
  User.findById.mockImplementation((id: string) => ({
    select: jest.fn(async () => (id === signedIn._id ? signedIn : req.target))
  }));
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  const handlers = layer.route.stack.map((s: any) => s.handle);
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn() };
  const fullReq = { header: () => 'Bearer token', params: {}, body: {}, ...req };
  for (const handle of handlers) {
    let advanced = false;
    await handle(fullReq, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
};

describe('customer accounts on the shop tablet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production', CUSTOMER_TABLET_ADMINS: ' tablet@shop.test , ', JWT_SECRET: 'test-secret' });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test('only the listed admin account is the tablet account', () => {
    expect(isTabletAccount(tablet)).toBe(true);
    expect(isTabletAccount(owner)).toBe(false);
    expect(isTabletAccount({ ...tablet, isAdmin: false })).toBe(false);
    jest.replaceProperty(process, 'env', { ...process.env, CUSTOMER_TABLET_ADMINS: '' });
    expect(isTabletAccount(tablet)).toBe(false);
  });

  test.each([['admin', adminAuth], ['operations', operationsAuth]])('the tablet account loses %s rights', async (_name, middleware) => {
    jwt.verify.mockReturnValue({ userId: tablet._id });
    User.findById.mockReturnValue({ select: jest.fn(async () => tablet) });
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await middleware({ header: () => 'Bearer token' }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('an ordinary admin cannot open a customer account', async () => {
    const res = await run('post', '/impersonate/:userId', owner, { params: { userId: customerId }, target: customer() });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  test('an open customer session cannot open another account', async () => {
    jwt.verify.mockReturnValue({ userId: tablet._id, isImpersonated: true });
    User.findById.mockReturnValue({ select: jest.fn(async () => tablet) });
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await tabletAuth({ header: () => 'Bearer token' }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('a hidden customer cannot be opened', async () => {
    const res = await run('post', '/impersonate/:userId', tablet, { params: { userId: customerId }, target: customer({ hiddenFromTablet: true }) });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  test('opening a customer is recorded before the session is handed out', async () => {
    const res = await run('post', '/impersonate/:userId', tablet, { params: { userId: customerId }, target: customer() });
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      category: 'access',
      actorId: 'tablet-1',
      entityId: customerId,
      details: expect.objectContaining({ customerName: 'Amina', adminName: 'Shop tablet' })
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, token: 'signed-token' }));
  });

  test('no session is handed out when the record cannot be written', async () => {
    AuditLog.create.mockRejectedValueOnce(new Error('db down'));
    const res = await run('post', '/impersonate/:userId', tablet, { params: { userId: customerId }, target: customer() });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ token: expect.anything() }));
  });

  test('the tablet list leaves out hidden customers and the connection history', async () => {
    const lean = jest.fn(async () => [customer()]);
    User.find.mockReturnValue({ select: () => ({ sort: () => ({ lean }) }) });
    const res = await run('get', '/tablet/customers', tablet);
    expect(User.find).toHaveBeenCalledWith(expect.objectContaining({ hiddenFromTablet: { $ne: true } }));
    expect(AuditLog.find).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recent: [] }));
  });

  test('an admin can hide a customer, the tablet account cannot', async () => {
    const denied = await run('patch', '/tablet/customers/:userId', tablet, { params: { userId: customerId }, body: { hidden: true }, target: customer() });
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(User.updateOne).not.toHaveBeenCalled();

    const res = await run('patch', '/tablet/customers/:userId', owner, { params: { userId: customerId }, body: { hidden: true }, target: customer() });
    expect(User.updateOne).toHaveBeenCalledWith({ _id: customerId }, { $set: { hiddenFromTablet: true } });
    expect(res.json).toHaveBeenCalledWith({ id: customerId, hidden: true });
  });
});
