const express = require('express');
const http = require('http');
const { STAFF_ROOM, isStaffUser, broadcastOnWrite } = require('../utils/liveUpdates');

describe('live workflow updates', () => {
  let server: any;
  let baseUrl: string;
  const emit = jest.fn();
  const to = jest.fn(() => ({ emit }));

  beforeAll(async () => {
    const app = express();
    app.set('io', { to });
    app.use('/api/workflow', broadcastOnWrite('workflow'), (req: any, res: any) => {
      res.status(req.path === '/fail' ? 400 : 200).json({ ok: true });
    });
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error: Error) => error ? reject(error) : resolve()));
  });

  beforeEach(() => {
    emit.mockClear();
    to.mockClear();
  });

  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  it('tells staff screens after a successful write', async () => {
    await fetch(`${baseUrl}/api/workflow/cases/1/transition`, { method: 'POST' });
    await settle();
    expect(to).toHaveBeenCalledWith(STAFF_ROOM);
    expect(emit).toHaveBeenCalledWith('workflow:changed', expect.objectContaining({ reason: 'workflow' }));
  });

  it('stays quiet for reads and failed writes', async () => {
    await fetch(`${baseUrl}/api/workflow/cases`);
    await fetch(`${baseUrl}/api/workflow/fail`, { method: 'POST' });
    await settle();
    expect(emit).not.toHaveBeenCalled();
  });

  it('only treats employees and admins as staff', () => {
    expect(isStaffUser({ role: 'employee' })).toBe(true);
    expect(isStaffUser({ role: 'admin' })).toBe(true);
    expect(isStaffUser({ role: 'user', isAdmin: true })).toBe(true);
    expect(isStaffUser({ role: 'user' })).toBe(false);
    expect(isStaffUser(null)).toBe(false);
  });
});

describe('employee notification policy', () => {
  const { canNotifyUser } = require('../utils/notificationPolicy');
  const employee = { role: 'employee' };

  it('only tells employees about tasks arriving for them', () => {
    expect(canNotifyUser(employee, 'new_task')).toBe(true);
    expect(canNotifyUser(employee, 'reassigned')).toBe(true);
    for (const type of ['deadline_soon', 'task_overdue', 'task_removed', 'order_blocked', 'print_failed', 'general']) {
      expect(canNotifyUser(employee, type)).toBe(false);
    }
  });

  it('leaves customers and admins unchanged', () => {
    expect(canNotifyUser({ role: 'user' }, 'order_ready')).toBe(true);
    expect(canNotifyUser({ role: 'admin' }, 'order_blocked')).toBe(true);
  });
});

describe('live app updates', () => {
  const { setLiveIo, notifyOrderChange, broadcastCatalogChange, userRoom, APP_ROOM } = require('../utils/liveUpdates');
  const emit = jest.fn();
  const to = jest.fn((room: string) => ({ emit }));

  beforeEach(() => {
    jest.useFakeTimers();
    emit.mockClear();
    to.mockClear();
    setLiveIo({ to });
  });

  afterEach(() => {
    setLiveIo(null);
    jest.useRealTimers();
  });

  test('tells the order owner and staff once per burst, without order data', () => {
    notifyOrderChange('user-1');
    notifyOrderChange('user-1');
    expect(emit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(500);
    expect(to.mock.calls.map((call: any[]) => call[0]).sort()).toEqual([STAFF_ROOM, userRoom('user-1')].sort());
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('orders:changed', { at: expect.any(Number) });
  });

  test('tells every signed-in app when catalogs change', () => {
    broadcastCatalogChange();
    jest.advanceTimersByTime(500);
    expect(to).toHaveBeenCalledWith(APP_ROOM);
    expect(emit).toHaveBeenCalledWith('catalogs:changed', { at: expect.any(Number) });
  });

  test('does nothing before the socket server is attached', () => {
    setLiveIo(null);
    notifyOrderChange('user-1');
    jest.advanceTimersByTime(500);
    expect(to).not.toHaveBeenCalled();
  });
});
