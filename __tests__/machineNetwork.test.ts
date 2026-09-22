const { observeMachineNetwork } = require('../utils/machineNetwork');

describe('machine network observation', () => {
  test('records reachability without claiming a printer is available or printing', () => {
    const at = new Date('2026-09-14T12:00:00Z');
    const machine = { status: 'failed', statusReason: 'Print head error', statusSource: 'manual', networkStatus: 'unknown', lastSeenAt: null, lastCheckedAt: null };
    expect(observeMachineNetwork(machine, true, at)).toBe('unknown');
    expect(machine).toMatchObject({ status: 'failed', statusReason: 'Print head error', statusSource: 'manual', networkStatus: 'online', lastSeenAt: at, lastCheckedAt: at });
  });

  test('an unreachable assigned printer keeps its task and records the failed check', () => {
    const at = new Date('2026-09-14T12:00:00Z');
    const previousSeen = new Date('2026-09-14T11:59:00Z');
    const machine = { status: 'busy', currentCaseId: 'case-1', networkStatus: 'online', lastSeenAt: previousSeen, lastCheckedAt: null };
    expect(observeMachineNetwork(machine, false, at)).toBe('online');
    expect(machine).toMatchObject({ status: 'busy', currentCaseId: 'case-1', networkStatus: 'offline', lastSeenAt: previousSeen, lastCheckedAt: at });
  });
});
