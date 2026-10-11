const mongoose = require('mongoose');
const WorkflowCase = require('../models/WorkflowCase');
const Plate = require('../models/Plate');
const Machine = require('../models/Machine');
const { operationsAuth } = require('../middlewares/auth');
const { findTeamAssignee } = require('../utils/workflowAssignment');
const { auditMachine, findMachine } = require('../utils/machineRegistry');
const { notifyCaseAssignment, notifyFailedPrint } = require('../utils/workflowNotifications');
const { teamForStatus, targetMinutesForTeam } = require('../utils/workflowRules');

const REMINDER_MINUTES = 120;
const BAD_PRINTER_STATUSES = ['offline', 'failed', 'maintenance'];

const cleanText = (value, max) => String(value || '').trim().slice(0, max);
const minutesBetween = (start, end = new Date()) => (start ? Math.max(Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000), 0) : null);
const fail = (message, statusCode = 409) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
};

// Plates belong to the printing team of their method (wax or resin); the boss and administrators may use any.
const canUsePlate = (user, method) => {
  if (user?.isAdmin || user?.role === 'admin') return true;
  if (user?.role !== 'employee') return false;
  return user.workRole === 'boss' || user.workRole === `${method}_print`;
};

const nextPlateNumber = async () => {
  const last = await Plate.findOne().sort({ number: -1 }).select('number').lean();
  return (last?.number || 0) + 1;
};

// The number is automatic. Two people opening a plate at the same moment can pick the same number; the unique index refuses one and it tries the next.
const createPlate = async ({ productionMethod, actorId }) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await Plate.create({ number: await nextPlateNumber(), productionMethod, createdBy: actorId });
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  return fail('Could not open a new plate. Try again.', 500);
};

const plateCases = (plate, extra = {}) => WorkflowCase.find({ 'print.plateId': plate._id, ...extra });

// An open plate with nothing on it is closed so it does not stay in the list.
const dropIfEmpty = async plate => {
  if (plate.status !== 'open') return false;
  if (await WorkflowCase.countDocuments({ 'print.plateId': plate._id })) return false;
  plate.status = 'cancelled';
  await plate.save();
  return true;
};

const putOnPlate = async ({ workflowCase, plate, actorId, note }) => {
  workflowCase.print = { ...(workflowCase.print?.toObject ? workflowCase.print.toObject() : workflowCase.print || {}), plateId: plate._id, plateNumber: plate.number };
  workflowCase.history.push({ actorId, action: 'plate_assigned', fromStatus: workflowCase.status, toStatus: workflowCase.status, note });
  await workflowCase.save();
};

const takeOffPlate = async ({ workflowCase, actorId, note }) => {
  workflowCase.print = { ...(workflowCase.print?.toObject ? workflowCase.print.toObject() : workflowCase.print || {}), plateId: null, plateNumber: null };
  workflowCase.history.push({ actorId, action: 'plate_removed', fromStatus: workflowCase.status, toStatus: workflowCase.status, note });
  await workflowCase.save();
};

const plateLine = workflowCase => {
  const order = workflowCase.orderId && typeof workflowCase.orderId === 'object' ? workflowCase.orderId : null;
  const orderItem = order?.items?.find?.(item => String(item._id) === String(workflowCase.orderItemId));
  const product = workflowCase.productId && typeof workflowCase.productId === 'object' ? workflowCase.productId : orderItem?.productId || {};
  return {
    _id: workflowCase._id,
    name: workflowCase.requestedName,
    reference: product.serialNumber || '',
    imageUrl: product.imageUrl || '',
    size: orderItem?.size || workflowCase.dimensions?.ringSize || '',
    quantity: workflowCase.quantity,
    orderNumber: order?.orderNumber || '',
    status: workflowCase.status,
    isBlocked: Boolean(workflowCase.isBlocked)
  };
};

