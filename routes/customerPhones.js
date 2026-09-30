const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const PhoneChangeRequest = require('../models/PhoneChangeRequest');
const { operationsAuth } = require('../middlewares/auth');
const { isTabletAccount } = require('../utils/customerTablet');
const {
  INACTIVE_DAYS,
  canApprovePhoneChanges,
  daysSince,
  isManagerAccount,
  isQuiet,
  quietSince
} = require('../utils/customerPhones');
const { customerFilter, getRequireApp, lastOrderDates, setRequireApp } = require('../utils/customerPhoneService');

const router = express.Router();

// Phone change requests and customer activity: the owner, the boss, and the
// staff the owner allowed.
const approverAuth = (req, res, next) => operationsAuth(req, res, () => {
  if (!canApprovePhoneChanges(req.user)) {
    return res.status(403).json({ message: 'You are not allowed to handle customer phones.' });
  }
  return next();
});

// Choosing who can approve, and the app setting: the owner and the boss only.
const managerAuth = (req, res, next) => operationsAuth(req, res, () => {
  if (!isManagerAccount(req.user)) {
    return res.status(403).json({ message: 'Only the owner can change this.' });
  }
  return next();
});

const validId = id => mongoose.Types.ObjectId.isValid(id);

const audit = (req, action, entityType, entityId, details = {}) => AuditLog.create({
  category: 'access',
  action,
  actorId: req.user._id,
  entityType,
  entityId: String(entityId),
  details
}).catch(error => console.error('❌ Audit log failed:', error));

const customerSummary = user => user && ({
  id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone || '',
  linkedPhone: user.boundDeviceName || (user.boundDeviceId ? 'Phone' : ''),
  linkedAt: user.boundDeviceAt || null
});

