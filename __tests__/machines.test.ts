const Machine = require('../models/Machine');
const { DEFAULT_MACHINES } = require('../utils/machineRegistry');

describe('machine registry', () => {
  test('contains the six confirmed printers without duplicate identities', () => {
    expect(DEFAULT_MACHINES).toHaveLength(6);
    expect(new Set(DEFAULT_MACHINES.map((machine: any) => machine.code)).size).toBe(6);
    expect(new Set(DEFAULT_MACHINES.map((machine: any) => machine.serialNumber)).size).toBe(6);
    expect(new Set(DEFAULT_MACHINES.map((machine: any) => machine.ipAddress)).size).toBe(6);
    expect(new Set(DEFAULT_MACHINES.map((machine: any) => machine.macAddress)).size).toBe(6);
  });

  test('keeps Wax and Resin machines on their confirmed routes', () => {
    expect(DEFAULT_MACHINES.filter((machine: any) => machine.productionMethod === 'wax')).toHaveLength(4);
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
