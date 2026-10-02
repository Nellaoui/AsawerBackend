const { effectiveDeadline, expectedMinutes, groupSamples, setStepSamples, stepKey, stepSamplesFromCase } = require('../utils/stepTimes');
const { addStepMinutes, stepMinutes } = require('../utils/workingTime');

describe('learned step times', () => {
  afterEach(() => setStepSamples([]));

  test('keeps the fixed target until a step has enough finished samples', () => {
    setStepSamples([{ status: 'stock_picking', durations: [10, 20, 30, 40] }]);
    expect(expectedMinutes({ status: 'stock_picking', assignedTeam: 'stock', targetMinutes: 30 })).toBe(30);
  });

  test('uses a fair average that leaves out the slowest and fastest steps', () => {
    setStepSamples([{ status: 'stock_picking', durations: [10, 20, 30, 40, 50, 60] }]);
    expect(expectedMinutes({ status: 'stock_picking', assignedTeam: 'stock', targetMinutes: 30 })).toBe(35);
    setStepSamples([{ status: 'stock_picking', durations: [60, 60, 60, 60, 60, 1] }]);
    expect(expectedMinutes({ status: 'stock_picking', targetMinutes: 30 })).toBe(60);
    // One forgotten 75h quality check does not move the average.
    setStepSamples([{ status: 'quality_check', durations: [20, 25, 30, 35, 40, 4527] }]);
    expect(expectedMinutes({ status: 'quality_check', targetMinutes: 30 })).toBe(33);
  });

  test('a product with enough finished steps gets its own average', () => {
    setStepSamples([
      { status: 'printing', productionMethod: 'wax', durations: [100, 100, 100, 100, 100] },
      { status: 'printing', productionMethod: 'wax', productId: 'big', durations: [300, 300, 300, 300, 300] }
    ]);
    expect(expectedMinutes({ status: 'printing', productionMethod: 'wax', productId: 'big' })).toBe(300);
    expect(expectedMinutes({ status: 'printing', productionMethod: 'wax', productId: { _id: 'big' } })).toBe(300);
    expect(expectedMinutes({ status: 'printing', productionMethod: 'wax', productId: 'small' })).toBe(100);
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
    // Monday 09:00 in Casablanca (UTC+1).
    const arrived = new Date('2026-09-28T08:00:00Z');
    expect(effectiveDeadline({ status: 'packing', stageQueuedAt: arrived, targetMinutes: 30 }).toISOString()).toBe('2026-09-28T09:30:00.000Z');
    // Arriving at 18:30 leaves 30 minutes today; the other hour runs Tuesday from 09:00.
    expect(effectiveDeadline({ status: 'packing', stageQueuedAt: new Date('2026-09-28T17:30:00Z') }).toISOString()).toBe('2026-09-29T09:00:00.000Z');
    expect(effectiveDeadline({ status: 'packing', stageQueuedAt: arrived, deadlineAt: '2026-10-01T00:00:00Z' }).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  test('builds samples from finished steps only, in working hours, without blocked time', () => {
    const quality = {
      productId: 'p1',
      productionMethod: 'wax',
      history: [
        // Started Monday 10:00 (Casablanca), still running: not a sample.
        { action: 'task_started', fromStatus: 'quality_check', queueMinutes: 60, createdAt: '2026-09-28T09:00:00Z' },
        { action: 'task_blocked', createdAt: '2026-09-28T10:00:00Z' },
        { action: 'task_resumed', createdAt: '2026-09-28T11:00:00Z' },
        // Finished Tuesday 10:00: 1h waiting + 24h on the clock, but only 11h open, minus 1h blocked.
        { action: 'status_changed', fromStatus: 'quality_check', toStatus: 'packing', queueMinutes: 60, workMinutes: 1440, createdAt: '2026-09-29T09:00:00Z' },
        // Boss corrections are not samples.
        { action: 'admin_stage_changed', fromStatus: 'packing', toStatus: 'quality_check', queueMinutes: 5, workMinutes: 0, createdAt: '2026-09-29T09:05:00Z' }
      ]
    };
    const samples = stepSamplesFromCase(quality);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ status: 'quality_check', productionMethod: null, productId: 'p1', minutes: 600 });
  });

  test('printing keeps the full clock because machines run at night', () => {
    const samples = stepSamplesFromCase({
      productionMethod: 'resin',
      history: [{ action: 'status_changed', fromStatus: 'printing', toStatus: 'quality_check', queueMinutes: 0, workMinutes: 720, createdAt: '2026-09-29T07:00:00Z' }]
    });
    expect(samples[0]).toMatchObject({ status: 'printing', productionMethod: 'resin', minutes: 720 });
  });

  test('groups samples per step and per product, newest first', () => {
    const samples = [1, 2, 3, 4, 5].map(day => ({ status: 'packing', productionMethod: null, productId: 'p1', minutes: day * 10, finishedAt: day }));
    const groups = groupSamples(samples);
    expect(groups).toEqual(expect.arrayContaining([
      { status: 'packing', productionMethod: null, durations: [50, 40, 30, 20, 10] },
      { status: 'packing', productionMethod: null, productId: 'p1', durations: [50, 40, 30, 20, 10] }
    ]));
  });
});

describe('shop working hours', () => {
  test('nights and Sundays do not count for people steps', () => {
    // Saturday 18:00 -> Monday 10:00 in Casablanca: 1h Saturday + 1h Monday.
    expect(stepMinutes('quality_check', '2026-09-26T17:00:00Z', '2026-09-28T09:00:00Z')).toBe(120);
    expect(stepMinutes('printing', '2026-09-26T17:00:00Z', '2026-09-28T09:00:00Z')).toBe(40 * 60);
  });

  test('adding time skips closed hours', () => {
    // Saturday 18:30 + 60 working minutes -> Monday 09:30.
    expect(addStepMinutes('packing', '2026-09-26T17:30:00Z', 60).toISOString()).toBe('2026-09-28T08:30:00.000Z');
    expect(addStepMinutes('printing', '2026-09-26T17:30:00Z', 60).toISOString()).toBe('2026-09-26T18:30:00.000Z');
  });
});
