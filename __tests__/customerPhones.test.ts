export {};

const {
  canApprovePhoneChanges,
  customersToReport,
  decidePhoneSignIn,
  deviceFromBody,
  visitUpdate
} = require('../utils/customerPhones');

const customer = (extra = {}) => ({ _id: 'c1', role: 'user', isAdmin: false, email: 'client@example.test', ...extra });
const DAY = 24 * 60 * 60 * 1000;

describe('one phone per customer account', () => {
  beforeAll(() => { process.env.PHONE_LOCK_ENABLED = 'true'; });
  afterAll(() => { delete process.env.PHONE_LOCK_ENABLED; });
  const phone = { deviceId: 'android:aaa', deviceName: 'Samsung A51', platform: 'android' };

  test('the first phone is remembered', () => {
    expect(decidePhoneSignIn({ user: customer(), device: phone })).toBe('link');
  });

  test('the same phone signs in', () => {
    expect(decidePhoneSignIn({ user: customer({ boundDeviceId: 'android:aaa' }), device: phone })).toBe('same');
  });

  test('another phone is refused', () => {
    expect(decidePhoneSignIn({ user: customer({ boundDeviceId: 'android:bbb' }), device: phone })).toBe('new_phone');
  });

  test('old app versions still sign in until the owner turns the lock on', () => {
    const user = customer({ boundDeviceId: 'android:bbb' });
    expect(decidePhoneSignIn({ user, device: {}, requireApp: false })).toBe('allow');
    expect(decidePhoneSignIn({ user, device: {}, requireApp: true })).toBe('needs_app');
    expect(decidePhoneSignIn({ user, device: { platform: 'web' }, requireApp: true })).toBe('web');
  });

  test('admins, employees and the shop tablet are never tied to a phone', () => {
    process.env.CUSTOMER_TABLET_ADMINS = 'tablet@example.test';
    const bound = { boundDeviceId: 'android:bbb' };
    expect(decidePhoneSignIn({ user: { ...bound, isAdmin: true, role: 'admin', email: 'owner@example.test' }, device: phone, requireApp: true })).toBe('allow');
    expect(decidePhoneSignIn({ user: { ...bound, role: 'employee', email: 'staff@example.test' }, device: phone, requireApp: true })).toBe('allow');
    expect(decidePhoneSignIn({ user: { ...bound, isAdmin: true, role: 'admin', email: 'tablet@example.test' }, device: {}, requireApp: true })).toBe('allow');
    delete process.env.CUSTOMER_TABLET_ADMINS;
  });

  test('only well-formed phone details are kept', () => {
    expect(deviceFromBody({ deviceId: '  x  ', deviceName: 5, platform: 'Android' })).toEqual({ deviceId: 'x', deviceName: '', platform: 'android' });
    expect(deviceFromBody({ deviceId: { $ne: '' }, platform: 'toaster' })).toEqual({ deviceId: '', deviceName: '', platform: '' });
  });
});

describe('who can approve a new phone', () => {
  test('owner and boss always, other staff only when allowed, customers never', () => {
    expect(canApprovePhoneChanges({ isAdmin: true, role: 'admin', email: 'owner@example.test' })).toBe(true);
    expect(canApprovePhoneChanges({ role: 'employee', workRole: 'boss' })).toBe(true);
    expect(canApprovePhoneChanges({ role: 'employee', workRole: 'customer_service' })).toBe(false);
    expect(canApprovePhoneChanges({ role: 'employee', workRole: 'customer_service', canApprovePhoneChanges: true })).toBe(true);
    expect(canApprovePhoneChanges({ role: 'employee', canApprovePhoneChanges: true, isActive: false })).toBe(false);
    expect(canApprovePhoneChanges({ role: 'user', canApprovePhoneChanges: true })).toBe(false);
  });
});

describe('customers without an order for 30 days', () => {
  const now = new Date('2026-10-30T12:00:00Z');

  test('reported once per quiet period', () => {
    const lastOrder = new Date(now.getTime() - 31 * DAY);
    const customers = [
      customer({ _id: 'quiet', createdAt: new Date('2026-01-01') }),
      customer({ _id: 'recent', createdAt: new Date('2026-01-01') }),
      customer({ _id: 'new', createdAt: new Date(now.getTime() - 5 * DAY) }),
      customer({ _id: 'never', createdAt: new Date(now.getTime() - 40 * DAY) }),
      customer({ _id: 'told', createdAt: new Date('2026-01-01'), inactivityReportedFor: lastOrder })
    ];
    const lastOrders = new Map<string, Date>([
      ['quiet', lastOrder],
      ['recent', new Date(now.getTime() - 3 * DAY)],
      ['told', lastOrder]
    ]);
    const due = customersToReport(customers, lastOrders, now).map((row: any) => row.customer._id);
    expect(due).toEqual(['quiet', 'never']);
  });

  test('a customer who orders again and goes quiet again is reported again', () => {
    const oldOrder = new Date(now.getTime() - 90 * DAY);
    const newOrder = new Date(now.getTime() - 30 * DAY);
    const due = customersToReport(
      [customer({ _id: 'back', createdAt: new Date('2026-01-01'), inactivityReportedFor: oldOrder })],
      new Map([['back', newOrder]]),
      now
    );
    expect(due).toHaveLength(1);
  });
});

describe('customer visits', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  test('a new visit after 30 minutes away, no write within 5 minutes', () => {
    expect(visitUpdate(null, now)).toEqual({ $set: { lastSeenAt: now }, $inc: { visitCount: 1 } });
    expect(visitUpdate(new Date(now.getTime() - 31 * 60 * 1000), now)).toHaveProperty('$inc');
    expect(visitUpdate(new Date(now.getTime() - 10 * 60 * 1000), now)).toEqual({ $set: { lastSeenAt: now } });
    expect(visitUpdate(new Date(now.getTime() - 60 * 1000), now)).toBeNull();
  });
});

describe('phone lock paused (default)', () => {
  it('lets every customer sign in from any phone, the website or an old app', () => {
    delete process.env.PHONE_LOCK_ENABLED;
    const bound = customer({ boundDeviceId: 'android:aaa' });
    expect(decidePhoneSignIn({ user: bound, device: { deviceId: 'android:bbb', platform: 'android' }, requireApp: true })).toBe('allow');
    expect(decidePhoneSignIn({ user: bound, device: { platform: 'web' }, requireApp: true })).toBe('allow');
  });
});
