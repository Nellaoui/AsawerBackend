const { TASK_VISIBILITY_CUTOFF, visibleTaskFilter, isVisibleWorkflowCase } = require('../utils/workflowVisibility');

describe('go-live task visibility', () => {
  test('keeps the historical task cutoff fixed and leaves stored records intact', () => {
    expect(TASK_VISIBILITY_CUTOFF.toISOString()).toBe('2026-09-18T21:47:31.000Z');
    const filter = visibleTaskFilter();
    expect(filter.createdAt.$gt).toBe(TASK_VISIBILITY_CUTOFF);
    expect(isVisibleWorkflowCase({ createdAt: new Date('2026-09-18T21:47:30.999Z') })).toBe(false);
    expect(isVisibleWorkflowCase({ createdAt: new Date('2026-09-18T21:47:31.001Z') })).toBe(true);
    expect(isVisibleWorkflowCase({})).toBe(false);
  });
});
