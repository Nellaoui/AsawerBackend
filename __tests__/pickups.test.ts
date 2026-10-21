export {};

const Order = require('../models/Order');
const AuditLog = require('../models/AuditLog');
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
  afterEach(() => jest.restoreAllMocks());

  test('lookup needs four digits', async () => {
    const res = response();
    await handler('/lookup', 'post')({ body: { code: '12' }, user: staff }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('lookup finds only a ready order that was not handed over', async () => {
    const find = jest.spyOn(Order, 'findOne').mockReturnValue(query(readyOrder));
    const res = response();
    await handler('/lookup', 'post')({ body: { code: '4 7 2 9' }, user: staff }, res);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ fulfillmentState: 'ready', pickedUpAt: null, pickupCode: '4729' }));
    expect(res.json.mock.calls[0][0]).toMatchObject({ orderNumber: 'ASW-1', customerName: 'Karim', products: 2 });
  });

  test('a wrong or used code is not found', async () => {
    jest.spyOn(Order, 'findOne').mockReturnValue(query(null));
    const res = response();
    await handler('/lookup', 'post')({ body: { code: '0000' }, user: staff }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('giving the order saves who and when, once', async () => {
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockReturnValue(query({ ...readyOrder, pickedUpAt: new Date(), pickedUpByName: 'Salma' }));
    jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    const res = response();
    await handler('/:id/picked-up', 'post')({ params: { id: readyOrder._id }, user: staff }, res);
    expect(update.mock.calls[0][0]).toMatchObject({ fulfillmentState: 'ready', pickedUpAt: null });
    expect((update.mock.calls[0] as any)[1].$set).toMatchObject({ pickedUpByName: 'Salma' });
    expect(res.json.mock.calls[0][0].pickedUpByName).toBe('Salma');
  });

  test('an order already handed over is refused', async () => {
    jest.spyOn(Order, 'findOneAndUpdate').mockReturnValue(query(null));
    const res = response();
    await handler('/:id/picked-up', 'post')({ params: { id: readyOrder._id }, user: staff }, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('a ready order gets a code nobody else is waiting with', async () => {
    jest.spyOn(Order, 'findById').mockReturnValue(query({ fulfillmentState: 'ready', pickupCode: null, pickedUpAt: null, status: 'confirmed' }));
    jest.spyOn(Order, 'exists').mockResolvedValueOnce({ _id: 'x' }).mockResolvedValue(null);
    jest.spyOn(Order, 'findOneAndUpdate').mockReturnValue(query({ pickupCode: '5555' }));
    expect(await ensurePickupCode('64b0000000000000000000aa')).toBe('5555');
    expect((Order.exists as jest.Mock).mock.calls.length).toBe(2);
  });

  test('no code before the order is ready', async () => {
    jest.spyOn(Order, 'findById').mockReturnValue(query({ fulfillmentState: 'in_progress', pickupCode: null, pickedUpAt: null }));
    expect(await ensurePickupCode('64b0000000000000000000aa')).toBeNull();
  });
});
