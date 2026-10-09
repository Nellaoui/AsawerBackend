const express = require('express');
const mongoose = require('mongoose');
const WorkflowCase = require('../models/WorkflowCase');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Catalog = require('../models/Catalog');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const BackupRun = require('../models/BackupRun');
const SystemError = require('../models/SystemError');
const Wishlist = require('../models/Wishlist');
const StockVariant = require('../models/StockVariant');
const InventoryMovement = require('../models/InventoryMovement');
const { operationsAuth } = require('../middlewares/auth');
const { buildCustomerInsights, recommendProducts } = require('../utils/customerInsights');
const { findTeamAssignee } = require('../utils/workflowAssignment');
const { visibleTaskFilter } = require('../utils/workflowVisibility');
const { assignMachineToCase, findMachine, releaseMachineFromCase } = require('../utils/machineRegistry');
const { takePickedStockOffShelf } = require('../utils/stockPicking');
const { putPickedStockBack, releaseStockTaskUnits, setShelfCount } = require('../utils/stockCount');
const {
  activeAdminIds,
  notifyCaseAssignment,
  notifyFailedPrint,
  notifyOrderBlocked,
  notifyTaskRemoved,
  notifyUser,
  notifyUsers
} = require('../utils/workflowNotifications');
const { ARCHIVE_PURGE_DAYS } = require('../utils/archivePurge');
const {
  CASE_STATUSES,
  CASE_TYPES,
  PRODUCTION_METHODS,
  normalizeReprintParts,
  latestModelVersion,
  teamForStatus,
  targetMinutesForTeam,
  validateTransition,
  skippedStepError
} = require('../utils/workflowRules');
const { effectiveDeadline, lateMinutes: stepLateMinutes, stepTimesSnapshot, MIN_SAMPLES } = require('../utils/stepTimes');
const { stepMinutes } = require('../utils/workingTime');
const { buildOverview } = require('../utils/bossOverview');

const router = express.Router();

const MANUAL_CASE_TYPES = ['general_task', 'product_missing', 'model_file_missing', 'dimensions_missing', 'customization'];

const WORK_ROLES = ['general', 'stock', 'customer_service', 'boss', 'wax_print', 'resin_print', 'quality', 'packing'];
const TEAM_WORK_ROLES = {
  stock: ['stock'],
  customer_service: ['customer_service'],
  boss: ['boss'],
  wax_print: ['wax_print'],
  resin_print: ['resin_print'],
  quality: ['quality'],
  packing: ['packing']
};
const ACTIVE_STATUSES = { $nin: ['completed', 'cancelled', 'rejected'] };
const visibleUnarchivedFilter = () => ({ ...visibleTaskFilter(), archivedAt: null });
const WORKFLOW_STAGE_FILTERS = {
  validation: ['awaiting_validation'],
  order_received: ['needs_customer_info', 'boss_review', 'waiting_customer_approval', 'modeling', 'file_validation'],
  stock_check: ['stock_picking'],
  printing: ['ready_to_print', 'printing'],
  quality: ['quality_check'],
  packing: ['packing'],
  ready_orders: ['completed'],
  ready: ['completed']
};
const TEAM_BY_WORK_ROLE = Object.fromEntries(
  Object.entries(TEAM_WORK_ROLES).flatMap(([team, roles]) => roles.map(role => [role, team]))
);

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const validObjectId = (value) => !value || mongoose.Types.ObjectId.isValid(value);
const cleanText = (value, max) => String(value || '').trim().slice(0, max);
const safelyNotify = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    console.error('Workflow notification failed:', error);
    return null;
  }
};

const isAdminUser = (user) => Boolean(user?.isAdmin || user?.role === 'admin');
const isBossUser = (user) => user?.role === 'employee' && user?.workRole === 'boss';
const isCustomerServiceUser = (user) => user?.role === 'employee' && user?.workRole === 'customer_service';
const isManagerUser = (user) => isAdminUser(user) || isBossUser(user);
const canViewCustomers = (user) => isManagerUser(user) || isCustomerServiceUser(user);
const isPrintingUser = (user) => user?.role === 'employee' && ['wax_print', 'resin_print'].includes(user?.workRole);
const canFilterCasesByCustomer = (user) => canViewCustomers(user) || isPrintingUser(user);
const mixedIdValues = (value) => {
  const text = String(value || '');
  const values = text ? [text] : [];
  if (mongoose.Types.ObjectId.isValid(text)) values.push(new mongoose.Types.ObjectId(text));
  return values;
};

const canUseTeam = (user, team) => {
  if (isManagerUser(user)) return true;
  const workRole = WORK_ROLES.includes(user?.workRole) ? user.workRole : 'general';
  return workRole === 'general' || (TEAM_WORK_ROLES[team] || []).includes(workRole);
};

const userTeam = (user) => TEAM_BY_WORK_ROLE[user?.workRole] || null;
const sameUserId = (left, right) => Boolean(left && right && String(left?._id || left) === String(right?._id || right));
const isUnassigned = (workflowCase) => !workflowCase.assignedTo;

const canSeeCase = (user, workflowCase) => {
  if (isManagerUser(user) || isCustomerServiceUser(user)) return true;
  return sameUserId(workflowCase.assignedTo, user?.id || user?._id);
};

const requireOwnedCase = (user, workflowCase) => {
  if (isManagerUser(user)) return null;
  if (!sameUserId(workflowCase.assignedTo, user?.id || user?._id) && !isUnassigned(workflowCase)) return 'This task belongs to another employee';
  if (isUnassigned(workflowCase)) return 'Claim this task before recording work';
  return null;
};

const unassignedFilter = () => ({ $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }] });

const scopedCaseFilter = (user, scope = 'mine') => {
  if (isManagerUser(user)) {
    if (scope === 'mine') return { assignedTo: user.id };
    if (scope === 'available') return unassignedFilter();
    return {};
  }

  if (isCustomerServiceUser(user) && scope === 'all') return {};

  return { assignedTo: user.id };
};

const taskSort = { priority: -1, taskKind: -1, deadlineAt: 1, 'quote.dueDate': 1, createdAt: 1 };

const minutesBetween = (start, end = new Date()) => {
  if (!start) return null;
  return Math.max(Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000), 0);
};

const isLateCase = (workflowCase, now = new Date()) => {
  if (['completed', 'cancelled', 'rejected'].includes(workflowCase.status)) return false;
  const deadline = effectiveDeadline(workflowCase);
  return Boolean(deadline && deadline < now);
};

const parseTargetMinutes = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 43200) {
    const error = new Error('Expected time must be between 1 and 43,200 minutes');
    error.statusCode = 400;
    throw error;
  }
  return minutes;
};

const requireTeam = (team) => (req, res, next) => {
  if (!canUseTeam(req.user, team)) {
    return res.status(403).json({ message: `This action belongs to the ${team.replaceAll('_', ' ')} team` });
  }
  next();
};

const normalizeDimensions = (input = {}, fallback = {}) => {
  const dimensions = { ...fallback, unit: 'mm' };
  for (const field of ['width', 'height', 'depth', 'length']) {
    if (input[field] === undefined || input[field] === null || input[field] === '') continue;
    const value = Number(input[field]);
    if (!Number.isFinite(value) || value < 0) {
      const error = new Error(`${field} must be a non-negative number`);
      error.statusCode = 400;
      throw error;
    }
    dimensions[field] = value;
  }
  if (input.ringSize !== undefined) dimensions.ringSize = cleanText(input.ringSize, 80);
  return dimensions;
};

const populateCase = (query) => query
  .populate({
    path: 'orderId',
    select: 'orderNumber status totalAmount notes createdAt userId items validationStatus validationCaseId validatedAt operationsArchivedAt archivePurgeAt',
    populate: [
      { path: 'items.productId', select: 'name serialNumber imageUrl printMethod stockLocation' },
      { path: 'userId', select: 'name email phone forcedProductionMethod' }
    ]
  })
  .populate('customerId', 'name email phone forcedProductionMethod')
  .populate('productId', 'name serialNumber imageUrl type catalogId fulfillmentPolicy printMethod modelFileStatus')
  .populate('assignedTo', 'name email workRole')
  .populate('createdBy', 'name email workRole');

// Older workflow records did not always keep a populated customer on the task.
// Resolve it through the original order so every employee can identify the client.
const hydrateCaseCustomers = async (caseDocuments) => {
  const single = !Array.isArray(caseDocuments);
  const cases = (single ? [caseDocuments] : caseDocuments)
    .filter(Boolean)
    .map(item => item?.toObject ? item.toObject() : item);
  const hasProfile = value => Boolean(value && typeof value === 'object' && (value.name || value.email));
  const missing = cases.filter(item => !hasProfile(item.customerId) && !hasProfile(item.orderId?.userId) && !hasProfile(item.customer));
  if (!missing.length) return single ? cases[0] : cases;

  const orderIds = [...new Set(missing.map(item => String(item.orderId?._id || item.orderId || '')).filter(mongoose.Types.ObjectId.isValid))];
  const rawOrders = orderIds.length
    ? await Order.find({ _id: { $in: orderIds } }).select('userId').lean()
    : [];
  const rawOrdersById = new Map(rawOrders.map(order => [String(order._id), order]));
  const customerIds = [...new Set(missing.map(item => {
    const orderId = String(item.orderId?._id || item.orderId || '');
    const source = item.customerId || rawOrdersById.get(orderId)?.userId;
    return String(source?._id || source || '');
  }).filter(mongoose.Types.ObjectId.isValid))];
  const customers = customerIds.length
    ? await User.find({ _id: { $in: customerIds } }).select('name email phone forcedProductionMethod').lean()
    : [];
  const customersById = new Map(customers.map(customer => [String(customer._id), customer]));

  for (const item of missing) {
    const orderId = String(item.orderId?._id || item.orderId || '');
    const rawCustomerId = item.customerId || rawOrdersById.get(orderId)?.userId;
    const customer = customersById.get(String(rawCustomerId?._id || rawCustomerId || ''));
    if (!customer) continue;
    item.customerId = customer;
    if (item.orderId && typeof item.orderId === 'object') item.orderId.userId = customer;
  }
  return single ? cases[0] : cases;
};

const refreshOrderFulfillment = async (orderId, actorId, app) => {
  if (!orderId) return;
  const openCases = await WorkflowCase.find({
    orderId,
    status: { $nin: ['completed', 'cancelled'] }
  }).select('status isBlocked');
  let fulfillmentState = openCases.some(item => item.isBlocked || ['needs_customer_info', 'rejected'].includes(item.status))
    ? 'blocked'
    : (openCases.length ? 'in_progress' : 'ready');

    if (!openCases.length) {
    // Lines that passed quality already went to packing one by one, so no extra pack task is needed.
    const linesWentToPacking = await WorkflowCase.exists({ orderId, requestType: { $ne: 'pack_order' }, 'history.toStatus': 'packing' });
    // A packing task the boss cancelled because it opened too early does not count.
    const existingPackingTask = await WorkflowCase.findOne({ orderId, requestType: 'pack_order', status: { $ne: 'cancelled' } }).select('_id status');
    if (!existingPackingTask && !linesWentToPacking) {
      const order = await Order.findById(orderId).select('items workflowCaseIds');
      if (order) {
        const assignedTo = await findTeamAssignee('packing');
        const now = new Date();
        const packingTask = await WorkflowCase.create({
          orderId,
          requestType: 'pack_order',
          requestedName: `Pack order #${String(orderId).slice(-6).toUpperCase()}`,
          quantity: order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0) || 1,
          status: 'packing',
          assignedTeam: 'packing',
          assignedTo: assignedTo?._id || null,
          assignedAt: assignedTo ? now : null,
          stageQueuedAt: now,
          taskKind: 'order',
          priority: 'normal',
          targetMinutes: targetMinutesForTeam('packing'),
          requirements: 'Gather every approved stock and printed item, verify the order, and prepare it for the customer.',
          productionMethod: 'undecided',
          customerApproval: 'not_required',
          createdBy: actorId,
          history: [{ actorId, action: 'packing_task_created', toStatus: 'packing', note: 'All stock and production tasks are complete.' }]
        });
        await Order.updateOne({ _id: orderId }, { $addToSet: { workflowCaseIds: packingTask._id } });
        await safelyNotify(() => notifyCaseAssignment(app, packingTask));
        fulfillmentState = 'in_progress';
      }
    } else if (existingPackingTask.status !== 'completed') {
      fulfillmentState = 'in_progress';
    }
  }
  await Order.updateOne(
    { _id: orderId },
    { $set: { fulfillmentState } }
  );

  // Packing finishes product by product: tell the customer how many are done
  // ("3 of 5"). One message per count, so repeated refreshes stay quiet.
  if (fulfillmentState !== 'ready') {
    const [order, packedCases] = await Promise.all([
      Order.findById(orderId).select('userId orderNumber items').lean(),
      WorkflowCase.find({ orderId, status: { $nin: ['cancelled', 'rejected'] }, requestType: { $nin: ['order_validation', 'pack_order'] } }).select('orderItemId productId status history.fromStatus').lean()
    ]);
    const total = order?.items?.length || 0;
    // A product is done when it went through packing and none of its tasks
    // (stock check, printing, packing) is still open.
    const itemCases = new Map();
    for (const item of packedCases) {
      const key = String(item.orderItemId || item.productId || item._id);
      if (!itemCases.has(key)) itemCases.set(key, []);
      itemCases.get(key).push(item);
    }
    const done = [...itemCases.values()].filter(group =>
      group.every(item => item.status === 'completed') && group.some(item => (item.history || []).some(entry => entry.fromStatus === 'packing'))
    ).length;
    if (order?.userId && mongoose.Types.ObjectId.isValid(String(order.userId)) && total > 1 && done > 0 && done < total) {
      const label = order.orderNumber || `#${String(orderId).slice(-6).toUpperCase()}`;
      await safelyNotify(() => notifyUser(app, {
        userId: order.userId,
        title: `Your order is coming together: ${done} of ${total} products ready`,
        body: `Order ${label}: ${done} of ${total} products are ready. We will tell you when all of them are done.`,
        type: 'order_progress',
        data: { type: 'order', orderId: String(orderId), status: 'partial', done, total },
        dedupeKey: `order-progress-${orderId}-${done}`
      }));
    }
  }

  // Packing was the last step: tell the customer on their phone. The dedupe
  // key keeps it to one message per order however often this runs.
  if (fulfillmentState === 'ready') {
    const order = await Order.findById(orderId).select('userId orderNumber').lean();
    if (order?.userId && mongoose.Types.ObjectId.isValid(String(order.userId))) {
      const label = order.orderNumber || `#${String(orderId).slice(-6).toUpperCase()}`;
      await safelyNotify(() => notifyUser(app, {
        userId: order.userId,
        title: '🎉 Your order is ready',
        body: `Order ${label}: all your products are done and ready for you.`,
        type: 'order_ready',
        data: { type: 'order', orderId: String(orderId), status: 'ready' },
        dedupeKey: `order-ready-${orderId}`
      }));
    }
  }
};

// Expected minutes per step, averaged from finished steps. The portal uses it for "Late by".
router.get('/step-times', operationsAuth, (req, res) => {
  res.json({ minSamples: MIN_SAMPLES, steps: stepTimesSnapshot() });
});

