const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const WorkflowCase = require('../models/WorkflowCase');
const { sendPushToUser } = require('./pushNotification');
const { canNotifyUser } = require('./notificationPolicy');
const { visibleTaskFilter, isVisibleWorkflowCase } = require('./workflowVisibility');
const { effectiveDeadline } = require('./stepTimes');

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
  const user = await User.findOne({ _id: userId, isActive: { $ne: false } }).select('_id role');
  if (!user) return null;
  if (!canNotifyUser(user, type, data)) return null;

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
  // Phone push goes through Expo's servers; don't make the employee's
  // request wait on it.
  Promise.resolve(sendPushToUser(User, user._id, notification.title, notification.body, {
    ...data,
    notificationId: String(notification._id),
    notificationType: type
  })).catch(error => console.error('❌ Workflow push failed:', error));
  return notification;
};

const activeAdminIds = async () => {
  const users = await User.find({
    $or: [{ isAdmin: true }, { role: 'admin' }, { role: 'employee', workRole: 'boss' }],
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

// Name of the employee whose action last moved this task, for "from X".
const lastActorName = async (workflowCase, assigneeId) => {
  const history = Array.isArray(workflowCase.history) ? workflowCase.history : [];
  const actorId = history.length ? history[history.length - 1]?.actorId : null;
  const id = String(actorId?._id || actorId || '');
  if (!mongoose.Types.ObjectId.isValid(id) || id === String(assigneeId)) return '';
  const actor = await User.findById(id).select('name email').lean();
  return actor?.name || actor?.email || '';
};

const notifyCaseAssignment = async (app, workflowCase, event = 'new_task') => {
  if (!isVisibleWorkflowCase(workflowCase) || !workflowCase.assignedTo || closedStatuses.includes(workflowCase.status)) return null;
  const assigneeId = workflowCase.assignedTo?._id || workflowCase.assignedTo;
  const from = await lastActorName(workflowCase, assigneeId).catch(() => '');
  const title = from ? `New task from ${from}` : 'New task for you';
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

const notifyTaskRemoved = async (app, userId, workflowCase) => isVisibleWorkflowCase(workflowCase) ? notifyUser(app, {
  userId,
  title: 'Task reassigned',
  body: `${workflowCase.requestedName} was moved to another employee.`,
  type: 'task_removed',
  data: taskData(workflowCase)
}) : null;

const notifyOrderBlocked = async (app, workflowCase, reason = '') => {
  if (!isVisibleWorkflowCase(workflowCase)) return null;
  const adminIds = await activeAdminIds();
  const recipients = [workflowCase.assignedTo?._id || workflowCase.assignedTo, ...adminIds];
  return notifyUsers(app, recipients, {
    title: 'Order needs attention',
    body: `${workflowCase.requestedName} is blocked${reason ? `: ${reason}` : '.'}`,
    type: 'order_blocked',
    data: taskData(workflowCase),
    dedupeKey: `blocked:${workflowCase._id}:${workflowCase.blockedAt ? new Date(workflowCase.blockedAt).getTime() : Date.now()}`
  });
};

const notifyFailedPrint = async (app, workflowCase, note = '') => {
  if (!isVisibleWorkflowCase(workflowCase)) return null;
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

let deadlineInterval = null;
const checkWorkflowDeadlines = async app => {
  const now = new Date();
  const cases = await WorkflowCase.find({
    ...visibleTaskFilter(),
    assignedTo: { $ne: null },
    status: { $nin: closedStatuses }
  }).select('orderId requestedName assignedTeam assignedTo status productionMethod deadlineAt targetMinutes stageQueuedAt assignedAt createdAt').lean();

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
  notifyOrderBlocked,
  notifyTaskRemoved,
  notifyUser,
  notifyUsers,
  startWorkflowDeadlineNotifier
};
