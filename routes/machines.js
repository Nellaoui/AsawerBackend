const express = require('express');
const mongoose = require('mongoose');
const Machine = require('../models/Machine');
const { operationsAuth } = require('../middlewares/auth');
const { auditMachine, ensureDefaultMachines, findMachine } = require('../utils/machineRegistry');
const { observeMachineNetwork } = require('../utils/machineNetwork');

const router = express.Router();
const STATUS_VALUES = ['unknown', 'offline', 'available', 'busy', 'failed', 'maintenance'];

const isManager = user => Boolean(user?.isAdmin || user?.role === 'admin' || (user?.role === 'employee' && user?.workRole === 'boss'));
const canControl = (user, machine) => isManager(user) || user?.workRole === `${machine.productionMethod}_print`;
const cleanText = (value, max) => String(value || '').trim().slice(0, max);

// Called by the office connector. It is intentionally disabled until a secret is configured.
router.post('/:code/heartbeat', async (req, res) => {
  try {
    const configuredToken = process.env.MACHINE_CONNECTOR_TOKEN;
    const suppliedToken = req.header('X-Machine-Connector-Token');
    if (!configuredToken || suppliedToken !== configuredToken) return res.status(401).json({ message: 'Machine connector is not authorized' });
    const machine = await findMachine(req.params.code);
    if (!machine) return res.status(404).json({ message: 'Machine not found' });

    const reachable = Boolean(req.body.reachable);
    const previousNetworkStatus = observeMachineNetwork(machine, reachable);
    await machine.save();
    if (previousNetworkStatus !== machine.networkStatus) {
      await auditMachine({ action: 'machine_network_observed', machine, details: { previousNetworkStatus, networkStatus: machine.networkStatus, reachable } });
    }
    res.json(machine);
  } catch (error) {
    console.error('Machine heartbeat failed:', error);
    res.status(500).json({ message: 'Failed to record machine heartbeat' });
  }
});

router.use(operationsAuth);

router.get('/', async (req, res) => {
  try {
    const filter = { enabled: true };
    if (req.user?.workRole === 'wax_print') filter.productionMethod = 'wax';
    if (req.user?.workRole === 'resin_print') filter.productionMethod = 'resin';
    const machines = await Machine.find(filter)
      .populate('currentCaseId', 'requestedName status priority orderId productId assignedTo')
      .sort({ productionMethod: 1, code: 1 });
    res.json(machines);
  } catch (error) {
    console.error('Failed to list machines:', error);
    res.status(500).json({ message: 'Failed to load printers' });
  }
});

router.post('/bootstrap', async (req, res) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ message: 'Only the boss or an administrator can register printers' });
    await ensureDefaultMachines();
    res.json(await Machine.find({ enabled: true }).sort({ productionMethod: 1, code: 1 }));
  } catch (error) {
    console.error('Failed to register machines:', error);
    res.status(500).json({ message: 'Failed to register printers' });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid machine ID' });
    const machine = await Machine.findById(req.params.id);
    if (!machine) return res.status(404).json({ message: 'Machine not found' });
    if (!canControl(req.user, machine)) return res.status(403).json({ message: `Only ${machine.productionMethod} printing staff or the boss can update this printer` });
    const status = String(req.body.status || '');
    if (!STATUS_VALUES.includes(status) || status === 'busy') return res.status(400).json({ message: 'Choose Available, Failed, Maintenance, Offline or Unknown' });
    const reason = cleanText(req.body.reason, 1000);
    if (['failed', 'maintenance'].includes(status) && !reason) return res.status(400).json({ message: 'Add a reason for failed or maintenance status' });
    if (machine.currentCaseId && status === 'available') return res.status(409).json({ message: 'Complete or move the assigned print task before making this printer available' });

    const previousStatus = machine.status;
    const previousReason = machine.statusReason;
    machine.status = status;
    machine.statusReason = reason;
    machine.statusSource = 'manual';
    machine.lastStatusChangedAt = new Date();
    machine.updatedBy = req.user.id;
    await machine.save();
    await auditMachine({ action: 'machine_status_changed', actorId: req.user.id, machine, details: { previousStatus, status, previousReason, reason } });
    res.json(machine);
  } catch (error) {
    console.error('Failed to update machine:', error);
    res.status(500).json({ message: 'Failed to update printer status' });
  }
});

module.exports = router;
