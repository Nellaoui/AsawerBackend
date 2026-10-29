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
// A printer marked failed can still be chosen: the person knows whether it works again.
const BAD_PRINTER_STATUSES = ['offline', 'maintenance'];

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

// A wax plate belongs to one wax employee. A plate without an owner (older plates, resin) is open to every employee of its method.
const isPlateOwner = (plate, userId) => !plate.ownerId || String(plate.ownerId) === String(userId);
const ownsPlate = (user, plate) => user?.isAdmin || user?.role === 'admin' || user?.workRole === 'boss'
  || plate.productionMethod !== 'wax' || isPlateOwner(plate, user?.id || user?._id);

const nextPlateNumber = async () => {
  const last = await Plate.findOne().sort({ number: -1 }).select('number').lean();
  return (last?.number || 0) + 1;
};

// The number is automatic. Two people opening a plate at the same moment can pick the same number; the unique index refuses one and it tries the next.
const createPlate = async ({ productionMethod, actorId, ownerId = null }) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await Plate.create({ number: await nextPlateNumber(), productionMethod, createdBy: actorId, ownerId: productionMethod === 'wax' ? ownerId : null });
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  return fail('Could not open a new plate. Try again.', 500);
};

const plateCases = (plate, extra = {}) => WorkflowCase.find({ 'print.plateId': plate._id, ...extra });

// An open plate with nothing on it is closed so it does not stay in the list.
// A plate is opened a moment before its first product is saved onto it, so the plate list (which every live screen refreshes) leaves a brand new plate alone.
const NEW_PLATE_GRACE_MS = 2 * 60 * 1000;
const dropIfEmpty = async (plate, { grace = false } = {}) => {
  if (plate.status !== 'open') return false;
  if (grace && Date.now() - new Date(plate.createdAt).getTime() < NEW_PLATE_GRACE_MS) return false;
  if (await WorkflowCase.countDocuments({ 'print.plateId': plate._id })) return false;
  plate.status = 'cancelled';
  await plate.save();
  return true;
};

const putOnPlate = async ({ workflowCase, plate, actorId, note }) => {
  // A plate cancelled as empty a moment ago is opened again, so a product is never linked to a closed plate.
  if (plate.status === 'cancelled') { plate.status = 'open'; await plate.save(); }
  workflowCase.print = { ...(workflowCase.print?.toObject ? workflowCase.print.toObject() : workflowCase.print || {}), plateId: plate._id, plateNumber: plate.number };
  workflowCase.history.push({ actorId, action: 'plate_assigned', fromStatus: workflowCase.status, toStatus: workflowCase.status, note });
  await workflowCase.save();
};

const takeOffPlate = async ({ workflowCase, actorId, note }) => {
  workflowCase.print = { ...(workflowCase.print?.toObject ? workflowCase.print.toObject() : workflowCase.print || {}), plateId: null, plateNumber: null };
  workflowCase.history.push({ actorId, action: 'plate_removed', fromStatus: workflowCase.status, toStatus: workflowCase.status, note });
  await workflowCase.save();
};

// An archived product can still be printed, but only after the person confirms. Printing it resumes it.
const archivedPrompt = (res, cases, confirmed) => {
  const archived = cases.filter(item => item.archivedAt);
  if (!archived.length || confirmed === true) return false;
  const names = archived.map(item => item.requestedName);
  res.status(409).json({ message: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} archived. Do you still want to print ${names.length === 1 ? 'it' : 'them'}?`, archivedNames: names });
  return true;
};

const resumeArchived = (cases, actorId, note) => cases.filter(item => item.archivedAt).forEach(item => {
  item.archivedAt = null;
  item.history.push({ actorId, action: 'resumed', fromStatus: item.status, toStatus: item.status, note });
});

// A paused (blocked) product on a plate is shown to the person first. If they confirm, it is resumed and the plate goes on.
const pausedPrompt = (res, cases, confirmed) => {
  const paused = cases.filter(item => item.isBlocked);
  if (!paused.length || confirmed === true) return false;
  const names = paused.map(item => item.requestedName);
  res.status(409).json({ message: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} paused. Do you still want to send the plate to Quality?`, pausedNames: names });
  return true;
};

