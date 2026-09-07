export {};

jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }), { virtual: true });
jest.mock('../models/User', () => ({ findById: jest.fn(), findOne: jest.fn() }));

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { operationsAuth } = require('../middlewares/auth');

describe('deployed inventory authorization', () => {
  let user: any;
  let response: any;
  let next: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
    user = { _id: 'employee-id', name: 'Stock employee', email: 'employee@example.test', role: 'employee', isAdmin: false, isActive: true };
    user.toObject = () => ({ ...user });
    User.findById.mockReturnValue({ select: jest.fn(async () => user) });
    User.findOne.mockImplementation(async () => user);
    jwt.verify.mockReturnValue({ userId: user._id });
    response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const request = (token?: string) => ({ header: jest.fn(() => token ? `Bearer ${token}` : undefined) });

  test('requires a login', async () => {
    await operationsAuth(request(), response, next);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test.each(['production', 'test', undefined])('rejects development tokens outside explicit development mode (%s)', async environment => {
    // The Node backend may omit NODE_ENV; Expo's app-only type declares it required.
    jest.replaceProperty(process as { env: Record<string, string | undefined> }, 'env', { ...process.env, NODE_ENV: environment });
    await operationsAuth(request('test-token-employee@example.test'), response, next);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(User.findOne).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('permits a signed-in employee', async () => {
    await operationsAuth(request('valid-signed-token'), response, next);
    expect(jwt.verify).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('permits a signed-in admin', async () => {
    user.isAdmin = true;
    user.role = 'admin';
    await operationsAuth(request('valid-signed-token'), response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('denies customers', async () => {
    user.role = 'user';
    await operationsAuth(request('valid-signed-token'), response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('denies impersonated sessions even if their account is later promoted', async () => {
    jwt.verify.mockReturnValue({ userId: user._id, isImpersonated: true });
    await operationsAuth(request('valid-signed-token'), response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('denies inactive accounts', async () => {
    user.isActive = false;
    await operationsAuth(request('valid-signed-token'), response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
