const Machine = require('../models/Machine');
const AuditLog = require('../models/AuditLog');

const DEFAULT_MACHINES = [
  {
    code: 'WAX-FF-01', name: 'WaxJet 510 · 086', manufacturer: 'FlashForge', model: 'WaxJet510',
    serialNumber: 'W51E9300086', macAddress: '00:E0:4C:9A:22:F1', ipAddress: '192.168.1.103', productionMethod: 'wax',
    software: { firmware: '0.0.2.73.6-I', imageSlicer: '1.11.5', script: '0.0.2.73-6' }
  },
  {
    code: 'WAX-FF-02', name: 'W510 · 082', manufacturer: 'FlashForge', model: 'W510',
    serialNumber: 'W51E9300082', macAddress: '00:E0:4C:9A:17:1F', ipAddress: '192.168.1.227', productionMethod: 'wax',
    software: { firmware: '0.0.2.73.6-I', imageSlicer: '1.10.2', script: '0.0.2.72-4' }
  },
  {
    code: 'WAX-FF-03', name: 'WaxJet 510 · 075', manufacturer: 'FlashForge', model: 'WaxJet510',
    serialNumber: 'W51E9300075', macAddress: '00:E0:4C:9A:24:6B', ipAddress: '192.168.1.123', productionMethod: 'wax',
    software: { firmware: '0.0.2.73.6-I', imageSlicer: '1.11.5', script: '0.0.2.73-6' }
  },
  {
    code: 'WAX-3DS-01', name: 'ProJet MJP 2500W', manufacturer: '3D Systems', model: 'ProJet MJP 2500W',
    serialNumber: '3010F475311', macAddress: '00:04:5F:46:27:64', ipAddress: '192.168.1.62', productionMethod: 'wax',
    software: { release: '4.1.21', printJobManager: '1.9.11034', imageSlicer: '1.0.0.20240207A', printEngine: '02.09.32', ui: '3.075', connect3D: '1.0.38.0' }
  },
  {
    code: 'RESIN-RS-01', name: 'Rapid Shape S50+ · 766', manufacturer: 'Rapid Shape', model: 'S50+',
    serialNumber: '222R142766', macAddress: 'DC:2C:6E:21:D2:33', ipAddress: '192.168.1.28', productionMethod: 'resin',
    software: { lightEngine: '1.0.2', pc: '22.2.1', ioBoard: '1.0.0' }
  },
  {
    code: 'RESIN-RS-02', name: 'Rapid Shape S50+ · 774', manufacturer: 'Rapid Shape', model: 'S50+',
    serialNumber: '224R157774', macAddress: 'DC:2C:6E:21:D6:D2', ipAddress: '192.168.1.26', productionMethod: 'resin',
    software: { lightEngine: '1.0.2', pc: '22.2.1', ioBoard: '1.0.0' }
  }
];

const auditMachine = async ({ action, actorId = null, machine, details = {} }) => AuditLog.create({
  category: 'machine',
  action,
  actorId,
  entityType: 'machine',
  entityId: String(machine._id),
  details: { code: machine.code, serialNumber: machine.serialNumber, ...details }
});

const ensureDefaultMachines = async () => {
  for (const definition of DEFAULT_MACHINES) {
    const existing = await Machine.findOne({ $or: [{ code: definition.code }, { serialNumber: definition.serialNumber }] });
    if (existing) continue;
    const machine = await Machine.create(definition);
    await auditMachine({ action: 'machine_registered', machine, details: { ipAddress: machine.ipAddress, productionMethod: machine.productionMethod } });
  }
};

const findMachine = value => {
  const identifier = String(value || '').trim();
  if (!identifier) return null;
  return Machine.findOne({ $or: [{ code: identifier.toUpperCase() }, { serialNumber: identifier }] });
};

const assignMachineToCase = async ({ machine, workflowCase, actorId }) => {
  if (!machine || !workflowCase) throw new Error('Machine and print task are required');
  if (!machine.enabled) throw new Error('This printer is disabled');
  if (machine.productionMethod !== workflowCase.productionMethod) throw new Error(`Choose a ${workflowCase.productionMethod} printer for this task`);
  if (['offline', 'failed', 'maintenance'].includes(machine.status)) throw new Error(`This printer is ${machine.status}`);
  if (machine.currentCaseId && String(machine.currentCaseId) !== String(workflowCase._id)) throw new Error('This printer is already assigned to another task');

  const previousStatus = machine.status;
  machine.status = 'busy';
  machine.statusReason = '';
  machine.statusSource = 'manual';
  machine.currentCaseId = workflowCase._id;
  machine.lastStatusChangedAt = new Date();
  machine.updatedBy = actorId;
  await machine.save();
  await auditMachine({
    action: 'print_task_assigned', actorId, machine,
    details: { previousStatus, status: machine.status, workflowCaseId: String(workflowCase._id), orderId: workflowCase.orderId ? String(workflowCase.orderId) : null }
  });
};

const releaseMachineFromCase = async ({ machineCode, workflowCase, actorId, outcome = 'completed', reason = '' }) => {
  if (!machineCode) return null;
  const machine = await findMachine(machineCode);
  if (!machine || (machine.currentCaseId && String(machine.currentCaseId) !== String(workflowCase._id))) return machine;
  const previousStatus = machine.status;
  machine.status = outcome === 'failed' ? 'failed' : 'available';
  machine.statusReason = reason;
  machine.statusSource = 'manual';
  machine.currentCaseId = null;
  machine.lastStatusChangedAt = new Date();
  machine.updatedBy = actorId;
  await machine.save();
  await auditMachine({
    action: outcome === 'failed' ? 'machine_print_failed' : 'print_task_released', actorId, machine,
    details: { previousStatus, status: machine.status, workflowCaseId: String(workflowCase._id), outcome, reason }
  });
  return machine;
};

module.exports = {
  DEFAULT_MACHINES,
  assignMachineToCase,
  auditMachine,
  ensureDefaultMachines,
  findMachine,
  releaseMachineFromCase
};
