const { targetMinutesForTeam, teamForStatus, validateTransition } = require('../utils/workflowRules');

const makeCase = (overrides: Record<string, unknown> = {}) => ({
  status: 'needs_customer_info',
  requirements: 'Customer supplied the reference and exact measurements.',
  productionMethod: 'undecided',
  customerApproval: 'pending',
  modelVersions: [],
  ...overrides,
});

describe('order exception workflow rules', () => {
  test('routes each stage to the responsible employee queue', () => {
    expect(teamForStatus('stock_picking')).toBe('stock');
    expect(teamForStatus('needs_customer_info')).toBe('customer_service');
    expect(teamForStatus('modeling')).toBe('boss');
    expect(teamForStatus('ready_to_print', 'wax')).toBe('wax_print');
    expect(teamForStatus('printing', 'resin')).toBe('resin_print');
    expect(teamForStatus('quality_check')).toBe('quality');
    expect(teamForStatus('packing')).toBe('packing');
  });

  test('sets a practical expected duration for every employee team', () => {
    expect(targetMinutesForTeam('stock')).toBe(30);
    expect(targetMinutesForTeam('customer_service')).toBe(120);
    expect(targetMinutesForTeam('boss')).toBe(240);
    expect(targetMinutesForTeam('wax_print')).toBe(180);
    expect(targetMinutesForTeam('resin_print')).toBe(180);
    expect(targetMinutesForTeam('quality')).toBe(30);
    expect(targetMinutesForTeam('packing')).toBe(30);
  });

  test('does not send an empty request to the boss', () => {
    expect(validateTransition(makeCase({ requirements: '   ' }), 'boss_review')).toMatch(/requirements/i);
  });

  test('requires a model file and customer approval before file validation', () => {
    const waiting = makeCase({ status: 'modeling' });
    expect(validateTransition(waiting, 'file_validation')).toMatch(/3D model file/i);

    const withFile = makeCase({
      status: 'modeling',
      modelVersions: [{ fileUrl: 'https://files.example/model.stl', isPrintReady: false }],
  });
    expect(validateTransition(withFile, 'file_validation')).toMatch(/customer approval/i);
  });

  test('requires method, approved model, and approval before the print queue', () => {
    const base = makeCase({
      status: 'file_validation',
      customerApproval: 'approved',
      modelVersions: [{ fileUrl: 'https://files.example/model.stl', isPrintReady: true }],
    });
    expect(validateTransition(base, 'ready_to_print')).toMatch(/wax or resin/i);
    expect(validateTransition({ ...base, productionMethod: 'wax' }, 'ready_to_print')).toBeNull();
    });

  test('keeps failed quality work inside the same case for a reprint', () => {
    const qualityCase = makeCase({ status: 'quality_check', productionMethod: 'resin' });
    expect(validateTransition(qualityCase, 'ready_to_print')).toBeNull();
    expect(validateTransition(qualityCase, 'completed')).toBeNull();
  });
});
