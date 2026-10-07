const mongoose = require('mongoose');
const WorkflowCase = require('../models/WorkflowCase');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Machine = require('../models/Machine');
const User = require('../models/User');
const PhoneChangeRequest = require('../models/PhoneChangeRequest');
const { visibleTaskFilter } = require('./workflowVisibility');
const { stepTimesSnapshot } = require('./stepTimes');
const { shopDayStart, shopDayKey, shopHour } = require('./workingTime');
const { customerFilter, lastOrderDates } = require('./customerPhoneService');

const RANGES = { today: 1, '7d': 7, '30d': 30 };
const DAY_MS = 24 * 60 * 60 * 1000;
const PRODUCT_LINE_TYPES = ['stock_pick', 'print_required'];
const CLOSED = ['completed', 'cancelled', 'rejected'];
const MAX_CASES = 20000;
const INACTIVE_DAYS = 30;
const FINISH_ACTIONS = new Set(['status_changed', 'stock_missing', 'order_validated', 'production_rerouted', 'product_created']);

const idText = value => (value && typeof value === 'object' && value._id ? String(value._id) : value ? String(value) : '');

const finishTime = (workflowCase) => {
  if (workflowCase.completedAt) return new Date(workflowCase.completedAt).getTime();
  const done = [...(workflowCase.history || [])].reverse().find(event => event.toStatus === 'completed');
  return new Date(done?.createdAt || workflowCase.updatedAt || workflowCase.createdAt).getTime();
};

// Where an open product line is right now (null when every task of the line is closed).
const stageOf = (cases) => {
  const open = cases.filter(item => !CLOSED.includes(item.status));
  if (!open.length) return null;
  const item = open[open.length - 1];
  if (item.isBlocked) return 'blocked';
  if (item.status === 'stock_picking') return 'stock_check';
  if (item.status === 'ready_to_print') return 'waiting_print';
  if (item.status === 'printing') return item.productionMethod === 'resin' ? 'resin_print' : 'wax_print';
  if (item.status === 'quality_check') return 'quality';
  if (item.status === 'packing') return 'packing';
  return 'setup';
};

