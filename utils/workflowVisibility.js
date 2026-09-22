// One-time go-live cutoff. Historical workflow cases stay in MongoDB for audit
// and recovery, but are omitted from active portal views and notifications.
const TASK_VISIBILITY_CUTOFF = new Date('2026-09-18T21:47:31.000Z');
const visibleTaskFilter = () => ({ createdAt: { $gt: TASK_VISIBILITY_CUTOFF } });
const isVisibleWorkflowCase = workflowCase =>
  Boolean(workflowCase?.createdAt && new Date(workflowCase.createdAt) > TASK_VISIBILITY_CUTOFF);

module.exports = { TASK_VISIBILITY_CUTOFF, visibleTaskFilter, isVisibleWorkflowCase };
