jest.mock('../middlewares/auth', () => ({ auth: (req: any, res: any, next: any) => next() }));
jest.mock('../utils/pushNotification', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../models/Catalog', () => {
  const Catalog: any = { find: jest.fn(), populate: jest.fn() };
  return Catalog;
});

const Catalog = require('../models/Catalog');
const catalogListCache = require('../utils/catalogListCache');
const router = require('../routes/catalogs');

const listHandler = router.stack
  .find((layer: any) => layer.route?.path === '/' && layer.route.methods.get)
  .route.stack.slice(-1)[0].handle;

const catalogDoc = (id: string, fields: any) => ({
  _id: { toString: () => id },
  ...fields,
  hasUserAccess(userId: string) {
    return fields.isPublic || fields.ownerId === userId;
  },
  toObject() {
    const { hasUserAccess, toObject, ...plain } = this as any;
    return plain;
  },
});

const run = async (query: any, role = 'user') => {
  const docs = [
    catalogDoc('public', { name: 'Public', isPublic: true, ownerId: 'admin', products: ['p1', 'p2'] }),
    catalogDoc('private', { name: 'Private', isPublic: false, ownerId: 'admin', products: ['p3'] }),
  ];
  Catalog.find.mockReturnValue({ sort: () => Promise.resolve(docs) });
  Catalog.populate.mockResolvedValue(docs);
  let body: any;
  const res = { json: (data: any) => { body = data; }, status: () => res };
  await listHandler({ query, user: { id: 'customer', role } }, res);
  return body;
};

describe('catalog list', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    catalogListCache.invalidate();
  });

  test('names view skips products and reports a count', async () => {
    const body = await run({ view: 'names' });
    expect(Catalog.populate).not.toHaveBeenCalled();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ name: 'Public', catalogId: 'public', productCount: 2 });
    expect(body[0]).not.toHaveProperty('products');
  });

  test('list view loads only the fields the list screen draws, and hides drafts from customers', async () => {
    const body = await run({ view: 'list' });
    const [, options] = Catalog.populate.mock.calls[0];
    // The shared copy holds every catalogue; each customer only gets theirs.
    expect(body.map((c: any) => c.name)).toEqual(['Public']);
    expect(options.select).toMatch(/\bimageUrl\b/);
    expect(options.select).not.toMatch(/relatedProducts|availableSizes/);
    expect(options.match).toEqual({ isActive: { $ne: false } });
  });

  test('without a view older apps still get every product in full', async () => {
    await run({}, 'admin');
    const [docs, options] = Catalog.populate.mock.calls[0];
    expect(docs).toHaveLength(2);
    expect(options).toEqual({ path: 'products' });
  });
});

