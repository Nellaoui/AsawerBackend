export {};
jest.mock('../utils/workflowAssignment', () => ({ findTeamAssignee: jest.fn(async () => ({ _id: 'quality-employee' })) }));
jest.mock('../utils/workflowNotifications', () => ({
  notifyCaseAssignment: jest.fn(), notifyFailedPrint: jest.fn(), notifyOrderBlocked: jest.fn(), notifyTaskRemoved: jest.fn()
}));
jest.mock('../utils/machineRegistry', () => ({
  releaseMachineFromCase: jest.fn(), assignMachineToCase: jest.fn(), findMachine: jest.fn(), auditMachine: jest.fn()
}));
const WorkflowCase = require('../models/WorkflowCase');
const Plate = require('../models/Plate');
const Order = require('../models/Order');
const { findMachine } = require('../utils/machineRegistry');
const { notifyFailedPrint } = require('../utils/workflowNotifications');
const router = require('../routes/workflow');

const handler = (path: string, method: string) => router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const add = handler('/plates/add', 'post');
const remove = handler('/plates/:id/remove', 'post');
const move = handler('/plates/:id/move', 'post');
const send = handler('/plates/:id/send', 'post');
const finish = handler('/plates/:id/finish', 'post');
const failPlate = handler('/plates/:id/fail', 'post');
const transition = handler('/cases/:id/transition', 'post');

const oid = (n: number) => `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}`;
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const waxUser = { id: 'wax-employee', role: 'employee', workRole: 'wax_print' };
const makeCase = (n: number, extra: any = {}) => ({
  _id: oid(n), requestedName: `Product ${n}`, status: 'ready_to_print', productionMethod: 'wax', assignedTeam: 'wax_print', assignedTo: 'wax-employee',
  orderId: oid(90), isBlocked: false, archivedAt: null, print: {}, history: [] as any[], save: jest.fn(async function (this: any) { return this; }), ...extra
});
const makePlate = (n: number, extra: any = {}) => ({
  _id: oid(50 + n), number: n, productionMethod: 'wax', status: 'open', machineCode: '', createdAt: new Date(), save: jest.fn(async function (this: any) { return this; }), ...extra
});

