const CASE_TYPES = [
  'order_validation',
  'general_task',
  'stock_pick',
  'pack_order',
  'print_required',
  'product_missing',
  'model_file_missing',
  'dimensions_missing',
  'customization',
  'damaged_item'
];

const CASE_STATUSES = [
  'awaiting_validation',
  'task_ready',
  'stock_picking',
  'needs_customer_info',
  'boss_review',
  'waiting_customer_approval',
  'modeling',
  'file_validation',
  'ready_to_print',
  'printing',
  'quality_check',
  'packing',
  'completed',
  'rejected',
  'cancelled'
];

const PRODUCTION_METHODS = ['undecided', 'wax', 'resin'];
const REPRINT_PART_CODES = 'ABCDEFGHIJ'.split('');

const normalizeReprintParts = (parts) => {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > REPRINT_PART_CODES.length) {
    throw new Error('Choose at least one part from A to J for the reprint');
  }
  const seen = new Set();
  return parts.map(part => {
    const code = String(part?.code || '').trim().toUpperCase();
    const quantity = part?.quantity;
    if (!REPRINT_PART_CODES.includes(code) || seen.has(code)) throw new Error('Each reprint part must have a unique code from A to J');
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000) {
      throw new Error('Each reprint part needs a positive whole-number quantity');
    }
    seen.add(code);
    return { code, quantity };
  });
};

const TEAM_TARGET_MINUTES = {
  stock: 30,
  customer_service: 120,
  boss: 240,
  wax_print: 180,
  resin_print: 180,
  quality: 30,
  packing: 30,
  none: 120
};

const targetMinutesForTeam = (team) => TEAM_TARGET_MINUTES[team] || TEAM_TARGET_MINUTES.none;

const ALLOWED_TRANSITIONS = {
  // This gate can only be completed by the dedicated order validation endpoint.
  awaiting_validation: [],
  task_ready: ['completed', 'cancelled'],
  stock_picking: ['completed', 'cancelled'],
  needs_customer_info: ['boss_review', 'cancelled'],
  boss_review: ['needs_customer_info', 'modeling', 'waiting_customer_approval', 'file_validation', 'rejected', 'cancelled'],
  waiting_customer_approval: ['needs_customer_info', 'modeling', 'file_validation', 'rejected', 'cancelled'],
  modeling: ['needs_customer_info', 'waiting_customer_approval', 'file_validation', 'rejected', 'cancelled'],
  file_validation: ['needs_customer_info', 'modeling', 'ready_to_print', 'rejected', 'cancelled'],
  ready_to_print: ['printing', 'modeling', 'cancelled'],
  printing: ['quality_check', 'ready_to_print', 'cancelled'],
  quality_check: ['completed', 'ready_to_print', 'modeling', 'cancelled'],
  packing: ['completed', 'cancelled'],
  completed: [],
  rejected: [],
  cancelled: []
};

const teamForStatus = (status, productionMethod = 'undecided') => {
  if (status === 'awaiting_validation') return 'customer_service';
  if (status === 'stock_picking') return 'stock';
  if (['needs_customer_info', 'waiting_customer_approval'].includes(status)) return 'customer_service';
  if (['boss_review', 'modeling', 'file_validation'].includes(status)) return 'boss';
  if (['ready_to_print', 'printing'].includes(status)) {
    if (productionMethod === 'wax') return 'wax_print';
    if (productionMethod === 'resin') return 'resin_print';
    return 'boss';
  }
  if (status === 'quality_check') return 'quality';
  if (status === 'packing') return 'packing';
  return 'none';
};

const latestModelVersion = (workflowCase) => {
  const versions = workflowCase.modelVersions || [];
  return versions.length ? versions[versions.length - 1] : null;
};

const validateTransition = (workflowCase, nextStatus) => {
  if (!CASE_STATUSES.includes(nextStatus)) return 'Unknown workflow status';
  if (workflowCase.status === nextStatus) return null;

  const allowed = ALLOWED_TRANSITIONS[workflowCase.status] || [];
  if (!allowed.includes(nextStatus)) {
    return `Case cannot move from ${workflowCase.status} to ${nextStatus}`;
  }

  if (nextStatus === 'boss_review' && !String(workflowCase.requirements || '').trim()) {
    return 'Customer requirements must be recorded before sending the case to the boss';
  }

  if (nextStatus === 'file_validation') {
    if (!latestModelVersion(workflowCase)?.fileUrl) return 'A 3D model file is required before validation';
    if (workflowCase.customerApproval === 'pending') return 'Customer approval is required before file validation';
    if (workflowCase.customerApproval === 'rejected') return 'The customer rejected this design or quote';
  }

  if (nextStatus === 'ready_to_print') {
    if (!['wax', 'resin'].includes(workflowCase.productionMethod)) return 'Choose wax or resin before printing';
    const isReprint = ['printing', 'quality_check'].includes(workflowCase.status);
    if (!isReprint && !latestModelVersion(workflowCase)?.isPrintReady) return 'The latest 3D model version must be marked print ready';
    if (!isReprint && !['approved', 'not_required'].includes(workflowCase.customerApproval)) return 'Customer approval is required before printing';
  }

  return null;
};

// The steps each kind of task goes through, in order. Statuses in one inner
// list belong to the same step. A boss or admin may send a task back to any
// earlier step, but forward only to the very next one, so no order reaches
// Ready without its stock check, printing, quality check and packing.
const STEP_ORDER = {
  order_validation: [['awaiting_validation'], ['completed']],
  stock_pick: [['stock_picking'], ['completed']],
  pack_order: [['packing'], ['completed']],
  extra: [['task_ready'], ['completed']],
  production: [
    ['needs_customer_info', 'boss_review', 'waiting_customer_approval', 'modeling', 'file_validation'],
    ['ready_to_print'],
    ['printing'],
    ['quality_check'],
    ['completed']
  ]
};
const STEP_NAMES = {
  ready_to_print: 'Printing',
  printing: 'Printing',
  quality_check: 'Quality',
  packing: 'Packing',
  stock_picking: 'Stock check'
};

const stepsFor = (workflowCase) => {
  if (STEP_ORDER[workflowCase.requestType]) return STEP_ORDER[workflowCase.requestType];
  if (workflowCase.status === 'task_ready') return STEP_ORDER.extra;
  return STEP_ORDER.production;
};

// Why moving this task to nextStatus would skip a step, or null when it does not.
const skippedStepError = (workflowCase, nextStatus) => {
  if (['cancelled', 'rejected'].includes(nextStatus)) return null;
  if (nextStatus === 'packing' && workflowCase.requestType !== 'pack_order') {
    return 'Only the packing task goes on Packing. It opens by itself when every product of the order is done';
  }
  const steps = stepsFor(workflowCase);
  const stepOf = status => steps.findIndex(step => step.includes(status));
  const current = stepOf(workflowCase.status);
  const next = stepOf(nextStatus);
  if (current < 0 || next < 0 || next <= current + 1) return null;
  const missed = steps[current + 1][0];
  return `This would skip ${STEP_NAMES[missed] || 'a step'}. Move the task one step at a time`;
};

module.exports = {
  ALLOWED_TRANSITIONS,
  CASE_STATUSES,
  CASE_TYPES,
  PRODUCTION_METHODS,
  REPRINT_PART_CODES,
  normalizeReprintParts,
  skippedStepError,
  TEAM_TARGET_MINUTES,
  latestModelVersion,
  targetMinutesForTeam,
  teamForStatus,
  validateTransition
};
