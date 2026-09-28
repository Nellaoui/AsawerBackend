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

// The mobile app gets the same kind of hint, so open screens refresh on
// their own: "catalogs:changed" to every signed-in app, and "orders:changed"
// to the order's owner and to staff. Like the staff event, neither carries
// any data.
const APP_ROOM = 'app';
const userRoom = userId => `user:${userId}`;
const COALESCE_MS = 500;

let liveIo = null;
const setLiveIo = io => { liveIo = io; };

// Bursts (a bulk product upload, an order saved several times in one
// request) become one event per room. The short delay also lets a
// transaction commit before clients re-fetch.
const pending = new Map();
const emitSoon = (room, event) => {
  if (!liveIo) return;
  const key = `${room}|${event}`;
  if (pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    if (liveIo) liveIo.to(room).emit(event, { at: Date.now() });
  }, COALESCE_MS));
};

const broadcastCatalogChange = () => emitSoon(APP_ROOM, 'catalogs:changed');

const notifyOrderChange = userId => {
  if (userId) emitSoon(userRoom(String(userId)), 'orders:changed');
  emitSoon(STAFF_ROOM, 'orders:changed');
};

const broadcastCatalogsOnWrite = (req, res, next) => {
  if (!MUTATING_METHODS.has(req.method)) return next();
  res.on('finish', () => {
    if (res.statusCode < 400) broadcastCatalogChange();
  });
  return next();
};

module.exports = {
  STAFF_ROOM,
  APP_ROOM,
  userRoom,
  isStaffUser,
  broadcastWorkflowChange,
  broadcastOnWrite,
  setLiveIo,
  broadcastCatalogChange,
  broadcastCatalogsOnWrite,
  notifyOrderChange
};