router.get('/summary', operationsAuth, async (req, res) => {
  try {
    const mineFilter = { ...visibleUnarchivedFilter(), ...scopedCaseFilter(req.user, 'mine'), status: ACTIVE_STATUSES };
    const availableFilter = { ...visibleUnarchivedFilter(), ...scopedCaseFilter(req.user, 'available'), status: ACTIVE_STATUSES };
    const now = new Date();
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const [total, customerService, boss, wax, resin, quality, completed, stock, packing, mineCases, available] = await Promise.all([
      WorkflowCase.countDocuments({ ...visibleUnarchivedFilter(), status: { $nin: ['cancelled', 'rejected'] } }),
      WorkflowCase.countDocuments({ ...visibleUnarchivedFilter(), assignedTeam: 'customer_service', status: { $nin: ['cancelled', 'rejected', 'completed'] } }),
      WorkflowCase.countDocuments({ ...visibleUnarchivedFilter(), assignedTeam: 'boss', status: { $nin: ['cancelled', 'rejected', 'completed'] } }),
      WorkflowCase.countDocuments({ ...visibleUnarchivedFilter(), assignedTeam: 'wax_print', status: { $nin: ['cancelled', 'rejected', 'completed'] } }),
      WorkflowCase.countDocuments({ ...visibleUnarchivedFilter(), assignedTeam: 'resin_print', status: { $nin: ['cancelled', 'rejected', 'completed'] } }),
      WorkflowCase.countDocuments({ ...visibleUnarchivedFilter(), assignedTeam: 'quality', status: { $nin: ['cancelled', 'rejected', 'completed'] } }),
      WorkflowCase.countDocuments({ ...visibleUnarchivedFilter(), status: 'completed' }),
      WorkflowCase.countDocuments({ ...visibleUnarchivedFilter(), assignedTeam: 'stock', status: ACTIVE_STATUSES }),
      WorkflowCase.countDocuments({ ...visibleUnarchivedFilter(), assignedTeam: 'packing', status: ACTIVE_STATUSES }),
      WorkflowCase.find(mineFilter).select('priority taskKind deadlineAt targetMinutes stageQueuedAt assignedAt startedAt status createdAt assignedTeam productionMethod').lean(),
      WorkflowCase.countDocuments(availableFilter)
    ]);
    const mine = mineCases.length;
    const urgent = mineCases.filter(item => item.priority === 'urgent').length;
    const dueToday = mineCases.filter(item => {
      const deadline = effectiveDeadline(item);
      return deadline && deadline <= todayEnd;
    }).length;
    const late = mineCases.filter(item => isLateCase(item, now)).length;
    const working = mineCases.filter(item => item.startedAt).length;
    const extra = mineCases.filter(item => item.taskKind === 'extra').length;
    res.json({ total, customerService, boss, wax, resin, quality, stock, packing, completed, mine, available, urgent, dueToday, late, working, extra });
  } catch (error) {
    console.error('Error fetching workflow summary:', error);
    res.status(500).json({ message: 'Failed to fetch workflow summary' });
  }
});

// The boss manages the operations team from the same portal as every employee.
router.get('/team', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user)) return res.status(403).json({ message: 'Only the boss or an administrator can manage the team' });
    const employees = await User.find({ role: 'employee', isActive: { $ne: false } })
      .select('name email role workRole isActive createdAt')
      .sort({ name: 1, email: 1 })
      .lean();
    res.json(employees.map(employee => ({ ...employee, id: String(employee._id) })));
  } catch (error) {
    console.error('Error fetching workflow team:', error);
    res.status(500).json({ message: 'Failed to fetch the operations team' });
  }
});

router.patch('/team/:id', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user)) return res.status(403).json({ message: 'Only the boss or an administrator can manage the team' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid employee ID' });
    const workRole = String(req.body.workRole || '');
    if (!WORK_ROLES.includes(workRole)) return res.status(400).json({ message: 'Invalid employee work role' });
    const employee = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'employee', isActive: { $ne: false } },
      { $set: { workRole } },
      { new: true }
    ).select('name email role workRole isActive createdAt');
    if (!employee) return res.status(404).json({ message: 'Active employee not found' });
    res.json({ ...employee.toObject(), id: String(employee._id) });
  } catch (error) {
    console.error('Error updating workflow role:', error);
    res.status(500).json({ message: 'Failed to update the employee role' });
  }
});

// Open order tasks per customer, matched the same way the customer filter on /cases matches them.
const openTaskCountsByCustomer = async () => {
  const cases = await WorkflowCase.find({ ...visibleUnarchivedFilter(), status: ACTIVE_STATUSES, taskKind: 'order' })
    .select('customerId orderId')
    .lean();
  const orderIds = [...new Set(cases.filter(item => !item.customerId).map(item => String(item.orderId || '')).filter(mongoose.Types.ObjectId.isValid))];
  const orders = orderIds.length ? await Order.find({ _id: { $in: orderIds } }).select('userId').lean() : [];
  const ownerByOrder = new Map(orders.map(order => [String(order._id), String(order.userId || '')]));
  const counts = new Map();
  cases.forEach(item => {
    const customerId = String(item.customerId || ownerByOrder.get(String(item.orderId || '')) || '');
    if (mongoose.Types.ObjectId.isValid(customerId)) counts.set(customerId, (counts.get(customerId) || 0) + 1);
  });
  return counts;
};

// The boss can force a customer's future printable items to Wax or Resin.
// Customer Service also uses this list to pick a customer, so customers with open tasks come first.
router.get('/customers', operationsAuth, async (req, res) => {
  try {
    if (!canViewCustomers(req.user)) return res.status(403).json({ message: 'Only Customer Service, the boss, or an administrator can view customers' });
    const search = cleanText(req.query.search, 120);
    const filter = { role: 'user', isActive: { $ne: false } };
    if (search) {
      const pattern = new RegExp(escapeRegExp(search), 'i');
      filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
    }
    const counts = await openTaskCountsByCustomer();
    const fields = 'name email phone forcedProductionMethod isActive createdAt';
    const busy = counts.size
      ? await User.find({ ...filter, _id: { $in: [...counts.keys()] } }).select(fields).lean()
      : [];
    const others = await User.find({ ...filter, _id: { $nin: busy.map(customer => customer._id) } })
      .select(fields)
      .sort({ name: 1, email: 1 })
      .limit(Math.max(100 - busy.length, 20))
      .lean();
    const byName = (a, b) => String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''));
    busy.sort((a, b) => (counts.get(String(b._id)) - counts.get(String(a._id))) || byName(a, b));
    res.json([...busy, ...others].map(customer => ({
      ...customer,
      id: String(customer._id),
      activeTasks: counts.get(String(customer._id)) || 0,
      forcedProductionMethod: customer.forcedProductionMethod || 'automatic'
    })));
  } catch (error) {
    console.error('Error fetching customer production routing:', error);
    res.status(500).json({ message: 'Failed to fetch customer routing' });
  }
});

// Printing staff see customers for their own active print tasks only.
router.get('/print-customers', operationsAuth, async (req, res) => {
  try {
    if (!isPrintingUser(req.user)) return res.status(403).json({ message: 'Printing team access required' });
    const cases = await WorkflowCase.find({
      ...visibleUnarchivedFilter(),
      assignedTo: req.user.id,
      assignedTeam: req.user.workRole,
      status: ACTIVE_STATUSES
    }).select('customerId orderId').lean();
    const orderIds = [...new Set(cases.map(item => String(item.orderId || '')).filter(mongoose.Types.ObjectId.isValid))];
    const orders = orderIds.length ? await Order.find({ _id: { $in: orderIds } }).select('userId').lean() : [];
    const customerIds = [...new Set([
      ...cases.map(item => String(item.customerId || '')),
      ...orders.map(item => String(item.userId || ''))
    ].filter(mongoose.Types.ObjectId.isValid))];
    const customers = customerIds.length
      ? await User.find({ _id: { $in: customerIds } }).select('name email').sort({ name: 1 }).lean()
      : [];
    res.json(customers.map(customer => ({ id: String(customer._id), name: customer.name, email: customer.email })));
  } catch (error) {
    console.error('Error loading printing customers:', error);
    res.status(500).json({ message: 'Failed to load printing customers' });
  }
});

router.patch('/customers/:id/routing', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user)) return res.status(403).json({ message: 'Only the boss or an administrator can manage customer routing' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid customer ID' });
    const forcedProductionMethod = String(req.body.forcedProductionMethod || 'automatic');
    if (!['automatic', 'wax', 'resin'].includes(forcedProductionMethod)) {
      return res.status(400).json({ message: 'Customer routing must be automatic, wax, or resin' });
    }
    const existingCustomer = await User.findOne({ _id: req.params.id, role: 'user', isActive: { $ne: false } })
      .select('forcedProductionMethod');
    if (!existingCustomer) return res.status(404).json({ message: 'Active customer not found' });
    const customer = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'user', isActive: { $ne: false } },
      { $set: { forcedProductionMethod } },
      { new: true }
    ).select('name email phone forcedProductionMethod isActive createdAt');
    await AuditLog.create({
      category: 'workflow',
      action: 'customer_routing_changed',
      actorId: req.user.id,
      entityType: 'customer',
      entityId: String(customer._id),
      details: {
        customerName: customer.name,
        customerEmail: customer.email,
        fromProductionMethod: existingCustomer.forcedProductionMethod || 'automatic',
        toProductionMethod: forcedProductionMethod
      }
    });
    res.json({ ...customer.toObject(), id: String(customer._id) });
  } catch (error) {
    console.error('Error updating customer production routing:', error);
    res.status(500).json({ message: 'Failed to update customer routing' });
  }
});

router.get('/customers/:id/overview', operationsAuth, async (req, res) => {
  try {
    if (!canViewCustomers(req.user)) return res.status(403).json({ message: 'Only Customer Service, the boss, or an administrator can view customer analytics' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid customer ID' });

    const customer = await User.findOne({ _id: req.params.id, role: 'user', isActive: { $ne: false } })
      .select('name email phone forcedProductionMethod isActive createdAt')
      .lean();
    if (!customer) return res.status(404).json({ message: 'Active customer not found' });

    const customerIds = mixedIdValues(customer._id);
    const orders = await Order.find({ userId: { $in: customerIds } })
      .sort({ createdAt: -1 })
      .limit(1000)
      .populate('catalogId', 'name')
      .populate('items.productId', 'name serialNumber imageUrl type size availableSizes relatedProducts printMethod fulfillmentPolicy price')
      .lean();
    const orderIds = orders.map(order => order._id);
    const workflowCases = await populateCase(WorkflowCase.find({
      ...visibleTaskFilter(),
      $or: [
        { customerId: { $in: customerIds } },
        ...(orderIds.length ? [{ orderId: { $in: orderIds } }] : [])
      ]
    }).sort({ createdAt: -1 }).limit(2000)).lean();

    const insights = buildCustomerInsights(orders, workflowCases);
    const [{ wishlistProductIds = [] } = {}, accessibleCatalogs, popularityOrders] = await Promise.all([
      Wishlist.find({ userId: { $in: customerIds } }).select('productId').lean()
        .then(items => ({ wishlistProductIds: items.map(item => String(item.productId)) })),
      Catalog.findAccessibleByUser(customer._id, 'user').select('_id products').lean(),
      Order.find({ status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).limit(3000).select('items.productId items.quantity').lean()
    ]);
    const accessibleProductIds = [...new Set(accessibleCatalogs.flatMap(catalog => (catalog.products || []).map(String)))];
    const accessibleCatalogIds = accessibleCatalogs.map(catalog => catalog._id);
    const candidates = accessibleCatalogIds.length || accessibleProductIds.length
      ? await Product.find({
        isActive: { $ne: false },
        $or: [
          ...(accessibleProductIds.length ? [{ _id: { $in: accessibleProductIds } }] : []),
          ...(accessibleCatalogIds.length ? [{ catalogId: { $in: accessibleCatalogIds } }] : [])
        ]
      }).select('name serialNumber imageUrl type price size availableSizes relatedProducts fulfillmentPolicy printMethod isActive').lean()
      : [];
    const globalProductUnits = new Map();
    for (const order of popularityOrders) {
      for (const item of order.items || []) {
        const productId = String(item.productId?._id || item.productId || '');
        if (productId) globalProductUnits.set(productId, (globalProductUnits.get(productId) || 0) + Number(item.quantity || 0));
      }
    }
    const recommendations = recommendProducts({
      products: candidates,
      insights,
      wishlistProductIds,
      globalProductUnits,
      forcedProductionMethod: customer.forcedProductionMethod || 'automatic'
    });
    const { productStats, ...publicInsights } = insights;

    res.json({
      customer: { ...customer, id: String(customer._id), forcedProductionMethod: customer.forcedProductionMethod || 'automatic' },
      analytics: publicInsights,
      recommendations,
      orders: orders.slice(0, 100),
      activeCases: workflowCases.filter(item => !['completed', 'cancelled', 'rejected'].includes(item.status)).slice(0, 100),
      recentCases: workflowCases.slice(0, 100)
    });
  } catch (error) {
    console.error('Error fetching customer overview:', error);
    res.status(500).json({ message: 'Failed to load the customer overview' });
  }
});

// Where each product of an order stands, so Quality and Packing staff see the
// whole order and not only the products waiting for them.
const LINE_STEP = {
  stock_picking: 'stock',
  quality_check: 'quality',
  packing: 'packing',
  completed: 'done'
};
const lineStepFor = (status) => LINE_STEP[status] || 'printing';
// What the customer-facing step hides: stock check, waiting for the machine,
// on the machine, or sent back from quality to print again.
const lineDetailFor = (row) => {
  if (row.status === 'completed') return 'Done';
  const reprint = (row.reprintParts || []).length > 0;
  if (row.status === 'stock_picking') return 'Stock check';
  if (row.status === 'ready_to_print') return reprint ? 'Reprint waiting' : 'Waiting to print';
  if (row.status === 'printing') return reprint ? 'Reprinting' : 'Printing';
  if (row.status === 'quality_check') return 'Waiting for quality';
  if (row.status === 'packing') return 'Ready to pack';
  return 'Being prepared';
};
const LINE_STEP_ORDER = ['stock', 'printing', 'quality', 'packing', 'done'];
const attachOrderLines = async (cases) => {
  const orderIds = [...new Set(cases.map(item => String(item.orderId?._id || item.orderId || '')).filter(mongoose.Types.ObjectId.isValid))];
  if (!orderIds.length) return cases;
  const rows = await WorkflowCase.find({
    orderId: { $in: orderIds },
    requestType: { $nin: ['order_validation', 'pack_order'] },
    status: { $nin: ['cancelled', 'rejected'] },
    archivedAt: null
  }).select('orderId orderItemId productId requestedName status isBlocked reprintParts').populate('productId', 'serialNumber name imageUrl').lean();
  // Size and quantity live on the order's items; the page already has them populated.
  const orderItems = new Map();
  for (const item of cases) {
    for (const orderItem of (item.orderId?.items || [])) orderItems.set(String(orderItem._id), orderItem);
  }
  const linesByOrder = new Map();
  for (const row of rows) {
    const orderKey = String(row.orderId);
    const lineKey = String(row.orderItemId || row.productId || row._id);
    if (!linesByOrder.has(orderKey)) linesByOrder.set(orderKey, new Map());
    const lines = linesByOrder.get(orderKey);
    const current = lines.get(lineKey);
    // A product split between stock and printing is shown by its least advanced
    // task; it only counts as done when every task of it is finished.
    const rank = (item) => LINE_STEP_ORDER.indexOf(lineStepFor(item.status));
    const blocked = Boolean(row.isBlocked || current?.isBlocked) && row.status !== 'completed';
    if (!current || rank(row) < rank(current)) lines.set(lineKey, { ...row, isBlocked: blocked });
    else if (blocked) lines.set(lineKey, { ...current, isBlocked: true });
  }
  return cases.map(item => {
    const lines = linesByOrder.get(String(item.orderId?._id || item.orderId || ''));
    if (!lines) return item;
    return {
      ...item,
      orderLines: [...lines.values()].map(row => ({
        id: row._id,
        name: row.requestedName,
        reference: row.productId?.serialNumber || '',
        imageUrl: row.productId?.imageUrl || '',
        size: orderItems.get(String(row.orderItemId))?.size || '',
        quantity: orderItems.get(String(row.orderItemId))?.quantity || row.quantity || 1,
        step: lineStepFor(row.status),
        detail: lineDetailFor(row),
        reprint: row.status !== 'completed' && (row.reprintParts || []).length > 0,
        isBlocked: Boolean(row.isBlocked)
      }))
    };
  });
};

router.get('/cases', operationsAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const scope = ['mine', 'available', 'all'].includes(String(req.query.scope)) ? String(req.query.scope) : 'mine';
    const filter = {
      ...(isManagerUser(req.user) && req.query.includeArchived === 'true' ? {} : visibleTaskFilter()),
      archivedAt: req.query.archived === 'true' && canViewCustomers(req.user) ? { $ne: null } : null,
      ...scopedCaseFilter(req.user, scope)
    };
    // Customer Service only sees the incoming orders it can bring back.
    if (req.query.archived === 'true' && !isManagerUser(req.user)) filter.archivePurgeAt = { $ne: null };

    if (req.query.team && isManagerUser(req.user)) filter.assignedTeam = String(req.query.team);
    if (req.query.stage) {
      const stage = String(req.query.stage);
      if (!Object.prototype.hasOwnProperty.call(WORKFLOW_STAGE_FILTERS, stage)) {
        return res.status(400).json({ message: 'Invalid workflow stage' });
      }
      filter.status = { $in: WORKFLOW_STAGE_FILTERS[stage] };
      // An order is ready only once its packing task is done; other finished
      // tasks are steps of orders that may still be printing.
      if (stage === 'ready_orders') filter.requestType = 'pack_order';
    } else if (req.query.status) filter.status = String(req.query.status);
    else if (req.query.active === 'true') filter.status = ACTIVE_STATUSES;
    if (scope === 'mine' && req.query.status === 'completed') {
      const participantIds = [String(req.user.id)];
      if (mongoose.Types.ObjectId.isValid(String(req.user.id))) {
        participantIds.push(new mongoose.Types.ObjectId(String(req.user.id)));
      }
      delete filter.assignedTo;
      filter.$or = [
        { assignedTo: req.user.id },
        { 'history.actorId': { $in: participantIds } }
      ];
    }
    const method = String(req.query.method || '');
    if (method && !['wax', 'resin'].includes(method)) filter.productionMethod = method;
    if (req.query.taskKind && ['order', 'extra'].includes(String(req.query.taskKind))) filter.taskKind = String(req.query.taskKind);
    if (req.query.orderId && mongoose.Types.ObjectId.isValid(req.query.orderId)) filter.orderId = req.query.orderId;
    if (req.query.customerId) {
      if (!canFilterCasesByCustomer(req.user)) return res.status(403).json({ message: 'This account cannot filter by customer' });
      if (!mongoose.Types.ObjectId.isValid(req.query.customerId)) return res.status(400).json({ message: 'Invalid customer ID' });
      const customerIds = mixedIdValues(req.query.customerId);
      const customerOrderIds = await Order.find({ userId: { $in: customerIds } }).distinct('_id');
      const customerScope = {
        $or: [
          { customerId: { $in: customerIds } },
          ...(customerOrderIds.length ? [{ orderId: { $in: customerOrderIds } }] : [])
        ]
      };
      if (filter.$or) {
        const scopeOr = filter.$or;
        delete filter.$or;
        filter.$and = [...(filter.$and || []), { $or: scopeOr }, customerScope];
      } else {
        filter.$and = [...(filter.$and || []), customerScope];
      }
    }
    if (req.query.search) {
      const searchValue = String(req.query.search).trim();
      const pattern = new RegExp(escapeRegExp(searchValue), 'i');
      const searchFilter = [{ requestedName: pattern }, { requirements: pattern }, { 'customer.name': pattern }, { 'customer.email': pattern }, { 'customer.phone': pattern }];
      if (mongoose.Types.ObjectId.isValid(searchValue)) searchFilter.push({ orderId: searchValue });
      // Staff see the product reference and the order number on every card,
      // so typing either one must find the task, not only the task name.
      // One character would match most products, so it only searches task names.
      if (searchValue.length >= 2) {
        // Cards show the client's account name, which is not stored on the task itself.
        const matchedCustomers = await User.find({ role: 'user', $or: [{ name: pattern }, { email: pattern }, { phone: pattern }] }).select('_id').limit(50).lean();
        const clientIds = matchedCustomers.flatMap(customer => mixedIdValues(customer._id));
        if (clientIds.length) {
          searchFilter.push({ customerId: { $in: clientIds } });
          const clientOrderIds = await Order.find({ userId: { $in: clientIds } }).distinct('_id');
          if (clientOrderIds.length) searchFilter.push({ orderId: { $in: clientOrderIds } });
        }
        // Older orders have no number; cards show "#" + the last 6 characters of the id.
        const idTail = /^[0-9a-f]{4,24}$/i.test(searchValue) ? searchValue.toLowerCase() : null;
        const [searchProductIds, searchOrders, tailOrders] = await Promise.all([
          Product.find({ $or: [{ serialNumber: pattern }, { name: pattern }] }).select('_id').limit(200).lean(),
          Order.find({ orderNumber: pattern }).select('_id').limit(100).lean(),
          idTail
            ? Order.find({ $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: `${idTail}$` } } }).select('_id').limit(100).lean()
            : []
        ]);
        if (searchProductIds.length) {
          const productIds = searchProductIds.map(product => product._id);
          searchFilter.push({ productId: { $in: productIds } });
          const productOrders = await Order.find({ 'items.productId': { $in: productIds } }).select('_id').sort({ createdAt: -1 }).limit(300).lean();
          // Validation and packing tasks cover a whole order and have no product of their own.
          if (productOrders.length) searchFilter.push({ productId: null, orderId: { $in: productOrders.map(order => order._id) } });
        }
        const orderIds = [...searchOrders, ...tailOrders].map(order => order._id);
        if (orderIds.length) searchFilter.push({ orderId: { $in: orderIds } });
      }
      if (filter.$or) {
        const scopeOr = filter.$or;
        delete filter.$or;
        filter.$and = [{ $or: scopeOr }, { $or: searchFilter }];
      } else {
        filter.$or = searchFilter;
      }
    }
    if (['wax', 'resin'].includes(method)) {
      // A packing task covers the whole order and has no print method of its
      // own: it matches when the order's items use this method and not the other.
      const otherMethod = method === 'wax' ? 'resin' : 'wax';
      const methodOrderIds = await Order.find({
        $and: [{ 'items.productionMethod': method }, { 'items.productionMethod': { $ne: otherMethod } }]
      }).distinct('_id');
      filter.$and = [...(filter.$and || []), {
        $or: [
          { productionMethod: method },
          ...(methodOrderIds.length ? [{ requestType: 'pack_order', orderId: { $in: methodOrderIds } }] : [])
        ]
      }];
    }

    // A page holds whole orders, not product tasks: one order with many
    // products used to fill a page and push every other order to later pages.
    const rows = await WorkflowCase.find(filter).sort(taskSort).select('_id orderId').lean();
    const orderGroups = new Map();
    for (const row of rows) {
      const key = row.orderId ? `order:${row.orderId}` : `task:${row._id}`;
      if (!orderGroups.has(key)) orderGroups.set(key, []);
      orderGroups.get(key).push(row._id);
    }
    const pageIds = [...orderGroups.values()].slice((page - 1) * limit, page * limit).flat();
    const caseDocuments = pageIds.length
      ? await populateCase(WorkflowCase.find({ _id: { $in: pageIds } }).sort(taskSort))
      : [];
    const cases = await attachOrderLines(await hydrateCaseCustomers(caseDocuments));
    const orders = orderGroups.size;

    res.json({
      cases,
      pagination: { page, limit, total: rows.length, orders, pages: Math.max(Math.ceil(orders / limit), 1) }
    });
  } catch (error) {
    console.error('Error fetching workflow cases:', error);
    res.status(500).json({ message: 'Failed to fetch workflow cases' });
  }
});