describe('shared catalog list for phones', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    catalogListCache.invalidate();
  });

  test('builds the list once for several phones, then again after an edit', async () => {
    const first = await run({ view: 'list' });
    await run({ view: 'list' });
    expect(Catalog.find).toHaveBeenCalledTimes(1);
    expect(first.map((c: any) => c.name)).toEqual(['Public']);

    catalogListCache.invalidate();
    await run({ view: 'list' });
    expect(Catalog.find).toHaveBeenCalledTimes(2);
  });

  test('the owner of a private catalogue still sees it from the shared copy', async () => {
    const docs = [
      catalogDoc('private', { name: 'Private', isPublic: false, ownerId: 'customer', products: [] }),
    ];
    Catalog.find.mockReturnValue({ sort: () => Promise.resolve(docs) });
    Catalog.populate.mockResolvedValue(docs);
    let body: any;
    const res = { json: (data: any) => { body = data; }, status: () => res };
    await listHandler({ query: { view: 'list' }, user: { id: 'customer', role: 'user' } }, res);
    expect(body.map((c: any) => c.name)).toEqual(['Private']);
    body = undefined;
    await listHandler({ query: { view: 'list' }, user: { id: 'someone-else', role: 'user' } }, res);
    expect(body).toEqual([]);
  });

  test('two customers with different private catalogues each get only their own from one shared copy', async () => {
    const docs = [
      catalogDoc('public', { name: 'Public', isPublic: true, ownerId: 'admin', products: [] }),
      catalogDoc('anna-only', { name: 'Anna only', isPublic: false, ownerId: 'anna', products: [] }),
      catalogDoc('ben-only', { name: 'Ben only', isPublic: false, ownerId: 'ben', products: [] }),
      catalogDoc('hidden', { name: 'Nobody', isPublic: false, ownerId: 'admin', products: [] }),
    ];
    Catalog.find.mockReturnValue({ sort: () => Promise.resolve(docs) });
    Catalog.populate.mockResolvedValue(docs);
    const listFor = async (id: string, role = 'user') => {
      let body: any;
      const res = { json: (data: any) => { body = data; }, status: () => res };
      await listHandler({ query: { view: 'list' }, user: { id, role } }, res);
      return body.map((c: any) => c.name);
    };
    expect(await listFor('anna')).toEqual(['Public', 'Anna only']);
    expect(await listFor('ben')).toEqual(['Public', 'Ben only']);
    expect(await listFor('anna')).toEqual(['Public', 'Anna only']);
    expect(await listFor('stranger')).toEqual(['Public']);
    // Staff and the tablet account see everything, and never read the shared copy.
    expect(await listFor('boss', 'admin')).toEqual(['Public', 'Anna only', 'Ben only', 'Nobody']);
    expect(Catalog.find).toHaveBeenCalledTimes(2); // one shared build + the admin's own read
  });

  test('changing who may see a catalogue drops the shared copy', async () => {
    const { broadcastCatalogsOnWrite } = require('../utils/liveUpdates');
    const open = [catalogDoc('c', { name: 'C', isPublic: false, ownerId: 'admin', allowedUserIds: ['anna'], products: [] })];
    open[0].hasUserAccess = (id: string) => id === 'anna';
    Catalog.find.mockReturnValue({ sort: () => Promise.resolve(open) });
    Catalog.populate.mockResolvedValue(open);
    const listFor = async (id: string) => {
      let body: any;
      const res = { json: (data: any) => { body = data; }, status: () => res };
      await listHandler({ query: { view: 'list' }, user: { id, role: 'user' } }, res);
      return body.length;
    };
    expect(await listFor('anna')).toBe(1);

    // The permissions route finished: access moved from anna to ben.
    open[0].hasUserAccess = (id: string) => id === 'ben';
    let onFinish: () => void = () => {};
    broadcastCatalogsOnWrite(
      { method: 'PUT' },
      { statusCode: 200, on: (_event: string, handler: () => void) => { onFinish = handler; } },
      () => {}
    );
    onFinish();
    expect(await listFor('anna')).toBe(0);
    expect(await listFor('ben')).toBe(1);
  });

  test('phones asking at the same moment share one build', async () => {
    let release: (v?: any) => void = () => {};
    const docs = [catalogDoc('public', { name: 'Public', isPublic: true, ownerId: 'admin', products: [] })];
    Catalog.find.mockReturnValue({ sort: () => new Promise(resolve => { release = () => resolve(docs); }) });
    Catalog.populate.mockResolvedValue(docs);
    const bodies: any[] = [];
    const res = { json: (data: any) => { bodies.push(data); }, status: () => res };
    const a = listHandler({ query: { view: 'list' }, user: { id: 'a', role: 'user' } }, res);
    const b = listHandler({ query: { view: 'list' }, user: { id: 'b', role: 'user' } }, res);
    await new Promise(r => setTimeout(r, 0));
    release();
    await Promise.all([a, b]);
    expect(Catalog.find).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
  });

  test('an edit during a build keeps the older build out of the cache', async () => {
    const stale = [catalogDoc('public', { name: 'Old', isPublic: true, ownerId: 'admin', products: [] })];
    let release: (v?: any) => void = () => {};
    Catalog.find.mockReturnValueOnce({ sort: () => new Promise(resolve => { release = () => resolve(stale); }) });
    Catalog.populate.mockResolvedValue(stale);
    const res = { json: () => {}, status: () => res };
    const pendingCall = listHandler({ query: { view: 'list' }, user: { id: 'a', role: 'user' } }, res);
    await new Promise(r => setTimeout(r, 0));
    catalogListCache.invalidate();
    release();
    await pendingCall;

    const fresh = [catalogDoc('public', { name: 'New', isPublic: true, ownerId: 'admin', products: [] })];
    Catalog.find.mockReturnValue({ sort: () => Promise.resolve(fresh) });
    Catalog.populate.mockResolvedValue(fresh);
    let body: any;
    const res2 = { json: (data: any) => { body = data; }, status: () => res2 };
    await listHandler({ query: { view: 'list' }, user: { id: 'a', role: 'user' } }, res2);
    expect(body.map((c: any) => c.name)).toEqual(['New']);
  });
});

describe('catalog names view with twins', () => {
  test('lists a repeated name once', async () => {
    const docs = [
      catalogDoc('one', { name: 'Bagues', isPublic: true, ownerId: 'admin', products: ['p1'] }),
      catalogDoc('two', { name: 'Bagues', isPublic: true, ownerId: 'admin', products: ['p2', 'p3'] }),
    ];
    Catalog.find.mockReturnValue({ sort: () => Promise.resolve(docs) });
    let body: any;
    const res = { json: (data: any) => { body = data; }, status: () => res };
    await listHandler({ query: { view: 'names' }, user: { id: 'admin', role: 'admin' } }, res);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ catalogId: 'two', productCount: 2, sameNameIds: ['one'] });
  });
});

describe('creating a catalog', () => {
  const createHandler = router.stack
    .find((layer: any) => layer.route?.path === '/' && layer.route.methods.post)
    .route.stack.slice(-1)[0].handle;

  test('refuses a name that is already taken', async () => {
    Catalog.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'b1', name: 'Bagues' }] }) });
    const res: any = { status: jest.fn(() => res), json: jest.fn() };
    await createHandler({ body: { name: ' bagues ' }, user: { id: 'admin', role: 'admin' } }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].message).toMatch(/already exists/);
  });
});
