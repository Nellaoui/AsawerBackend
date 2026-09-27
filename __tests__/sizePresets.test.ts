export {};

// Pull the handlers out of the router so the test never touches a database.
jest.mock('express', () => ({ Router: () => ({
  stack: [] as any[],
  get(path: string, ...handlers: any[]) {
    this.stack.push({ method: 'get', route: { path, stack: handlers.map(handle => ({ handle })) } });
  },
  put(path: string, ...handlers: any[]) {
    this.stack.push({ method: 'put', route: { path, stack: handlers.map(handle => ({ handle })) } });
  },
}) }), { virtual: true });
jest.mock('../models/SizePreset', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../middlewares/auth', () => ({ auth: jest.fn(), adminAuth: jest.fn() }));

const SizePreset = require('../models/SizePreset');
const router = require('../routes/sizePresets');

const pick = (method: string, path: string) => {
  const layer = router.stack.find((entry: any) => entry.method === method && entry.route?.path === path);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const response = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('size presets routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('saves "apply to all" for other categories and forces it on for bague/bracelet', async () => {
    const put = pick('put', '/:type');
    SizePreset.findOneAndUpdate.mockResolvedValue({});

    await put({ params: { type: 'Collier' }, body: { availableSizes: ['40', '45'], applyToAll: true } }, response());
    expect(SizePreset.findOneAndUpdate.mock.calls[0][1]).toMatchObject({ type: 'collier', availableSizes: ['40', '45'], applyToAll: true });

    await put({ params: { type: 'gourmette' }, body: { availableSizes: [] } }, response());
    expect(SizePreset.findOneAndUpdate.mock.calls[1][1].applyToAll).toBe(false);

    await put({ params: { type: 'bague' }, body: { availableSizes: ['50'], applyToAll: false } }, response());
    expect(SizePreset.findOneAndUpdate.mock.calls[2][1].applyToAll).toBe(true);
  });

  it('rejects unknown types and the types that have no size', async () => {
    for (const type of ['watch', 'boucle', 'pendantif']) {
      const res = response();
      await pick('put', '/:type')({ params: { type }, body: {} }, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(SizePreset.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('reports bague/bracelet as apply-to-all even for presets saved before the flag existed', async () => {
    SizePreset.find.mockReturnValue({ sort: () => Promise.resolve([
      { type: 'bague', availableSizes: ['50'], availableHeights: [] },
      { type: 'collier', availableSizes: ['40'], availableHeights: [], applyToAll: true },
      { type: 'gourmette', availableSizes: ['18'], availableHeights: ['4'] },
    ]) });
    const res = response();
    await pick('get', '/')({}, res);
    const map = res.json.mock.calls[0][0];
    expect(map.bague.applyToAll).toBe(true);
    expect(map.collier.applyToAll).toBe(true);
    expect(map.gourmette.applyToAll).toBe(false);
  });
});