// Customer Service finds a task anywhere in the pipeline by order number, product reference or customer.
const FIND_STAGE_LABELS = {
  awaiting_validation: 'Validation',
  task_ready: 'To do',
  stock_picking: 'Stock check',
  needs_customer_info: 'Order received',
  boss_review: 'Order received',
  waiting_customer_approval: 'Order received',
  modeling: 'Order received',
  file_validation: 'Order received',
  ready_to_print: 'Printing',
  printing: 'Printing',
  quality_check: 'Quality',
  packing: 'Packing',
  completed: 'Ready / completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled'
};
// A finished task names the step it finished. Only the packing task means the
// whole order is ready: a finished stock check or confirmation says nothing
// about the printing still going on for the same product.
const findStageLabel = (item) => {
  if (item.status !== 'completed') return FIND_STAGE_LABELS[item.status] || item.status;
  if (item.requestType === 'pack_order') return FIND_STAGE_LABELS.completed;
  if (item.requestType === 'order_validation') return 'Order confirmed';
  if (item.requestType === 'stock_pick') return 'Stock check done';
  if (item.taskKind === 'extra' || item.requestType === 'general_task') return 'Done';
  return 'Printed and checked';
};
const TEAM_LABELS = {
  stock: 'Stock',
  customer_service: 'Customer Service',
  boss: 'Boss',
  wax_print: 'Wax printing',
  resin_print: 'Resin printing',
  quality: 'Quality',
  packing: 'Packing',
  none: 'No team'
};
const FIND_LIMIT = 30;
const FINISHED_STATUSES = ['completed', 'cancelled', 'rejected'];

const shortOrderCode = (id) => String(id || '').slice(-6).toUpperCase();

router.get('/find', operationsAuth, async (req, res) => {
  try {
    if (!canViewCustomers(req.user)) return res.status(403).json({ message: 'Only Customer Service, the boss, or an administrator can search all tasks' });
    const q = cleanText(req.query.q, 80).replace(/^#/, '').trim();
    if (q.length < 2) return res.json({ query: q, results: [] });
    const pattern = new RegExp(escapeRegExp(q), 'i');

    // The portal shows orders without a number as "#" + the last 6 characters of their id.
    const idTail = /^[0-9a-f]{4,24}$/i.test(q) ? q.toLowerCase() : null;
    const [numberedOrders, codedOrders, products, customers] = await Promise.all([
      Order.find({ orderNumber: pattern }).select('_id').limit(100).lean(),
      idTail
        ? Order.find({ $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: `${idTail}$` } } }).select('_id').limit(100).lean()
        : [],
      Product.find({ $or: [{ serialNumber: pattern }, { name: pattern }] }).select('_id').limit(200).lean(),
      User.find({ role: 'user', $or: [{ name: pattern }, { email: pattern }, { phone: pattern }] }).select('_id').limit(50).lean()
    ]);
    const orderIds = [...numberedOrders, ...codedOrders].map(order => order._id);
    const productIds = products.map(product => product._id);
    const customerIds = customers.flatMap(customer => mixedIdValues(customer._id));
    const [productOrderIds, customerOrderIds] = await Promise.all([
      productIds.length ? Order.find({ 'items.productId': { $in: productIds } }).distinct('_id') : [],
      customerIds.length ? Order.find({ userId: { $in: customerIds } }).distinct('_id') : []
    ]);

    const matches = [{ requestedName: pattern }];
    if (idTail && idTail.length === 24) matches.push({ _id: idTail });
    if (orderIds.length) matches.push({ orderId: { $in: orderIds } });
    if (productIds.length) matches.push({ productId: { $in: productIds } });
    // Validation tasks cover the whole order and have no product of their own.
    if (productOrderIds.length) matches.push({ productId: null, orderId: { $in: productOrderIds } });
    matches.push({ 'customer.name': pattern }, { 'customer.email': pattern }, { 'customer.phone': pattern });
    if (customerIds.length) matches.push({ customerId: { $in: customerIds } });
    if (customerOrderIds.length) matches.push({ orderId: { $in: customerOrderIds } });

    const found = await WorkflowCase.find({ ...visibleTaskFilter(), $or: matches })
      .select('orderId productId customerId customer requestType taskKind requestedName quantity status assignedTeam assignedTo isBlocked blockedReason archivedAt priority deadlineAt targetMinutes assignedAt stageQueuedAt productionMethod print.machineId createdAt updatedAt')
      .populate('orderId', 'orderNumber userId')
      .populate('productId', 'name serialNumber imageUrl stockLocation')
      .populate('assignedTo', 'name email')
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    const cases = await hydrateCaseCustomers(found);
    // Work still in progress first, then finished and archived work, newest first.
    const rank = item => (item.archivedAt ? 2 : FINISHED_STATUSES.includes(item.status) ? 1 : 0);
    cases.sort((a, b) => (rank(a) - rank(b)) || (new Date(b.updatedAt) - new Date(a.updatedAt)));

    const results = cases.slice(0, FIND_LIMIT).map(item => {
      const order = item.orderId && typeof item.orderId === 'object' ? item.orderId : null;
      const product = item.productId && typeof item.productId === 'object' ? item.productId : null;
      const customer = [item.customerId, order?.userId, item.customer]
        .find(value => value && typeof value === 'object' && (value.name || value.email)) || null;
      return {
        _id: String(item._id),
        requestedName: item.requestedName,
        quantity: item.quantity,
        order: order ? { _id: String(order._id), orderNumber: order.orderNumber || `#${shortOrderCode(order._id)}` } : null,
        product: product ? { name: product.name, serialNumber: product.serialNumber || '', imageUrl: product.imageUrl || '', stockLocation: product.stockLocation || '' } : null,
        customer: customer ? { name: customer.name || '', email: customer.email || '' } : null,
        status: item.status,
        stage: findStageLabel(item),
        team: item.assignedTeam,
        teamLabel: TEAM_LABELS[item.assignedTeam] || item.assignedTeam,
        assignedTo: item.assignedTo && typeof item.assignedTo === 'object' ? { name: item.assignedTo.name || item.assignedTo.email || '' } : null,
        machineId: item.print?.machineId || '',
        productionMethod: item.productionMethod,
        priority: item.priority,
        isBlocked: Boolean(item.isBlocked),
        blockedReason: item.isBlocked ? item.blockedReason || '' : '',
        isLate: isLateCase(item),
        archived: Boolean(item.archivedAt),
        canOpen: canSeeCase(req.user, item),
        updatedAt: item.updatedAt
      };
    });
    res.json({ query: q, results, more: cases.length > FIND_LIMIT });
  } catch (error) {
    console.error('❌ Error finding workflow tasks:', error);
    res.status(500).json({ message: 'Failed to search tasks' });
  }
});

// Boss overview: totals and charts for today, the last 7 days or the last 30 days (Morocco time).
router.get('/overview', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user)) return res.status(403).json({ message: 'Only the boss or an administrator can view the overview' });
    res.json(await buildOverview({ range: String(req.query.range || 'today'), isLateCase }));
  } catch (error) {
    console.error('Error building overview:', error);
    res.status(500).json({ message: 'Failed to load the overview' });
  }
});

