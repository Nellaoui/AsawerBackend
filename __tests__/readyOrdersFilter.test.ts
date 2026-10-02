export {};

const sift = require('sift').default || require('sift');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/workflow');

const listCases = (() => {
  const route = router.stack.find((layer: any) => layer.route?.path === '/cases' && layer.route.methods.get);
  return route.route.stack[route.route.stack.length - 1].handle;
})();

const createdAt = new Date('2026-10-01T10:00:00Z');
const task = (_id: string, requestType: string, status: string) => ({
  _id, orderId: 'order-1', requestType, requestedName: _id, productionMethod: 'wax', status,
  taskKind: 'order', archivedAt: null, createdAt, customer: { name: 'Client' }
});
const cases = [
  task('confirmation', 'order_validation', 'completed'),
  task('quality-done', 'print_required', 'completed'),
  task('printing', 'print_required', 'printing'),
  task('packed', 'pack_order', 'completed'),
  task('packing', 'pack_order', 'packing')
];

const findQuery = (rows: any[]) => {
  const chain: any = {};
  ['sort', 'skip', 'limit', 'populate', 'select', 'lean'].forEach(name => { chain[name] = jest.fn(() => chain); });
  chain.then = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject);
  return chain;
};
const list = async (stage: string) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await listCases({ query: { scope: 'all', stage }, user: { id: 'cs-id', role: 'employee', workRole: 'customer_service' } }, res);
  expect(res.status).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0].cases.map((item: any) => item._id);
};

describe('ready orders filter', () => {
  beforeEach(() => {
    jest.spyOn(WorkflowCase, 'find').mockImplementation((filter: any) => findQuery(cases.filter(sift(filter))));
    jest.spyOn(WorkflowCase, 'countDocuments').mockImplementation(async (filter: any) => cases.filter(sift(filter)).length);
  });
  afterEach(() => jest.restoreAllMocks());

  test('Ready orders shows only orders whose packing is finished', async () => {
    expect(await list('ready_orders')).toEqual(['packed']);
  });

  test('Finished tasks still lists every finished step', async () => {
    expect(await list('ready')).toEqual(['confirmation', 'quality-done', 'packed']);
  });
});
