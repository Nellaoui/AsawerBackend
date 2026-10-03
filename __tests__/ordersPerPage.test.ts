export {};

const sift = require('sift').default || require('sift');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/workflow');

const listCases = (() => {
  const route = router.stack.find((layer: any) => layer.route?.path === '/cases' && layer.route.methods.get);
  return route.route.stack[route.route.stack.length - 1].handle;
})();

const createdAt = new Date('2026-10-01T10:00:00Z');
const task = (_id: string, orderId: string | null) => ({
  _id, orderId, requestType: 'print_required', requestedName: _id, productionMethod: 'wax', status: 'printing',
  taskKind: 'order', archivedAt: null, createdAt, customer: { name: 'Client' }
});
// Order A has many products; orders B and C have one each; one task has no order.
const cases = [
  ...Array.from({ length: 5 }, (_, index) => task(`a${index}`, 'order-a')),
  task('b0', 'order-b'),
  task('c0', 'order-c'),
  task('extra', null)
];

const findQuery = (rows: any[]) => {
  const chain: any = {};
  ['sort', 'skip', 'limit', 'populate', 'select', 'lean'].forEach(name => { chain[name] = jest.fn(() => chain); });
  chain.then = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject);
  return chain;
};
const list = async (page: number, limit: number) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await listCases({ query: { scope: 'all', active: 'true', page: String(page), limit: String(limit) }, user: { id: 'boss-id', role: 'admin', isAdmin: true } }, res);
  expect(res.status).not.toHaveBeenCalled();
  const body = res.json.mock.calls[0][0];
  return { ids: body.cases.map((item: any) => item._id), pagination: body.pagination };
};

describe('All orders pages hold whole orders', () => {
  beforeEach(() => {
    jest.spyOn(WorkflowCase, 'find').mockImplementation((filter: any) => findQuery(cases.filter(sift(filter))));
  });
  afterEach(() => jest.restoreAllMocks());

  test('a big order does not push other orders off the page', async () => {
    const { ids, pagination } = await list(1, 3);
    expect(ids).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'b0', 'c0']);
    expect(pagination).toMatchObject({ total: 8, orders: 4, pages: 2 });
  });

  test('the next page starts at the next order', async () => {
    expect((await list(2, 3)).ids).toEqual(['extra']);
  });
});