router.get('/analytics', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user)) return res.status(403).json({ message: 'Only the boss or an administrator can view employee timing' });
    const now = new Date();
    const [employees, activeCases, timedCases, recentOrders, completedOrders, failureCases, allProducts] = await Promise.all([
      User.find({ role: 'employee', isActive: { $ne: false } }).select('name email workRole').lean(),
      WorkflowCase.find({ ...visibleUnarchivedFilter(), status: ACTIVE_STATUSES })
        .select('requestedName assignedTeam assignedTo status deadlineAt targetMinutes stageQueuedAt assignedAt startedAt createdAt orderId productId productionMethod priority taskKind isBlocked blockedReason blockedAt')
        .populate('assignedTo', 'name email workRole')
        .populate('orderId', 'createdAt status fulfillmentState')
        .populate('productId', 'name serialNumber imageUrl')
        .lean(),
      WorkflowCase.find({ ...visibleTaskFilter(), 'history.workMinutes': { $gte: 0 } })
        .sort({ completedAt: -1, updatedAt: -1 })
        .limit(2000)
        .select('history completedAt assignedTo productionMethod')
        .lean(),
      Order.find({}).sort({ createdAt: -1 }).limit(25).select('createdAt status fulfillmentState items totalAmount').lean(),
      Order.find({ status: { $in: ['shipped', 'delivered'] } })
        .sort({ updatedAt: -1 })
        .limit(2000)
        .select('createdAt updatedAt')
        .lean(),
      WorkflowCase.find({
        ...visibleTaskFilter(),
        history: {
          $elemMatch: {
            action: 'status_changed',
            fromStatus: { $in: ['printing', 'quality_check'] },
            toStatus: { $in: ['ready_to_print', 'modeling'] }
          }
        }
      })
        .sort({ updatedAt: -1 })
        .limit(100)
        .select('requestedName orderId productId productionMethod history')
        .populate('productId', 'name serialNumber imageUrl')
        .lean(),
      Product.find({ removedFromShop: { $ne: true } })
        .select('name serialNumber imageUrl isActive stockSyncState printMethod fulfillmentPolicy price updatedAt')
        .sort({ updatedAt: -1 })
        .lean()
    ]);

    const employeeMap = new Map(employees.map(employee => [String(employee._id), {
      id: employee._id,
      name: employee.name,
      email: employee.email,
      workRole: employee.workRole || 'general',
      activeTasks: 0,
      workingTasks: 0,
      lateTasks: 0,
      completedSteps: 0,
      totalWorkMinutes: 0
    }]));

    const lateTasks = [];
    const blockedTasks = [];
    const unassignedByTeam = {};
    for (const item of activeCases) {
      const assigneeId = item.assignedTo?._id ? String(item.assignedTo._id) : null;
      const metric = assigneeId ? employeeMap.get(assigneeId) : null;
      const deadline = effectiveDeadline(item);
      const late = isLateCase(item, now);
      if (metric) {
        metric.activeTasks += 1;
        if (item.startedAt) metric.workingTasks += 1;
        if (late) metric.lateTasks += 1;
      } else {
        unassignedByTeam[item.assignedTeam] = (unassignedByTeam[item.assignedTeam] || 0) + 1;
      }
      if (late) {
        lateTasks.push({
          id: item._id,
          requestedName: item.requestedName,
          assignedTeam: item.assignedTeam,
          assignedTo: item.assignedTo || null,
          orderId: item.orderId?._id || item.orderId || null,
          orderSubmittedAt: item.orderId?.createdAt || null,
          deadlineAt: deadline,
          lateMinutes: stepLateMinutes(item, deadline, now),
          startedAt: item.startedAt,
          priority: item.priority
        });
      }
      if (item.isBlocked) {
        blockedTasks.push({
          id: item._id,
          requestedName: item.requestedName,
          assignedTeam: item.assignedTeam,
          assignedTo: item.assignedTo || null,
          orderId: item.orderId?._id || item.orderId || null,
          blockedReason: item.blockedReason,
          blockedAt: item.blockedAt,
          product: item.productId || null,
          priority: item.priority
        });
      }
    }

    const completionByTeamMap = new Map();
    let totalCompletedMinutes = 0;
    let completedStepCount = 0;
    for (const item of timedCases) {
      for (const event of item.history || []) {
        if (event.workMinutes === null || event.workMinutes === undefined) continue;
        // Work time in shop working hours (printing keeps the full clock).
        const finishedAt = event.createdAt ? new Date(event.createdAt).getTime() : NaN;
        const minutes = Number.isFinite(finishedAt)
          ? stepMinutes(event.fromStatus, finishedAt - Number(event.workMinutes || 0) * 60000, finishedAt) || 0
          : Number(event.workMinutes || 0);
        const metric = employeeMap.get(String(event.actorId?._id || event.actorId));
        if (metric) {
          metric.completedSteps += 1;
          metric.totalWorkMinutes += minutes;
        }
        totalCompletedMinutes += minutes;
        completedStepCount += 1;
        const team = teamForStatus(event.fromStatus, item.productionMethod);
        if (team && team !== 'none') {
          const teamMetric = completionByTeamMap.get(team) || { totalMinutes: 0, count: 0 };
          teamMetric.totalMinutes += minutes;
          teamMetric.count += 1;
          completionByTeamMap.set(team, teamMetric);
        }
      }
    }

    const employeeTiming = [...employeeMap.values()].map(metric => ({
      ...metric,
      averageWorkMinutes: metric.completedSteps ? Math.round(metric.totalWorkMinutes / metric.completedSteps) : null
    })).sort((left, right) => right.lateTasks - left.lateTasks || right.activeTasks - left.activeTasks || left.name.localeCompare(right.name));

    const printFailures = failureCases.flatMap(workflowCase => (workflowCase.history || [])
      .filter(event => event.action === 'status_changed'
        && ['printing', 'quality_check'].includes(event.fromStatus)
        && ['ready_to_print', 'modeling'].includes(event.toStatus))
      .map(event => ({
        caseId: workflowCase._id,
        requestedName: workflowCase.requestedName,
        orderId: workflowCase.orderId,
        product: workflowCase.productId || null,
        productionMethod: workflowCase.productionMethod,
        reason: event.note || 'Print returned for rework',
        failedAt: event.createdAt,
        returnedTo: event.toStatus
      })))
      .sort((left, right) => new Date(right.failedAt) - new Date(left.failedAt))
      .slice(0, 25);

    const productsWaiting = allProducts.map(product => {
      const needsImage = !product.imageUrl || /placeholder/i.test(product.imageUrl);
      const needsDetails = product.stockSyncState === 'needs_details' || product.isActive === false;
      const needsClassification = product.fulfillmentPolicy !== 'stock_only' && (!product.printMethod || product.printMethod === 'none');
      return { ...product, needsImage, needsDetails, needsClassification };
    }).filter(product => product.needsImage || product.needsDetails);

    const completionByTeam = Object.fromEntries([...completionByTeamMap].map(([team, metric]) => [team, {
      completedSteps: metric.count,
      averageMinutes: metric.count ? Math.round(metric.totalMinutes / metric.count) : null
    }]));
    const averageOrderMinutes = completedOrders.length
      ? Math.round(completedOrders.reduce((sum, order) => sum + minutesBetween(order.createdAt, order.updatedAt), 0) / completedOrders.length)
      : null;

    res.json({
      generatedAt: now,
      employees: employeeTiming,
      lateTasks: lateTasks.sort((left, right) => right.lateMinutes - left.lateMinutes),
      blockedTasks: blockedTasks.sort((left, right) => new Date(right.blockedAt) - new Date(left.blockedAt)),
      printFailures,
      averageTaskMinutes: completedStepCount ? Math.round(totalCompletedMinutes / completedStepCount) : null,
      averageOrderMinutes,
      completionByTeam,
      productsWaiting: productsWaiting.slice(0, 50),
      productsWaitingTotal: productsWaiting.length,
      unassignedByTeam,
      recentOrders: recentOrders.map(order => ({
        id: order._id,
        submittedAt: order.createdAt,
        status: order.status,
        fulfillmentState: order.fulfillmentState,
        itemCount: order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        totalAmount: order.totalAmount
      }))
    });
  } catch (error) {
    console.error('Error fetching workflow analytics:', error);
    res.status(500).json({ message: 'Failed to fetch workflow timing' });
  }
});

router.get('/audit', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user)) return res.status(403).json({ message: 'Only the boss or an administrator can view the audit trail' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const filter = {};
    if (['inventory', 'workflow', 'machine', 'backup', 'system'].includes(String(req.query.category))) {
      filter.category = String(req.query.category);
    }
    const records = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('actorId', 'name email')
      .lean();
    res.json(records);
  } catch (error) {
    console.error('Error fetching audit trail:', error);
    res.status(500).json({ message: 'Failed to fetch the audit trail' });
  }
});

router.get('/system-safety', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user)) return res.status(403).json({ message: 'Only the boss or an administrator can view system monitoring' });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [lastBackup, errorsLast24Hours, recentErrors] = await Promise.all([
      BackupRun.findOne({ status: 'completed' }).sort({ completedAt: -1 }).select('-filePath').lean(),
      SystemError.countDocuments({ lastSeenAt: { $gte: since }, resolvedAt: null }),
      SystemError.find({ resolvedAt: null }).sort({ lastSeenAt: -1 }).limit(5).select('-stack').lean()
    ]);
    res.json({ lastBackup, errorsLast24Hours, recentErrors });
  } catch (error) {
    console.error('Error fetching system safety status:', error);
    res.status(500).json({ message: 'Failed to fetch system safety status' });
  }
});

// An order still waiting to be confirmed. Customer Service may archive it, and
// it is erased for good once it has stayed ARCHIVE_PURGE_DAYS in the archive.
const isIncomingOrder = order => order.validationStatus === 'pending' && order.status !== 'cancelled';
const archivePurgeDate = (now = new Date()) => new Date(now.getTime() + ARCHIVE_PURGE_DAYS * 24 * 60 * 60 * 1000);
const purgeNote = purgeAt => `Erased for good on ${purgeAt.toISOString().slice(0, 10)} unless it is returned`;

router.post('/orders/:id/archive', operationsAuth, async (req, res) => {
  if (!isManagerUser(req.user) && !isCustomerServiceUser(req.user)) return res.status(403).json({ message: 'Only the boss or Customer Service can archive orders' });
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid order ID' });
  let session;
  try {
    session = await mongoose.startSession();
    let purgeAt = null;
    await session.withTransaction(async () => {
      const order = await Order.findById(req.params.id).session(session);
      if (!order) { const error = new Error('Order not found'); error.statusCode = 404; throw error; }
      if (order.operationsArchivedAt) { const error = new Error('Order is already archived'); error.statusCode = 409; throw error; }
      const cases = await WorkflowCase.find({ orderId: order._id }).session(session);
      const incoming = isIncomingOrder(order);
      if (!incoming && !isManagerUser(req.user)) {
        const error = new Error('This order is already confirmed. Use Ask to archive so the boss can archive it.'); error.statusCode = 403; throw error;
      }
      const active = item => !['completed', 'cancelled', 'rejected'].includes(item.status);
      if (!incoming && !cases.some(item => active(item) && (item.isBlocked || item.archiveRequest?.requestedAt))) {
        const error = new Error('Only an order with a blocked task or an archive request can be archived'); error.statusCode = 409; throw error;
      }
      const now = new Date();
      purgeAt = incoming ? archivePurgeDate(now) : null;
      order.operationsArchivedAt = now;
      order.operationsArchivedBy = req.user.id;
      order.archivePurgeAt = purgeAt;
      await order.save({ session });
      for (const item of cases) {
        item.archivedAt = now;
        item.archivedBy = req.user.id;
        item.archivePurgeAt = purgeAt;
        item.archiveRequest = undefined;
        item.history.push({ actorId: req.user.id, action: 'order_archived', note: purgeAt ? purgeNote(purgeAt) : 'Hidden from active operations until resumed' });
        await item.save({ session });
      }
    });
    res.json({ orderId: req.params.id, archived: true, ...(purgeAt ? { purgeAt } : {}) });
  } catch (error) {
    console.error('Error archiving order:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to archive order' });
  } finally { if (session) await session.endSession(); }
});

router.post('/orders/:id/resume', operationsAuth, async (req, res) => {
  if (!isManagerUser(req.user) && !isCustomerServiceUser(req.user)) return res.status(403).json({ message: 'Only the boss or an administrator can resume archived orders' });
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid order ID' });
  let session;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const order = await Order.findById(req.params.id).session(session);
      if (!order) { const error = new Error('Order not found'); error.statusCode = 404; throw error; }
      if (!order.operationsArchivedAt) { const error = new Error('Order is not archived'); error.statusCode = 409; throw error; }
      if (!isManagerUser(req.user) && !order.archivePurgeAt) { const error = new Error('Only the boss can return this order'); error.statusCode = 403; throw error; }
      const now = new Date();
      const cases = await WorkflowCase.find({ orderId: order._id, archivedAt: { $ne: null } }).session(session);
      for (const item of cases) {
        item.archivedAt = null;
        item.archivedBy = null;
        item.archivePurgeAt = null;
        if (item.isBlocked) {
          item.isBlocked = false;
          item.blockedReason = '';
          item.blockedAt = null;
          item.blockedBy = null;
        }
        if (!['completed', 'cancelled', 'rejected'].includes(item.status)) {
          item.startedAt = null;
          item.stageQueuedAt = now;
          item.assignedAt = item.assignedTo ? now : null;
        }
        item.history.push({ actorId: req.user.id, action: 'order_resumed', note: 'Returned to active operations; blocked tasks were reopened' });
        await item.save({ session });
      }
      order.operationsArchivedAt = null;
      order.operationsArchivedBy = null;
      order.archivePurgeAt = null;
      await order.save({ session });
    });
    await refreshOrderFulfillment(req.params.id, req.user.id, req.app);
    res.json({ orderId: req.params.id, archived: false });
  } catch (error) {
    console.error('Error resuming order:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to resume order' });
  } finally { if (session) await session.endSession(); }
});

// An incoming task with no order behind it is archived and returned on its own.
router.post('/tasks/:id/archive', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user) && !isCustomerServiceUser(req.user)) return res.status(403).json({ message: 'Only the boss or Customer Service can archive this task' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    if (workflowCase.orderId) return res.status(409).json({ message: 'Archive the whole order instead' });
    if (workflowCase.archivedAt) return res.status(409).json({ message: 'This task is already archived' });
    if (workflowCase.status !== 'awaiting_validation') return res.status(409).json({ message: 'Only a task waiting to be confirmed can be archived' });
    const now = new Date();
    const purgeAt = archivePurgeDate(now);
    workflowCase.archivedAt = now;
    workflowCase.archivedBy = req.user.id;
    workflowCase.archivePurgeAt = purgeAt;
    workflowCase.archiveRequest = undefined;
    workflowCase.history.push({ actorId: req.user.id, action: 'order_archived', note: purgeNote(purgeAt) });
    await workflowCase.save();
    res.json({ caseId: req.params.id, archived: true, purgeAt });
  } catch (error) {
    console.error('Error archiving task:', error);
    res.status(500).json({ message: 'Failed to archive the task' });
  }
});

router.post('/tasks/:id/resume', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user) && !isCustomerServiceUser(req.user)) return res.status(403).json({ message: 'Only the boss or Customer Service can return this task' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    if (workflowCase.orderId) return res.status(409).json({ message: 'Return the whole order instead' });
    if (!workflowCase.archivedAt) return res.status(409).json({ message: 'This task is not archived' });
    const now = new Date();
    workflowCase.archivedAt = null;
    workflowCase.archivedBy = null;
    workflowCase.archivePurgeAt = null;
    workflowCase.isBlocked = false;
    workflowCase.blockedReason = '';
    workflowCase.blockedAt = null;
    workflowCase.blockedBy = null;
    workflowCase.startedAt = null;
    workflowCase.stageQueuedAt = now;
    workflowCase.history.push({ actorId: req.user.id, action: 'order_resumed', note: 'Returned from the archive' });
    await workflowCase.save();
    res.json({ caseId: req.params.id, archived: false });
  } catch (error) {
    console.error('Error returning task:', error);
    res.status(500).json({ message: 'Failed to return the task' });
  }
});

// An employee who cannot archive an order asks the boss to archive it.
router.post('/tasks/:id/archive-request', operationsAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const reason = cleanText(req.body.reason, 500);
    if (!reason) return res.status(400).json({ message: 'Explain why this order should be archived' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    if (!canSeeCase(req.user, workflowCase)) return res.status(403).json({ message: 'This task belongs to another employee' });
    if (workflowCase.archivedAt) return res.status(409).json({ message: 'This order is already archived' });
    if (['completed', 'cancelled', 'rejected'].includes(workflowCase.status)) return res.status(409).json({ message: 'This task is already finished' });
    if (workflowCase.archiveRequest?.requestedAt) return res.status(409).json({ message: 'Archiving was already asked for this order' });
    const requester = mongoose.Types.ObjectId.isValid(String(req.user.id)) ? await User.findById(req.user.id).select('name email').lean() : null;
    const requestedByName = requester?.name || requester?.email || req.user.email || 'An employee';
    workflowCase.archiveRequest = { requestedBy: req.user.id, requestedByName, requestedAt: new Date(), reason };
    workflowCase.history.push({ actorId: req.user.id, action: 'archive_requested', note: `Reason: ${reason}` });
    await workflowCase.save();
    await safelyNotify(async () => notifyUsers(req.app, await activeAdminIds(), {
      title: 'Archive asked',
      body: `${requestedByName} asks to archive ${workflowCase.requestedName}: ${reason}`,
      type: 'archive_requested',
      data: { workflowCaseId: String(workflowCase._id), orderId: workflowCase.orderId ? String(workflowCase.orderId) : null },
      dedupeKey: `archive-request:${workflowCase._id}:${workflowCase.archiveRequest.requestedAt.getTime()}`
    }));
    res.json(await hydrateCaseCustomers(await populateCase(WorkflowCase.findById(workflowCase._id))));
  } catch (error) {
    console.error('Error asking to archive:', error);
    res.status(500).json({ message: 'Failed to send the archive request' });
  }
});

router.use('/cases/:id', operationsAuth, async (req, res, next) => {
  if (req.method === 'GET') return next();
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next();
  try {
    const item = await WorkflowCase.findById(req.params.id).select('archivedAt').lean();
    if (item?.archivedAt) return res.status(409).json({ message: 'Resume the archived order before changing its tasks' });
    next();
  } catch (error) { next(error); }
});

router.post('/cases/:id/claim', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user)) {
      return res.status(403).json({ message: 'Tasks are assigned automatically. Only the boss can change an assignment.' });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    if (['completed', 'cancelled', 'rejected'].includes(workflowCase.status)) {
      return res.status(409).json({ message: 'Closed tasks cannot be claimed' });
    }
    if (!isManagerUser(req.user) && userTeam(req.user) !== workflowCase.assignedTeam) {
      return res.status(403).json({ message: 'This task belongs to another team' });
    }
    if (workflowCase.assignedTo && !sameUserId(workflowCase.assignedTo, req.user.id)) {
      return res.status(409).json({ message: 'This task has already been claimed by another employee' });
    }
    if (!workflowCase.assignedTo) {
      const now = new Date();
      workflowCase.assignedTo = req.user.id;
      workflowCase.assignedAt = now;
      workflowCase.history.push({
        actorId: req.user.id,
        action: 'task_claimed',
        note: cleanText(req.body.note, 1000),
        queueMinutes: minutesBetween(workflowCase.stageQueuedAt || workflowCase.createdAt, now)
      });
      await workflowCase.save();
    }
    res.json(await populateCase(WorkflowCase.findById(workflowCase._id)));
  } catch (error) {
    console.error('Error claiming workflow task:', error);
    res.status(500).json({ message: error.message || 'Failed to claim task' });
  }
});

