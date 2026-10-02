const { targetMinutesForTeam, teamForStatus } = require('./workflowRules');
const { addStepMinutes, stepMinutes } = require('./workingTime');

// Expected time per workflow step, learned from how long finished steps really took.
// Each finished step records queueMinutes (arrival -> start) and workMinutes
// (start -> finish) in the case history, ending at the entry's createdAt. From that
// we rebuild the span from arriving at the step to leaving it (the span the "Late by"
// timer measures) and count it in shop working hours, without blocked periods.
// The average leaves out the slowest and fastest 10%, so one forgotten task does
// not move it. A product with enough finished steps gets its own average.
const SAMPLE_SIZE = 50;
const MIN_SAMPLES = 5;
const TRIM_SHARE = 0.1;
const LOOKBACK_DAYS = 90;
const MAX_CASES = 5000;
const REFRESH_MS = 15 * 60 * 1000;
const MAX_MINUTES = 43200;
const PRINT_STAGES = new Set(['ready_to_print', 'printing']);
// History actions that mean a step was finished. task_started also carries
// queueMinutes but the step is still running; boss and admin moves are corrections.
const FINISH_ACTIONS = new Set(['status_changed', 'stock_missing', 'order_validated', 'production_rerouted', 'product_created']);

let learned = {};
let refreshInterval = null;

const stepKey = (status, productionMethod) => (PRINT_STAGES.has(status)
  ? `${status}:${productionMethod || 'undecided'}`
  : String(status || ''));
const productStepKey = (status, productionMethod, productId) => `${stepKey(status, productionMethod)}|${productId}`;
const idOf = value => (value && typeof value === 'object' && value._id ? String(value._id) : value ? String(value) : '');

const averageMinutes = (durations) => {
  const values = durations.map(Number).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (values.length < MIN_SAMPLES) return null;
  const trim = Math.max(1, Math.round(values.length * TRIM_SHARE));
  const kept = values.slice(trim, values.length - trim);
  const average = kept.reduce((sum, value) => sum + value, 0) / kept.length;
  return Math.min(Math.max(Math.round(average), 1), MAX_MINUTES);
};

const setStepSamples = (groups) => {
  const next = {};
  for (const group of groups) {
    const durations = (group.durations || []).slice(0, SAMPLE_SIZE);
    const minutes = averageMinutes(durations);
    if (minutes === null) continue;
    const key = group.productId
      ? productStepKey(group.status, group.productionMethod, group.productId)
      : stepKey(group.status, group.productionMethod);
    next[key] = { minutes, samples: durations.length };
  }
  learned = next;
  return learned;
};

const stepTimesSnapshot = () => ({ ...learned });

const expectedMinutes = (workflowCase) => {
  const productId = idOf(workflowCase.productId);
  const average = (productId && learned[productStepKey(workflowCase.status, workflowCase.productionMethod, productId)])
    || learned[stepKey(workflowCase.status, workflowCase.productionMethod)];
  if (average) return average.minutes;
  return Number(workflowCase.targetMinutes)
    || targetMinutesForTeam(workflowCase.assignedTeam || teamForStatus(workflowCase.status, workflowCase.productionMethod));
};

const effectiveDeadline = (workflowCase) => {
  if (workflowCase.deadlineAt) return new Date(workflowCase.deadlineAt);
  const timerStartedAt = workflowCase.assignedAt || workflowCase.stageQueuedAt || workflowCase.createdAt;
  if (!timerStartedAt) return null;
  return addStepMinutes(workflowCase.status, timerStartedAt, expectedMinutes(workflowCase));
};

// Step time past the deadline, in the same working hours the deadline uses.
const lateMinutes = (workflowCase, deadline, now = new Date()) => stepMinutes(workflowCase.status, deadline, now) || 0;

const timeOf = value => new Date(value).getTime();

// Blocked stretches of a case: from "blocked" until "resumed" or the step ends.
const blockedPeriods = (history) => {
  const periods = [];
  let blockedAt = null;
  for (const entry of history) {
    if (entry.action === 'task_blocked') {
      if (!blockedAt) blockedAt = entry.createdAt;
    } else if (blockedAt && (entry.action === 'task_resumed' || (entry.fromStatus && entry.action !== 'task_started'))) {
      periods.push({ start: blockedAt, end: entry.createdAt });
      blockedAt = null;
    }
  }
  if (blockedAt) periods.push({ start: blockedAt, end: null });
  return periods;
};

// One sample per finished step of a case: { status, productionMethod, productId, minutes, finishedAt }.
const stepSamplesFromCase = (workflowCase) => {
  const history = (workflowCase.history || [])
    .filter(entry => entry && entry.createdAt && Number.isFinite(timeOf(entry.createdAt)))
    .sort((left, right) => timeOf(left.createdAt) - timeOf(right.createdAt));
  const blocked = blockedPeriods(history);
  const samples = [];
  for (const entry of history) {
    if (!FINISH_ACTIONS.has(entry.action) || !entry.fromStatus) continue;
    const queue = Number(entry.queueMinutes);
    if (entry.queueMinutes === null || entry.queueMinutes === undefined || !Number.isFinite(queue) || queue < 0) continue;
    const work = Math.max(Number(entry.workMinutes) || 0, 0);
    const finishedAt = timeOf(entry.createdAt);
    const arrivedAt = finishedAt - (queue + work) * 60000;
    const minutes = stepMinutes(entry.fromStatus, arrivedAt, finishedAt, blocked);
    // A step that took time but none of it in working hours says nothing about the step.
    if (minutes === null || (minutes === 0 && queue + work > 0)) continue;
    samples.push({
      status: entry.fromStatus,
      productionMethod: PRINT_STAGES.has(entry.fromStatus) ? (workflowCase.productionMethod || null) : null,
      productId: idOf(workflowCase.productId) || null,
      minutes,
      finishedAt
    });
  }
  return samples;
};

const groupSamples = (samples, since = 0) => {
  const groups = new Map();
  const add = (key, group, sample) => {
    if (!groups.has(key)) groups.set(key, { ...group, entries: [] });
    groups.get(key).entries.push(sample);
  };
  for (const sample of samples) {
    if (sample.finishedAt < since) continue;
    add(stepKey(sample.status, sample.productionMethod), { status: sample.status, productionMethod: sample.productionMethod }, sample);
    if (sample.productId) {
      add(productStepKey(sample.status, sample.productionMethod, sample.productId),
        { status: sample.status, productionMethod: sample.productionMethod, productId: sample.productId }, sample);
    }
  }
  return [...groups.values()].map(({ entries, ...group }) => ({
    ...group,
    durations: entries.sort((left, right) => right.finishedAt - left.finishedAt).slice(0, SAMPLE_SIZE).map(entry => entry.minutes)
  }));
};

const refreshStepTimes = async () => {
  const WorkflowCase = require('../models/WorkflowCase');
  const { visibleTaskFilter } = require('./workflowVisibility');
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const cases = await WorkflowCase.find({
    ...visibleTaskFilter(),
    status: { $ne: 'cancelled' },
    'history.createdAt': { $gte: since }
  })
    .sort({ updatedAt: -1 })
    .limit(MAX_CASES)
    .select('productId productionMethod history.action history.fromStatus history.queueMinutes history.workMinutes history.createdAt')
    .lean();
  return setStepSamples(groupSamples(cases.flatMap(stepSamplesFromCase), since.getTime()));
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
  groupSamples,
  lateMinutes,
  refreshStepTimes,
  setStepSamples,
  startStepTimeTracker,
  stepKey,
  stepSamplesFromCase,
  stepTimesSnapshot
};
