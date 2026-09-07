const CASE_TYPES = [
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

module.exports = {
  ALLOWED_TRANSITIONS,
  CASE_STATUSES,
  CASE_TYPES,
  PRODUCTION_METHODS,
  TEAM_TARGET_MINUTES,
  latestModelVersion,
  targetMinutesForTeam,
  teamForStatus,
  validateTransition
};