router.post('/cases/:id/release', operationsAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    if (!isManagerUser(req.user) && !sameUserId(workflowCase.assignedTo, req.user.id)) {
      return res.status(403).json({ message: 'Only the assigned employee can release this task' });
    }
    const now = new Date();
    workflowCase.history.push({
      actorId: req.user.id,
      action: 'task_released',
      note: cleanText(req.body.note, 1000),
      queueMinutes: minutesBetween(workflowCase.stageQueuedAt || workflowCase.createdAt, workflowCase.startedAt || now),
      workMinutes: workflowCase.startedAt ? minutesBetween(workflowCase.startedAt, now) : null
    });
    workflowCase.assignedTo = null;
    workflowCase.assignedAt = null;
    workflowCase.startedAt = null;
    await workflowCase.save();
    res.json(await populateCase(WorkflowCase.findById(workflowCase._id)));
  } catch (error) {
    console.error('Error releasing workflow task:', error);
    res.status(500).json({ message: error.message || 'Failed to release task' });
  }
});

router.patch('/cases/:id/assignment', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user)) return res.status(403).json({ message: 'Only the boss or an administrator can assign tasks' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    const previousAssignee = workflowCase.assignedTo;

    const userId = req.body.userId || null;
    let employee = null;
    if (userId) {
      if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ message: 'Invalid employee ID' });
      employee = await User.findOne({ _id: userId, role: 'employee', isActive: { $ne: false } }).select('name email workRole');
      if (!employee) return res.status(404).json({ message: 'Active employee not found' });
      if (!canUseTeam(employee, workflowCase.assignedTeam)) {
        return res.status(409).json({ message: 'Choose an employee whose role matches this task team' });
      }
    }

    workflowCase.assignedTo = employee?._id || null;
    workflowCase.assignedAt = employee ? new Date() : null;
    workflowCase.startedAt = null;
    workflowCase.history.push({
      actorId: req.user.id,
      action: employee ? 'task_assigned' : 'task_unassigned',
      note: employee ? `Assigned to ${employee.name || employee.email}` : cleanText(req.body.note, 1000)
    });
    await workflowCase.save();
    if (!sameUserId(previousAssignee, workflowCase.assignedTo)) {
      if (previousAssignee) await safelyNotify(() => notifyTaskRemoved(req.app, previousAssignee, workflowCase));
      if (workflowCase.assignedTo) await safelyNotify(() => notifyCaseAssignment(req.app, workflowCase, previousAssignee ? 'reassigned' : 'new_task'));
    }
    res.json(await populateCase(WorkflowCase.findById(workflowCase._id)));
  } catch (error) {
    console.error('Error assigning workflow task:', error);
    res.status(500).json({ message: error.message || 'Failed to assign task' });
  }
});

router.post('/cases/:id/start', operationsAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    const ownershipError = requireOwnedCase(req.user, workflowCase);
    if (ownershipError) return res.status(isUnassigned(workflowCase) ? 409 : 403).json({ message: ownershipError });
    if (['completed', 'cancelled', 'rejected'].includes(workflowCase.status)) {
      return res.status(409).json({ message: 'Closed tasks cannot be started' });
    }
    if (workflowCase.isBlocked) {
      return res.status(409).json({ message: 'Resume this blocked task before starting it' });
    }
    if (!workflowCase.startedAt) {
      const now = new Date();
      const previousStatus = workflowCase.status;
      workflowCase.startedAt = now;
      // Starting a task records employee work, not a printer job. The separate
      // ready_to_print -> printing transition requires a chosen machine.
      workflowCase.history.push({
        actorId: req.user.id,
        action: 'task_started',
        fromStatus: previousStatus,
        toStatus: workflowCase.status,
        note: cleanText(req.body.note, 1000),
        queueMinutes: minutesBetween(workflowCase.stageQueuedAt || workflowCase.createdAt, now)
      });
      await workflowCase.save();
    }
    res.json(await populateCase(WorkflowCase.findById(workflowCase._id)));
  } catch (error) {
    console.error('Error starting workflow task:', error);
    res.status(500).json({ message: error.message || 'Failed to start task' });
  }
});

router.post('/cases/:id/block', operationsAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const reason = cleanText(req.body.reason, 1000);
    if (!reason) return res.status(400).json({ message: 'Explain why the task is blocked' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    const ownershipError = requireOwnedCase(req.user, workflowCase);
    if (ownershipError) return res.status(isUnassigned(workflowCase) ? 409 : 403).json({ message: ownershipError });
    if (['completed', 'cancelled', 'rejected'].includes(workflowCase.status)) {
      return res.status(409).json({ message: 'Closed tasks cannot be blocked' });
    }

    const now = new Date();
    workflowCase.isBlocked = true;
    workflowCase.blockedReason = reason;
    workflowCase.blockedAt = now;
    workflowCase.blockedBy = req.user.id;
    workflowCase.history.push({ actorId: req.user.id, action: 'task_blocked', note: reason });
    await workflowCase.save();
    await refreshOrderFulfillment(workflowCase.orderId, req.user.id, req.app);
    await safelyNotify(() => notifyOrderBlocked(req.app, workflowCase, reason));
    res.json(await populateCase(WorkflowCase.findById(workflowCase._id)));
  } catch (error) {
    console.error('Error blocking workflow task:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to block task' });
  }
});

router.post('/cases/:id/unblock', operationsAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    const ownershipError = requireOwnedCase(req.user, workflowCase);
    if (ownershipError) return res.status(isUnassigned(workflowCase) ? 409 : 403).json({ message: ownershipError });
    if (workflowCase.isBlocked) {
      workflowCase.isBlocked = false;
      workflowCase.blockedReason = '';
      workflowCase.blockedAt = null;
      workflowCase.blockedBy = null;
      workflowCase.history.push({ actorId: req.user.id, action: 'task_resumed', note: cleanText(req.body.note, 1000) });
      await workflowCase.save();
      await refreshOrderFulfillment(workflowCase.orderId, req.user.id, req.app);
    }
    res.json(await populateCase(WorkflowCase.findById(workflowCase._id)));
  } catch (error) {
    console.error('Error resuming workflow task:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to resume task' });
  }
});

router.patch('/products/:id/production', operationsAuth, requireTeam('boss'), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid product ID' });
    const policy = String(req.body.fulfillmentPolicy || '');
    const method = String(req.body.printMethod || 'none');
    if (!['stock_only', 'print_on_demand', 'stock_then_print'].includes(policy)) {
      return res.status(400).json({ message: 'Invalid product supply rule' });
    }
    if (!['none', 'wax', 'resin'].includes(method)) {
      return res.status(400).json({ message: 'Printing method must be none, wax, or resin' });
    }
    if (policy !== 'stock_only' && method === 'none') {
      return res.status(400).json({ message: 'Choose wax or resin for a printable product' });
    }
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: { fulfillmentPolicy: policy, printMethod: method } },
      { new: true, runValidators: true }
    ).populate('catalogId', 'name');
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (error) {
    console.error('Error updating product production rule:', error);
    res.status(500).json({ message: error.message || 'Failed to update product production rule' });
  }
});

router.get('/cases/:id', operationsAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await hydrateCaseCustomers(await populateCase(WorkflowCase.findById(req.params.id)));
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    if (!canSeeCase(req.user, workflowCase)) return res.status(403).json({ message: 'This task belongs to another employee' });
    res.json(workflowCase);
  } catch (error) {
    console.error('Error fetching workflow case:', error);
    res.status(500).json({ message: 'Failed to fetch workflow case' });
  }
});

router.post('/cases', operationsAuth, requireTeam('customer_service'), async (req, res) => {
  try {
    const requestType = String(req.body.requestType || 'product_missing');
    const requestedName = cleanText(req.body.requestedName, 200);
    const quantity = Number(req.body.quantity || 1);
    const requirements = cleanText(req.body.requirements, 4000);

    if (!CASE_TYPES.includes(requestType)) return res.status(400).json({ message: 'Invalid case type' });
    if (!MANUAL_CASE_TYPES.includes(requestType)) {
      return res.status(400).json({ message: 'Stock, printing, damage, quality, and packing tasks are created automatically by the system' });
    }
    if (!requestedName) return res.status(400).json({ message: 'Requested product name is required' });
    if (!Number.isSafeInteger(quantity) || quantity < 1) return res.status(400).json({ message: 'Quantity must be a positive whole number' });
    if (!validObjectId(req.body.orderId) || !validObjectId(req.body.productId) || !validObjectId(req.body.customerId)) {
      return res.status(400).json({ message: 'Invalid order, product, or customer ID' });
    }

    const [order, product] = await Promise.all([
      req.body.orderId ? Order.findById(req.body.orderId) : null,
      req.body.productId ? Product.findById(req.body.productId) : null
    ]);
    if (req.body.orderId && !order) return res.status(404).json({ message: 'Order not found' });
    if (order?.operationsArchivedAt) return res.status(409).json({ message: 'Resume the archived order before adding a task' });
    if (req.body.productId && !product) return res.status(404).json({ message: 'Product not found' });

    const isExtraTask = req.body.taskKind === 'extra' || requestType === 'general_task';
    const requestedTeam = String(req.body.targetTeam || '');
    const allowedTeams = Object.keys(TEAM_WORK_ROLES);
    if (isExtraTask && !allowedTeams.includes(requestedTeam)) {
      return res.status(400).json({ message: 'Choose the team responsible for this extra task' });
    }
    const status = isExtraTask ? 'task_ready' : (req.body.sendToBoss && requirements ? 'boss_review' : 'needs_customer_info');
    const approval = req.body.customerApproval === 'not_required' ? 'not_required' : 'pending';
    const initialTeam = isExtraTask ? requestedTeam : teamForStatus(status);
    const deadlineValue = req.body.deadlineAt || req.body.dueDate || null;
    const deadlineAt = deadlineValue ? new Date(deadlineValue) : null;
    if (deadlineAt && Number.isNaN(deadlineAt.getTime())) return res.status(400).json({ message: 'Invalid deadline' });
    const targetMinutes = parseTargetMinutes(req.body.targetMinutes, targetMinutesForTeam(initialTeam));
    const assignToCreator = req.body.assignToMe === true && (isManagerUser(req.user) || userTeam(req.user) === initialTeam);
    const automaticAssignee = assignToCreator ? null : await findTeamAssignee(initialTeam);
    const now = new Date();
    const workflowCase = await WorkflowCase.create({
      orderId: order?._id || null,
      customerId: req.body.customerId || order?.userId || null,
      productId: product?._id || null,
      requestType,
      requestedName,
      quantity,
      status,
      assignedTeam: initialTeam,
      assignedTo: assignToCreator ? req.user.id : (automaticAssignee?._id || null),
      taskKind: isExtraTask ? 'extra' : 'order',
      priority: ['low', 'normal', 'urgent'].includes(req.body.priority) ? req.body.priority : 'normal',
      deadlineAt,
      targetMinutes,
      stageQueuedAt: now,
      assignedAt: assignToCreator || automaticAssignee ? now : null,
      customer: {
        name: cleanText(req.body.customer?.name, 160),
        email: cleanText(req.body.customer?.email, 320).toLowerCase(),
        phone: cleanText(req.body.customer?.phone, 60)
      },
      requirements,
      referenceUrls: Array.isArray(req.body.referenceUrls) ? req.body.referenceUrls.slice(0, 10).map(url => cleanText(url, 2000)).filter(Boolean) : [],
      dimensions: normalizeDimensions(req.body.dimensions),
      productionMethod: PRODUCTION_METHODS.includes(req.body.productionMethod) ? req.body.productionMethod : 'undecided',
      quote: { amount: null, currency: 'MAD', dueDate: deadlineAt },
      customerApproval: approval,
      createdBy: req.user.id,
      history: [{ actorId: req.user.id, action: 'case_created', toStatus: status, note: cleanText(req.body.note, 1000) }]
    });

    if (order) {
      await Order.updateOne(
        { _id: order._id },
        { $addToSet: { workflowCaseIds: workflowCase._id }, $set: { fulfillmentState: status === 'needs_customer_info' ? 'blocked' : 'in_progress' } }
      );
    }

    await safelyNotify(() => notifyCaseAssignment(req.app, workflowCase));
    if (status === 'needs_customer_info') {
      await safelyNotify(() => notifyOrderBlocked(req.app, workflowCase, requirements || 'customer information is missing'));
    }

    res.status(201).json(await populateCase(WorkflowCase.findById(workflowCase._id)));
  } catch (error) {
    console.error('Error creating workflow case:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to create workflow case' });
  }
});

router.patch('/cases/:id', operationsAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    const previousAssignee = workflowCase.assignedTo;
    const ownershipError = requireOwnedCase(req.user, workflowCase);
    if (ownershipError) return res.status(isUnassigned(workflowCase) ? 409 : 403).json({ message: ownershipError });

    if (req.body.requestedName !== undefined) workflowCase.requestedName = cleanText(req.body.requestedName, 200);
    if (req.body.quantity !== undefined) {
      const quantity = Number(req.body.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 1) return res.status(400).json({ message: 'Quantity must be a positive whole number' });
      workflowCase.quantity = quantity;
    }
    if (req.body.requirements !== undefined) workflowCase.requirements = cleanText(req.body.requirements, 4000);
    if (req.body.priority !== undefined) {
      if (!['low', 'normal', 'urgent'].includes(req.body.priority)) return res.status(400).json({ message: 'Invalid task priority' });
      workflowCase.priority = req.body.priority;
    }
    if (req.body.taskKind !== undefined) {
      if (!['order', 'extra'].includes(req.body.taskKind)) return res.status(400).json({ message: 'Invalid task type' });
      workflowCase.taskKind = req.body.taskKind;
    }
    if (req.body.deadlineAt !== undefined) {
      const deadlineAt = req.body.deadlineAt ? new Date(req.body.deadlineAt) : null;
      if (deadlineAt && Number.isNaN(deadlineAt.getTime())) return res.status(400).json({ message: 'Invalid deadline' });
      workflowCase.deadlineAt = deadlineAt;
    }
    if (req.body.targetMinutes !== undefined) {
      workflowCase.targetMinutes = parseTargetMinutes(req.body.targetMinutes, targetMinutesForTeam(workflowCase.assignedTeam));
    }
    if (req.body.productionMethod !== undefined) {
      if (!PRODUCTION_METHODS.includes(req.body.productionMethod)) return res.status(400).json({ message: 'Printing method must be undecided, wax, or resin' });
      workflowCase.productionMethod = req.body.productionMethod;
      const nextTeam = workflowCase.status === 'task_ready'
        ? workflowCase.assignedTeam
        : teamForStatus(workflowCase.status, workflowCase.productionMethod);
      if (nextTeam !== workflowCase.assignedTeam) {
        const automaticAssignee = await findTeamAssignee(nextTeam);
        workflowCase.assignedTeam = nextTeam;
        workflowCase.assignedTo = automaticAssignee?._id || null;
        workflowCase.assignedAt = automaticAssignee ? new Date() : null;
        workflowCase.startedAt = null;
        workflowCase.stageQueuedAt = new Date();
        workflowCase.targetMinutes = targetMinutesForTeam(nextTeam);
      }
    }
    if (req.body.dimensions !== undefined) workflowCase.dimensions = normalizeDimensions(req.body.dimensions, workflowCase.dimensions?.toObject?.() || workflowCase.dimensions);
    if (req.body.customer !== undefined) {
      workflowCase.customer = {
        name: cleanText(req.body.customer.name, 160),
        email: cleanText(req.body.customer.email, 320).toLowerCase(),
        phone: cleanText(req.body.customer.phone, 60)
      };
    }
    if (req.body.referenceUrls !== undefined) {
      if (!Array.isArray(req.body.referenceUrls)) return res.status(400).json({ message: 'Reference URLs must be a list' });
      workflowCase.referenceUrls = req.body.referenceUrls.slice(0, 10).map(url => cleanText(url, 2000)).filter(Boolean);
    }
    if (req.body.quote !== undefined) {
      const amount = req.body.quote.amount === '' || req.body.quote.amount === null ? null : Number(req.body.quote.amount);
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return res.status(400).json({ message: 'Quote amount must be zero or more' });
      const dueDate = req.body.quote.dueDate || null;
      if (dueDate && Number.isNaN(new Date(dueDate).getTime())) return res.status(400).json({ message: 'Invalid due date' });
      workflowCase.quote = {
        amount,
        currency: cleanText(req.body.quote.currency || 'MAD', 3).toUpperCase(),
        dueDate
      };
      if (req.body.deadlineAt === undefined && req.body.quote.dueDate !== undefined) {
        workflowCase.deadlineAt = dueDate ? new Date(dueDate) : null;
      }
    }
    if (req.body.customerApproval !== undefined) {
      if (!['pending', 'approved', 'rejected', 'not_required'].includes(req.body.customerApproval)) {
        return res.status(400).json({ message: 'Invalid customer approval value' });
      }
      workflowCase.customerApproval = req.body.customerApproval;
      if (req.body.customerApproval === 'approved') {
        workflowCase.customerApprovedAt = new Date();
        workflowCase.customerApprovedBy = req.user.id;
      } else {
        workflowCase.customerApprovedAt = null;
        workflowCase.customerApprovedBy = null;
      }
    }
    workflowCase.history.push({ actorId: req.user.id, action: 'details_updated', note: cleanText(req.body.note, 1000) });
    await workflowCase.save();
    if (!sameUserId(previousAssignee, workflowCase.assignedTo)) {
      if (previousAssignee) await safelyNotify(() => notifyTaskRemoved(req.app, previousAssignee, workflowCase));
      if (workflowCase.assignedTo) await safelyNotify(() => notifyCaseAssignment(req.app, workflowCase, 'reassigned'));
    }
    res.json(await populateCase(WorkflowCase.findById(workflowCase._id)));
  } catch (error) {
    console.error('Error updating workflow case:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update workflow case' });
  }
});

