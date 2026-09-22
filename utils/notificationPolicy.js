const EMPLOYEE_ACTIONABLE_NOTIFICATION_TYPES = [
  'new_task',
  'deadline_soon',
  'task_overdue',
  'reassigned',
  'task_removed',
  'order_blocked',
  'print_failed'
];

const employeeActionableTypes = new Set(EMPLOYEE_ACTIONABLE_NOTIFICATION_TYPES);

const notificationTypeFrom = (type, data = {}) => String(
  type || data.notificationType || data.type || data.action || 'general'
);

const canNotifyUser = (user, type, data = {}) => {
  if (user?.role !== 'employee') return true;
  return employeeActionableTypes.has(notificationTypeFrom(type, data));
};

const notificationFilterForUser = user => ({
  user: user.id || user._id,
  type: user.role === 'employee'
    ? { $in: EMPLOYEE_ACTIONABLE_NOTIFICATION_TYPES }
    : { $ne: 'low_stock' }
});

module.exports = {
  EMPLOYEE_ACTIONABLE_NOTIFICATION_TYPES,
  canNotifyUser,
  notificationFilterForUser,
  notificationTypeFrom
};
