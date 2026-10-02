export {};

const sift = require('sift').default || require('sift');
const Order = require('../models/Order');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/workflow');

const listCases = (() => {
  const route = router.stack.find((layer: any) => layer.route?.path === '/cases' && layer.route.methods.get);
  return route.route.stack[route.route.stack.length - 1].handle;
})();

const createdAt = new Date('2026-10-01T10:00:00Z');
const orders = [
  { _id: 'wax-order', items: [{ productionMethod: 'wax' }, { productionMethod: 'wax' }] },
  { _id: 'resin-order', items: [{ productionMethod: 'resin' }] },
  { _id: 'mixed-order', items: [{ productionMethod: 'wax' }, { productionMethod: 'resin' }] }
];
const pack = (orderId: string) => ({
  _id: 'pack-' + orderId, orderId, requestType: 'pack_order', requestedName: 'Pack ' + orderId,
  productionMethod: 'undecided', status: 'packing', taskKind: 'order', archivedAt: null, createdAt,
  customer: { name: 'Client' }
});
const cases = [
  pack('wax-order'),
  pack('resin-order'),
  pack('mixed-order'),
  { _id: 'quality-wax', requestType: 'print_required', requestedName: 'Ring', productionMethod: 'wax', status: 'quality_check', taskKind: 'order', archivedAt: null, createdAt, customer: { name: 'Client' } }
];

const findQuery = (rows: any[]) => {
  const chain: any = {};
  ['sort', 'skip', 'limit', 'populate', 'select', 'lean'].forEach(name => { chain[name] = jest.fn(() => chain); });
  chain.then = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject);
  chain.distinct = jest.fn(async (field: string) => rows.map(row => row[field]));
  return chain;
};
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const boss = { id: 'boss-id', role: 'admin', isAdmin: true };

const list = async (query: any) => {
  const res = response();
  await listCases({ query: { scope: 'all', active: 'true', ...query }, user: boss }, res);
  expect(res.status).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0].cases.map((item: any) => item._id);
};

describe('print method filter', () => {
  beforeEach(() => {
    jest.spyOn(WorkflowCase, 'find').mockImplementation((filter: any) => findQuery(cases.filter(sift(filter))));
    jest.spyOn(WorkflowCase, 'countDocuments').mockImplementation(async (filter: any) => cases.filter(sift(filter)).length);
    jest.spyOn(Order, 'find').mockImplementation((filter: any) => findQuery(orders.filter(sift(filter))));
  });

  afterEach(() => jest.restoreAllMocks());

  test('Wax only shows packing for orders made only in wax', async () => {
    expect(await list({ stage: 'packing', method: 'wax' })).toEqual(['pack-wax-order']);
  });

  test('Resin only shows packing for orders made only in resin', async () => {
    expect(await list({ stage: 'packing', method: 'resin' })).toEqual(['pack-resin-order']);
  });

  test('Wax and resin shows every packing task', async () => {
    expect(await list({ stage: 'packing' })).toEqual(['pack-wax-order', 'pack-resin-order', 'pack-mixed-order']);
  });

  test('product tasks still match on their own method', async () => {
    expect(await list({ stage: 'quality', method: 'wax' })).toEqual(['quality-wax']);
    expect(await list({ stage: 'quality', method: 'resin' })).toEqual([]);
  });
});