router.post('/cases/:id/models', operationsAuth, requireTeam('boss'), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    const ownershipError = requireOwnedCase(req.user, workflowCase);
    if (ownershipError) return res.status(isUnassigned(workflowCase) ? 409 : 403).json({ message: ownershipError });

    const fileName = cleanText(req.body.fileName, 200);
    const fileUrl = cleanText(req.body.fileUrl, 2000);
    if (!fileName || !fileUrl) return res.status(400).json({ message: 'Model file name and URL are required' });
    if (!/^https?:\/\//i.test(fileUrl)) return res.status(400).json({ message: 'Model file URL must start with http:// or https://' });
    const isPrintReady = req.body.isPrintReady === true;
    if (isPrintReady && !['wax', 'resin'].includes(workflowCase.productionMethod)) {
      return res.status(400).json({ message: 'Choose wax or resin before marking a model print ready' });
    }

    if (isPrintReady) workflowCase.modelVersions.forEach(version => { version.isPrintReady = false; });
    workflowCase.modelVersions.push({
      version: workflowCase.modelVersions.length + 1,
      fileName,
      fileUrl,
      notes: cleanText(req.body.notes, 1000),
      dimensions: normalizeDimensions(req.body.dimensions, workflowCase.dimensions?.toObject?.() || workflowCase.dimensions),
      uploadedBy: req.user.id,
      isPrintReady
    });
    workflowCase.history.push({ actorId: req.user.id, action: 'model_version_added', note: `Version ${workflowCase.modelVersions.length}: ${fileName}` });
    await workflowCase.save();

    if (isPrintReady && workflowCase.productId) {
      await Product.updateOne({ _id: workflowCase.productId }, {
        $set: {
          modelFileName: fileName,
          modelFileUrl: fileUrl,
          modelFileStatus: 'print_ready',
          modelVersion: workflowCase.modelVersions.length,
          printMethod: workflowCase.productionMethod
        }
      });
    }

    res.status(201).json(await populateCase(WorkflowCase.findById(workflowCase._id)));
  } catch (error) {
    console.error('Error adding model version:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to add model version' });
  }
});

router.post('/cases/:id/reroute-print', operationsAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    const ownershipError = requireOwnedCase(req.user, workflowCase);
    if (ownershipError) return res.status(isUnassigned(workflowCase) ? 409 : 403).json({ message: ownershipError });
    if (!['ready_to_print', 'printing'].includes(workflowCase.status)) {
      return res.status(409).json({ message: 'Only a task waiting to print or currently printing can change printer' });
    }
    if (!['wax', 'resin'].includes(workflowCase.productionMethod)) {
      return res.status(409).json({ message: 'This task does not have a Wax or Resin route yet' });
    }
    if (!isManagerUser(req.user) && req.user.workRole !== workflowCase.assignedTeam) {
      return res.status(403).json({ message: 'Only the assigned printing team can reroute this task' });
    }

    const reason = cleanText(req.body.reason, 1000);
    if (!reason) return res.status(400).json({ message: 'Add a short reason for changing the printer' });

    const previousMethod = workflowCase.productionMethod;
    const previousMachineCode = workflowCase.print?.machineId || '';
    const nextMethod = previousMethod === 'wax' ? 'resin' : 'wax';
    const previousStatus = workflowCase.status;
    const previousAssignee = workflowCase.assignedTo;
    const nextTeam = teamForStatus('ready_to_print', nextMethod);
    const now = new Date();
    const queueMinutes = minutesBetween(workflowCase.stageQueuedAt || workflowCase.createdAt, workflowCase.startedAt || now);
    const workMinutes = workflowCase.startedAt ? minutesBetween(workflowCase.startedAt, now) : null;
    const automaticAssignee = await findTeamAssignee(nextTeam);

    workflowCase.productionMethod = nextMethod;
    workflowCase.status = 'ready_to_print';
    workflowCase.assignedTeam = nextTeam;
    workflowCase.assignedTo = automaticAssignee?._id || null;
    workflowCase.assignedAt = automaticAssignee ? now : null;
    workflowCase.startedAt = null;
    workflowCase.stageQueuedAt = now;
    workflowCase.targetMinutes = targetMinutesForTeam(nextTeam);
    workflowCase.isBlocked = false;
    workflowCase.blockedReason = '';
    workflowCase.blockedAt = null;
    workflowCase.blockedBy = null;
    workflowCase.print = { machineId: '', sentAt: null, startedAt: null, completedAt: null };
    workflowCase.history.push({
      actorId: req.user.id,
      action: 'production_rerouted',
      fromStatus: previousStatus,
      toStatus: 'ready_to_print',
      note: `${previousMethod} → ${nextMethod}: ${reason}`,
      queueMinutes,
      workMinutes
    });
    await workflowCase.save();

    if (previousStatus === 'printing' && previousMachineCode) {
      await releaseMachineFromCase({ machineCode: previousMachineCode, workflowCase, actorId: req.user.id, outcome: 'failed', reason });
    }

    if (workflowCase.orderId && workflowCase.orderItemId) {
      await Order.updateOne(
        { _id: workflowCase.orderId, 'items._id': workflowCase.orderItemId },
        { $set: { 'items.$.productionMethod': nextMethod, 'items.$.fulfillmentStatus': 'production' } }
      );
    }

    if (previousAssignee) await safelyNotify(() => notifyTaskRemoved(req.app, previousAssignee, workflowCase));
    if (previousStatus === 'printing') {
      await safelyNotify(() => notifyFailedPrint(req.app, workflowCase, reason));
    } else if (workflowCase.assignedTo) {
      await safelyNotify(() => notifyCaseAssignment(req.app, workflowCase, 'reassigned'));
    }
    await refreshOrderFulfillment(workflowCase.orderId, req.user.id, req.app);

    res.json(await populateCase(WorkflowCase.findById(workflowCase._id)));
  } catch (error) {
    console.error('Error rerouting print task:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to reroute the print task' });
  }
});

// The stock team could not find some reserved units on the shelf. Those units
// are written off the stock count (they are not there) and sent to printing on
// the route Customer Service chose, so the order keeps moving.
const failWith = (message, statusCode = 409) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
};

const printMethodForItem = (orderItem, workflowCase, product) => (
  ['wax', 'resin'].includes(orderItem.productionMethod) ? orderItem.productionMethod
    : ['wax', 'resin'].includes(workflowCase.productionMethod) ? workflowCase.productionMethod
      : ['wax', 'resin'].includes(product.printMethod) ? product.printMethod : null
);

// Reserved units that are not on the shelf leave both the reserved and the on-hand count.
const removeMissingReservedUnits = async ({ order, orderItem, product, missing, actorId, notes, session }) => {
  if (orderItem.inventoryVariantId) {
    const variant = await StockVariant.findOneAndUpdate(
      { _id: orderItem.inventoryVariantId, reservedQuantity: { $gte: missing }, onHandQuantity: { $gte: missing } },
      { $inc: { reservedQuantity: -missing, onHandQuantity: -missing } },
      { new: true, session }
    );
    if (!variant) failWith('Reserved size stock is inconsistent for this item');
    await Product.updateMany({ _id: { $in: variant.productIds } }, { $inc: { reservedStock: -missing } }, { session });
  } else {
    const updated = await Product.updateOne(
      { _id: product._id, reservedStock: { $gte: missing } },
      { $inc: { reservedStock: -missing } },
      { session }
    );
    if (updated.modifiedCount !== 1) failWith('Reserved stock is inconsistent for this item');
  }
  await InventoryMovement.create([{
    productId: product._id,
    orderId: order._id,
    actorId,
    type: 'remove',
    quantity: -missing,
    stockBefore: product.stock,
    stockAfter: product.stock,
    notes
  }], { session });
};

// Units the stock side cannot supply move to printing: they join the item's
// print task if it has not started yet, otherwise a new print task opens.
const moveStockUnitsToPrint = async ({ workflowCase, order, orderItem, product, missing, method, actorId, note, session }) => {
  const now = new Date();
  orderItem.stockQuantity = Number(orderItem.stockQuantity || 0) - missing;
  orderItem.printQuantity = Number(orderItem.printQuantity || 0) + missing;
  orderItem.productionMethod = method;
  orderItem.fulfillmentStatus = 'production';

  let printCase = await WorkflowCase.findOne({
    orderId: order._id,
    orderItemId: orderItem._id,
    requestType: 'print_required',
    status: 'ready_to_print',
    startedAt: null,
    archivedAt: null
  }).session(session);
  if (printCase) {
    printCase.quantity += missing;
    printCase.history.push({ actorId, action: 'stock_missing_added', fromStatus: 'ready_to_print', toStatus: 'ready_to_print', note });
  } else {
    const team = teamForStatus('ready_to_print', method);
    const assignee = await findTeamAssignee(team, session);
    printCase = new WorkflowCase({
      orderId: order._id,
      orderItemId: orderItem._id,
      customerId: order.userId,
      productId: product._id,
      requestType: 'print_required',
      requestedName: product.name,
      quantity: missing,
      status: 'ready_to_print',
      assignedTeam: team,
      assignedTo: assignee?._id || null,
      assignedAt: assignee ? now : null,
      stageQueuedAt: now,
      taskKind: 'order',
      priority: workflowCase.priority,
      targetMinutes: targetMinutesForTeam(team),
      requirements: `Print ${missing} unit(s), size ${orderItem.size || '-'}, that were not found in stock.`,
      productionMethod: method,
      customerApproval: 'not_required',
      createdBy: actorId,
      history: [{ actorId, action: 'created_from_missing_stock', toStatus: 'ready_to_print', note }]
    });
    order.workflowCaseIds.addToSet(printCase._id);
  }
  await printCase.save({ session });
  return printCase;
};

router.post('/cases/:id/stock-missing', operationsAuth, async (req, res) => {
  let session;
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const reason = cleanText(req.body.reason, 1000);
    session = await mongoose.startSession();
    let printCase;
    let stockCaseId;
    await session.withTransaction(async () => {
      const fail = (message, statusCode = 409) => { const error = new Error(message); error.statusCode = statusCode; throw error; };
      const workflowCase = await WorkflowCase.findById(req.params.id).session(session);
      if (!workflowCase) fail('Workflow case not found', 404);
      if (workflowCase.status !== 'stock_picking' || workflowCase.requestType !== 'stock_pick') fail('Only a stock picking task can send missing units to printing');
      const ownershipError = requireOwnedCase(req.user, workflowCase);
      if (ownershipError) fail(ownershipError, isUnassigned(workflowCase) ? 409 : 403);
      if (!canUseTeam(req.user, 'stock')) fail('Only the stock team can report missing stock', 403);
      if (workflowCase.isBlocked) fail('Resume this blocked task first');
      const missing = Number(req.body.quantity);
      if (!Number.isSafeInteger(missing) || missing < 1 || missing > workflowCase.quantity) {
        fail(`Enter how many units are missing, from 1 to ${workflowCase.quantity}`, 400);
      }

      const order = await Order.findById(workflowCase.orderId).session(session);
      const orderItem = order?.items.id(workflowCase.orderItemId);
      if (!order || !orderItem) fail('This stock task is not linked to an order item');
      const product = await Product.findById(orderItem.productId).session(session);
      if (!product) fail('The product for this order item no longer exists');
      const method = printMethodForItem(orderItem, workflowCase, product);
      if (!method) fail('Customer Service must choose Wax or Resin for this item before it can be printed');
      if (Number(orderItem.stockQuantity || 0) < missing) fail('The order has fewer reserved units than that');

      // The reserved units are not on the shelf: take them off the count.
      if (order.inventoryState === 'reserved') {
        await removeMissingReservedUnits({ order, orderItem, product, missing, actorId: req.user.id, notes: `Size ${orderItem.size || '-'}: ${missing} reserved unit(s) not found on the shelf for order ${order.orderNumber || order._id}; sent to ${method} printing${reason ? ` (${reason})` : ''}`, session });
      }

      const now = new Date();
      const note = `${missing} unit(s) not found in stock${reason ? `: ${reason}` : ''}`;
      printCase = await moveStockUnitsToPrint({ workflowCase, order, orderItem, product, missing, method, actorId: req.user.id, note, session });

      const queueMinutes = minutesBetween(workflowCase.stageQueuedAt || workflowCase.createdAt, workflowCase.startedAt || now);
      const workMinutes = workflowCase.startedAt ? minutesBetween(workflowCase.startedAt, now) : null;
      if (missing === workflowCase.quantity) {
        workflowCase.status = 'completed';
        workflowCase.completedAt = now;
        if (!workflowCase.startedAt) workflowCase.startedAt = now;
        workflowCase.history.push({ actorId: req.user.id, action: 'stock_missing', fromStatus: 'stock_picking', toStatus: 'completed', note: `${note}. Sent to ${method} printing.`, queueMinutes, workMinutes });
      } else {
        workflowCase.quantity -= missing;
        workflowCase.requirements = `Collect ${workflowCase.quantity} reserved unit(s), size ${orderItem.size || '-'}, from stock for this order. ${orderItem.printQuantity} unit(s) are being printed.`;
        workflowCase.history.push({ actorId: req.user.id, action: 'stock_missing', fromStatus: 'stock_picking', toStatus: 'stock_picking', note: `${note}. Sent to ${method} printing; ${workflowCase.quantity} unit(s) still to collect.` });
      }
      workflowCase.productionMethod = method;
      await workflowCase.save({ session });
      order.fulfillmentState = 'in_progress';
      await order.save({ session });
      stockCaseId = workflowCase._id;
    });

    await safelyNotify(() => notifyCaseAssignment(req.app, printCase));
    await refreshOrderFulfillment(printCase.orderId, req.user.id, req.app);
    res.json({
      stockCase: await hydrateCaseCustomers(await populateCase(WorkflowCase.findById(stockCaseId))),
      printCase: await hydrateCaseCustomers(await populateCase(WorkflowCase.findById(printCase._id)))
    });
  } catch (error) {
    console.error('Error sending missing stock to printing:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to send missing stock to printing' });
  } finally {
    if (session) await session.endSession();
  }
});

// Boss corrections: when an employee got a task wrong, the boss (or an admin)
// puts it on the right stage of the pipeline and the stock, printing and
// packing follow. Every correction lands in the task history and the audit
// log with who made it, the reason and any stock count change.
const CLOSED_STATUSES = ['cancelled', 'rejected'];
const STAGE_LABELS = {
  validation: 'Awaiting validation',
  order_received: 'Order received',
  stock_check: 'Stock check',
  printing: 'Printing',
  quality: 'Quality',
  packing: 'Packing',
  ready: 'Ready'
};

