const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const AuditLog = require('../models/AuditLog');
const { operationsAuth } = require('../middlewares/auth');
const WorkflowCase = require('../models/WorkflowCase');
const { ensurePickupCode } = require('../utils/pickupCode');
const { handoverStates } = require('../utils/handover');
const { completeOrder } = require('../utils/completeOrder');
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

const FIELDS = 'orderNumber userId items fulfillmentState pickupCode pickedUpAt pickedUpByName handovers packedWeights status createdAt';
const HANDOVER_CASE_TYPES = { $nin: ['order_validation', 'pack_order'] };
const RECENT_DAYS = 45;

const summary = (order, state) => {
  const products = state?.products || [];
  return {
    _id: String(order._id),
    orderNumber: order.orderNumber || `#${String(order._id).slice(-6).toUpperCase()}`,
    customerName: order.userId?.name || order.userId?.email || 'Customer',
    products: products.length || (order.items || []).length,
    readyCount: products.filter(product => product.ready || product.given).length,
    givenCount: products.filter(product => product.given).length,
    // Older orders have no product tasks: they are given whole, without ticking products.
    wholeOrder: products.length === 0,
    productList: products,
    weightGrams: state?.weightGrams || 0,
    pickupCode: order.pickupCode || null,
    pickedUpAt: order.pickedUpAt || null,
    pickedUpByName: order.pickedUpByName || ''
  };
};

const canGive = (order, state) => (state.products.length === 0 ? order.fulfillmentState === 'ready' : state.toGive.length > 0);
const openFilter = { pickedUpAt: null, status: { $ne: 'cancelled' } };

router.get('/', counterAuth, async (req, res) => {
  try {
    // Orders with at least one packed product can already give it; older, fully ready orders too.
    const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
    const packedOrderIds = await WorkflowCase.distinct('orderId', {
      requestType: HANDOVER_CASE_TYPES, status: 'completed', 'history.fromStatus': 'packing', completedAt: { $gte: since }, orderId: { $ne: null }
    });
    const [candidates, picked] = await Promise.all([
      Order.find({ ...openFilter, $or: [{ fulfillmentState: 'ready' }, { fulfillmentState: 'in_progress', _id: { $in: packedOrderIds } }] })
        .sort({ updatedAt: -1 }).limit(100).select(FIELDS).populate('userId', 'name email').lean(),
      Order.find({ pickedUpAt: { $ne: null } }).sort({ pickedUpAt: -1 }).limit(50).select(FIELDS).populate('userId', 'name email').lean()
    ]);
    const [candidateStates, pickedStates] = await Promise.all([handoverStates(candidates), handoverStates(picked)]);
    const waiting = candidates.filter(order => canGive(order, candidateStates.get(String(order._id))));
    for (const order of waiting) {
      if (!order.pickupCode) order.pickupCode = await ensurePickupCode(order._id, { partial: true });
    }
    res.json({
      waiting: waiting.map(order => summary(order, candidateStates.get(String(order._id)))),
      picked: picked.map(order => summary(order, pickedStates.get(String(order._id))))
    });
  } catch (error) {
    console.error('Error listing pickups:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// One order for the Ready card in the portal: what can be given, what is still in a stage, what was given.
router.get('/:id', counterAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Order not found' });
    const order = await Order.findById(req.params.id).select(FIELDS).populate('userId', 'name email').lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(summary(order, (await handoverStates([order])).get(String(order._id))));
  } catch (error) {
    console.error('Error reading pickup order:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/lookup', counterAuth, async (req, res) => {
  try {
    const code = String(req.body?.code || '').replace(/\D/g, '');
    if (code.length !== 4) return res.status(400).json({ message: 'Type the 4 digits shown on the customer\'s phone.' });
    const order = await Order.findOne({ ...openFilter, pickupCode: code }).select(FIELDS).populate('userId', 'name email').lean();
    if (!order) return res.status(404).json({ message: 'Code not found. It may be wrong, or the order was already handed over.' });
    const state = (await handoverStates([order])).get(String(order._id));
    if (!canGive(order, state)) return res.status(409).json({ message: 'No product of this order is ready to give yet.' });
    res.json(summary(order, state));
  } catch (error) {
    console.error('Error looking up pickup code:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Give the ticked ready products to the customer. Their weight was typed at Packing.
router.post('/:id/picked-up', counterAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Order not found' });
    const name = req.user.name || req.user.email || 'Staff';
    const order = await Order.findOne({ _id: req.params.id, ...openFilter }).select(FIELDS).lean();
    if (!order) return res.status(409).json({ message: 'This order is not waiting for pickup (already handed over, or not ready yet).' });
    const state = (await handoverStates([order])).get(String(order._id));
    if (!canGive(order, state)) return res.status(409).json({ message: 'No product of this order is ready to give yet.' });

    const whole = state.products.length === 0;
    // "all" (Ready cards in the portal): give every product that is ready now.
    const keys = whole ? [] : (req.body?.all === true
      ? state.toGive.map(product => product.key)
      : [...new Set((Array.isArray(req.body?.itemKeys) ? req.body.itemKeys : []).map(String))]);
    if (!whole) {
      if (!keys.length) return res.status(400).json({ message: 'Tick at least one product the customer takes.' });
      const allowed = new Set(state.toGive.map(product => product.key));
      if (keys.some(key => !allowed.has(key))) return res.status(409).json({ message: 'Some of these products are not ready, or were already given. Check the code again.' });
    }
    const by = mongoose.Types.ObjectId.isValid(req.user.id) ? req.user.id : null;
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, ...openFilter, ...(keys.length ? { 'handovers.itemKeys': { $nin: keys } } : {}) },
      { $push: { handovers: { at: new Date(), byId: by, byName: name, itemKeys: keys } } },
      { new: true }
    ).select('_id').lean();
    if (!updated) return res.status(409).json({ message: 'These products were just given by someone else.' });

    const finished = whole || state.products.every(product => product.given || keys.includes(product.key));
    if (finished) {
      await Order.updateOne({ _id: order._id, pickedUpAt: null }, { $set: { pickedUpAt: new Date(), pickedUpBy: by, pickedUpByName: name } });
    }
    const fresh = await Order.findById(order._id).select(FIELDS).populate('userId', 'name email').lean();
    const result = summary(fresh, (await handoverStates([fresh])).get(String(fresh._id)));
    res.json(result);
    // Side effects go after the answer so the counter does not wait for them.
    AuditLog.create({
      category: 'workflow',
      action: finished ? 'order_picked_up' : 'order_partly_picked_up',
      entityType: 'Order',
      entityId: String(order._id),
      actorId: req.user.id,
      details: { by: name, products: keys.length || undefined }
    }).catch(error => console.error('Pickup audit failed:', error.message));
    // The last product given makes the order Completed. If its stock rules refuse, the handover
    // stays recorded and the failure is written to the audit log.
    const completion = finished
      ? completeOrder(order._id, req.user.id).catch(error => {
        console.error('Completing the picked-up order failed:', error.message);
        return AuditLog.create({
          category: 'workflow', action: 'order_complete_failed', entityType: 'Order', entityId: String(order._id),
          actorId: req.user.id, details: { error: error.message }
        }).catch(() => {});
      })
      : Promise.resolve();
    completion.then(() => notifyOrderChange(fresh.userId?._id || fresh.userId));
  } catch (error) {
    console.error('Error marking pickup:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