const buildOverview = async ({ range = 'today', now = new Date(), isLateCase }) => {
  const key = RANGES[range] ? range : 'today';
  const days = RANGES[key];
  const nowMs = now.getTime();
  const startMs = shopDayStart(nowMs, days - 1);
  const start = new Date(startMs);
  const previousStartMs = shopDayStart(nowMs, days * 2 - 1);
  const previousStart = new Date(previousStartMs);
  const dayKeys = [];
  for (let back = days - 1; back >= 0; back -= 1) dayKeys.push(shopDayKey(shopDayStart(nowMs, back) + 3 * 60 * 60 * 1000));
  const lowStockFilter = { removedFromShop: { $ne: true }, isActive: { $ne: false }, $expr: { $lte: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$lowStockThreshold', 2] }] } };

  const [lineCases, activeCases, ordersInRange, previousOrders, openPacking, lowStock, lowStockTotal, machines, historyEvents, customers, newCustomers, pendingPhones, previousNewCustomers, reprintRequests] = await Promise.all([
    WorkflowCase.find({ ...visibleTaskFilter(), archivedAt: null, requestType: { $in: PRODUCT_LINE_TYPES }, taskKind: 'order', orderId: { $ne: null }, status: { $nin: ['cancelled', 'rejected'] } })
      .sort({ createdAt: -1 }).limit(MAX_CASES)
      .select('orderId orderItemId status isBlocked productionMethod completedAt updatedAt createdAt history.toStatus history.createdAt')
      .lean(),
    WorkflowCase.find({ ...visibleTaskFilter(), archivedAt: null, status: { $nin: CLOSED } })
      .select('status isBlocked deadlineAt targetMinutes stageQueuedAt assignedAt createdAt assignedTeam productionMethod productId')
      .lean(),
    Order.find({ createdAt: { $gte: start }, status: { $ne: 'cancelled' } }).select('userId createdAt items.productId items.name items.quantity items.productionMethod items.printQuantity').lean(),
    Order.countDocuments({ createdAt: { $gte: previousStart, $lt: start }, status: { $ne: 'cancelled' } }),
    WorkflowCase.find({ ...visibleTaskFilter(), archivedAt: null, requestType: 'pack_order', status: { $nin: CLOSED } }).select('orderId').lean(),
    Product.find(lowStockFilter).sort({ stock: 1 }).limit(5).select('name serialNumber stock lowStockThreshold').lean(),
    Product.countDocuments(lowStockFilter),
    Machine.find({ enabled: { $ne: false } }).select('name productionMethod status').lean(),
    WorkflowCase.aggregate([
      { $match: { ...visibleTaskFilter(), 'history.createdAt': { $gte: previousStart } } },
      { $unwind: '$history' },
      { $match: { 'history.createdAt': { $gte: previousStart } } },
      { $project: { _id: 0, actorId: '$history.actorId', action: '$history.action', fromStatus: '$history.fromStatus', toStatus: '$history.toStatus', createdAt: '$history.createdAt' } }
    ]),
    User.find({ ...customerFilter, isActive: { $ne: false } }).select('_id createdAt').lean(),
    User.countDocuments({ ...customerFilter, createdAt: { $gte: start } }),
    PhoneChangeRequest.countDocuments({ status: 'pending' }),
    User.countDocuments({ ...customerFilter, createdAt: { $gte: previousStart, $lt: start } }),
    WorkflowCase.countDocuments({ ...visibleTaskFilter(), reprintRequestedAt: { $gte: start } })
  ]);

  // Products (order lines) finished, and where the others are now.
  const lines = new Map();
  for (const item of lineCases) {
    const lineKey = `${item.orderId}:${item.orderItemId || item._id}`;
    if (!lines.has(lineKey)) lines.set(lineKey, []);
    lines.get(lineKey).push(item);
  }
  const packingOpen = new Set(openPacking.map(item => String(item.orderId)));
  const orderState = new Map();
  const perBucket = new Map();
  const hourly = days === 1;
  let finishedInRange = 0;
  let finishedPrevious = 0;
  let finishedTotal = 0;
  const stages = { stock_check: 0, waiting_print: 0, wax_print: 0, resin_print: 0, quality: 0, packing: 0, setup: 0, blocked: 0 };
  for (const [lineKey, cases] of lines) {
    const orderKey = lineKey.split(':')[0];
    const state = orderState.get(orderKey) || { open: packingOpen.has(orderKey), lastFinish: 0 };
    orderState.set(orderKey, state);
    // A stock-only line is not finished while the order's own packing task is still open.
    const stage = stageOf(cases) || (packingOpen.has(orderKey) ? 'packing' : null);
    if (stage) { stages[stage] += 1; state.open = true; continue; }
    finishedTotal += 1;
    const finishedAt = Math.max(...cases.map(finishTime));
    state.lastFinish = Math.max(state.lastFinish, finishedAt);
    if (finishedAt >= previousStartMs && finishedAt < startMs) finishedPrevious += 1;
    if (finishedAt >= startMs) {
      finishedInRange += 1;
      const bucket = hourly ? shopHour(finishedAt) : shopDayKey(finishedAt);
      perBucket.set(bucket, (perBucket.get(bucket) || 0) + 1);
    }
  }
  const finishedSeries = hourly
    ? Array.from({ length: 13 }, (_, index) => ({ label: `${index + 8}h`, value: perBucket.get(index + 8) || 0 }))
    : dayKeys.map(dayKey => ({ label: dayKey.slice(5), value: perBucket.get(dayKey) || 0 }));

  // An order is ready when none of its products is still open; it counts on the day its last product finished.
  let readyOrders = 0;
  let readyPrevious = 0;
  for (const state of orderState.values()) {
    if (state.open) continue;
    if (state.lastFinish >= startMs) readyOrders += 1;
    else if (state.lastFinish >= previousStartMs) readyPrevious += 1;
  }

  // Late and blocked right now.
  let late = 0;
  let blocked = 0;
  for (const item of activeCases) {
    if (isLateCase(item, now)) late += 1;
    if (item.isBlocked) blocked += 1;
  }

  // Top products by pieces ordered, and how many customers ordered.
  const topMap = new Map();
  const ordering = new Set();
  const customerPieces = new Map();
  const printPieces = { wax: 0, resin: 0 };
  for (const order of ordersInRange) {
    ordering.add(idText(order.userId));
    for (const item of order.items || []) {
      const pieces = Number(item.quantity || 0);
      customerPieces.set(idText(order.userId), (customerPieces.get(idText(order.userId)) || 0) + pieces);
      if (printPieces[item.productionMethod] !== undefined) printPieces[item.productionMethod] += Number(item.printQuantity || 0);
      const productKey = idText(item.productId) || item.name;
      const row = topMap.get(productKey) || { name: item.name, quantity: 0 };
      row.quantity += Number(item.quantity || 0);
      topMap.set(productKey, row);
    }
  }
  const topProducts = [...topMap.values()].sort((left, right) => right.quantity - left.quantity).slice(0, 5);

  // When the team finishes steps, and printing that went back for rework.
  const hours = Array.from({ length: 24 }, () => 0);
  let printFailures = 0;
  let printFailuresPrevious = 0;
  const stepsByActor = new Map();
  for (const event of historyEvents) {
    const at = new Date(event.createdAt).getTime();
    const failed = event.action === 'status_changed' && ['printing', 'quality_check'].includes(event.fromStatus) && ['ready_to_print', 'modeling'].includes(event.toStatus);
    if (!(at >= startMs)) {
      if (failed) printFailuresPrevious += 1;
      continue;
    }
    if (FINISH_ACTIONS.has(event.action) && event.fromStatus) {
      hours[shopHour(at)] += 1;
      const actor = idText(event.actorId);
      if (actor) stepsByActor.set(actor, (stepsByActor.get(actor) || 0) + 1);
    }
    if (failed) printFailures += 1;
  }

  // Names for the team and top-customer lists (test tokens use non-ObjectId ids, so those are skipped).
  const topActors = [...stepsByActor].sort((left, right) => right[1] - left[1]).slice(0, 10);
  const topBuyers = [...customerPieces].sort((left, right) => right[1] - left[1]).slice(0, 5);
  const wantedIds = [...new Set([...topActors, ...topBuyers].map(([id]) => id))].filter(id => mongoose.Types.ObjectId.isValid(id));
  const people = wantedIds.length ? await User.find({ _id: { $in: wantedIds } }).select('name email workRole').lean() : [];
  const personOf = new Map(people.map(person => [String(person._id), person]));
  const team = topActors.map(([id, steps]) => ({ name: personOf.get(id)?.name || personOf.get(id)?.email || 'Unknown', workRole: personOf.get(id)?.workRole || '', steps }));
  const topCustomers = topBuyers.map(([id, quantity]) => ({ name: personOf.get(id)?.name || personOf.get(id)?.email || 'Customer', quantity }));

  // Average time per step, from the learned step times (shop working hours).
  const learned = stepTimesSnapshot();
  const stepAverages = [
    ['Stock check', 'stock_picking'], ['Wax printing', 'printing:wax'], ['Resin printing', 'printing:resin'],
    ['Quality', 'quality_check'], ['Packing', 'packing']
  ].map(([label, stepKey]) => ({ label, minutes: learned[stepKey]?.minutes ?? null }));

  const printers = { total: machines.length, busy: 0, available: 0, problem: 0, other: 0 };
  for (const machine of machines) {
    if (machine.status === 'busy') printers.busy += 1;
    else if (machine.status === 'available') printers.available += 1;
    else if (['failed', 'maintenance', 'offline'].includes(machine.status)) printers.problem += 1;
    else printers.other += 1;
  }

  // Customers who ordered before but not for 30 days.
  const lastOrders = await lastOrderDates(customers.map(customer => customer._id));
  const quietBefore = nowMs - INACTIVE_DAYS * DAY_MS;
  let quiet = 0;
  for (const customer of customers) {
    const last = lastOrders.get(String(customer._id))?.lastOrderAt;
    if (last && new Date(last).getTime() < quietBefore) quiet += 1;
  }

  return {
    range: key,
    generatedAt: now,
    since: start,
    finished: { inRange: finishedInRange, previous: finishedPrevious, total: finishedTotal, series: finishedSeries, perHour: hourly },
    orders: { received: ordersInRange.length, previous: previousOrders, ready: readyOrders, readyPrevious },
    late,
    blocked,
    lowStock: { total: lowStockTotal, products: lowStock },
    stages,
    stepAverages,
    topProducts,
    printers: { ...printers, failures: printFailures, failuresPrevious: printFailuresPrevious },
    printing: { wax: printPieces.wax, resin: printPieces.resin, reprints: reprintRequests },
    team,
    topCustomers,
    customers: { new: newCustomers, newPrevious: previousNewCustomers, ordering: ordering.size, quiet, pendingPhones },
    busiestHours: hours.map((value, hour) => ({ hour, value })).filter(row => row.hour >= 6 && row.hour <= 22)
  };
};

module.exports = { buildOverview, RANGES };
