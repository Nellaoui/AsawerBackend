const express = require('express');
const mongoose = require('mongoose');
const WorkflowCase = require('../models/WorkflowCase');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Catalog = require('../models/Catalog');
const User = require('../models/User');
const { operationsAuth } = require('../middlewares/auth');
const { findTeamAssignee } = require('../utils/workflowAssignment');
const {
  notifyCaseAssignment,
  notifyFailedPrint,
  notifyOrderBlocked,
  notifyTaskRemoved
} = require('../utils/workflowNotifications');
const {
  CASE_STATUSES,
  CASE_TYPES,
  PRODUCTION_METHODS,
  latestModelVersion,
  teamForStatus,
  targetMinutesForTeam,
  validateTransition
} = require('../utils/workflowRules');

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

const canUseTeam = (user, team) => {
  if (user?.isAdmin || user?.role === 'admin') return true;
  const workRole = WORK_ROLES.includes(user?.workRole) ? user.workRole : 'general';
  return workRole === 'general' || (TEAM_WORK_ROLES[team] || []).includes(workRole);
};

const isAdminUser = (user) => Boolean(user?.isAdmin || user?.role === 'admin');
const userTeam = (user) => TEAM_BY_WORK_ROLE[user?.workRole] || null;
const sameUserId = (left, right) => Boolean(left && right && String(left?._id || left) === String(right?._id || right));
const isUnassigned = (workflowCase) => !workflowCase.assignedTo;

const canSeeCase = (user, workflowCase) => {
  if (isAdminUser(user)) return true;
  if (sameUserId(workflowCase.assignedTo, user?.id || user?._id)) return true;
  return isUnassigned(workflowCase) && Boolean(userTeam(user)) && workflowCase.assignedTeam === userTeam(user);
};

const requireOwnedCase = (user, workflowCase) => {
  if (isAdminUser(user)) return null;
  if (!canSeeCase(user, workflowCase)) return 'This task belongs to another employee';
  if (isUnassigned(workflowCase)) return 'Claim this task before recording work';
  return null;
};

const unassignedFilter = () => ({ $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }] });

const scopedCaseFilter = (user, scope = 'mine') => {
  if (isAdminUser(user)) {
    if (scope === 'mine') return { assignedTo: user.id };
    if (scope === 'available') return unassignedFilter();
    return {};
  }

  const team = userTeam(user);
  if (scope === 'available') return team ? { assignedTeam: team, ...unassignedFilter() } : { _id: null };
  return { assignedTo: user.id };
};

const taskSort = { priority: -1, taskKind: -1, deadlineAt: 1, 'quote.dueDate': 1, createdAt: 1 };

const minutesBetween = (start, end = new Date()) => {
  if (!start) return null;
  return Math.max(Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000), 0);
};