// The stages a task can be put on, and the status each one means for it.
const stageStatusesFor = (workflowCase) => {
  // An order confirmation is only finished by confirming the order, which
  // creates its stock and printing work. The boss can only send it back.
  if (workflowCase.requestType === 'order_validation') {
    return workflowCase.status === 'completed' ? { validation: 'awaiting_validation' } : {};
  }
  if (workflowCase.requestType === 'stock_pick') {
    return workflowCase.orderId && workflowCase.orderItemId
      ? { stock_check: 'stock_picking', printing: 'ready_to_print', ready: 'completed' }
      : {};
  }
  if (workflowCase.requestType === 'pack_order') return { packing: 'packing', ready: 'completed' };
  if (workflowCase.status === 'task_ready') return { ready: 'completed' };
  return { order_received: 'boss_review', printing: 'ready_to_print', quality: 'quality_check', ready: 'completed' };
};

// Sending a confirmed order back to Customer Service. Confirming it again
// creates its stock and printing work, so this is only allowed while the order
// has none; otherwise each product task is fixed on its own.
const PRODUCT_TASK_TYPES = ['stock_pick', 'print_required', 'pack_order'];
const reopenOrderValidation = async ({ workflowCase, session = null }) => {
  if (workflowCase.requestType !== 'order_validation' || !workflowCase.orderId) return;
  const productTasks = await WorkflowCase.countDocuments({
    orderId: workflowCase.orderId,
    requestType: { $in: PRODUCT_TASK_TYPES },
    status: { $nin: CLOSED_STATUSES }
  }).session(session);
  if (productTasks) {
    failWith(`This order already has ${productTasks} stock, printing or packing task(s). Confirming it again would create them twice. Use Fix this task on those tasks instead.`);
  }
  await Order.updateOne(
    { _id: workflowCase.orderId },
    { $set: { validationStatus: 'pending', fulfillmentState: 'in_progress', 'items.$[].fulfillmentStatus': 'awaiting_validation' } },
    { session }
  );
};

const correctionOptions = async (workflowCase) => {
  let stock = null;
  if (workflowCase.requestType === 'stock_pick' && workflowCase.orderId && workflowCase.orderItemId) {
    const order = await Order.findById(workflowCase.orderId).select('items').lean();
    const orderItem = (order?.items || []).find(item => String(item._id) === String(workflowCase.orderItemId));
    if (orderItem?.inventoryVariantId) {
      const variant = await StockVariant.findById(orderItem.inventoryVariantId).lean();
      if (variant) {
        stock = {
          size: variant.size,
          printMethod: variant.printMethod,
          onHand: Number(variant.onHandQuantity || 0),
          reserved: Number(variant.reservedQuantity || 0),
          pickedForThisTask: workflowCase.status === 'completed' ? Math.min(Number(orderItem.stockPickedQuantity || 0), workflowCase.quantity) : 0
        };
      }
    }
  }
  const closed = CLOSED_STATUSES.includes(workflowCase.status) || Boolean(workflowCase.archivedAt);
  return {
    status: workflowCase.status,
    quantity: workflowCase.quantity,
    canDelete: !closed && !['order_validation', 'pack_order'].includes(workflowCase.requestType),
    stages: closed ? [] : Object.entries(stageStatusesFor(workflowCase)).filter(([, status]) => !skippedStepError(workflowCase, status)).map(([stage, status]) => ({
      stage, status, label: STAGE_LABELS[stage], current: status === workflowCase.status
    })),
    stock
  };
};

const cancelEarlyPackingTask = async ({ orderId, actorId, note, session }) => {
  if (!orderId) return null;
  const packingTask = await WorkflowCase.findOne({ orderId, requestType: 'pack_order', status: 'packing' }).session(session);
  if (!packingTask) return null;
  const previousAssignee = packingTask.assignedTo;
  packingTask.status = 'cancelled';
  packingTask.completedAt = new Date();
  packingTask.history.push({ actorId, action: 'boss_correction', fromStatus: 'packing', toStatus: 'cancelled', note: `Packing started too early: ${note}`.slice(0, 1000) });
  await packingTask.save({ session });
  return { packingTask, previousAssignee };
};

router.get('/cases/:id/correction', operationsAuth, async (req, res) => {
  try {
    if (!isManagerUser(req.user)) return res.status(403).json({ message: 'Only the boss can move tasks between stages' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    res.json(await correctionOptions(workflowCase));
  } catch (error) {
    console.error('Error loading task correction options:', error);
    res.status(500).json({ message: 'Failed to load correction options' });
  }
});

router.post('/cases/:id/correction', operationsAuth, async (req, res) => {
  let session;
  try {
    if (!isManagerUser(req.user)) return res.status(403).json({ message: 'Only the boss can move tasks between stages' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const stage = cleanText(req.body.stage, 40);
    const reason = cleanText(req.body.reason, 500);
    if (!reason) return res.status(400).json({ message: 'Explain what went wrong' });
    const hasCount = req.body.shelfCount !== undefined && req.body.shelfCount !== null && req.body.shelfCount !== '';
    const shelfCount = hasCount ? Number(req.body.shelfCount) : null;
    if (hasCount && (!Number.isSafeInteger(shelfCount) || shelfCount < 0)) return res.status(400).json({ message: 'The shelf count must be a whole number, 0 or more' });
    if (!stage && !hasCount) return res.status(400).json({ message: 'Choose a stage or enter the real shelf count' });

    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      const workflowCase = await WorkflowCase.findById(req.params.id).session(session);
      if (!workflowCase) failWith('Workflow case not found', 404);
      if (workflowCase.archivedAt) failWith('Resume this order before correcting its tasks');
      if (CLOSED_STATUSES.includes(workflowCase.status)) failWith('A cancelled or rejected task cannot be moved here');
      const stages = stageStatusesFor(workflowCase);
      if (stage && !stages[stage]) {
        const allowed = Object.keys(stages).map(key => STAGE_LABELS[key]);
        failWith(allowed.length ? `This task can only be put on: ${allowed.join(', ')}` : 'This task cannot be moved between stages', 400);
      }
      const target = stage ? stages[stage] : null;
      const skipError = target ? skippedStepError(workflowCase, target) : null;
      if (skipError) failWith(skipError, 400);
      const isStockTask = workflowCase.requestType === 'stock_pick';

      let order = null;
      let orderItem = null;
      if (workflowCase.orderId) {
        order = await Order.findById(workflowCase.orderId).session(session);
        if (order && ['shipped', 'delivered', 'cancelled'].includes(order.status)) failWith(`This order is already ${order.status}`);
        orderItem = order?.items.id(workflowCase.orderItemId) || null;
      }
      if (hasCount && !orderItem?.inventoryVariantId) failWith('This task has no size stock to count');

      const now = new Date();
      const fromStatus = workflowCase.status;
      const previousTeam = workflowCase.assignedTeam;
      const previousAssignee = workflowCase.assignedTo;
      const previousMachineCode = workflowCase.print?.machineId || '';
      const notes = [];
      let printCase = null;

      if (isStockTask && target === 'ready_to_print') {
        // The units were not on the shelf: they go to printing instead.
        if (!orderItem) failWith('This stock task is not linked to an order item');
        const missing = req.body.quantity === undefined || req.body.quantity === '' ? workflowCase.quantity : Number(req.body.quantity);
        if (!Number.isSafeInteger(missing) || missing < 1 || missing > workflowCase.quantity) {
          failWith(`Enter how many units were not in stock, from 1 to ${workflowCase.quantity}`, 400);
        }
        if (Number(orderItem.stockQuantity || 0) < missing) failWith('The order has fewer stock units than that');
        const product = await Product.findById(orderItem.productId).session(session);
        if (!product) failWith('The product for this order item no longer exists');
        const method = printMethodForItem(orderItem, workflowCase, product);
        if (!method) failWith('Choose Wax or Resin for this item before it can be printed');

        const picked = Number(orderItem.stockPickedQuantity || 0);
        if (fromStatus === 'completed' && picked > 0) {
          // The stock check already took these units off the count; they were
          // never there, so only the order's record of what was picked changes.
          orderItem.stockPickedQuantity = Math.max(picked - missing, 0);
        } else if (order.inventoryState === 'reserved') {
          await removeMissingReservedUnits({
            order, orderItem, product, missing, actorId: req.user.id, session,
            notes: `Size ${orderItem.size || '-'}: ${missing} reserved unit(s) not found on the shelf for order ${order.orderNumber || order._id}; boss sent them to ${method} printing (${reason})`.slice(0, 500)
          });
        }
        const note = `Boss correction: ${missing} unit(s) were not in stock: ${reason}`;
        printCase = await moveStockUnitsToPrint({ workflowCase, order, orderItem, product, missing, method, actorId: req.user.id, note, session });
        if (missing === workflowCase.quantity) {
          if (fromStatus !== 'completed') {
            workflowCase.status = 'completed';
            workflowCase.completedAt = now;
            if (!workflowCase.startedAt) workflowCase.startedAt = now;
          }
        } else {
          workflowCase.quantity -= missing;
          workflowCase.requirements = `Collect ${workflowCase.quantity} reserved unit(s), size ${orderItem.size || '-'}, from stock for this order. ${orderItem.printQuantity} unit(s) are being printed.`;
        }
        workflowCase.productionMethod = method;
        notes.push(`${missing} unit(s) sent to ${method} printing`);
      } else if (target === 'completed') {
        if (fromStatus === 'completed') failWith('This task is already done');
        if (isStockTask && fromStatus === 'stock_picking') {
          await takePickedStockOffShelf({ workflowCase, actorId: req.user.id, session });
        }
        workflowCase.status = 'completed';
        workflowCase.completedAt = now;
        if (!workflowCase.startedAt) workflowCase.startedAt = now;
        if (fromStatus === 'printing') workflowCase.print.completedAt = now;
        notes.push('Marked done');
      } else if (target) {
        if (target === 'awaiting_validation') await reopenOrderValidation({ workflowCase, session });
        if (target === 'ready_to_print' && !['wax', 'resin'].includes(workflowCase.productionMethod)) {
          failWith('Choose Wax or Resin for this task before sending it to printing');
        }
        if (fromStatus === 'completed' && isStockTask) {
          const putBack = await putPickedStockBack({ workflowCase, actorId: req.user.id, session });
          if (putBack) notes.push(`${putBack} unit(s) put back as reserved for this order`);
        }
        const team = teamForStatus(target, workflowCase.productionMethod);
        workflowCase.status = target;
        workflowCase.assignedTeam = team;
        workflowCase.completedAt = null;
        workflowCase.startedAt = null;
        workflowCase.stageQueuedAt = now;
        workflowCase.targetMinutes = targetMinutesForTeam(team);
        if (team !== previousTeam) {
          const assignee = await findTeamAssignee(team, session);
          workflowCase.assignedTo = assignee?._id || null;
          workflowCase.assignedAt = assignee ? now : null;
        } else if (workflowCase.assignedTo) {
          workflowCase.assignedAt = now;
        }
        if (fromStatus === 'printing') {
          workflowCase.print = { machineId: '', sentAt: workflowCase.print?.sentAt || null, startedAt: null, completedAt: null };
        }
        notes.unshift(target === fromStatus ? `Restarted at ${STAGE_LABELS[stage]}` : `Moved to ${STAGE_LABELS[stage]}`);
      }

      if (hasCount) {
        const count = await setShelfCount({ variantId: orderItem.inventoryVariantId, count: shelfCount, actorId: req.user.id, orderId: order._id, note: reason, session });
        notes.push(count.before === count.after ? `Shelf count for size ${count.size} confirmed at ${count.after}` : `Shelf count for size ${count.size} changed from ${count.before} to ${count.after}`);
      }

      workflowCase.history.push({
        actorId: req.user.id,
        action: 'boss_correction',
        fromStatus,
        toStatus: workflowCase.status,
        note: `${notes.join('. ')}. Reason: ${reason}`.slice(0, 1000)
      });
      await workflowCase.save({ session });
      if (printCase) await order.save({ session });

      // Work that goes back into the pipeline means the order is not ready to pack yet.
      const reopened = printCase || (target && target !== 'completed');
      const packing = reopened && workflowCase.requestType !== 'pack_order'
        ? await cancelEarlyPackingTask({ orderId: workflowCase.orderId, actorId: req.user.id, note: reason, session })
        : null;
      result = { workflowCase, printCase, packing, previousAssignee, previousMachineCode, fromStatus };
    });

    const { workflowCase, printCase, packing, previousAssignee, previousMachineCode, fromStatus } = result;
    if (fromStatus === 'printing' && workflowCase.status !== 'printing' && previousMachineCode) {
      await releaseMachineFromCase({ machineCode: previousMachineCode, workflowCase, actorId: req.user.id, outcome: workflowCase.status === 'completed' ? 'completed' : 'cancelled', reason: 'Boss correction' });
    }
    if (!sameUserId(previousAssignee, workflowCase.assignedTo)) {
      if (previousAssignee) await safelyNotify(() => notifyTaskRemoved(req.app, previousAssignee, workflowCase));
      if (workflowCase.assignedTo) await safelyNotify(() => notifyCaseAssignment(req.app, workflowCase));
    }
    if (printCase) await safelyNotify(() => notifyCaseAssignment(req.app, printCase));
    if (packing?.previousAssignee) await safelyNotify(() => notifyTaskRemoved(req.app, packing.previousAssignee, packing.packingTask));
    await refreshOrderFulfillment(workflowCase.orderId, req.user.id, req.app);
    res.json({
      workflowCase: await hydrateCaseCustomers(await populateCase(WorkflowCase.findById(workflowCase._id))),
      printCase: printCase ? await hydrateCaseCustomers(await populateCase(WorkflowCase.findById(printCase._id))) : null
    });
  } catch (error) {
    console.error('Error correcting workflow case:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to correct the task' });
  } finally {
    if (session) await session.endSession();
  }
});

// The boss deletes a task an employee should never have had. It leaves every
// list but stays in the history and audit log; stock tasks give their units back.
router.post('/cases/:id/delete', operationsAuth, async (req, res) => {
  let session;
  try {
    if (!isManagerUser(req.user)) return res.status(403).json({ message: 'Only the boss can delete tasks' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const reason = cleanText(req.body.reason, 500);
    if (!reason) return res.status(400).json({ message: 'Explain why this task is deleted' });
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      const workflowCase = await WorkflowCase.findById(req.params.id).session(session);
      if (!workflowCase) failWith('Workflow case not found', 404);
      if (CLOSED_STATUSES.includes(workflowCase.status)) failWith('This task is already deleted');
      if (workflowCase.requestType === 'order_validation') failWith('An order confirmation cannot be deleted. Cancel the order instead.');
      if (workflowCase.requestType === 'pack_order') failWith('A packing task cannot be deleted. Mark it Ready or move the other tasks back instead.');
      const notes = [];
      if (workflowCase.requestType === 'stock_pick') {
        const released = await releaseStockTaskUnits({ workflowCase, actorId: req.user.id, session });
        if (released) notes.push(`${released} unit(s) given back to stock`);
      } else if (workflowCase.orderId && workflowCase.orderItemId && workflowCase.requestType === 'print_required') {
        const order = await Order.findById(workflowCase.orderId).session(session);
        const orderItem = order?.items.id(workflowCase.orderItemId);
        if (orderItem) {
          await Order.updateOne(
            { _id: order._id, 'items._id': orderItem._id },
            { $set: { 'items.$.printQuantity': Math.max(Number(orderItem.printQuantity || 0) - Number(workflowCase.quantity || 0), 0) } },
            { session }
          );
        }
      }
      const fromStatus = workflowCase.status;
      const previousAssignee = workflowCase.assignedTo;
      const previousMachineCode = workflowCase.print?.machineId || '';
      workflowCase.status = 'cancelled';
      workflowCase.completedAt = new Date();
      workflowCase.history.push({
        actorId: req.user.id,
        action: 'boss_deleted',
        fromStatus,
        toStatus: 'cancelled',
        note: `${notes.length ? `${notes.join('. ')}. ` : ''}Reason: ${reason}`.slice(0, 1000)
      });
      await workflowCase.save({ session });
      result = { workflowCase, fromStatus, previousAssignee, previousMachineCode };
    });
    const { workflowCase, fromStatus, previousAssignee, previousMachineCode } = result;
    if (fromStatus === 'printing' && previousMachineCode) {
      await releaseMachineFromCase({ machineCode: previousMachineCode, workflowCase, actorId: req.user.id, outcome: 'cancelled', reason: 'Task deleted by the boss' });
    }
    if (previousAssignee && fromStatus !== 'completed') await safelyNotify(() => notifyTaskRemoved(req.app, previousAssignee, workflowCase));
    await refreshOrderFulfillment(workflowCase.orderId, req.user.id, req.app);
    res.json({ deleted: true, workflowCase: await hydrateCaseCustomers(await populateCase(WorkflowCase.findById(workflowCase._id))) });
  } catch (error) {
    console.error('Error deleting workflow case:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to delete the task' });
  } finally {
    if (session) await session.endSession();
  }
});

