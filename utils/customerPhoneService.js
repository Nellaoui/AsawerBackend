const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const AppSetting = require('../models/AppSetting');
const PhoneChangeRequest = require('../models/PhoneChangeRequest');
const { notifyUsers } = require('./workflowNotifications');
const { isTabletAccount } = require('./customerTablet');
const {
  INACTIVE_DAYS,
  REQUIRE_APP_SETTING,
  canApprovePhoneChanges,
  customersToReport
} = require('./customerPhones');

let requireAppCache = { value: false, at: 0 };

// Whether customers must sign in from an app version that says which phone it is.
// Off until the owner turns it on, so current app versions keep working.
const getRequireApp = async () => {
  if (Date.now() - requireAppCache.at < 30 * 1000) return requireAppCache.value;
  // Checked on customer requests: never wait on a database that is not connected.
  if (mongoose.connection.readyState !== 1) return requireAppCache.value;
  const setting = await AppSetting.findOne({ key: REQUIRE_APP_SETTING }).lean();
  requireAppCache = { value: setting?.value === true, at: Date.now() };
  return requireAppCache.value;
};

const setRequireApp = async (value, userId) => {
  await AppSetting.findOneAndUpdate(
    { key: REQUIRE_APP_SETTING },
    { $set: { value: value === true, updatedBy: userId, updatedAt: new Date() } },
    { upsert: true }
  );
  requireAppCache = { value: value === true, at: Date.now() };
};

const approverIds = async () => {
  const staff = await User.find({
    $or: [{ isAdmin: true }, { role: 'admin' }, { role: 'employee' }],
    isActive: { $ne: false }
  }).select('_id email isAdmin role workRole isActive canApprovePhoneChanges').lean();
  return staff.filter(canApprovePhoneChanges).map(user => user._id);
};

const customerLabel = user => user.name || user.email;

// A customer tried another phone: keep one open request per customer and tell
// the people who can approve it.
const recordPhoneRequest = async (app, user, device) => {
  const request = await PhoneChangeRequest.findOneAndUpdate(
    { user: user._id, status: 'pending' },
    {
      $set: {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        previousDeviceName: user.boundDeviceName || '',
        lastAttemptAt: new Date()
      },
      $inc: { attempts: 1 },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const phone = device.deviceName ? ` (${device.deviceName})` : '';
  await notifyUsers(app, await approverIds(), {
    title: 'Phone change request',
    body: `${customerLabel(user)} is trying to sign in from a new phone${phone}. Approve or reject it in the portal.`,
    type: 'phone_change_request',
    data: { phoneChangeRequestId: String(request._id), customerId: String(user._id) },
    // One notification per new phone, not one per attempt.
    dedupeKey: `phone-request:${request._id}:${device.deviceId}`
  });
  return request;
};

const lastOrderDates = async (customerIds) => {
  const keys = customerIds.map(String);
  const rows = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    { $group: { _id: { $toString: '$userId' }, lastOrderAt: { $max: '$createdAt' }, orderCount: { $sum: 1 } } },
    { $match: { _id: { $in: keys } } }
  ]);
  return new Map(rows.map(row => [row._id, row]));
};

const customerFilter = { isAdmin: { $ne: true }, role: { $nin: ['admin', 'employee'] } };

// Tell the approvers once about each customer who has not ordered for 30 days.
const checkInactiveCustomers = async (app, now = new Date()) => {
  const customers = (await User.find({ ...customerFilter, isActive: { $ne: false } })
    .select('_id name email createdAt inactivityReportedFor isAdmin role')
    .lean()).filter(customer => !isTabletAccount(customer));
  if (!customers.length) return [];

  const orders = await lastOrderDates(customers.map(customer => customer._id));
  const lastOrders = new Map([...orders].map(([id, row]) => [id, row.lastOrderAt]));
  const due = customersToReport(customers, lastOrders, now, INACTIVE_DAYS);
  if (!due.length) return [];

  const names = due.map(({ customer }) => customerLabel(customer));
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
  await notifyUsers(app, await approverIds(), {
    title: due.length === 1 ? '1 customer has not ordered for 30 days' : `${due.length} customers have not ordered for 30 days`,
    body: `${shown}. Open Customers in the portal to see them.`,
    type: 'customer_inactive',
    data: { customerIds: due.map(({ customer }) => String(customer._id)).slice(0, 50) },
    dedupeKey: `customers-inactive:${now.toISOString().slice(0, 13)}`
  });

  await User.bulkWrite(due.map(({ customer, since }) => ({
    updateOne: { filter: { _id: customer._id }, update: { $set: { inactivityReportedFor: since } } }
  })));
  return due;
};

let inactivityInterval = null;
const startInactivityNotifier = app => {
  if (inactivityInterval) return;
  const run = () => checkInactiveCustomers(app).catch(error => console.error('❌ Customer inactivity check failed:', error));
  const initial = setTimeout(run, 60 * 1000);
  initial.unref?.();
  inactivityInterval = setInterval(run, 6 * 60 * 60 * 1000);
  inactivityInterval.unref?.();
};

module.exports = {
  approverIds,
  checkInactiveCustomers,
  customerFilter,
  getRequireApp,
  lastOrderDates,
  recordPhoneRequest,
  setRequireApp,
  startInactivityNotifier
};
