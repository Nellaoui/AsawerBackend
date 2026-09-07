const Notification = require('../models/Notification');
const User = require('../models/User');
const WorkflowCase = require('../models/WorkflowCase');
const { sendPushToUser } = require('./pushNotification');

const closedStatuses = ['completed', 'cancelled', 'rejected'];

const emitNotification = (app, notification) => {
  const io = app?.get?.('io');
  const socketsByUser = app?.get?.('socketsByUser');
  if (!io || !socketsByUser) return;
  const sockets = socketsByUser.get(String(notification.user));
  if (!sockets) return;
  for (const socketId of sockets) {
    io.to(socketId).emit('notification', {
      id: notification._id,
      title: notification.title,
      body: notification.body,
      type: notification.type,
      data: notification.data,
      read: notification.read,
      createdAt: notification.createdAt
    });
  }
};

const notifyUser = async (app, { userId, title, body, type = 'general', data = {}, dedupeKey }) => {
  if (!userId) return null;
  const user = await User.findOne({ _id: userId, isActive: { $ne: false } }).select('_id');
  if (!user) return null;

  let notification;
  try {
    notification = await Notification.create({
      user: user._id,
      title: String(title || '').slice(0, 180),
      body: String(body || '').slice(0, 1000),
      type,
      ...(dedupeKey ? { dedupeKey } : {}),
      data
    });
  } catch (error) {
    if (error?.code === 11000 && dedupeKey) {
      return Notification.findOne({ user: user._id, dedupeKey });
    }
    throw error;
  }

  emitNotification(app, notification);
  await sendPushToUser(User, user._id, notification.title, notification.body, {
    ...data,
    notificationId: String(notification._id),
    notificationType: type
  });
  return notification;
};

const activeAdminIds = async () => {
  const users = await User.find({
    $or: [{ isAdmin: true }, { role: 'admin' }],
    isActive: { $ne: false }
  }).select('_id').lean();
  return users.map(user => user._id);
};

const uniqueIds = values => [...new Set(values.filter(Boolean).map(value => String(value?._id || value)))];

const notifyUsers = async (app, userIds, payload) => Promise.all(
  uniqueIds(userIds).map(userId => notifyUser(app, { ...payload, userId }))
);

const taskData = workflowCase => ({
  workflowCaseId: String(workflowCase._id),
  orderId: workflowCase.orderId ? String(workflowCase.orderId?._id || workflowCase.orderId) : null,
  assignedTeam: workflowCase.assignedTeam,
  status: workflowCase.status,
  requestedName: workflowCase.requestedName
});

const notifyCaseAssignment = async (app, workflowCase, event = 'new_task') => {
  if (!workflowCase?.assignedTo || closedStatuses.includes(workflowCase.status)) return null;
  const assigneeId = workflowCase.assignedTo?._id || workflowCase.assignedTo;
  const title = event === 'reassigned' ? 'Task reassigned to you' : 'New task assigned';
  const body = `${workflowCase.requestedName} · ${String(workflowCase.assignedTeam || '').replaceAll('_', ' ')}`;
  return notifyUser(app, {
    userId: assigneeId,
    title,
    body,
    type: event,
    data: taskData(workflowCase),
    dedupeKey: `${event}:${workflowCase._id}:${workflowCase.assignedAt ? new Date(workflowCase.assignedAt).getTime() : (workflowCase.stageQueuedAt ? new Date(workflowCase.stageQueuedAt).getTime() : 'initial')}:${assigneeId}`
  });
};

const notifyTaskRemoved = async (app, userId, workflowCase) => notifyUser(app, {
  userId,
  title: 'Task reassigned',
  body: `${workflowCase.requestedName} was moved to another employee.`,
  type: 'task_removed',
  data: taskData(workflowCase)
});

const notifyOrderBlocked = async (app, workflowCase, reason = '') => {
  const adminIds = await activeAdminIds();
  const recipients = [workflowCase.assignedTo?._id || workflowCase.assignedTo, ...adminIds];
  return notifyUsers(app, recipients, {
    title: 'Order needs attention',
    body: `${workflowCase.requestedName} is blocked${reason ? `: ${reason}` : '.'}`,
    type: 'order_blocked',
    data: taskData(workflowCase),
    dedupeKey: `blocked:${workflowCase._id}:${workflowCase.stageQueuedAt ? new Date(workflowCase.stageQueuedAt).getTime() : workflowCase.status}`
  });
};

