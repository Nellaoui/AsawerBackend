export {};

const WorkflowCase = require('../models/WorkflowCase');
const Machine = require('../models/Machine');
const Order = require('../models/Order');
const router = require('../routes/workflow');

const listCases = (() => {
  const route = router.stack.find((layer: any) => layer.route?.path === '/cases' && layer.route.methods.get);
  return route.route.stack[route.route.stack.length - 1].handle;
})();

const query = (rows: any[]) => {
  const chain: any = {};
  ['sort', 'skip', 'limit', 'populate', 'select', 'lean'].forEach(name => { chain[name] = jest.fn(() => chain); });
  chain.then = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject);
  return chain;
};

describe('Packing shows the plate each product was printed on', () => {
  afterEach(() => jest.restoreAllMocks());

  test('order lines carry the plate number and the printer name', async () => {
    const packing = { _id: 'pack', orderId: 'order-1', orderItemId: 'item-1', requestType: 'pack_order', requestedName: 'Pack', status: 'packing', taskKind: 'order', archivedAt: null, createdAt: new Date() };
    const printed = { _id: 'print', orderId: '507f1f77bcf86cd799439011', orderItemId: 'item-1', requestType: 'print_required', requestedName: 'COL 112', status: 'packing', print: { plateNumber: 14, machineId: 'W2' } };
    const fromStock = { _id: 'stock', orderId: '507f1f77bcf86cd799439011', orderItemId: 'item-2', requestType: 'stock_pick', requestedName: 'BRA 490', status: 'completed', print: {} };
    packing.orderId = { _id: '507f1f77bcf86cd799439011', items: [{ _id: 'item-2', stockPickedQuantity: 1 }, { _id: 'item-3', stockPickedQuantity: 0 }] } as any;
    const allMissing = { _id: 'miss', orderId: '507f1f77bcf86cd799439011', orderItemId: 'item-3', requestType: 'stock_pick', requestedName: 'GO 001', status: 'completed', print: {} };
    jest.spyOn(WorkflowCase, 'find').mockImplementation((filter: any) => query(filter.requestType?.$nin ? [printed, fromStock, allMissing] : [packing]));
    jest.spyOn(WorkflowCase, 'countDocuments').mockResolvedValue(1 as any);
    jest.spyOn(Order, 'find').mockReturnValue(query([]) as any);
    jest.spyOn(Machine, 'find').mockReturnValue(query([{ code: 'W2', name: 'Wax 2' }]) as any);
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await listCases({ query: { scope: 'all' }, user: { id: 'boss', role: 'employee', workRole: 'boss' } }, res);
    expect(res.status).not.toHaveBeenCalled();
    const lines = res.json.mock.calls[0][0].cases[0].orderLines;
    expect(lines.find((line: any) => line.orderItemId === 'item-1').plate).toEqual({ number: 14, printer: 'Wax 2' });
    expect(lines.find((line: any) => line.orderItemId === 'item-2').plate).toBeNull();
    expect(lines.find((line: any) => line.orderItemId === 'item-2')).toMatchObject({ fromStock: true, detail: 'Taken from stock' });
    expect(lines.find((line: any) => line.orderItemId === 'item-1').fromStock).toBe(false);
    expect(lines.find((line: any) => line.orderItemId === 'item-3')).toMatchObject({ fromStock: false, detail: 'Done' });
  });
});