router.get('/requests', approverAuth, async (req, res) => {
  try {
    const requests = await PhoneChangeRequest.find({ status: 'pending' })
      .sort({ lastAttemptAt: -1 })
      .limit(200)
      .populate('user', 'name email phone boundDeviceId boundDeviceName boundDeviceAt')
      .lean();
    res.json(requests.filter(request => request.user).map(request => ({
      id: request._id,
      customer: customerSummary(request.user),
      newPhone: request.deviceName || 'Unknown phone',
      attempts: request.attempts,
      createdAt: request.createdAt,
      lastAttemptAt: request.lastAttemptAt
    })));
  } catch (error) {
    console.error('❌ Phone requests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

const decide = approve => async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ message: 'Invalid request' });
    const request = await PhoneChangeRequest.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: approve ? 'approved' : 'rejected', decidedBy: req.user._id, decidedAt: new Date() } },
      { new: true }
    );
    if (!request) return res.status(404).json({ message: 'This request was already handled.' });

    if (approve) {
      // The new phone replaces the old one; the old phone is signed out.
      await User.updateOne(
        { _id: request.user },
        { $set: { boundDeviceId: request.deviceId, boundDeviceName: request.deviceName, boundDeviceAt: new Date() } }
      );
    }
    audit(req, approve ? 'phone_change_approved' : 'phone_change_rejected', 'User', request.user, {
      newPhone: request.deviceName,
      previousPhone: request.previousDeviceName
    });
    res.json({ ok: true, status: request.status });
  } catch (error) {
    console.error('❌ Phone request decision error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

router.post('/requests/:id/approve', approverAuth, decide(true));
router.post('/requests/:id/reject', approverAuth, decide(false));

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every customer with their last visit and last order, quiet ones first.
router.get('/customers', approverAuth, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 80);
    const filter = { ...customerFilter };
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
    }
    const customers = (await User.find(filter)
      .select('name email phone isActive isAdmin role createdAt lastSeenAt visitCount boundDeviceId boundDeviceName boundDeviceAt')
      .lean()).filter(customer => !isTabletAccount(customer));
    const orders = await lastOrderDates(customers.map(customer => customer._id));
    const now = new Date();

    const rows = customers.map(customer => {
      const order = orders.get(String(customer._id));
      const since = quietSince(customer, order?.lastOrderAt);
      return {
        ...customerSummary(customer),
        blocked: customer.isActive === false,
        joinedAt: customer.createdAt || null,
        lastSeenAt: customer.lastSeenAt || null,
        visits: customer.visitCount || 0,
        orderCount: order?.orderCount || 0,
        lastOrderAt: order?.lastOrderAt || null,
        daysWithoutOrder: daysSince(since, now),
        quiet: customer.isActive !== false && isQuiet(since, now)
      };
    });
    const onlyQuiet = req.query.filter === 'quiet';
    const seen = row => (row.lastSeenAt ? new Date(row.lastSeenAt).getTime() : 0);
    res.json({
      inactiveDays: INACTIVE_DAYS,
      customers: rows
        .filter(row => !onlyQuiet || row.quiet)
        .sort((a, b) => Number(b.quiet) - Number(a.quiet) || seen(b) - seen(a))
        .slice(0, 500)
    });
  } catch (error) {
    console.error('❌ Customer activity error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

const findCustomer = async id => {
  if (!validId(id)) return null;
  const user = await User.findOne({ _id: id, ...customerFilter });
  return user && !isTabletAccount(user) ? user : null;
};

router.post('/customers/:id/block', approverAuth, async (req, res) => {
  try {
    const customer = await findCustomer(req.params.id);
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    const blocked = req.body?.blocked === true;
    await User.updateOne({ _id: customer._id }, { $set: { isActive: !blocked } });
    audit(req, blocked ? 'customer_blocked' : 'customer_unblocked', 'User', customer._id);
    res.json({ ok: true, blocked });
  } catch (error) {
    console.error('❌ Customer block error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Forget the linked phone: the next phone the customer signs in with is kept.
router.post('/customers/:id/unlink-phone', approverAuth, async (req, res) => {
  try {
    const customer = await findCustomer(req.params.id);
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    await User.updateOne(
      { _id: customer._id },
      { $set: { boundDeviceId: '', boundDeviceName: '' }, $unset: { boundDeviceAt: 1 } }
    );
    audit(req, 'customer_phone_unlinked', 'User', customer._id, { previousPhone: customer.boundDeviceName });
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Customer unlink error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/approvers', managerAuth, async (req, res) => {
  try {
    const staff = (await User.find({ $or: [{ isAdmin: true }, { role: 'admin' }, { role: 'employee' }], isActive: { $ne: false } })
      .select('name email isAdmin role workRole isActive canApprovePhoneChanges')
      .sort({ name: 1 })
      .lean()).filter(user => !isTabletAccount(user));
    res.json(staff.map(user => ({
      id: user._id,
      name: user.name,
      email: user.email,
      always: isManagerAccount(user),
      allowed: canApprovePhoneChanges(user)
    })));
  } catch (error) {
    console.error('❌ Approvers list error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/approvers/:id', managerAuth, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ message: 'Invalid account' });
    const user = await User.findOne({ _id: req.params.id, $or: [{ isAdmin: true }, { role: 'admin' }, { role: 'employee' }] });
    if (!user || isTabletAccount(user)) return res.status(404).json({ message: 'Account not found' });
    const allowed = req.body?.allowed === true;
    await User.updateOne({ _id: user._id }, { $set: { canApprovePhoneChanges: allowed } });
    audit(req, allowed ? 'phone_approver_added' : 'phone_approver_removed', 'User', user._id);
    res.json({ ok: true, allowed });
  } catch (error) {
    console.error('❌ Approver update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/settings', approverAuth, async (req, res) => {
  try {
    res.json({ customersNeedPhoneApp: await getRequireApp() });
  } catch (error) {
    console.error('❌ Phone settings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/settings', managerAuth, async (req, res) => {
  try {
    const value = req.body?.customersNeedPhoneApp === true;
    await setRequireApp(value, req.user._id);
    audit(req, value ? 'phone_app_required_on' : 'phone_app_required_off', 'AppSetting', 'customersNeedPhoneApp');
    res.json({ customersNeedPhoneApp: value });
  } catch (error) {
    console.error('❌ Phone settings update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
