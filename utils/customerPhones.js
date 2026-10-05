const { isTabletAccount } = require('./customerTablet');

// One phone per customer account, and the customer activity the owner watches.

const INACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUIRE_APP_SETTING = 'customersNeedPhoneApp';

const MESSAGES = {
  newPhone: 'This account is linked to another phone. Please contact the shop to use this phone.',
  needsApp: 'Please update the Asawer app from the store, then sign in again.',
  webBlocked: 'Customers sign in with the Asawer phone app.',
  phoneMoved: 'This account is now linked to another phone. Please contact the shop.'
};

const textOf = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// The phone details the app sends with a sign-in. Older app versions send none.
const deviceFromBody = (body = {}) => {
  const platform = textOf(body.platform, 20).toLowerCase();
  return {
    deviceId: textOf(body.deviceId, 200),
    deviceName: textOf(body.deviceName, 100),
    platform: ['android', 'ios', 'web'].includes(platform) ? platform : ''
  };
};

// The one-phone lock is paused: every customer can sign in from any phone, the
// website or an old app. Set PHONE_LOCK_ENABLED=true on the server to bring it back.
const isPhoneLockEnabled = () => process.env.PHONE_LOCK_ENABLED === 'true';

const roleOf = user => (user?.isAdmin ? 'admin' : (user?.role || 'user'));

// Only customers are tied to a phone: never admins, employees or the shop tablet.
const isPhoneLockedAccount = user => Boolean(user) && roleOf(user) === 'user' && !isTabletAccount(user);

// What a customer's sign-in does with the phone it comes from.
//   allow      sign in, nothing to remember (no phone details, check not required yet)
//   same       sign in from the linked phone
//   link       sign in and remember this phone (first phone, or no phone yet)
//   new_phone  refused: another phone is linked
//   needs_app  refused: the app is too old to say which phone it is
//   web        refused: customers must use the phone app
const decidePhoneSignIn = ({ user, device = {}, requireApp = false }) => {
  if (!isPhoneLockEnabled() || !isPhoneLockedAccount(user)) return 'allow';
  if (!device.deviceId) {
    if (!requireApp) return 'allow';
    return device.platform === 'web' ? 'web' : 'needs_app';
  }
  if (!user.boundDeviceId) return 'link';
  return user.boundDeviceId === device.deviceId ? 'same' : 'new_phone';
};

const isManagerAccount = user => !isTabletAccount(user) && (
  Boolean(user?.isAdmin) || user?.role === 'admin' || (user?.role === 'employee' && user?.workRole === 'boss')
);

// The owner and the boss always can; other staff only when the owner allowed it.
const canApprovePhoneChanges = user => Boolean(user) && user.isActive !== false && !isTabletAccount(user) && (
  isManagerAccount(user) || (['admin', 'employee'].includes(roleOf(user)) && user.canApprovePhoneChanges === true)
);

// When a customer's current quiet period started: their last order, or sign-up.
const quietSince = (customer, lastOrderAt) => {
  const value = lastOrderAt || customer?.createdAt;
  return value ? new Date(value) : null;
};

const daysSince = (date, now = new Date()) => (date ? Math.floor((now.getTime() - new Date(date).getTime()) / DAY_MS) : null);

const isQuiet = (since, now = new Date(), days = INACTIVE_DAYS) => Boolean(since) && daysSince(since, now) >= days;

// Customers to report now: quiet for 30 days and not yet reported for this quiet period.
const customersToReport = (customers = [], lastOrderByUser = new Map(), now = new Date(), days = INACTIVE_DAYS) =>
  customers
    .map(customer => ({ customer, since: quietSince(customer, lastOrderByUser.get(String(customer._id))) }))
    .filter(({ customer, since }) => isQuiet(since, now, days) && (
      !customer.inactivityReportedFor || new Date(customer.inactivityReportedFor).getTime() !== since.getTime()
    ));

// Counts a new visit when the customer comes back after 30 minutes away. Returns
// the update to store, or null when nothing needs writing yet.
const VISIT_GAP_MS = 30 * 60 * 1000;
const SEEN_WRITE_MS = 5 * 60 * 1000;
const visitUpdate = (lastSeenAt, now = new Date()) => {
  const last = lastSeenAt ? new Date(lastSeenAt).getTime() : 0;
  const gap = now.getTime() - last;
  if (!last || gap >= VISIT_GAP_MS) return { $set: { lastSeenAt: now }, $inc: { visitCount: 1 } };
  if (gap >= SEEN_WRITE_MS) return { $set: { lastSeenAt: now } };
  return null;
};

module.exports = {
  INACTIVE_DAYS,
  MESSAGES,
  REQUIRE_APP_SETTING,
  canApprovePhoneChanges,
  customersToReport,
  daysSince,
  decidePhoneSignIn,
  deviceFromBody,
  isManagerAccount,
  isPhoneLockEnabled,
  isPhoneLockedAccount,
  isQuiet,
  quietSince,
  visitUpdate
};
