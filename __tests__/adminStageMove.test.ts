export {};
jest.mock('../utils/workflowAssignment', () => ({ findTeamAssignee: jest.fn(async () => ({ _id: 'destination-employee' })) }));
jest.mock('../utils/workflowNotifications', () => ({
  notifyCaseAssignment: jest.fn(), notifyFailedPrint: jest.fn(), notifyOrderBlocked: jest.fn(), notifyTaskRemoved: jest.fn()
}));
jest.mock('../utils/machineRegistry', () => ({ releaseMachineFromCase: jest.fn(), findMachine: jest.fn(), assignMachineToCase: jest.fn() }));
const WorkflowCase = require('../models/WorkflowCase');
const Order = require('../models/Order');
const { releaseMachineFromCase } = require('../utils/machineRegistry');
const router = require('../routes/workflow');
const route = router.stack.find((layer: any) => layer.route?.path === '/cases/:id/transition');
const transition = route.route.stack.at(-1).handle;
const id = '507f1f77bcf86cd799439011';
const leanable = (value: any) => Object.assign(Promise.resolve(value), { lean: async () => value });
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
describe('administrator stage corrections', () => {
  let task: any;
  let req: any;
  beforeEach(() => {
    task = { _id: id, status: 'completed', requestType: 'print_required', assignedTeam: 'quality', assignedTo: 'old-employee', completedAt: new Date(), startedAt: new Date(), isBlocked: true, blockedReason: 'Bad finish', deadlineAt: new Date(), productionMethod: 'wax', print: { machineId: 'W1' }, history: [], save: jest.fn() };
    req = { params: { id }, user: { id: 'admin', role: 'admin' }, app: {}, body: { adminMove: true, status: 'modeling', note: 'Fix the dimensions' } };
    jest.spyOn(WorkflowCase, 'findById').mockImplementation(() => Object.assign(Promise.resolve(task), { populate: jest.fn().mockReturnThis() }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });
  test.each(['employee', 'customer'])('rejects %s override before reading a case', async role => {
    req.user = { id: 'other', role, workRole: 'boss' };
    const res=response(); await transition(req,res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(WorkflowCase.findById).not.toHaveBeenCalled();
  });
  test('requires a reason', async () => {
    req.body.note=' '; const res=response(); await transition(req,res);
    expect(res.status).toHaveBeenCalledWith(400); expect(task.save).not.toHaveBeenCalled();
  });
  test.each(['invalid', 'completed'])('rejects invalid or unchanged destination %s', async status => {
    req.body.status=status; const res=response(); await transition(req,res);
    expect(res.status).toHaveBeenCalled(); expect(task.save).not.toHaveBeenCalled();
  });
  test('reopens completed blocked work, resets timers and records the actor and reason', async () => {
    const res=response(); await transition(req,res);
    expect(res.status).not.toHaveBeenCalled();
    expect(task).toMatchObject({ status:'modeling', assignedTeam:'boss', assignedTo:'destination-employee', completedAt:null, startedAt:null, isBlocked:false, blockedReason:'', deadlineAt:null });
    expect(task.stageQueuedAt).toBeInstanceOf(Date);
    expect(task.history[0]).toMatchObject({ action:'admin_stage_changed', actorId:'admin', fromStatus:'completed', toStatus:'modeling', note:'Fix the dimensions' });
    expect(task.save).toHaveBeenCalled();
  });
  test('normal transitions still enforce the workflow graph', async () => {
    task.isBlocked=false; req.body.adminMove=false;
    const res=response(); await transition(req,res);
    expect(res.status).toHaveBeenCalledWith(409); expect(task.save).not.toHaveBeenCalled();
  });
  test('routes print corrections to the selected printing team', async () => {
    req.body.status='ready_to_print'; req.body.productionMethod='resin';
    const res=response(); await transition(req,res);
    expect(res.status).not.toHaveBeenCalled();
    expect(task).toMatchObject({ status:'ready_to_print', productionMethod:'resin', assignedTeam:'resin_print' });
    expect(task.print.machineId).toBe('');
  });
  test('requires a print method', async () => {
    task.productionMethod='undecided'; req.body.status='printing';
    const res=response(); await transition(req,res);
    expect(res.status).toHaveBeenCalledWith(400); expect(task.save).not.toHaveBeenCalled();
  });
  test('releases a printer when work is sent backward', async () => {
    task.status='printing'; const res=response(); await transition(req,res);
    expect(releaseMachineFromCase).toHaveBeenCalledWith(expect.objectContaining({ machineCode:'W1', outcome:'failed' }));
  });
  test('requires archived orders to be resumed first', async () => {
    task.archivedAt=new Date(); const res=response(); await transition(req,res);
    expect(res.status).toHaveBeenCalledWith(409); expect(task.save).not.toHaveBeenCalled();
  });
  test('does not create an unusable per-item validation task', async () => {
    req.body.status='awaiting_validation'; const res=response(); await transition(req,res);
    expect(res.status).toHaveBeenCalledWith(409); expect(task.save).not.toHaveBeenCalled();
  });
  test.each([true, false])('does not close an unconfirmed validation task after diversion (override %s)', async adminMove => {
    task.requestType='order_validation'; task.orderId=id; task.status='packing'; task.isBlocked=false;
    req.body={ adminMove, status:'completed', note:'Correction' };
    jest.spyOn(Order,'findById').mockReturnValue({select:jest.fn(()=>leanable(({validationStatus:'pending'})))} as any);
    const res=response(); await transition(req,res);
    expect(res.status).toHaveBeenCalledWith(409); expect(task.save).not.toHaveBeenCalled();
  });
  test('returns a diverted pending validation task to its validation queue', async () => {
    task.requestType='order_validation'; task.orderId=id; task.status='boss_review'; req.body.status='awaiting_validation';
    jest.spyOn(Order,'findById').mockReturnValue({select:jest.fn(()=>leanable(({validationStatus:'pending'})))} as any);
    jest.spyOn(WorkflowCase,'find').mockReturnValue({select:jest.fn(()=>leanable([{status:'awaiting_validation'}]))} as any);
    jest.spyOn(Order,'updateOne').mockResolvedValue({} as any);
    const res=response(); await transition(req,res);
    expect(res.status).not.toHaveBeenCalled(); expect(task.assignedTeam).toBe('customer_service');
    expect(Order.updateOne).toHaveBeenCalledWith({_id:id},{$set:{fulfillmentState:'in_progress'}});
  });
  test('returns an already-validated order validation task to awaiting_validation and resets order validationStatus', async () => {
    task.requestType='order_validation'; task.orderId=id; task.status='completed'; req.body.status='awaiting_validation';
    jest.spyOn(Order,'findById').mockReturnValue({select:jest.fn(()=>leanable(({validationStatus:'approved'})))} as any);
    jest.spyOn(WorkflowCase,'find').mockReturnValue({select:jest.fn(()=>leanable([{status:'awaiting_validation'}]))} as any);
    jest.spyOn(WorkflowCase,'countDocuments').mockReturnValue({session:jest.fn(async()=>0)} as any);
    jest.spyOn(Order,'updateOne').mockResolvedValue({} as any);
    const res=response(); await transition(req,res);
    expect(res.status).not.toHaveBeenCalled(); expect(task.assignedTeam).toBe('customer_service');
    expect(Order.updateOne).toHaveBeenCalledWith({_id:id},{$set:{validationStatus:'pending',fulfillmentState:'in_progress','items.$[].fulfillmentStatus':'awaiting_validation'}},{session:null});
  });
  test('keeps an already-validated order confirmed when its stock or printing tasks exist, so they are not created twice', async () => {
    task.requestType='order_validation'; task.orderId=id; task.status='completed'; req.body.status='awaiting_validation';
    jest.spyOn(Order,'findById').mockReturnValue({select:jest.fn(()=>leanable(({validationStatus:'approved'})))} as any);
    jest.spyOn(WorkflowCase,'countDocuments').mockReturnValue({session:jest.fn(async()=>4)} as any);
    jest.spyOn(Order,'updateOne').mockResolvedValue({} as any);
    const res=response(); await transition(req,res);
    expect(res.status).toHaveBeenCalledWith(409); expect(task.save).not.toHaveBeenCalled();
    expect(Order.updateOne).not.toHaveBeenCalled();
  });
});

describe('administrator stage moves keep every step', () => {
  let task: any;
  beforeEach(() => {
    task = { _id: id, status: 'ready_to_print', requestType: 'print_required', assignedTeam: 'wax_print', productionMethod: 'wax', print: {}, history: [], save: jest.fn() };
    jest.spyOn(WorkflowCase, 'findById').mockImplementation(() => Object.assign(Promise.resolve(task), { populate: jest.fn().mockReturnThis() }));
  });
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });
  test.each(['completed', 'quality_check', 'packing'])('refuses to jump a print task waiting to print to %s', async status => {
    const req = { params: { id }, user: { id: 'admin', role: 'admin' }, app: {}, body: { adminMove: true, status, note: 'Skip it' } };
    const res = response(); await transition(req, res);
    expect(res.status).toHaveBeenCalledWith(409); expect(task.save).not.toHaveBeenCalled();
  });
});
