const Machine = require('../models/Machine');
const { DEFAULT_MACHINES } = require('../utils/machineRegistry');

describe('machine registry', () => {
  test('contains the seven printers without duplicate identities', () => {
    expect(DEFAULT_MACHINES).toHaveLength(7);
    expect(new Set(DEFAULT_MACHINES.map((machine: any) => machine.code)).size).toBe(7);
    expect(new Set(DEFAULT_MACHINES.map((machine: any) => machine.serialNumber)).size).toBe(7);
    expect(new Set(DEFAULT_MACHINES.map((machine: any) => machine.ipAddress)).size).toBe(7);
    expect(new Set(DEFAULT_MACHINES.map((machine: any) => machine.macAddress)).size).toBe(7);
  });

  test('every printer has its own M number, and the new FlashForge 410 is registered', () => {
    for (const method of ['wax', 'resin']) {
      const labels = DEFAULT_MACHINES.filter((machine: any) => machine.productionMethod === method).map((machine: any) => machine.label);
      expect(labels).toEqual(labels.map((_: string, index: number) => `M${index + 1}`).sort());
      expect(new Set(labels).size).toBe(labels.length);
    }
    expect(DEFAULT_MACHINES.filter((machine: any) => machine.productionMethod === 'resin').map((machine: any) => machine.label)).toEqual(['M1', 'M2']);
    expect(DEFAULT_MACHINES.find((machine: any) => machine.ipAddress === '192.168.1.61')).toMatchObject({ manufacturer: 'FlashForge', productionMethod: 'wax', label: 'M4' });
  });

  test('keeps Wax and Resin machines on their confirmed routes', () => {
    expect(DEFAULT_MACHINES.filter((machine: any) => machine.productionMethod === 'wax')).toHaveLength(5);
    expect(DEFAULT_MACHINES.filter((machine: any) => machine.productionMethod === 'resin')).toHaveLength(2);
    expect(DEFAULT_MACHINES.find((machine: any) => machine.serialNumber === '222R142766')?.ipAddress).toBe('192.168.1.28');
    expect(DEFAULT_MACHINES.find((machine: any) => machine.serialNumber === '224R157774')?.ipAddress).toBe('192.168.1.26');
  });

  test('rejects an unsupported operational status', () => {
    const machine = new Machine({ ...DEFAULT_MACHINES[0], status: 'printing_forever' });
    const validation = machine.validateSync();
    expect(validation?.errors.status).toBeDefined();
  });
});

describe('making a printer available', () => {
  const router = require('../routes/machines');
  const route = router.stack.find((layer: any) => layer.route?.path === '/:id/status' && layer.route.methods.patch);
  const patch = route.route.stack[route.route.stack.length - 1].handle;
  const id = '507f1f77bcf86cd799439011';
  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  const boss = { id: 'boss', role: 'employee', workRole: 'boss' };
  afterEach(() => jest.restoreAllMocks());

  test('an old print task left on the printer no longer blocks it, but a plate does', async () => {
    const AuditLog = require('../models/AuditLog');
    jest.spyOn(AuditLog, 'create').mockResolvedValue({} as any);
    const old: any = { _id: id, code: 'R1', productionMethod: 'resin', status: 'failed', currentCaseId: '507f1f77bcf86cd799439022', currentPlateId: null, save: jest.fn() };
    jest.spyOn(Machine, 'findById').mockResolvedValue(old);
    let res = response();
    await patch({ params: { id }, body: { status: 'available' }, user: boss }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(old).toMatchObject({ status: 'available', currentCaseId: null });

    const onPlate: any = { _id: id, code: 'R2', productionMethod: 'resin', status: 'busy', currentCaseId: null, currentPlateId: '507f1f77bcf86cd799439033', save: jest.fn() };
    jest.spyOn(Machine, 'findById').mockResolvedValue(onPlate);
    res = response();
    await patch({ params: { id }, body: { status: 'available' }, user: boss }, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});