router.post('/cases/:id/transition', operationsAuth, async (req, res) => {
  try {
    const adminMove = req.body.adminMove === true;
    if (adminMove && !isAdminUser(req.user)) return res.status(403).json({ message: 'Only an administrator can move a task to another stage' });
    if (adminMove && !cleanText(req.body.note, 1000)) return res.status(400).json({ message: 'Explain the problem and why this stage is needed' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    const ownershipError = requireOwnedCase(req.user, workflowCase);
    if (ownershipError) return res.status(isUnassigned(workflowCase) ? 409 : 403).json({ message: ownershipError });
    if (workflowCase.archivedAt) return res.status(409).json({ message: 'Resume this archived order before moving its tasks' });
    if (!adminMove && workflowCase.isBlocked) return res.status(409).json({ message: 'Resume this blocked task before completing it' });
    const nextStatus = String(req.body.status || '');
    if (adminMove) {
      if (!CASE_STATUSES.includes(nextStatus)) return res.status(400).json({ message: 'Unknown workflow status' });
      if (nextStatus === workflowCase.status) return res.status(409).json({ message: 'Choose a different stage' });
      const skipError = skippedStepError(workflowCase, nextStatus);
      if (skipError) return res.status(409).json({ message: skipError });
      if (['ready_to_print', 'printing'].includes(nextStatus)) {
        const method = req.body.productionMethod || workflowCase.productionMethod;
        if (!['wax', 'resin'].includes(method)) return res.status(400).json({ message: 'Choose Wax or Resin for the destination printing team' });
        workflowCase.productionMethod = method;
      }
      // The order validation endpoint creates per-item fulfillment work. Keep
      // that gate intact when an administrator routes its task for corrections.
      if (nextStatus === 'awaiting_validation' && workflowCase.requestType !== 'order_validation') {
        return res.status(409).json({ message: 'Use Customer information for item review, or open the order validation task to return the order to validation' });
      }
      if (workflowCase.requestType === 'order_validation' && workflowCase.orderId) {
        const order = await Order.findById(workflowCase.orderId).select('validationStatus');
        if (order?.validationStatus === 'pending' && ['completed', 'cancelled', 'rejected'].includes(nextStatus)) {
          return res.status(409).json({ message: 'Return to Awaiting validation and confirm the order items before closing the validation task' });
        }
        if (order && order.validationStatus !== 'pending' && nextStatus === 'awaiting_validation') {
          await reopenOrderValidation({ workflowCase });
        }
      }
    }
    if (!adminMove && workflowCase.requestType === 'order_validation' && workflowCase.orderId && ['completed', 'cancelled', 'rejected'].includes(nextStatus)) {
      const order = await Order.findById(workflowCase.orderId).select('validationStatus');
      if (order?.validationStatus === 'pending') return res.status(409).json({ message: 'Return to Awaiting validation and confirm the order items before closing the validation task' });
    }
    const targetTeam = nextStatus === 'completed'
      ? workflowCase.assignedTeam
      : teamForStatus(nextStatus, workflowCase.productionMethod);
    if (!canUseTeam(req.user, workflowCase.assignedTeam) && !canUseTeam(req.user, targetTeam)) {
      return res.status(403).json({ message: 'This transition belongs to another team' });
    }
    if (!adminMove && nextStatus === 'waiting_customer_approval' && !Number.isFinite(workflowCase.quote?.amount)) {
      return res.status(409).json({ message: 'Record the proposed cost before requesting customer approval' });
    }
    const transitionError = adminMove ? null : validateTransition(workflowCase, nextStatus);
    if (transitionError) return res.status(409).json({ message: transitionError });
    const qualityReprint = !adminMove && workflowCase.status === 'quality_check' && nextStatus === 'ready_to_print';
    let reprintParts = null;
    let reprintReason = '';
    if (qualityReprint) {
      try { reprintParts = normalizeReprintParts(req.body.reprintParts); }
      catch (error) { return res.status(400).json({ message: error.message }); }
      reprintReason = cleanText(req.body.note, 1000);
      if (!reprintReason) return res.status(400).json({ message: 'Explain why these parts need reprinting' });
    }
    const startsPrintingNow = workflowCase.status === 'ready_to_print' && nextStatus === 'printing';
    // Quality and packing finish with one click: no separate Start step.
    const finishesInOneClick = (workflowCase.status === 'quality_check' && nextStatus === 'packing')
      || (workflowCase.status === 'packing' && nextStatus === 'completed')
      || qualityReprint;
    if (!isManagerUser(req.user) && !workflowCase.startedAt && !startsPrintingNow && !finishesInOneClick) {
      return res.status(409).json({ message: 'Start this task before marking the step complete' });
    }

    let selectedMachine = null;
    if (nextStatus === 'printing') {
      const requestedMachine = cleanText(req.body.machineId, 120);
      // The operator chooses the physical printer in the manufacturer's app.
      // A machine code is optional here and is only validated when supplied by an integration.
      if (requestedMachine) {
        selectedMachine = await findMachine(requestedMachine);
        if (!selectedMachine) return res.status(404).json({ message: 'Selected printer is not registered' });
        if (!selectedMachine.enabled) return res.status(409).json({ message: 'Selected printer is disabled' });
        if (selectedMachine.productionMethod !== workflowCase.productionMethod) {
          return res.status(409).json({ message: `Choose a ${workflowCase.productionMethod} printer for this task` });
        }
        if (['offline', 'failed', 'maintenance'].includes(selectedMachine.status)) {
          return res.status(409).json({ message: `Selected printer is ${selectedMachine.status}` });
        }
        if (selectedMachine.currentCaseId && String(selectedMachine.currentCaseId) !== String(workflowCase._id)) {
          return res.status(409).json({ message: 'Selected printer is already assigned to another task' });
        }
      }
    }

    const now = new Date();
    const previousStatus = workflowCase.status;
    const previousMachineCode = workflowCase.print?.machineId || '';
    const previousTeam = workflowCase.assignedTeam;
    const previousAssignee = workflowCase.assignedTo;
    const queueMinutes = minutesBetween(workflowCase.stageQueuedAt || workflowCase.createdAt, workflowCase.startedAt || now);
    const workMinutes = workflowCase.startedAt ? minutesBetween(workflowCase.startedAt, now) : null;
    workflowCase.status = nextStatus;
    if (adminMove) {
      workflowCase.isBlocked = false;
      workflowCase.blockedReason = '';
      workflowCase.blockedAt = null;
      workflowCase.blockedBy = null;
      workflowCase.deadlineAt = null;
      workflowCase.print = { machineId: '', sentAt: null, startedAt: null, completedAt: null };
      workflowCase.reprintParts = [];
      workflowCase.reprintReason = '';
      workflowCase.reprintRequestedAt = null;
    }
    if (qualityReprint) {
      workflowCase.reprintParts = reprintParts;
      workflowCase.reprintReason = reprintReason;
      workflowCase.reprintRequestedAt = now;
      workflowCase.print = { machineId: '', sentAt: null, startedAt: null, completedAt: null };
    }
    workflowCase.assignedTeam = targetTeam;
    if (nextStatus === 'completed') {
      workflowCase.completedAt = now;
    } else {
      workflowCase.completedAt = null;
      workflowCase.stageQueuedAt = now;
      workflowCase.targetMinutes = targetMinutesForTeam(targetTeam);
      // Starting in the portal records the manufacturer-app print start.
      workflowCase.startedAt = nextStatus === 'printing' ? now : null;
      if (adminMove || previousTeam !== targetTeam) {
        const automaticAssignee = await findTeamAssignee(targetTeam);
        workflowCase.assignedTo = automaticAssignee?._id || null;
        workflowCase.assignedAt = automaticAssignee ? now : null;
      } else if (workflowCase.assignedTo) {
        workflowCase.assignedAt = now;
      }
    }
    if (nextStatus === 'printing') {
      workflowCase.print.machineId = selectedMachine?.code || '';
      workflowCase.print.sentAt = workflowCase.print.sentAt || new Date();
      workflowCase.print.startedAt = now;
    }
    if (nextStatus === 'quality_check') workflowCase.print.completedAt = now;
    workflowCase.history.push({
      actorId: req.user.id,
      action: adminMove ? 'admin_stage_changed' : 'status_changed',
      fromStatus: previousStatus,
      toStatus: nextStatus,
      note: qualityReprint
        ? `Reprint ${reprintParts.map(part => `${part.code} x${part.quantity}`).join(', ')}. ${reprintReason}`.slice(0, 1000)
        : cleanText(req.body.note, 1000),
      queueMinutes,
      workMinutes
    });
    if (previousStatus === 'stock_picking' && nextStatus === 'completed') {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(() => takePickedStockOffShelf({ workflowCase, actorId: req.user.id, session }));
      } finally {
        await session.endSession();
      }
    }
    await workflowCase.save();
    if (nextStatus === 'printing' && selectedMachine) {
      await assignMachineToCase({ machine: selectedMachine, workflowCase, actorId: req.user.id });
    } else if (previousStatus === 'printing' && previousMachineCode) {
      const failed = ['ready_to_print', 'modeling'].includes(nextStatus);
      await releaseMachineFromCase({
        machineCode: previousMachineCode,
        workflowCase,
        actorId: req.user.id,
        outcome: failed ? 'failed' : nextStatus,
        reason: failed ? cleanText(req.body.note, 1000) : ''
      });
    }
    if (!sameUserId(previousAssignee, workflowCase.assignedTo)) {
      if (previousAssignee) await safelyNotify(() => notifyTaskRemoved(req.app, previousAssignee, workflowCase));
      if (workflowCase.assignedTo) await safelyNotify(() => notifyCaseAssignment(req.app, workflowCase));
    }
    if (nextStatus === 'needs_customer_info' || nextStatus === 'rejected') {
      await safelyNotify(() => notifyOrderBlocked(req.app, workflowCase, cleanText(req.body.note, 1000)));
    }
    if (['printing', 'quality_check'].includes(previousStatus) && ['ready_to_print', 'modeling'].includes(nextStatus)) {
      const failureNote = qualityReprint
        ? `Reprint ${reprintParts.map(part => `${part.code} x${part.quantity}`).join(', ')}. ${reprintReason}`
        : cleanText(req.body.note, 1000);
      await safelyNotify(() => notifyFailedPrint(req.app, workflowCase, failureNote));
    }
    await refreshOrderFulfillment(workflowCase.orderId, req.user.id, req.app);
    res.json(await populateCase(WorkflowCase.findById(workflowCase._id)));
  } catch (error) {
    console.error('Error transitioning workflow case:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to transition workflow case' });
  }
});

router.post('/cases/:id/create-product', operationsAuth, requireTeam('boss'), async (req, res) => {
  let session;
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id) || !mongoose.Types.ObjectId.isValid(req.body.catalogId)) {
      return res.status(400).json({ message: 'Valid case and catalog IDs are required' });
    }
    const serialNumber = cleanText(req.body.serialNumber, 120);
    const type = cleanText(req.body.type, 120);
    if (!serialNumber || !type) return res.status(400).json({ message: 'Serial number and product type are required' });

    session = await mongoose.startSession();
    let productId;
    let previousAssignee;
    await session.withTransaction(async () => {
      const workflowCase = await WorkflowCase.findById(req.params.id).session(session);
      if (!workflowCase) {
        const error = new Error('Workflow case not found'); error.statusCode = 404; throw error;
      }
      const ownershipError = requireOwnedCase(req.user, workflowCase);
      if (ownershipError) {
        const error = new Error(ownershipError); error.statusCode = isUnassigned(workflowCase) ? 409 : 403; throw error;
      }
      if (workflowCase.productId) {
        const error = new Error('This case is already connected to a product'); error.statusCode = 409; throw error;
      }
      previousAssignee = workflowCase.assignedTo;
      const model = latestModelVersion(workflowCase);
      if (!model?.isPrintReady || !['wax', 'resin'].includes(workflowCase.productionMethod)) {
        const error = new Error('A print-ready wax or resin model is required'); error.statusCode = 409; throw error;
      }
      if (!['approved', 'not_required'].includes(workflowCase.customerApproval)) {
        const error = new Error('Customer approval is required before creating and printing this product'); error.statusCode = 409; throw error;
      }
      if (!Number.isFinite(workflowCase.quote?.amount)) {
        const error = new Error('Record the product cost before creating it'); error.statusCode = 409; throw error;
      }
      const catalog = await Catalog.findById(req.body.catalogId).session(session);
      if (!catalog) {
        const error = new Error('Catalog not found'); error.statusCode = 404; throw error;
      }
      const duplicate = await Product.findOne({ serialNumber }).session(session);
      if (duplicate) {
        const error = new Error('A product with this serial number already exists'); error.statusCode = 409; throw error;
      }

      const created = await Product.create([{
        name: workflowCase.requestedName,
        description: workflowCase.requirements,
        type,
        serialNumber,
        price: Number.isFinite(workflowCase.quote?.amount) ? workflowCase.quote.amount : 0,
        stock: 0,
        reservedStock: 0,
        catalogId: catalog._id,
        createdBy: req.user.id,
        fulfillmentPolicy: 'print_on_demand',
        printMethod: workflowCase.productionMethod,
        modelFileStatus: 'print_ready',
        modelFileName: model.fileName,
        modelFileUrl: model.fileUrl,
        modelVersion: model.version
      }], { session });
      const product = created[0];
      productId = product._id;
      await Catalog.updateOne({ _id: catalog._id }, { $addToSet: { products: product._id } }, { session });

      workflowCase.productId = product._id;
      const previousStatus = workflowCase.status;
      const now = new Date();
      const queueMinutes = minutesBetween(workflowCase.stageQueuedAt || workflowCase.createdAt, workflowCase.startedAt || now);
      const workMinutes = workflowCase.startedAt ? minutesBetween(workflowCase.startedAt, now) : null;
      workflowCase.status = 'ready_to_print';
      workflowCase.assignedTeam = teamForStatus('ready_to_print', workflowCase.productionMethod);
      const automaticAssignee = await findTeamAssignee(workflowCase.assignedTeam, session);
      workflowCase.assignedTo = automaticAssignee?._id || null;
      workflowCase.assignedAt = automaticAssignee ? now : null;
      workflowCase.startedAt = null;
      workflowCase.stageQueuedAt = now;
      workflowCase.targetMinutes = targetMinutesForTeam(workflowCase.assignedTeam);
      workflowCase.history.push({
        actorId: req.user.id,
        action: 'product_created',
        fromStatus: previousStatus,
        toStatus: 'ready_to_print',
        note: serialNumber,
        queueMinutes,
        workMinutes
      });

      if (workflowCase.orderId) {
        const order = await Order.findById(workflowCase.orderId).session(session);
        if (!order) {
          const error = new Error('Connected order no longer exists'); error.statusCode = 409; throw error;
        }
        if (!['pending', 'confirmed', 'picking'].includes(order.status)) {
          const error = new Error('This order is already packed or closed and cannot accept a new product'); error.statusCode = 409; throw error;
        }
        order.items.push({
          productId: product._id,
          workflowCaseId: workflowCase._id,
          quantity: workflowCase.quantity,
          stockQuantity: 0,
          printQuantity: workflowCase.quantity,
          productionMethod: workflowCase.productionMethod,
          fulfillmentStatus: 'production',
          price: product.price,
          weight: product.weight || 0,
          name: product.name,
          size: workflowCase.dimensions?.ringSize || ''
        });
        workflowCase.orderItemId = order.items[order.items.length - 1]._id;
        order.totalAmount += product.price * workflowCase.quantity;
        order.workflowCaseIds.addToSet(workflowCase._id);
        order.fulfillmentState = 'in_progress';
        await order.save({ session });
      }
      await workflowCase.save({ session });
    });

    const updatedWorkflowCase = await populateCase(WorkflowCase.findById(req.params.id));
    if (previousAssignee && !sameUserId(previousAssignee, updatedWorkflowCase.assignedTo)) {
      await safelyNotify(() => notifyTaskRemoved(req.app, previousAssignee, updatedWorkflowCase));
    }
    await safelyNotify(() => notifyCaseAssignment(req.app, updatedWorkflowCase));

    res.status(201).json({
      product: await Product.findById(productId).populate('catalogId', 'name'),
      workflowCase: updatedWorkflowCase
    });
  } catch (error) {
    console.error('Error creating product from workflow case:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to create product' });
  } finally {
    if (session) await session.endSession();
  }
});

module.exports = router;