const notifyLowStock = async (app, product, contextKey = '') => {
  if (!product || product.fulfillmentPolicy === 'print_on_demand' || Number(product.stock) > Number(product.lowStockThreshold ?? 2)) return [];
  const stockEmployees = await User.find({ role: 'employee', workRole: 'stock', isActive: { $ne: false } }).select('_id').lean();
  const adminIds = await activeAdminIds();
  const recipients = [...stockEmployees.map(user => user._id), ...adminIds];
  return notifyUsers(app, recipients, {
    title: Number(product.stock) <= 0 ? 'Product out of stock' : 'Product stock is low',
    body: `${product.name} has ${Number(product.stock || 0)} available unit(s).`,
    type: 'low_stock',
    data: { productId: String(product._id), stock: Number(product.stock || 0), lowStockThreshold: Number(product.lowStockThreshold ?? 2) },
    ...(contextKey ? { dedupeKey: `low-stock:${product._id}:${contextKey}` } : {})
  });
};

const notifyFailedPrint = async (app, workflowCase, note = '') => {
  const adminIds = await activeAdminIds();
  const recipients = [workflowCase.assignedTo?._id || workflowCase.assignedTo, ...adminIds];
  return notifyUsers(app, recipients, {
    title: 'Print failed — rework assigned',
    body: `${workflowCase.requestedName}${note ? `: ${note}` : ' must be printed again.'}`,
    type: 'print_failed',
    data: taskData(workflowCase),
    dedupeKey: `print-failed:${workflowCase._id}:${workflowCase.stageQueuedAt ? new Date(workflowCase.stageQueuedAt).getTime() : Date.now()}`
  });
};

const effectiveDeadline = workflowCase => {
  if (workflowCase.deadlineAt) return new Date(workflowCase.deadlineAt);
  const start = workflowCase.assignedAt || workflowCase.stageQueuedAt || workflowCase.createdAt;
  return start ? new Date(new Date(start).getTime() + Number(workflowCase.targetMinutes || 120) * 60000) : null;
};

let deadlineInterval = null;
const checkWorkflowDeadlines = async app => {
  const now = new Date();
  const cases = await WorkflowCase.find({
    assignedTo: { $ne: null },
    status: { $nin: closedStatuses }
  }).select('orderId requestedName assignedTeam assignedTo status deadlineAt targetMinutes stageQueuedAt assignedAt createdAt').lean();

  for (const workflowCase of cases) {
    const deadline = effectiveDeadline(workflowCase);
    if (!deadline || Number.isNaN(deadline.getTime())) continue;
    const remainingMinutes = Math.round((deadline.getTime() - now.getTime()) / 60000);
    const stageKey = workflowCase.stageQueuedAt ? new Date(workflowCase.stageQueuedAt).getTime() : new Date(workflowCase.createdAt).getTime();
    if (remainingMinutes > 0 && remainingMinutes <= 30) {
      await notifyUser(app, {
        userId: workflowCase.assignedTo,
        title: 'Task deadline approaching',
        body: `${workflowCase.requestedName} is due in ${remainingMinutes} minute(s).`,
        type: 'deadline_soon',
        data: { ...taskData(workflowCase), deadlineAt: deadline.toISOString(), remainingMinutes },
        dedupeKey: `deadline-soon:${workflowCase._id}:${stageKey}`
      });
    } else if (remainingMinutes <= 0) {
      await notifyUser(app, {
        userId: workflowCase.assignedTo,
        title: 'Task is late',
        body: `${workflowCase.requestedName} passed its deadline.`,
        type: 'task_overdue',
        data: { ...taskData(workflowCase), deadlineAt: deadline.toISOString(), lateMinutes: Math.abs(remainingMinutes) },
        dedupeKey: `task-overdue:${workflowCase._id}:${stageKey}`
      });
    }
  }
};

const startWorkflowDeadlineNotifier = app => {
  if (deadlineInterval) return;
  const run = () => checkWorkflowDeadlines(app).catch(error => console.error('Workflow deadline notification check failed:', error));
  const initial = setTimeout(run, 5000);
  initial.unref?.();
  deadlineInterval = setInterval(run, 5 * 60 * 1000);
  deadlineInterval.unref?.();
};

module.exports = {
  checkWorkflowDeadlines,
  notifyCaseAssignment,
  notifyFailedPrint,
  notifyLowStock,
  notifyOrderBlocked,
  notifyTaskRemoved,
  notifyUser,
  notifyUsers,
  startWorkflowDeadlineNotifier
};
