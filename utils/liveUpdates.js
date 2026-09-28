// Tells every connected staff screen (employees and admins) that workflow
// data changed, so open portals reload themselves instead of waiting for
// someone to press Refresh. The event carries no order data: each client
// re-fetches through the normal authenticated API.
const STAFF_ROOM = 'staff';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const isStaffUser = user => Boolean(user && (user.isAdmin || ['admin', 'employee'].includes(user.role)));

const broadcastWorkflowChange = (app, reason = 'changed') => {
  const io = app?.get?.('io');
  if (!io) return;
  io.to(STAFF_ROOM).emit('workflow:changed', { reason, at: Date.now() });
};

// Express middleware: after any successful write under the mounted path,
// broadcast once the response has been sent.
const broadcastOnWrite = reason => (req, res, next) => {
  if (!MUTATING_METHODS.has(req.method)) return next();
  res.on('finish', () => {
    if (res.statusCode < 400) broadcastWorkflowChange(req.app, reason);
  });
  return next();
};

module.exports = { STAFF_ROOM, isStaffUser, broadcastWorkflowChange, broadcastOnWrite };
