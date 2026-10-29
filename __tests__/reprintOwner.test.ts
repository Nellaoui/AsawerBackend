export {};
jest.mock('../utils/workflowAssignment', () => ({
  findTeamAssignee: jest.fn(async (_team: string, _session: any, options: any = {}) => ({ _id: options.preferredId === 'wax-two' ? 'wax-two' : 'oldest-wax' }))
}));
jest.mock('../utils/workflowNotifications', () => ({
  notifyCaseAssignment: jest.fn(), notifyFailedPrint: jest.fn(), notifyOrderBlocked: jest.fn(), notifyTaskRemoved: jest.fn()
}));
jest.mock('../utils/machineRegistry', () => ({ releaseMachineFromCase: jest.fn(), findMachine: jest.fn(), assignMachineToCase: jest.fn() }));
const WorkflowCase = require('../models/WorkflowCase');
const router = require('../routes/workflow');
const route = router.stack.find((layer: any) => layer.route?.path === '/cases/:id/transition');
const transition = route.route.stack.at(-1).handle;
const id = '507f1f77bcf86cd799439011';
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

describe('a reprint goes back to the person who put the product on the plate', () => {
  let task: any;
  let req: any;
  beforeEach(() => {
    task = { _id: id, status: 'quality_check', requestType: 'print_required', requestedName: 'BO AB 004 A', assignedTeam: 'quality', assignedTo: 'quality-employee', productionMethod: 'wax', startedAt: new Date(), print: { machineId: 'W1', plateNumber: 5 }, history: [], save: jest.fn() };
    req = { params: { id }, user: { id: 'quality-employee', role: 'employee', workRole: 'quality' }, app: {}, body: { status: 'ready_to_print', note: 'Broken arm', reprintParts: [{ code: 'A', quantity: 1 }] } };
    jest.spyOn(WorkflowCase, 'findById').mockImplementation(() => Object.assign(Promise.resolve(task), { populate: jest.fn().mockReturnThis() }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  test('assigns the reprint to the employee who plated it', async () => {
    task.history.push({ action: 'plate_assigned', actorId: 'wax-one' }, { action: 'plate_assigned', actorId: 'wax-two' });
    const res = response();
    await transition(req, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(task).toMatchObject({ status: 'ready_to_print', assignedTeam: 'wax_print', assignedTo: 'wax-two' });
  });

  test('uses the normal pick when nobody plated it', async () => {
    const res = response();
    await transition(req, res);
    expect(task.assignedTo).toBe('oldest-wax');
  });
});
