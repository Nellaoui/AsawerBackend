const { effectiveDeadline, expectedMinutes, setStepSamples, stepKey } = require('../utils/stepTimes');

describe('learned step times', () => {
  afterEach(() => setStepSamples([]));

  test('keeps the fixed target until a step has enough finished samples', () => {
    setStepSamples([{ status: 'stock_picking', durations: [10, 20, 30, 40] }]);
    expect(expectedMinutes({ status: 'stock_picking', assignedTeam: 'stock', targetMinutes: 30 })).toBe(30);
  });

  test('uses the average of the most recent finished steps', () => {
    setStepSamples([{ status: 'stock_picking', durations: [10, 20, 30, 40, 50, 60] }]);
    expect(expectedMinutes({ status: 'stock_picking', assignedTeam: 'stock', targetMinutes: 30 })).toBe(35);
    setStepSamples([{ status: 'stock_picking', durations: [60, 60, 60, 60, 60, 1] }]);
    expect(expectedMinutes({ status: 'stock_picking', targetMinutes: 30 })).toBe(50);
  });

  test('keeps wax and resin printing apart', () => {
    setStepSamples([
      { status: 'printing', productionMethod: 'wax', durations: [100, 100, 100, 100, 100] },
      { status: 'printing', productionMethod: 'resin', durations: [400, 400, 400, 400, 400] }
    ]);
    expect(stepKey('printing', 'wax')).toBe('printing:wax');
    expect(expectedMinutes({ status: 'printing', productionMethod: 'wax', targetMinutes: 180 })).toBe(100);
    expect(expectedMinutes({ status: 'printing', productionMethod: 'resin', targetMinutes: 180 })).toBe(400);
  });

  test('times the deadline from arrival with the learned average, and a typed deadline wins', () => {
    setStepSamples([{ status: 'packing', durations: [90, 90, 90, 90, 90] }]);
    const arrived = new Date('2026-09-28T08:00:00Z');
    expect(effectiveDeadline({ status: 'packing', stageQueuedAt: arrived, targetMinutes: 30 }).toISOString()).toBe('2026-09-28T09:30:00.000Z');
    expect(effectiveDeadline({ status: 'packing', stageQueuedAt: arrived, deadlineAt: '2026-10-01T00:00:00Z' }).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});
