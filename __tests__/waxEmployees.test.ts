export {};
jest.mock('../utils/workflowNotifications', () => ({
  notifyCaseAssignment: jest.fn(async () => {}), notifyFailedPrint: jest.fn(), notifyOrderBlocked: jest.fn(), notifyTaskRemoved: jest.fn(async () => {})
}));
jest.mock('../utils/machineRegistry', () => ({
  releaseMachineFromCase: jest.fn(), assignMachineToCase: jest.fn(), findMachine: jest.fn(), auditMachine: jest.fn()
}));
const User = require('../models/User');
const WorkflowCase = require('../models/WorkflowCase');
const Plate = require('../models/Plate');
const { findTeamAssignee } = require('../utils/workflowAssignment');
const { notifyCaseAssignment, notifyTaskRemoved } = require('../utils/workflowNotifications');
const router = require('../routes/workflow');

const handler = (path: string, method: string) => router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const give = handler('/cases/:id/give', 'post');
const add = handler('/plates/add', 'post');
const move = handler('/plates/:id/move', 'post');

const oid = (n: number) => `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}`;
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn(), once: jest.fn() });
const waxA = { id: oid(1), role: 'employee', workRole: 'wax_print' };
const waxB = { id: oid(2), role: 'employee', workRole: 'wax_print' };
const csUser = { id: oid(3), role: 'employee', workRole: 'customer_service' };
const makeCase = (n: number, extra: any = {}) => ({
  _id: oid(10 + n), requestedName: `Product ${n}`, status: 'ready_to_print', productionMethod: 'wax', assignedTeam: 'wax_print', assignedTo: oid(1),
  orderId: oid(90), isBlocked: false, archivedAt: null, print: {}, history: [] as any[], save: jest.fn(async function (this: any) { return this; }), ...extra
});
const makePlate = (n: number, extra: any = {}) => ({
  _id: oid(50 + n), number: n, productionMethod: 'wax', status: 'open', machineCode: '', createdAt: new Date(), save: jest.fn(async function (this: any) { return this; }), ...extra
});
const chain = (rows: any) => ({ sort: () => ({ select: async () => rows }) });

describe('wax employees', () => {
  beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

  test('new wax work goes to the least busy wax employee', async () => {
    jest.spyOn(User, 'find').mockReturnValue(chain([{ _id: oid(1) }, { _id: oid(2) }]) as any);
    jest.spyOn(WorkflowCase, 'aggregate').mockResolvedValue([{ _id: oid(1), count: 5 }, { _id: oid(2), count: 2 }] as any);
    expect(String((await findTeamAssignee('wax_print'))._id)).toBe(oid(2));
  });

  test('a tie keeps the oldest wax account', async () => {
    jest.spyOn(User, 'find').mockReturnValue(chain([{ _id: oid(1) }, { _id: oid(2) }]) as any);
    jest.spyOn(WorkflowCase, 'aggregate').mockResolvedValue([] as any);
    expect(String((await findTeamAssignee('wax_print'))._id)).toBe(oid(1));
  });

  test('the chosen wax employee must be an active wax employee', async () => {
    const findOne = jest.spyOn(User, 'findOne').mockReturnValue({ select: async () => null } as any);
    expect(await findTeamAssignee('wax_print', null, { preferredId: oid(2) })).toBeNull();
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ _id: oid(2), workRole: 'wax_print' }));
  });

  test('a wax employee gives a waiting product to the other one', async () => {
    const workflowCase = makeCase(1);
    jest.spyOn(User, 'findOne').mockReturnValue({ select: async () => ({ _id: oid(2), name: 'Sara' }) } as any);
    jest.spyOn(WorkflowCase, 'find').mockResolvedValue([workflowCase] as any);
    const res = response();
    await give({ params: { id: workflowCase._id }, body: { userId: oid(2) }, user: waxA, app: {} }, res);
    expect(workflowCase.assignedTo).toBe(oid(2));
    expect(workflowCase.save).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ given: [workflowCase._id] }));
  });

  test('a wax employee cannot give away a product of the other one', async () => {
    const workflowCase = makeCase(1, { assignedTo: oid(2) });
    jest.spyOn(User, 'findOne').mockReturnValue({ select: async () => ({ _id: oid(1), name: 'Ali' }) } as any);
    jest.spyOn(WorkflowCase, 'find').mockResolvedValue([workflowCase] as any);
    const res = response();
    await give({ params: { id: workflowCase._id }, body: { userId: oid(1) }, user: waxA, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(workflowCase.save).not.toHaveBeenCalled();
  });

  test('Customer Service can give the whole order, but not a product that is on a plate', async () => {
    const first = makeCase(1);
    const second = makeCase(2);
    jest.spyOn(User, 'findOne').mockReturnValue({ select: async () => ({ _id: oid(2), name: 'Sara' }) } as any);
    jest.spyOn(WorkflowCase, 'find').mockResolvedValue([first, second] as any);
    const res = response();
    await give({ params: { id: first._id }, body: { userId: oid(2), caseIds: [second._id] }, user: csUser, app: {} }, res);
    expect(first.assignedTo).toBe(oid(2));
    expect(second.assignedTo).toBe(oid(2));

    const onPlate = makeCase(3, { print: { plateId: oid(55), plateNumber: 5 } });
    jest.spyOn(WorkflowCase, 'find').mockResolvedValue([onPlate] as any);
    const blocked = response();
    await give({ params: { id: onPlate._id }, body: { userId: oid(2) }, user: csUser, app: {} }, blocked);
    expect(blocked.status).toHaveBeenCalledWith(409);
    expect(onPlate.assignedTo).toBe(oid(1));
  });

  test('a new plate belongs to the wax employee who owns the product', async () => {
    const workflowCase = makeCase(1, { assignedTo: oid(2) });
    jest.spyOn(WorkflowCase, 'findById').mockResolvedValue(workflowCase as any);
    jest.spyOn(Plate, 'findOne').mockImplementation((() => ({ sort: () => ({ select: () => ({ lean: async () => ({ number: 3 }) }), then: (ok: any) => ok(null) }) })) as any);
    const create = jest.spyOn(Plate, 'create').mockResolvedValue(makePlate(4) as any);
    await add({ body: { caseId: workflowCase._id }, user: { ...waxB, id: oid(2) }, app: {} }, response());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: oid(2) }));
  });

  test('a product can not go on a plate owned by the other wax employee', async () => {
    const workflowCase = makeCase(1);
    jest.spyOn(WorkflowCase, 'findById').mockResolvedValue(workflowCase as any);
    jest.spyOn(Plate, 'findById').mockResolvedValue(makePlate(7, { ownerId: oid(2) }) as any);
    const res = response();
    await add({ body: { caseId: workflowCase._id, toPlateId: oid(57) }, user: waxA, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(workflowCase.save).not.toHaveBeenCalled();
  });

  test('a wax employee can not use the other one\'s plate', async () => {
    jest.spyOn(Plate, 'findById').mockResolvedValue(makePlate(7, { ownerId: oid(2) }) as any);
    const res = response();
    await move({ params: { id: oid(57) }, body: { caseId: oid(11) }, user: waxA, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