describe('printing plates', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Order, 'find').mockReturnValue({ select: jest.fn().mockReturnValue({ lean: async () => [] }) } as any);
  });
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

  test('adding the first product opens the next plate automatically', async () => {
    const workflowCase = makeCase(1);
    jest.spyOn(WorkflowCase, 'findById').mockResolvedValue(workflowCase as any);
    jest.spyOn(Plate, 'findOne').mockImplementation((() => ({ sort: () => ({ select: () => ({ lean: async () => ({ number: 13 }) }), then: (ok: any) => ok(null) }) })) as any);
    const created = makePlate(14);
    jest.spyOn(Plate, 'create').mockResolvedValue(created as any);
    jest.spyOn(WorkflowCase, 'find').mockReturnValue({ populate: () => ({ populate: async () => [] }) } as any);
    const res = response();
    await add({ body: { caseId: workflowCase._id }, user: waxUser, app: {} }, res);
    expect(Plate.create).toHaveBeenCalledWith(expect.objectContaining({ number: 14, productionMethod: 'wax' }));
    expect(workflowCase.print).toMatchObject({ plateNumber: 14 });
    expect(workflowCase.save).toHaveBeenCalled();
  });

  test('the employee can pick which open plate a product goes on', async () => {
    const workflowCase = makeCase(1);
    const chosen = makePlate(15);
    jest.spyOn(WorkflowCase, 'findById').mockResolvedValue(workflowCase as any);
    jest.spyOn(Plate, 'findById').mockResolvedValue(chosen as any);
    jest.spyOn(Plate, 'create');
    jest.spyOn(WorkflowCase, 'find').mockReturnValue({ populate: () => ({ populate: async () => [] }) } as any);
    const res = response();
    await add({ body: { caseId: workflowCase._id, toPlateId: chosen._id }, user: waxUser, app: {} }, res);
    expect(workflowCase.print).toMatchObject({ plateNumber: 15 });
    expect(Plate.create).not.toHaveBeenCalled();
  });

  test('a wax product can not be put on a resin plate', async () => {
    const workflowCase = makeCase(1);
    jest.spyOn(WorkflowCase, 'findById').mockResolvedValue(workflowCase as any);
    jest.spyOn(Plate, 'findById').mockResolvedValue(makePlate(15, { productionMethod: 'resin' }) as any);
    const res = response();
    await add({ body: { caseId: workflowCase._id, toPlateId: oid(65) }, user: waxUser, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(workflowCase.save).not.toHaveBeenCalled();
  });

  test('products of different orders can share one plate', async () => {
    const first = makeCase(1, { orderId: oid(90) });
    const second = makeCase(2, { orderId: oid(91) });
    const plate = makePlate(14);
    jest.spyOn(Plate, 'findById').mockResolvedValue(plate as any);
    jest.spyOn(WorkflowCase, 'findById').mockResolvedValueOnce(first as any).mockResolvedValueOnce(second as any);
    jest.spyOn(WorkflowCase, 'find').mockReturnValue({ populate: () => ({ populate: async () => [] }) } as any);
    for (const workflowCase of [first, second]) await add({ body: { caseId: workflowCase._id, toPlateId: plate._id }, user: waxUser, app: {} }, response());
    expect(first.print).toMatchObject({ plateNumber: 14 });
    expect(second.print).toMatchObject({ plateNumber: 14 });
  });

  test('a resin employee can not use a wax product or plate', async () => {
    const workflowCase = makeCase(1);
    jest.spyOn(WorkflowCase, 'findById').mockResolvedValue(workflowCase as any);
    const res = response();
    await add({ body: { caseId: workflowCase._id }, user: { id: 'wax-employee', role: 'employee', workRole: 'resin_print' }, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(workflowCase.save).not.toHaveBeenCalled();
  });

  test('only products waiting to print can be added', async () => {
    const workflowCase = makeCase(1, { status: 'printing' });
    jest.spyOn(WorkflowCase, 'findById').mockResolvedValue(workflowCase as any);
    const res = response();
    await add({ body: { caseId: workflowCase._id }, user: waxUser, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('removing the last product closes the empty plate', async () => {
    const plate = makePlate(14);
    const workflowCase = makeCase(1, { print: { plateId: plate._id, plateNumber: 14 } });
    jest.spyOn(Plate, 'findById').mockResolvedValue(plate as any);
    jest.spyOn(WorkflowCase, 'findById').mockResolvedValue(workflowCase as any);
    jest.spyOn(WorkflowCase, 'countDocuments').mockResolvedValue(0 as any);
    const res = response();
    await remove({ params: { id: plate._id }, body: { caseId: workflowCase._id }, user: waxUser }, res);
    expect(workflowCase.print.plateId).toBeNull();
    expect(plate.status).toBe('cancelled');
    expect(res.json).toHaveBeenCalledWith({ closed: true });
  });

  test('a product only moves to a plate of the same type (wax or resin)', async () => {
    const plate = makePlate(14);
    const other = makePlate(15, { productionMethod: 'resin' });
    const workflowCase = makeCase(1, { print: { plateId: plate._id, plateNumber: 14 } });
    jest.spyOn(Plate, 'findById').mockResolvedValueOnce(plate as any).mockResolvedValueOnce(other as any);
    jest.spyOn(WorkflowCase, 'findById').mockResolvedValue(workflowCase as any);
    const res = response();
    await move({ params: { id: plate._id }, body: { caseId: workflowCase._id, toPlateId: other._id }, user: waxUser }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(workflowCase.save).not.toHaveBeenCalled();
  });

  test('sending a plate puts every product on the printer together, even when not full', async () => {
    const plate = makePlate(14);
    const cases = [makeCase(1, { print: { plateId: plate._id, plateNumber: 14 } })];
    const machine: any = { code: 'W2', name: 'Wax 2', enabled: true, productionMethod: 'wax', status: 'available', currentCaseId: null, currentPlateId: null, save: jest.fn() };
    jest.spyOn(Plate, 'findById').mockResolvedValue(plate as any);
    (findMachine as jest.Mock).mockResolvedValue(machine);
    jest.spyOn(WorkflowCase, 'find').mockImplementation(((filter: any) => filter['print.plateId'] && !filter.status ? Promise.resolve(cases) : { populate: () => ({ populate: async () => cases }) }) as any);
    const res = response();
    await send({ params: { id: plate._id }, body: { machineId: 'W2' }, user: waxUser }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(cases[0]).toMatchObject({ status: 'printing' });
    expect(cases[0].print).toMatchObject({ machineId: 'W2', plateNumber: 14 });
    expect(plate).toMatchObject({ status: 'printing', machineCode: 'W2' });
    expect(machine).toMatchObject({ status: 'busy', currentPlateId: plate._id });
  });

  test('a printer marked failed can still be chosen, an offline one can not', async () => {
    const plate = makePlate(14);
    const cases = [makeCase(1, { print: { plateId: plate._id, plateNumber: 14 } })];
    const failed: any = { code: 'W2', name: 'Wax 2', enabled: true, productionMethod: 'wax', status: 'failed', statusReason: 'old jam', currentCaseId: null, currentPlateId: null, save: jest.fn() };
    jest.spyOn(Plate, 'findById').mockResolvedValue(plate as any);
    jest.spyOn(WorkflowCase, 'find').mockImplementation(((filter: any) => filter['print.plateId'] && !filter.status ? Promise.resolve(cases) : { populate: () => ({ populate: async () => cases }) }) as any);
    (findMachine as jest.Mock).mockResolvedValue(failed);
    let res = response();
    await send({ params: { id: plate._id }, body: { machineId: 'W2' }, user: waxUser }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(failed).toMatchObject({ status: 'busy', statusReason: '', currentPlateId: plate._id });

    const second = makePlate(15);
    jest.spyOn(Plate, 'findById').mockResolvedValue(second as any);
    (findMachine as jest.Mock).mockResolvedValue({ code: 'W3', enabled: true, productionMethod: 'wax', status: 'offline', currentPlateId: null });
    res = response();
    await send({ params: { id: second._id }, body: { machineId: 'W3' }, user: waxUser }, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('a busy printer is refused', async () => {
    const plate = makePlate(14);
    (findMachine as jest.Mock).mockResolvedValue({ code: 'W2', enabled: true, productionMethod: 'wax', status: 'busy', currentPlateId: oid(70) });
    jest.spyOn(Plate, 'findById').mockResolvedValue(plate as any);
    const res = response();
    await send({ params: { id: plate._id }, body: { machineId: 'W2' }, user: waxUser }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(plate.status).toBe('open');
  });

  test('finishing the plate sends all its products to Quality and frees the printer', async () => {
    const plate = makePlate(14, { status: 'printing', machineCode: 'W2' });
    const cases = [1, 2].map(n => makeCase(n, { orderId: null, status: 'printing', startedAt: new Date(), print: { plateId: plate._id, plateNumber: 14, machineId: 'W2' } }));
    const machine: any = { code: 'W2', currentPlateId: plate._id, status: 'busy', save: jest.fn() };
    jest.spyOn(Plate, 'findById').mockResolvedValue(plate as any);
    (findMachine as jest.Mock).mockResolvedValue(machine);
    jest.spyOn(WorkflowCase, 'find').mockResolvedValue(cases as any);
    jest.spyOn(WorkflowCase, 'findById').mockResolvedValue(null as any);
    const res = response();
    await finish({ params: { id: plate._id }, body: {}, user: waxUser, app: {} }, res);
    expect(res.status).not.toHaveBeenCalled();
    for (const workflowCase of cases) {
      expect(workflowCase).toMatchObject({ status: 'quality_check', assignedTeam: 'quality', assignedTo: 'quality-employee', startedAt: null });
      expect(workflowCase.print.plateNumber).toBe(14);
    }
    expect(plate.status).toBe('finished');
    expect(machine).toMatchObject({ status: 'available', currentPlateId: null });
  });

  test('a failed plate needs a reason and returns every product to To print', async () => {
    const plate = makePlate(14, { status: 'printing', machineCode: 'W2' });
    const cases = [makeCase(1, { orderId: null, status: 'printing', startedAt: new Date(), print: { plateId: plate._id, plateNumber: 14, machineId: 'W2' } })];
    jest.spyOn(Plate, 'findById').mockResolvedValue(plate as any);
    (findMachine as jest.Mock).mockResolvedValue({ code: 'W2', currentPlateId: plate._id, status: 'busy', save: jest.fn() });
    jest.spyOn(WorkflowCase, 'find').mockResolvedValue(cases as any);
    const empty = response();
    await failPlate({ params: { id: plate._id }, body: { note: ' ' }, user: waxUser, app: {} }, empty);
    expect(empty.status).toHaveBeenCalledWith(400);
    const res = response();
    await failPlate({ params: { id: plate._id }, body: { note: 'Supports broke' }, user: waxUser, app: {} }, res);
    expect(cases[0]).toMatchObject({ status: 'ready_to_print', startedAt: null });
    expect(cases[0].print.plateId).toBeNull();
    expect(plate.status).toBe('failed');
    expect(notifyFailedPrint).toHaveBeenCalled();
  });

  test('the old one-by-one Send to printing path is closed', async () => {
    const workflowCase: any = { ...makeCase(1), requestType: 'print_required', save: jest.fn() };
    jest.spyOn(WorkflowCase, 'findById').mockImplementation(() => Object.assign(Promise.resolve(workflowCase), { populate: jest.fn().mockReturnThis() }) as any);
    const res = response();
    await transition({ params: { id: workflowCase._id }, body: { status: 'printing' }, user: waxUser, app: {} }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(workflowCase.save).not.toHaveBeenCalled();
  });
});