const resumePaused = (cases, actorId, note) => cases.filter(item => item.isBlocked).forEach(item => {
  item.isBlocked = false;
  item.blockedReason = '';
  item.blockedAt = null;
  item.history.push({ actorId, action: 'resumed', fromStatus: item.status, toStatus: item.status, note });
});

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
    width: orderItem?.width || '',
    clasp: orderItem?.clasp || '',
    quantity: workflowCase.quantity,
    orderNumber: order?.orderNumber || '',
    status: workflowCase.status,
    isBlocked: Boolean(workflowCase.isBlocked),
    archived: Boolean(workflowCase.archivedAt)
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
    if (!ownsPlate(req.user, plate)) fail('This plate belongs to another wax employee', 403);
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
        // A wax employee sees their own plates, and older plates nobody owns.
        if (user.workRole === 'wax_print') filter.ownerId = { $in: [mongoose.Types.ObjectId.isValid(user.id) ? user.id : null, null] };
      }
      // Products waiting to print that still point to a cancelled plate: open the plate again so they show on it.
      const waitingPlateIds = await WorkflowCase.distinct('print.plateId', { status: 'ready_to_print', 'print.plateId': { $ne: null } });
      if (waitingPlateIds.length) await Plate.updateMany({ _id: { $in: waitingPlateIds }, status: 'cancelled' }, { $set: { status: 'open' } });
      const plates = await Plate.find(filter).sort({ number: 1 });
      const views = await Promise.all(plates.map(async plate => ((await dropIfEmpty(plate, { grace: true })) ? null : listView(plate))));
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
        if (plate.productionMethod === 'wax' && !isPlateOwner(plate, workflowCase.assignedTo)) fail('This plate belongs to another wax employee. Choose one of your own plates.');
      } else if (req.body.toPlateId !== 'new') {
        const own = workflowCase.productionMethod === 'wax' && workflowCase.assignedTo ? { ownerId: workflowCase.assignedTo } : {};
        plate = await Plate.findOne({ productionMethod: workflowCase.productionMethod, status: 'open', ...own }).sort({ number: -1 });
      }
      if (!plate) plate = await createPlate({ productionMethod: workflowCase.productionMethod, actorId: req.user.id, ownerId: workflowCase.assignedTo || null });
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
        if (target.productionMethod === 'wax' && !isPlateOwner(target, workflowCase.assignedTo)) fail('That plate belongs to another wax employee');
      } else {
        target = await createPlate({ productionMethod: plate.productionMethod, actorId: req.user.id, ownerId: plate.ownerId || workflowCase.assignedTo || null });
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
      // Only a plate on the printer makes it busy. An old one-by-one print task, left from before plates, does not lock it.
      if (machine.currentPlateId) fail('This printer is already busy');
      const linked = await plateCases(plate);
      // Products already in another step are taken off by themselves; they never stop the plate.
      const hidden = linked.filter(item => item.status !== 'ready_to_print');
      const cases = linked.filter(item => !hidden.includes(item));
      const stale = cases.find(item => item.isBlocked);
      if (stale) fail(`${stale.requestedName} is blocked. Take it off the plate first.`);
      if (!cases.length) fail('Put at least one product on the plate first');
      if (archivedPrompt(res, cases, req.body.allowArchived)) return;
      resumeArchived(cases, req.user.id, `Printed on Plate ${plate.number} after confirmation`);
      await Promise.all(hidden.map(item => takeOffPlate({ workflowCase: item, actorId: req.user.id, note: `Taken off Plate ${plate.number} (no longer waiting to print)` })));
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
      machine.currentCaseId = null;
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
  // "Already printed" does the same for a plate that was never sent to a printer: its products are ready_to_print and no printer is released.
  const finishPlate = (plateStatus, caseStatus, noteText) => async (req, res) => {
    try {
      const plate = await loadPlate(req, plateStatus);
      const cases = await plateCases(plate, { status: caseStatus });
      if (plateStatus === 'open' && !cases.length) fail('This plate has no products to send');
      if (plateStatus === 'open') {
        if (archivedPrompt(res, cases, req.body.allowArchived)) return;
        resumeArchived(cases, req.user.id, `Plate ${plate.number} already printed, confirmed`);
      }
      if (plateStatus === 'printing') {
        if (archivedPrompt(res, cases, req.body.allowArchived)) return;
        resumeArchived(cases, req.user.id, `Plate ${plate.number} finished, confirmed`);
      }
      if (pausedPrompt(res, cases, req.body.allowPaused)) return;
      resumePaused(cases, req.user.id, `Plate ${plate.number} ${noteText}, confirmed`);
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
          actorId: req.user.id, action: 'status_changed', fromStatus: caseStatus, toStatus: 'quality_check',
          note: `Plate ${plate.number} ${noteText}`, queueMinutes, workMinutes
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
  };
  router.post('/plates/:id/finish', operationsAuth, finishPlate('printing', 'printing', 'finished'));
  router.post('/plates/:id/printed', operationsAuth, finishPlate('open', 'ready_to_print', 'already printed'));

  // Take the plate back off the printer: the printer is free again and the plate is open with the same products, ready to edit and send again.
  router.post('/plates/:id/unsend', operationsAuth, async (req, res) => {
    try {
      const plate = await loadPlate(req, 'printing');
      const cases = await plateCases(plate, { status: 'printing' });
      const now = new Date();
      const team = teamForStatus('ready_to_print', plate.productionMethod);
      const machineCode = plate.machineCode;
      const saves = [];
      for (const workflowCase of cases) {
        workflowCase.status = 'ready_to_print';
        workflowCase.assignedTeam = team;
        workflowCase.stageQueuedAt = now;
        workflowCase.targetMinutes = targetMinutesForTeam(team);
        workflowCase.startedAt = null;
        workflowCase.print = { machineId: '', sentAt: null, startedAt: null, completedAt: null, plateId: plate._id, plateNumber: plate.number };
        workflowCase.history.push({
          actorId: req.user.id, action: 'status_changed', fromStatus: 'printing', toStatus: 'ready_to_print',
          note: `Plate ${plate.number} taken back off ${machineCode || 'the printer'}`
        });
        saves.push(workflowCase.save());
      }
      plate.status = 'open';
      plate.machineCode = '';
      plate.sentAt = null;
      saves.push(plate.save());
      await Promise.all(saves);
      await releasePrinter({ plate: { _id: plate._id, number: plate.number, machineCode }, actorId: req.user.id, failed: false, reason: '' });
      res.json({ unsent: true, plate: { _id: plate._id, number: plate.number }, products: cases.length });
    } catch (error) {
      respond(res, error, 'take the plate back off the printer');
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
