export {};

const sift = require('sift').default || require('sift');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/workflow');

const listCases = (() => {
  const route = router.stack.find((layer: any) => layer.route?.path === '/cases' && layer.route.methods.get);
  return route.route.stack[route.route.stack.length - 1].handle;
})();

const oid = (n: number) => String(n).padStart(24, '0');
const old = new Date('2026-10-01T10:00:00Z');
const fresh = new Date('2026-10-24T10:00:00Z');
const task = (n: number, orderId: string, status: string, updatedAt: Date) => ({
  _id: oid(n), orderId, requestType: 'print_required', requestedName: `t${n}`, productionMethod: 'wax', status,
  taskKind: 'order', archivedAt: null, createdAt: old, updatedAt, customer: { name: 'Client' }
});
const rows = [
  task(1, oid(101), 'printing', old),
  task(2, oid(101), 'quality_check', fresh), // changed: its sibling must come back too
  task(3, oid(102), 'printing', old)
];

const findQuery = (data: any[]) => {
  const chain: any = {};
  ['sort', 'skip', 'limit', 'populate', 'select', 'lean'].forEach(name => { chain[name] = jest.fn(() => chain); });
  chain.distinct = (field: string) => Promise.resolve([...new Set(data.map((row: any) => row[field]))]);
  chain.then = (resolve: any, reject: any) => Promise.resolve(data).then(resolve, reject);
  return chain;
};

const ask = async (query: any) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await listCases({ query: { scope: 'all', stage: 'printing', ...query }, user: { id: 'boss-id', role: 'admin', isAdmin: true } }, res);
  expect(res.status).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0];
};

describe('Quick refresh of the case list', () => {
  beforeEach(() => {
    jest.spyOn(WorkflowCase, 'find').mockImplementation((filter: any) => findQuery(rows.filter(sift(filter))));
  });
  afterEach(() => jest.restoreAllMocks());

  test('a full list carries the server time', async () => {
    const body = await ask({});
    expect(typeof body.serverTime).toBe('string');
    expect(body.delta).toBeUndefined();
  });

  test('only changed orders come back, and moved tasks are reported as gone', async () => {
    const body = await ask({ since: '2026-10-20T00:00:00Z', known: [oid(1), oid(2), oid(3)].join(',') });
    expect(body.delta).toBe(true);
    // task 2 changed and left the printing stage; task 1 only comes back as a sibling of the changed order
    expect(body.cases.map((item: any) => item._id)).toEqual([oid(1)]);
    expect(body.gone).toEqual([oid(2)]);
  });

  test('nothing changed means an empty answer', async () => {
    const body = await ask({ since: '2026-10-25T00:00:00Z', known: oid(3) });
    expect(body.cases).toEqual([]);
    expect(body.gone).toEqual([]);
  });
});