module.exports = function registerPlateRoutes(router, { refreshOrderFulfillment, safelyNotify, requireOwnedCase, isUnassigned }) {
  const respond = (res, error, label) => {
    if (!error.statusCode) console.error(`Plate ${label} failed:`, error);
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : `Could not ${label}` });
  };

  const loadPlate = async (req, status) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) fail('Invalid plate ID', 400);
    const plate = await Plate.findById(req.params.id);
    if (!plate) fail('Plate not found', 404);
    if (!canUsePlate(req.user, plate.productionMethod)) fail(`Only ${plate.productionMethod} printing staff or the boss can use this plate`, 403);
    if (status && plate.status !== status) fail(status === 'open' ? 'This plate was already sent to a printer' : 'This plate is not printing', 409);
    return plate;
  };

  const loadOwnedCase = async (req, caseId) => {
    if (!mongoose.Types.ObjectId.isValid(caseId)) fail('Invalid product ID', 400);
    const workflowCase = await WorkflowCase.findById(caseId);
    if (!workflowCase) fail('Product task not found', 404);
    const ownershipError = requireOwnedCase(req.user, workflowCase);
    if (ownershipError) fail(ownershipError, isUnassigned(workflowCase) ? 409 : 403);
    return workflowCase;
  };

  const listView = async plate => {
    const cases = await WorkflowCase.find({ 'print.plateId': plate._id, status: { $in: ['ready_to_print', 'printing'] } })
      .populate('productId', 'serialNumber name imageUrl')
      .populate({ path: 'orderId', select: 'orderNumber items', populate: { path: 'items.productId', select: 'serialNumber name imageUrl' } });
    return {
      _id: plate._id,
      number: plate.number,
      productionMethod: plate.productionMethod,
      status: plate.status,
      machineCode: plate.machineCode,
      createdAt: plate.createdAt,
      sentAt: plate.sentAt,
      waitingTooLong: plate.status === 'open' && minutesBetween(plate.createdAt) >= REMINDER_MINUTES,
      products: cases.map(plateLine)
    };
  };

  // Plates the user can work with: open plates and plates on a printer.
  router.get('/plates', operationsAuth, async (req, res) => {
    try {
      const user = req.user;
      const filter = { status: { $in: ['open', 'printing'] } };
      if (!(user?.isAdmin || user?.role === 'admin' || user?.workRole === 'boss')) {
        if (!['wax_print', 'resin_print'].includes(user?.workRole)) return res.json([]);
        filter.productionMethod = user.workRole === 'wax_print' ? 'wax' : 'resin';
      }
      const plates = await Plate.find(filter).sort({ number: 1 });
      const views = await Promise.all(plates.map(async plate => ((await dropIfEmpty(plate)) ? null : listView(plate))));
      res.json(views.filter(Boolean));
    } catch (error) {
      respond(res, error, 'load the plates');
    }
  });

  // Add a product waiting to print to its order's open plate (opened automatically).
  router.post('/plates/add', operationsAuth, async (req, res) => {
    try {
      const workflowCase = await loadOwnedCase(req, req.body.caseId);
      if (workflowCase.status !== 'ready_to_print' || workflowCase.archivedAt) fail('Only a product waiting to print can go on a plate');
      if (workflowCase.isBlocked) fail('Resume this blocked product before putting it on a plate');
      if (!['wax', 'resin'].includes(workflowCase.productionMethod)) fail('This product has no Wax or Resin route yet');
      if (!workflowCase.orderId) fail('Only order products can go on a plate');
      if (!canUsePlate(req.user, workflowCase.productionMethod)) fail(`Only ${workflowCase.productionMethod} printing staff or the boss can use plates`, 403);
      if (workflowCase.print?.plateId) fail(`This product is already on Plate ${workflowCase.print.plateNumber}`);
      // The employee's current plate is sent along ('new' opens one); without it the newest open plate of the method is used.
      let plate = null;
      if (req.body.toPlateId && req.body.toPlateId !== 'new') {
        if (!mongoose.Types.ObjectId.isValid(req.body.toPlateId)) fail('Invalid plate ID', 400);
        plate = await Plate.findById(req.body.toPlateId);
        if (!plate || plate.status !== 'open') fail('That plate is not open any more');
        if (plate.productionMethod !== workflowCase.productionMethod) fail(`This is a ${plate.productionMethod} plate. Choose a ${workflowCase.productionMethod} plate for this product`);
      } else if (req.body.toPlateId !== 'new') {
        plate = await Plate.findOne({ productionMethod: workflowCase.productionMethod, status: 'open' }).sort({ number: -1 });
      }
      if (!plate) plate = await createPlate({ productionMethod: workflowCase.productionMethod, actorId: req.user.id });
      await putOnPlate({ workflowCase, plate, actorId: req.user.id, note: `Put on Plate ${plate.number}` });
      // The portal only needs the plate itself here; its product list comes with the next plate list, so no extra queries delay the answer.
      res.json({ _id: plate._id, number: plate.number, productionMethod: plate.productionMethod, status: plate.status, createdAt: plate.createdAt });
    } catch (error) {
      respond(res, error, 'add the product to a plate');
    }
  });

  // Take a product off an open plate; it goes back to the To print list.
  router.post('/plates/:id/remove', operationsAuth, async (req, res) => {
    try {
      const plate = await loadPlate(req, 'open');
      const workflowCase = await loadOwnedCase(req, req.body.caseId);
      if (String(workflowCase.print?.plateId || '') !== String(plate._id)) fail('This product is not on this plate');
      await takeOffPlate({ workflowCase, actorId: req.user.id, note: `Taken off Plate ${plate.number}` });
      const closed = await dropIfEmpty(plate);
      res.json({ closed });
    } catch (error) {
      respond(res, error, 'remove the product from the plate');
    }
  });

  // Move a product to another open plate of the same type (wax or resin), or to a new plate.
  router.post('/plates/:id/move', operationsAuth, async (req, res) => {
    try {
      const plate = await loadPlate(req, 'open');
      const workflowCase = await loadOwnedCase(req, req.body.caseId);
      if (String(workflowCase.print?.plateId || '') !== String(plate._id)) fail('This product is not on this plate');
      let target;
      if (req.body.toPlateId) {
        if (!mongoose.Types.ObjectId.isValid(req.body.toPlateId)) fail('Invalid plate ID', 400);
        target = await Plate.findById(req.body.toPlateId);
        if (!target || target.status !== 'open') fail('That plate is not open any more');
        if (target.productionMethod !== plate.productionMethod) fail('A product can only move to a plate of the same type');
        if (String(target._id) === String(plate._id)) fail('The product is already on this plate');
      } else {
        target = await createPlate({ productionMethod: plate.productionMethod, actorId: req.user.id });
      }
      await putOnPlate({ workflowCase, plate: target, actorId: req.user.id, note: `Moved from Plate ${plate.number} to Plate ${target.number}` });
      res.json({ moved: true, plate: { _id: target._id, number: target.number } });
      dropIfEmpty(plate).catch(error => console.error('Plate cleanup failed:', error));
    } catch (error) {
      respond(res, error, 'move the product');
    }
  });

  // Send the whole plate to one printer, even when it is not full.
  router.post('/plates/:id/send', operationsAuth, async (req, res) => {
    try {
      const plate = await loadPlate(req, 'open');
      const machine = await findMachine(cleanText(req.body.machineId, 120));
      if (!machine) fail('Choose a printer', 400);
      if (!machine.enabled) fail('This printer is disabled');
      if (machine.productionMethod !== plate.productionMethod) fail(`Choose a ${plate.productionMethod} printer for this plate`);
      if (BAD_PRINTER_STATUSES.includes(machine.status)) fail(`This printer is ${machine.status}`);
      if (machine.currentCaseId || machine.currentPlateId) fail('This printer is already busy');
      const cases = await plateCases(plate);
      if (!cases.length) fail('Put at least one product on the plate first');
      const stale = cases.find(item => item.status !== 'ready_to_print' || item.isBlocked || item.archivedAt);
      if (stale) fail(`${stale.requestedName} can not be printed now. Take it off the plate first.`);
      const now = new Date();
      const team = teamForStatus('printing', plate.productionMethod);
      const saves = [];
      for (const workflowCase of cases) {
        const queueMinutes = minutesBetween(workflowCase.stageQueuedAt || workflowCase.createdAt, workflowCase.startedAt || now);
        workflowCase.status = 'printing';
        workflowCase.assignedTeam = team;
        workflowCase.stageQueuedAt = now;
        workflowCase.targetMinutes = targetMinutesForTeam(team);
        workflowCase.startedAt = now;
        workflowCase.print = { machineId: machine.code, sentAt: now, startedAt: now, completedAt: null, plateId: plate._id, plateNumber: plate.number };
        workflowCase.history.push({
          actorId: req.user.id, action: 'status_changed', fromStatus: 'ready_to_print', toStatus: 'printing',
          note: `Plate ${plate.number} sent to ${machine.name || machine.code}`, queueMinutes
        });
        saves.push(workflowCase.save());
      }
      plate.status = 'printing';
      plate.machineCode = machine.code;
      plate.sentAt = now;
      saves.push(plate.save());
      machine.status = 'busy';
      machine.statusReason = '';
      machine.statusSource = 'manual';
      machine.currentPlateId = plate._id;
      machine.lastStatusChangedAt = now;
      machine.updatedBy = req.user.id;
      saves.push(machine.save());
      // The cases, the plate and the printer are separate documents, so they are saved together.
      await Promise.all(saves);
      res.json(await listView(plate));
      // The audit line is written after the answer so the person does not wait for it.
      Promise.resolve(auditMachine({ action: 'plate_assigned', actorId: req.user.id, machine, details: { plateId: String(plate._id), plateNumber: plate.number, products: cases.length } }))
        .catch(error => console.error('Plate audit failed:', error));
    } catch (error) {
      respond(res, error, 'send the plate to the printer');
    }
  });

  const releasePrinter = async ({ plate, actorId, failed, reason }) => {
    const machine = plate.machineCode ? await findMachine(plate.machineCode) : null;
    if (!machine || String(machine.currentPlateId || '') !== String(plate._id)) return;
    const previousStatus = machine.status;
    machine.status = failed ? 'failed' : 'available';
    machine.statusReason = failed ? reason : '';
    machine.statusSource = 'manual';
    machine.currentPlateId = null;
    machine.lastStatusChangedAt = new Date();
    machine.updatedBy = actorId;
    await machine.save();
    await auditMachine({
      action: failed ? 'machine_print_failed' : 'plate_released', actorId, machine,
      details: { previousStatus, status: machine.status, plateId: String(plate._id), plateNumber: plate.number, reason }
    });
  };

  // The printer is done: every product of the plate goes to Quality together.
  router.post('/plates/:id/finish', operationsAuth, async (req, res) => {
    try {
      const plate = await loadPlate(req, 'printing');
      const cases = await plateCases(plate, { status: 'printing' });
      const stuck = cases.find(item => item.isBlocked || item.archivedAt);
      if (stuck) fail(`Resume ${stuck.requestedName} before finishing the plate`);
      const now = new Date();
      const team = teamForStatus('quality_check', plate.productionMethod);
      const assignee = cases.length ? await findTeamAssignee(team) : null;
      const saves = [];
      for (const workflowCase of cases) {
        const queueMinutes = minutesBetween(workflowCase.stageQueuedAt || workflowCase.createdAt, workflowCase.startedAt || now);
        const workMinutes = workflowCase.startedAt ? minutesBetween(workflowCase.startedAt, now) : null;
        workflowCase.status = 'quality_check';
        workflowCase.assignedTeam = team;
        workflowCase.assignedTo = assignee?._id || null;
        workflowCase.assignedAt = assignee ? now : null;
        workflowCase.completedAt = null;
        workflowCase.stageQueuedAt = now;
        workflowCase.targetMinutes = targetMinutesForTeam(team);
        workflowCase.startedAt = null;
        workflowCase.print.completedAt = now;
        workflowCase.history.push({
          actorId: req.user.id, action: 'status_changed', fromStatus: 'printing', toStatus: 'quality_check',
          note: `Plate ${plate.number} finished`, queueMinutes, workMinutes
        });
        saves.push(workflowCase.save());
      }
      plate.status = 'finished';
      plate.finishedAt = now;
      saves.push(plate.save());
      await Promise.all(saves);
      await Promise.all([
        releasePrinter({ plate, actorId: req.user.id, failed: false, reason: '' }),
        ...[...new Set(cases.map(item => String(item.orderId || '')).filter(Boolean))].map(orderId => refreshOrderFulfillment(orderId, req.user.id, req.app))
      ]);
      res.json({ finished: true, moved: cases.length });
      for (const workflowCase of cases) if (workflowCase.assignedTo) await safelyNotify(() => notifyCaseAssignment(req.app, workflowCase));
    } catch (error) {
      respond(res, error, 'finish the plate');
    }
  });

  // The print failed: every product goes back to To print, ready for a new plate.
  router.post('/plates/:id/fail', operationsAuth, async (req, res) => {
    try {
      const plate = await loadPlate(req, 'printing');
      const reason = cleanText(req.body.note, 1000);
      if (!reason) fail('Write why the print failed', 400);
      const cases = await plateCases(plate, { status: 'printing' });
      const now = new Date();
      const team = teamForStatus('ready_to_print', plate.productionMethod);
      const saves = [];
      for (const workflowCase of cases) {
        const queueMinutes = minutesBetween(workflowCase.stageQueuedAt || workflowCase.createdAt, workflowCase.startedAt || now);
        const workMinutes = workflowCase.startedAt ? minutesBetween(workflowCase.startedAt, now) : null;
        workflowCase.status = 'ready_to_print';
        workflowCase.assignedTeam = team;
        workflowCase.stageQueuedAt = now;
        workflowCase.targetMinutes = targetMinutesForTeam(team);
        workflowCase.startedAt = null;
        workflowCase.print = { machineId: '', sentAt: null, startedAt: null, completedAt: null, plateId: null, plateNumber: null };
        workflowCase.history.push({
          actorId: req.user.id, action: 'status_changed', fromStatus: 'printing', toStatus: 'ready_to_print',
          note: `Plate ${plate.number} failed: ${reason}`.slice(0, 1000), queueMinutes, workMinutes
        });
        saves.push(workflowCase.save());
      }
      plate.status = 'failed';
      plate.failedReason = reason;
      plate.finishedAt = now;
      saves.push(plate.save());
      await Promise.all(saves);
      await Promise.all([
        releasePrinter({ plate, actorId: req.user.id, failed: true, reason }),
        ...[...new Set(cases.map(item => String(item.orderId || '')).filter(Boolean))].map(orderId => refreshOrderFulfillment(orderId, req.user.id, req.app))
      ]);
      res.json({ failed: true, returned: cases.length });
      for (const workflowCase of cases) await safelyNotify(() => notifyFailedPrint(req.app, workflowCase, `Plate ${plate.number}: ${reason}`));
    } catch (error) {
      respond(res, error, 'mark the plate as failed');
    }
  });
};

module.exports.canUsePlate = canUsePlate;
