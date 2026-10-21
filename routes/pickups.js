const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const AuditLog = require('../models/AuditLog');
const { operationsAuth } = require('../middlewares/auth');
const { ensurePickupCode } = require('../utils/pickupCode');
const { notifyOrderChange } = require('../utils/liveUpdates');

const router = express.Router();

// The counter: Customer Service, the boss and administrators.
const counterAuth = (req, res, next) => operationsAuth(req, res, () => {
  const user = req.user;
  const allowed = user?.isAdmin || user?.role === 'admin'
    || (user?.role === 'employee' && ['customer_service', 'boss'].includes(user?.workRole));
  if (!allowed) return res.status(403).json({ message: 'Only Customer Service or the boss can hand over orders.' });
  return next();
});

const FIELDS = 'orderNumber userId items fulfillmentState pickupCode pickedUpAt pickedUpByName status createdAt';

const summary = (order) => ({
  _id: String(order._id),
  orderNumber: order.orderNumber || `#${String(order._id).slice(-6).toUpperCase()}`,
  customerName: order.userId?.name || order.userId?.email || 'Customer',
  products: (order.items || []).length,
  pickupCode: order.pickupCode || null,
  pickedUpAt: order.pickedUpAt || null,
  pickedUpByName: order.pickedUpByName || ''
});

// Ready orders still need a code if they became ready before codes existed.
const waitingFilter = { fulfillmentState: 'ready', pickedUpAt: null, status: { $ne: 'cancelled' } };

router.get('/', counterAuth, async (req, res) => {
  try {
    const [waiting, picked] = await Promise.all([
      Order.find(waitingFilter).sort({ updatedAt: -1 }).limit(100).select(FIELDS).populate('userId', 'name email').lean(),
      Order.find({ pickedUpAt: { $ne: null } }).sort({ pickedUpAt: -1 }).limit(50).select(FIELDS).populate('userId', 'name email').lean()
    ]);
    for (const order of waiting) {
      if (!order.pickupCode) order.pickupCode = await ensurePickupCode(order._id);
    }
    res.json({ waiting: waiting.map(summary), picked: picked.map(summary) });
  } catch (error) {
    console.error('Error listing pickups:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/lookup', counterAuth, async (req, res) => {
  try {
    const code = String(req.body?.code || '').replace(/\D/g, '');
    if (code.length !== 4) return res.status(400).json({ message: 'Type the 4 digits shown on the customer\'s phone.' });
    const order = await Order.findOne({ ...waitingFilter, pickupCode: code }).select(FIELDS).populate('userId', 'name email').lean();
    if (!order) return res.status(404).json({ message: 'Code not found. It may be wrong, or the order was already handed over.' });
    res.json(summary(order));
  } catch (error) {
    console.error('Error looking up pickup code:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/picked-up', counterAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Order not found' });
    const name = req.user.name || req.user.email || 'Staff';
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, ...waitingFilter },
      { $set: { pickedUpAt: new Date(), pickedUpBy: mongoose.Types.ObjectId.isValid(req.user.id) ? req.user.id : null, pickedUpByName: name } },
      { new: true }
    ).select(FIELDS).populate('userId', 'name email').lean();
    if (!order) return res.status(409).json({ message: 'This order is not waiting for pickup (already handed over, or not ready yet).' });
    await AuditLog.create({
      category: 'workflow',
      action: 'order_picked_up',
      entityType: 'Order',
      entityId: String(order._id),
      actorId: req.user.id,
      details: { by: name }
    }).catch(error => console.error('Pickup audit failed:', error.message));
    notifyOrderChange(order.userId?._id || order.userId);
    res.json(summary(order));
  } catch (error) {
    console.error('Error marking pickup:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
