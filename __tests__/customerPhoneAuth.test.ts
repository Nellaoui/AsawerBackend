export {};

jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../utils/customerPhoneService', () => ({ getRequireApp: jest.fn(async () => false) }));
jest.mock('../models/User', () => ({ findById: jest.fn(), findOne: jest.fn(), updateOne: jest.fn(async () => ({})) }));

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getRequireApp } = require('../utils/customerPhoneService');
const { auth } = require('../middlewares/auth');

describe('a customer session on a phone that is no longer linked', () => {
  let user: any;
  let response: any;
  let next: jest.Mock;
  const request = () => ({ header: jest.fn(() => 'Bearer signed-token') });

  beforeEach(() => {
    jest.clearAllMocks();
    user = { _id: 'customer-id', email: 'client@example.test', role: 'user', isAdmin: false, isActive: true, boundDeviceId: 'android:new' };
    user.toObject = () => ({ ...user });
    User.findById.mockReturnValue({ select: jest.fn(async () => user) });
    response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test('is signed out after the account moved to another phone', async () => {
    jwt.verify.mockReturnValue({ userId: user._id, did: 'android:old' });
    await auth(request(), response, next);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PHONE_CHANGED' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('keeps working on the linked phone and records the visit', async () => {
    jwt.verify.mockReturnValue({ userId: user._id, did: 'android:new' });
    await auth(request(), response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(User.updateOne).toHaveBeenCalledWith({ _id: user._id }, expect.objectContaining({ $inc: { visitCount: 1 } }));
  });

  test('old sessions keep working until the owner turns the phone lock on', async () => {
    jwt.verify.mockReturnValue({ userId: user._id });
    await auth(request(), response, next);
    expect(next).toHaveBeenCalledTimes(1);

    getRequireApp.mockResolvedValueOnce(true);
    next.mockClear();
    await auth(request(), response, next);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'APP_UPDATE_REQUIRED' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('the shop opening the account on the tablet is not affected', async () => {
    jwt.verify.mockReturnValue({ userId: user._id, isImpersonated: true });
    await auth(request(), response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(User.updateOne).not.toHaveBeenCalled();
  });
});
