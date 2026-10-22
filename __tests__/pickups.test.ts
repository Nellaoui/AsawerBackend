export {};

jest.mock('../utils/completeOrder', () => ({ completeOrder: jest.fn() }));
const { completeOrder } = require('../utils/completeOrder');
const flush = () => new Promise(resolve => setImmediate(resolve));

const Order = require('../models/Order');
const AuditLog = require('../models/AuditLog');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/pickups');
const { ensurePickupCode } = require('../utils/pickupCode');

const handler = (path: string, method: string) => {
  const route = router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]);
  return route.route.stack[route.route.stack.length - 1].handle;
};
const query = (result: any) => {
  const chain: any = {};
  ['sort', 'limit', 'select', 'populate', 'lean'].forEach(name => { chain[name] = jest.fn(() => chain); });
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return chain;
};
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const staff = { id: '64b000000000000000000001', name: 'Salma', role: 'employee', workRole: 'customer_service' };
const readyOrder = { _id: '64b0000000000000000000aa', orderNumber: 'ASW-1', userId: { name: 'Karim' }, items: [{}, {}], pickupCode: '4729', pickedUpAt: null, pickedUpByName: '' };

describe('pickup code at the counter', () => {
  beforeEach(() => { (completeOrder as jest.Mock).mockReset().mockResolvedValue({ completed: true }); });
  afterEach(() => jest.restoreAllMocks());

  test('lookup needs four digits', async () => {
    const res = response();
    await handler('/lookup', 'post')({ body: { code: '12' }, user: staff }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  const packedCase = (key: string, extra: any = {}) => ({ orderId: readyOrder._id, orderItemId: key, requestedName: `P${key}`, status: 'completed', history: [{ fromStatus: 'packing' }], ...extra });
  const withCases = (cases: any[]) => jest.spyOn(WorkflowCase, 'find').mockReturnValue(query(cases));

  test('lookup finds an order that has a product ready, not one already handed over', async () => {
    const find = jest.spyOn(Order, 'findOne').mockReturnValue(query(readyOrder));
    withCases([packedCase('a'), packedCase('b', { status: 'printing', history: [] })]);
    const res = response();
    await handler('/lookup', 'post')({ body: { code: '4 7 2 9' }, user: staff }, res);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ pickedUpAt: null, pickupCode: '4729' }));
    expect(res.json.mock.calls[0][0]).toMatchObject({ orderNumber: 'ASW-1', customerName: 'Karim', products: 2, readyCount: 1 });
  });

  test('lookup refuses an order with nothing ready yet', async () => {
    jest.spyOn(Order, 'findOne').mockReturnValue(query(readyOrder));
    withCases([packedCase('a', { status: 'printing', history: [] })]);
    const res = response();
    await handler('/lookup', 'post')({ body: { code: '4729' }, user: staff }, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('a wrong or used code is not found', async () => {
    jest.spyOn(Order, 'findOne').mockReturnValue(query(null));
    const res = response();
    await handler('/lookup', 'post')({ body: { code: '0000' }, user: staff }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('giving needs at least one ticked product', async () => {
    jest.spyOn(Order, 'findOne').mockReturnValue(query(readyOrder));
    withCases([packedCase('a')]);
    const res = response();
    await handler('/:id/picked-up', 'post')({ params: { id: readyOrder._id }, body: { itemKeys: [] }, user: staff }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('giving one of two ready products keeps the order open', async () => {
    jest.spyOn(Order, 'findOne').mockReturnValue(query(readyOrder));
    withCases([packedCase('a'), packedCase('b')]);
    const push = jest.spyOn(Order, 'findOneAndUpdate').mockReturnValue(query({ _id: readyOrder._id }));
    const done = jest.spyOn(Order, 'updateOne').mockResolvedValue({} as any);
    jest.spyOn(Order, 'findById').mockReturnValue(query({ ...readyOrder, handovers: [{ itemKeys: ['a'] }], packedWeights: [{ itemKeys: ['a'], weightGrams: 12.5 }] }));
    jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    const res = response();
    await handler('/:id/picked-up', 'post')({ params: { id: readyOrder._id }, body: { itemKeys: ['a'] }, user: staff }, res);
    expect((push.mock.calls[0] as any)[1].$push.handovers).toMatchObject({ itemKeys: ['a'], byName: 'Salma' });
    expect(done).not.toHaveBeenCalled();
    await flush();
    expect(completeOrder).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0]).toMatchObject({ givenCount: 1, weightGrams: 12.5 });
  });

  test('giving the last products closes the order as picked up', async () => {
    jest.spyOn(Order, 'findOne').mockReturnValue(query({ ...readyOrder, handovers: [{ itemKeys: ['a'] }] }));
    withCases([packedCase('a'), packedCase('b')]);
    jest.spyOn(Order, 'findOneAndUpdate').mockReturnValue(query({ _id: readyOrder._id }));
    const done = jest.spyOn(Order, 'updateOne').mockResolvedValue({} as any);
    jest.spyOn(Order, 'findById').mockReturnValue(query({ ...readyOrder, pickedUpAt: new Date() }));
    jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    const res = response();
    await handler('/:id/picked-up', 'post')({ params: { id: readyOrder._id }, body: { itemKeys: ['b'] }, user: staff }, res);
    expect((done.mock.calls[0] as any)[1].$set).toMatchObject({ pickedUpByName: 'Salma' });
    await flush();
    expect(completeOrder).toHaveBeenCalledWith(readyOrder._id, staff.id);
  });

  test('if completing the order fails, the handover stays and the failure is logged', async () => {
    jest.spyOn(Order, 'findOne').mockReturnValue(query({ ...readyOrder, handovers: [{ itemKeys: ['a'] }] }));
    withCases([packedCase('a'), packedCase('b')]);
    jest.spyOn(Order, 'findOneAndUpdate').mockReturnValue(query({ _id: readyOrder._id }));
    jest.spyOn(Order, 'updateOne').mockResolvedValue({} as any);
    jest.spyOn(Order, 'findById').mockReturnValue(query({ ...readyOrder, pickedUpAt: new Date() }));
    const audit = jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (completeOrder as jest.Mock).mockRejectedValue(new Error('Reserved inventory is inconsistent'));
    const res = response();
    await handler('/:id/picked-up', 'post')({ params: { id: readyOrder._id }, body: { itemKeys: ['b'] }, user: staff }, res);
    await flush();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].pickedUpAt).toBeTruthy();
    expect(audit.mock.calls.map((call: any) => call[0].action)).toContain('order_complete_failed');
  });

  test('a product that is not ready or already given is refused', async () => {
    jest.spyOn(Order, 'findOne').mockReturnValue(query({ ...readyOrder, handovers: [{ itemKeys: ['a'] }] }));
    withCases([packedCase('a'), packedCase('b', { status: 'printing', history: [] })]);
    const res = response();
    await handler('/:id/picked-up', 'post')({ params: { id: readyOrder._id }, body: { itemKeys: ['a', 'b'] }, user: staff }, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('a ready order gets a code nobody else is waiting with', async () => {
    jest.spyOn(Order, 'findById').mockReturnValue(query({ fulfillmentState: 'ready', pickupCode: null, pickedUpAt: null, status: 'confirmed' }));
    jest.spyOn(Order, 'exists').mockResolvedValueOnce({ _id: 'x' }).mockResolvedValue(null);
    jest.spyOn(Order, 'findOneAndUpdate').mockReturnValue(query({ pickupCode: '5555' }));
    expect(await ensurePickupCode('64b0000000000000000000aa')).toBe('5555');
    expect((Order.exists as jest.Mock).mock.calls.length).toBe(2);
  });

  test('no code before the order is ready (unless a product is already done)', async () => {
    jest.spyOn(Order, 'findById').mockReturnValue(query({ fulfillmentState: 'in_progress', pickupCode: null, pickedUpAt: null }));
    expect(await ensurePickupCode('64b0000000000000000000aa')).toBeNull();
  });

  test('a partly ready order can get its code', async () => {
    jest.spyOn(Order, 'findById').mockReturnValue(query({ fulfillmentState: 'in_progress', pickupCode: null, pickedUpAt: null, status: 'confirmed' }));
    jest.spyOn(Order, 'exists').mockResolvedValue(null);
    jest.spyOn(Order, 'findOneAndUpdate').mockReturnValue(query({ pickupCode: '1234' }));
    expect(await ensurePickupCode('64b0000000000000000000aa', { partial: true })).toBe('1234');
  });
});
