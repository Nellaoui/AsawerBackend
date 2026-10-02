const mongoose = require('mongoose');
const Order = require('../models/Order');
const WorkflowCase = require('../models/WorkflowCase');
const Notification = require('../models/Notification');
const { releaseReservedInventory } = require('./orderInventory');

// Orders archived while still waiting to be confirmed stay this long in the
// archive, then they are erased for good with their tasks and notifications.
const ARCHIVE_PURGE_DAYS = 14;

// Stock the order still held goes back first; the stock movement stays in the
// inventory ledger so shelf counts keep adding up.
const eraseOrder = async (orderId, now) => {
  const session = await mongoose.startSession();
  let erased = false;
  try {
    await session.withTransaction(async () => {
      erased = false;
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        await WorkflowCase.deleteMany({ orderId, archivePurgeAt: { $ne: null, $lte: now } }, { session });
        return;
      }
      // Returned from the archive in the meantime, or archived again later.
      if (!order.operationsArchivedAt || !order.archivePurgeAt || order.archivePurgeAt > now) return;
      await releaseReservedInventory(order, order.operationsArchivedBy || 'archive-cleanup', session);
      await WorkflowCase.deleteMany({ orderId: order._id }, { session });
      await Notification.deleteMany({ 'data.orderId': String(order._id) }, { session });
      await Order.deleteOne({ _id: order._id }, { session });
      erased = true;
    });
  } finally {
    await session.endSession();
  }
  return erased;
};

const eraseTask = async (workflowCase, now) => {
  const result = await WorkflowCase.deleteOne({ _id: workflowCase._id, orderId: null, archivedAt: { $ne: null }, archivePurgeAt: { $ne: null, $lte: now } });
  if (result.deletedCount) await Notification.deleteMany({ 'data.workflowCaseId': String(workflowCase._id) });
  return Boolean(result.deletedCount);
};

const purgeExpiredArchives = async (now = new Date()) => {
  const due = await WorkflowCase.find({ archivedAt: { $ne: null }, archivePurgeAt: { $ne: null, $lte: now } })
    .select('_id orderId')
    .limit(500)
    .lean();
  const orderIds = [...new Set(due.filter(item => item.orderId).map(item => String(item.orderId)))];
  let orders = 0;
  let tasks = 0;
  for (const orderId of orderIds) {
    try {
      if (await eraseOrder(orderId, now)) orders += 1;
    } catch (error) {
      console.error(`❌ Could not erase archived order ${orderId}:`, error);
    }
  }
  for (const workflowCase of due.filter(item => !item.orderId)) {
    try {
      if (await eraseTask(workflowCase, now)) tasks += 1;
    } catch (error) {
      console.error(`❌ Could not erase archived task ${workflowCase._id}:`, error);
    }
  }
  if (orders || tasks) console.log(`🗑️ Erased ${orders} archived order(s) and ${tasks} archived task(s) after ${ARCHIVE_PURGE_DAYS} days`);
  return { orders, tasks };
};

let purgeInterval = null;
const startArchivePurge = () => {
  if (purgeInterval) return;
  const run = () => purgeExpiredArchives().catch(error => console.error('❌ Archive clean-up failed:', error));
  const initial = setTimeout(run, 2 * 60 * 1000);
  initial.unref?.();
  purgeInterval = setInterval(run, 60 * 60 * 1000);
  purgeInterval.unref?.();
};

module.exports = { ARCHIVE_PURGE_DAYS, purgeExpiredArchives, startArchivePurge };
