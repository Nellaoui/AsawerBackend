const { targetMinutesForTeam, teamForStatus } = require('./workflowRules');

// Expected time per workflow step, learned from how long finished steps really took.
// Each finished step already records queueMinutes (arrival -> start) and workMinutes
// (start -> finish) in the case history; their sum is the time from arriving at the
// step to leaving it, which is the same span the "Late by" timer measures.
const SAMPLE_SIZE = 50;
const MIN_SAMPLES = 5;
const LOOKBACK_DAYS = 90;
const REFRESH_MS = 15 * 60 * 1000;
const MAX_MINUTES = 43200;
const PRINT_STAGES = new Set(['ready_to_print', 'printing']);

let learned = {};
let refreshInterval = null;

const stepKey = (status, productionMethod) => (PRINT_STAGES.has(status)
  ? `${status}:${productionMethod || 'undecided'}`
  : String(status || ''));

const averageMinutes = (durations) => {
  const values = durations.map(Number).filter(value => Number.isFinite(value) && value >= 0);
  if (values.length < MIN_SAMPLES) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.min(Math.max(Math.round(average), 1), MAX_MINUTES);
};

const setStepSamples = (groups) => {
  const next = {};
  for (const group of groups) {
    const durations = (group.durations || []).slice(0, SAMPLE_SIZE);
    const minutes = averageMinutes(durations);
    if (minutes !== null) next[stepKey(group.status, group.productionMethod)] = { minutes, samples: durations.length };
  }
  learned = next;
  return learned;
};

const stepTimesSnapshot = () => ({ ...learned });

const expectedMinutes = (workflowCase) => {
  const average = learned[stepKey(workflowCase.status, workflowCase.productionMethod)];
  if (average) return average.minutes;
  return Number(workflowCase.targetMinutes)
    || targetMinutesForTeam(workflowCase.assignedTeam || teamForStatus(workflowCase.status, workflowCase.productionMethod));
};

const effectiveDeadline = (workflowCase) => {
  if (workflowCase.deadlineAt) return new Date(workflowCase.deadlineAt);
  const timerStartedAt = workflowCase.assignedAt || workflowCase.stageQueuedAt || workflowCase.createdAt;
  if (!timerStartedAt) return null;
  return new Date(new Date(timerStartedAt).getTime() + expectedMinutes(workflowCase) * 60000);
};

const refreshStepTimes = async () => {
  const WorkflowCase = require('../models/WorkflowCase');
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const groups = await WorkflowCase.aggregate([
    { $match: { 'history.createdAt': { $gte: since } } },
    { $project: { productionMethod: 1, history: 1 } },
    { $unwind: '$history' },
    { $match: {
      'history.createdAt': { $gte: since },
      'history.fromStatus': { $nin: [null, ''] },
      'history.queueMinutes': { $gte: 0 }
    } },
    { $sort: { 'history.createdAt': -1 } },
    { $group: {
      _id: {
        status: '$history.fromStatus',
        productionMethod: { $cond: [{ $in: ['$history.fromStatus', [...PRINT_STAGES]] }, '$productionMethod', null] }
      },
      durations: { $push: { $add: ['$history.queueMinutes', { $ifNull: ['$history.workMinutes', 0] }] } }
    } },
    { $project: { _id: 0, status: '$_id.status', productionMethod: '$_id.productionMethod', durations: { $slice: ['$durations', SAMPLE_SIZE] } } }
  ]);
  return setStepSamples(groups);
};

const startStepTimeTracker = () => {
  if (refreshInterval) return;
  const run = () => refreshStepTimes().catch(error => console.error('Step time refresh failed:', error));
  run();
  refreshInterval = setInterval(run, REFRESH_MS);
  refreshInterval.unref?.();
};

module.exports = {
  MIN_SAMPLES,
  SAMPLE_SIZE,
  effectiveDeadline,
  expectedMinutes,
  refreshStepTimes,
  setStepSamples,
  startStepTimeTracker,
  stepKey,
  stepTimesSnapshot
};
