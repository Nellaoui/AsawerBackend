export {};

jest.mock('../utils/workflowNotifications', () => ({
  notifyCaseAssignment: jest.fn(async () => {}),
  notifyFailedPrint: jest.fn(async () => {}),
  notifyOrderBlocked: jest.fn(async () => {}),
  notifyTaskRemoved: jest.fn(async () => {})
}));

const Order = require('../models/Order');
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/workflow');

const handler = (path: string) => {
  const route = router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods.post);
  return route.route.stack[route.route.stack.length - 1].handle;
};
const packWeight = handler('/orders/:orderId/pack-weight');
const transition = handler('/cases/:id/transition');
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const query = (result: any) => {
  const chain: any = {};
  ['select', 'lean', 'populate'].forEach(name => { chain[name] = jest.fn(() => chain); });
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return chain;
};
const orderId = '507f1f77bcf86cd799439011';
const userId = '507f1f77bcf86cd799439012';
const packer = { id: userId, role: 'employee', workRole: 'packing', name: 'Hind' };
const packingCase = (id: string, itemId: string) => ({ _id: id, orderId, orderItemId: itemId, status: 'packing', assignedTo: userId, requestedName: `P${itemId}` });

describe('weight typed at Packing', () => {
  afterEach(() => jest.restoreAllMocks());

  test('needs a weight above zero', async () => {
    const res = response();
    await packWeight({ params: { orderId }, body: { caseIds: ['507f1f77bcf86cd799439021'], weightGrams: 0 }, user: packer }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('saves one weight for the products packed together and replaces an older one', async () => {
    jest.spyOn(WorkflowCase, 'find').mockReturnValue(query([packingCase('507f1f77bcf86cd799439021', 'a'), packingCase('507f1f77bcf86cd799439022', 'b')]));
    jest.spyOn(Order, 'findById').mockReturnValue(query({ packedWeights: [{ itemKeys: ['a', 'c'], weightGrams: 5 }] }));
    const update = jest.spyOn(Order, 'updateOne').mockResolvedValue({} as any);
    const res = response();
    await packWeight({ params: { orderId }, body: { caseIds: ['507f1f77bcf86cd799439021', '507f1f77bcf86cd799439022'], weightGrams: '27,8' }, user: packer }, res);
    const saved = (update.mock.calls[0] as any)[1].$set.packedWeights;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ itemKeys: ['c'], weightGrams: 5 });
    expect(saved[1]).toMatchObject({ itemKeys: ['a', 'b'], weightGrams: 27.8, byName: 'Hind' });
  });

  test('refuses products that are not at Packing', async () => {
    jest.spyOn(WorkflowCase, 'find').mockReturnValue(query([{ ...packingCase('507f1f77bcf86cd799439021', 'a'), status: 'quality_check' }]));
    const res = response();
    await packWeight({ params: { orderId }, body: { caseIds: ['507f1f77bcf86cd799439021'], weightGrams: 10 }, user: packer }, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('Packing done does not ask for a weight', async () => {
    const save = jest.fn();
    const workflowCase = { ...packingCase('507f1f77bcf86cd799439021', 'a'), requestType: 'print_required', assignedTeam: 'packing', history: [], save };
    jest.spyOn(WorkflowCase, 'findById').mockReturnValue(query(workflowCase));
    // Another product of the order is still printing, so the order refresh after the move stays simple.
    jest.spyOn(WorkflowCase, 'find').mockReturnValue(query([{ status: 'printing', isBlocked: false }]));
    jest.spyOn(Order, 'findById').mockReturnValue(query({ packedWeights: [], items: [{}, {}] }));
    jest.spyOn(Order, 'updateOne').mockResolvedValue({} as any);
    const res = response();
    await transition({ params: { id: '507f1f77bcf86cd799439021' }, body: { status: 'completed' }, user: packer, app: {} }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
    expect(workflowCase.status).toBe('completed');
  });
});