const effectiveDeadline = (workflowCase) => {
  if (workflowCase.deadlineAt) return new Date(workflowCase.deadlineAt);
  const timerStartedAt = workflowCase.assignedAt || workflowCase.stageQueuedAt || workflowCase.createdAt;
  if (!timerStartedAt) return null;
  return new Date(new Date(timerStartedAt).getTime() + Number(workflowCase.targetMinutes || 120) * 60000);
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
  .populate('orderId', 'status totalAmount createdAt userId')
  .populate('customerId', 'name email phone')
  .populate('productId', 'name serialNumber imageUrl type catalogId fulfillmentPolicy printMethod modelFileStatus')
  .populate('assignedTo', 'name email workRole')
  .populate('createdBy', 'name email workRole');

const refreshOrderFulfillment = async (orderId, actorId, app) => {
  if (!orderId) return;
  const openCases = await WorkflowCase.find({
    orderId,
    status: { $nin: ['completed', 'cancelled'] }
  }).select('status');
  let fulfillmentState = openCases.some(item => ['needs_customer_info', 'rejected'].includes(item.status))
    ? 'blocked'
    : (openCases.length ? 'in_progress' : 'ready');

    if (!openCases.length) {
    const existingPackingTask = await WorkflowCase.findOne({ orderId, requestType: 'pack_order' }).select('_id status');
    if (!existingPackingTask) {
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
};

router.get('/summary', operationsAuth, async (req, res) => {
  try {
    const mineFilter = { ...scopedCaseFilter(req.user, 'mine'), status: ACTIVE_STATUSES };
    const availableFilter = { ...scopedCaseFilter(req.user, 'available'), status: ACTIVE_STATUSES };
    const now = new Date();
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const [total, customerService, boss, wax, resin, quality, completed, stock, packing, mineCases, available] = await Promise.all([
      WorkflowCase.countDocuments({ status: { $nin: ['cancelled', 'rejected'] } }),
      WorkflowCase.countDocuments({ assignedTeam: 'customer_service', status: { $nin: ['cancelled', 'rejected', 'completed'] } }),
      WorkflowCase.countDocuments({ assignedTeam: 'boss', status: { $nin: ['cancelled', 'rejected', 'completed'] } }),
      WorkflowCase.countDocuments({ assignedTeam: 'wax_print', status: { $nin: ['cancelled', 'rejected', 'completed'] } }),
      WorkflowCase.countDocuments({ assignedTeam: 'resin_print', status: { $nin: ['cancelled', 'rejected', 'completed'] } }),
      WorkflowCase.countDocuments({ assignedTeam: 'quality', status: { $nin: ['cancelled', 'rejected', 'completed'] } }),
      WorkflowCase.countDocuments({ status: 'completed' }),
      WorkflowCase.countDocuments({ assignedTeam: 'stock', status: ACTIVE_STATUSES }),
      WorkflowCase.countDocuments({ assignedTeam: 'packing', status: ACTIVE_STATUSES }),
      WorkflowCase.find(mineFilter).select('priority taskKind deadlineAt targetMinutes stageQueuedAt startedAt status createdAt').lean(),
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

router.get('/cases', operationsAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const scope = ['mine', 'available', 'all'].includes(String(req.query.scope)) ? String(req.query.scope) : 'mine';
    const filter = scopedCaseFilter(req.user, scope);

    if (req.query.team && isAdminUser(req.user)) filter.assignedTeam = String(req.query.team);
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.active === 'true') filter.status = ACTIVE_STATUSES;
    if (req.query.method) filter.productionMethod = String(req.query.method);
    if (req.query.taskKind && ['order', 'extra'].includes(String(req.query.taskKind))) filter.taskKind = String(req.query.taskKind);
    if (req.query.orderId && mongoose.Types.ObjectId.isValid(req.query.orderId)) filter.orderId = req.query.orderId;
    if (req.query.search) {
      const searchValue = String(req.query.search).trim();
      const pattern = new RegExp(escapeRegExp(searchValue), 'i');
      const searchFilter = [{ requestedName: pattern }, { requirements: pattern }, { 'customer.name': pattern }, { 'customer.email': pattern }];
      if (mongoose.Types.ObjectId.isValid(searchValue)) searchFilter.push({ orderId: searchValue });
      if (filter.$or) {
        const scopeOr = filter.$or;
        delete filter.$or;
        filter.$and = [{ $or: scopeOr }, { $or: searchFilter }];
      } else {
        filter.$or = searchFilter;
      }
    }

    const [cases, total] = await Promise.all([
      populateCase(WorkflowCase.find(filter).sort(taskSort).skip((page - 1) * limit).limit(limit)),
      WorkflowCase.countDocuments(filter)
    ]);

    res.json({
      cases,
      pagination: { page, limit, total, pages: Math.max(Math.ceil(total / limit), 1) }
    });
  } catch (error) {
    console.error('Error fetching workflow cases:', error);
    res.status(500).json({ message: 'Failed to fetch workflow cases' });
  }
});

router.get('/analytics', operationsAuth, async (req, res) => {
  try {
    if (!isAdminUser(req.user)) return res.status(403).json({ message: 'Only an administrator can view employee timing' });
    const now = new Date();
    const [employees, activeCases, timedCases, recentOrders] = await Promise.all([
      User.find({ role: 'employee', isActive: { $ne: false } }).select('name email workRole').lean(),
      WorkflowCase.find({ status: ACTIVE_STATUSES })
        .select('requestedName assignedTeam assignedTo status deadlineAt targetMinutes stageQueuedAt assignedAt startedAt createdAt orderId priority taskKind')
        .populate('assignedTo', 'name email workRole')
        .populate('orderId', 'createdAt status fulfillmentState')
        .lean(),
      WorkflowCase.find({ 'history.workMinutes': { $gte: 0 } })
        .sort({ completedAt: -1, updatedAt: -1 })
        .limit(2000)
        .select('history completedAt assignedTo')
        .lean(),
      Order.find({}).sort({ createdAt: -1 }).limit(25).select('createdAt status fulfillmentState items totalAmount').lean()
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
          lateMinutes: minutesBetween(deadline, now),
          startedAt: item.startedAt,
          priority: item.priority
        });
      }
    }

    for (const item of timedCases) {
      for (const event of item.history || []) {
        if (event.workMinutes === null || event.workMinutes === undefined) continue;
        const metric = employeeMap.get(String(event.actorId?._id || event.actorId));
        if (!metric) continue;
        metric.completedSteps += 1;
        metric.totalWorkMinutes += Number(event.workMinutes || 0);
      }
    }

    const employeeTiming = [...employeeMap.values()].map(metric => ({
      ...metric,
      averageWorkMinutes: metric.completedSteps ? Math.round(metric.totalWorkMinutes / metric.completedSteps) : null
    })).sort((left, right) => right.lateTasks - left.lateTasks || right.activeTasks - left.activeTasks || left.name.localeCompare(right.name));

    res.json({
      generatedAt: now,
      employees: employeeTiming,
      lateTasks: lateTasks.sort((left, right) => right.lateMinutes - left.lateMinutes),
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

router.post('/cases/:id/claim', operationsAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    if (['completed', 'cancelled', 'rejected'].includes(workflowCase.status)) {
      return res.status(409).json({ message: 'Closed tasks cannot be claimed' });
    }
    if (!isAdminUser(req.user) && userTeam(req.user) !== workflowCase.assignedTeam) {
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
    if (!isAdminUser(req.user) && !sameUserId(workflowCase.assignedTo, req.user.id)) {
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
    if (!isAdminUser(req.user)) return res.status(403).json({ message: 'Only an administrator can assign tasks' });
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
    if (!workflowCase.startedAt) {
      const now = new Date();
      workflowCase.startedAt = now;
      workflowCase.history.push({
        actorId: req.user.id,
        action: 'task_started',
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
    const workflowCase = await populateCase(WorkflowCase.findById(req.params.id));
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
    const assignToCreator = req.body.assignToMe === true && (isAdminUser(req.user) || userTeam(req.user) === initialTeam);
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

router.post('/cases/:id/transition', operationsAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid case ID' });
    const workflowCase = await WorkflowCase.findById(req.params.id);
    if (!workflowCase) return res.status(404).json({ message: 'Workflow case not found' });
    const ownershipError = requireOwnedCase(req.user, workflowCase);
    if (ownershipError) return res.status(isUnassigned(workflowCase) ? 409 : 403).json({ message: ownershipError });
    const nextStatus = String(req.body.status || '');
    const targetTeam = nextStatus === 'completed'
      ? workflowCase.assignedTeam
      : teamForStatus(nextStatus, workflowCase.productionMethod);
    if (!canUseTeam(req.user, workflowCase.assignedTeam) && !canUseTeam(req.user, targetTeam)) {
      return res.status(403).json({ message: 'This transition belongs to another team' });
    }
    if (nextStatus === 'waiting_customer_approval' && !Number.isFinite(workflowCase.quote?.amount)) {
      return res.status(409).json({ message: 'Record the proposed cost before requesting customer approval' });
    }
    const transitionError = validateTransition(workflowCase, nextStatus);
    if (transitionError) return res.status(409).json({ message: transitionError });
    if (!isAdminUser(req.user) && !workflowCase.startedAt) {
      return res.status(409).json({ message: 'Start this task before marking the step complete' });
    }

    const now = new Date();
    const previousStatus = workflowCase.status;
    const previousTeam = workflowCase.assignedTeam;
    const previousAssignee = workflowCase.assignedTo;
    const queueMinutes = minutesBetween(workflowCase.stageQueuedAt || workflowCase.createdAt, workflowCase.startedAt || now);
    const workMinutes = workflowCase.startedAt ? minutesBetween(workflowCase.startedAt, now) : null;
    workflowCase.status = nextStatus;
    workflowCase.assignedTeam = targetTeam;
    if (nextStatus === 'completed') {
      workflowCase.completedAt = now;
    } else {
      workflowCase.completedAt = null;
      workflowCase.stageQueuedAt = now;
      workflowCase.targetMinutes = targetMinutesForTeam(targetTeam);
      workflowCase.startedAt = null;
      if (previousTeam !== targetTeam) {
        const automaticAssignee = await findTeamAssignee(targetTeam);
        workflowCase.assignedTo = automaticAssignee?._id || null;
        workflowCase.assignedAt = automaticAssignee ? now : null;
      } else if (workflowCase.assignedTo) {
        workflowCase.assignedAt = now;
      }
    }
    if (nextStatus === 'printing') {
      workflowCase.print.machineId = cleanText(req.body.machineId, 120);
      workflowCase.print.sentAt = workflowCase.print.sentAt || new Date();
      workflowCase.print.startedAt = now;
    }
    if (nextStatus === 'quality_check') workflowCase.print.completedAt = now;
    workflowCase.history.push({
      actorId: req.user.id,
      action: 'status_changed',
      fromStatus: previousStatus,
      toStatus: nextStatus,
      note: cleanText(req.body.note, 1000),
      queueMinutes,
      workMinutes
    });
    await workflowCase.save();
    if (!sameUserId(previousAssignee, workflowCase.assignedTo)) {
      if (previousAssignee) await safelyNotify(() => notifyTaskRemoved(req.app, previousAssignee, workflowCase));
      if (workflowCase.assignedTo) await safelyNotify(() => notifyCaseAssignment(req.app, workflowCase));
    }
    if (nextStatus === 'needs_customer_info' || nextStatus === 'rejected') {
      await safelyNotify(() => notifyOrderBlocked(req.app, workflowCase, cleanText(req.body.note, 1000)));
    }
    if (['printing', 'quality_check'].includes(previousStatus) && ['ready_to_print', 'modeling'].includes(nextStatus)) {
      await safelyNotify(() => notifyFailedPrint(req.app, workflowCase, cleanText(req.body.note, 1000)));
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
