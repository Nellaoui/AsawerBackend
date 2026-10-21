const { customerProgress } = require('../utils/customerProgress');

const order = (extra = {}) => ({ status: 'confirmed', fulfillmentState: 'in_progress', items: [{}, {}, {}], ...extra });
const task = (orderItemId: string, status: string, packed = false) => ({
  orderItemId, status, requestType: 'print_job', history: packed ? [{ fromStatus: 'packing' }] : []
});

describe('customerProgress', () => {
  it('stays confirmed before any product task exists', () => {
    expect(customerProgress(order(), []).stage).toBe('confirmed');
  });
  it('follows the least advanced product', () => {
    const cases = [task('a', 'printing'), task('b', 'quality_check'), task('c', 'packing')];
    expect(customerProgress(order(), cases)).toEqual({ stage: 'in_preparation', done: 0, total: 3 });
    expect(customerProgress(order(), cases.slice(1)).stage).toBe('quality_check');
  });
  it('counts finished products', () => {
    const cases = [task('a', 'completed', true), task('b', 'packing'), task('c', 'quality_check')];
    expect(customerProgress(order(), cases)).toEqual({ stage: 'quality_check', done: 1, total: 3 });
  });
  it('is ready when every product is packed', () => {
    const cases = [task('a', 'completed', true), task('b', 'completed', true), task('c', 'completed', true)];
    expect(customerProgress(order(), cases).stage).toBe('ready');
  });
  it('ignores cancelled tasks and handles cancelled and picked up orders', () => {
    expect(customerProgress(order(), [task('a', 'cancelled'), task('b', 'packing')]).stage).toBe('packing');
    expect(customerProgress(order({ status: 'cancelled' }), []).stage).toBe('cancelled');
    expect(customerProgress(order({ status: 'delivered' }), []).stage).toBe('picked_up');
    expect(customerProgress(order({ fulfillmentState: 'ready', pickedUpAt: new Date() }), []).stage).toBe('picked_up');
  });
  it('folds hidden sartla bracelets into their parent product', () => {
    const o = order({ items: [{ _id: 'p' }, { _id: 'b1', partOfItemId: 'p' }, { _id: 'b2', partOfItemId: 'p' }] });
    const cases = [task('p', 'completed', true), task('b1', 'completed', true), task('b2', 'packing')];
    expect(customerProgress(o, cases)).toEqual({ stage: 'packing', done: 0, total: 1 });
    expect(customerProgress(o, cases.map(c => ({ ...c, status: 'completed', history: [{ fromStatus: 'packing' }] }))).stage).toBe('ready');
  });
});
