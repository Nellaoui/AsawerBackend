jest.mock('../middlewares/auth', () => ({ auth: (req: any, res: any, next: any) => next() }));
jest.mock('../utils/pushNotification', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../models/Catalog', () => {
  const Catalog: any = { find: jest.fn(), populate: jest.fn() };
  return Catalog;
});

const Catalog = require('../models/Catalog');
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
  beforeEach(() => jest.clearAllMocks());

  test('names view skips products and reports a count', async () => {
    const body = await run({ view: 'names' });
    expect(Catalog.populate).not.toHaveBeenCalled();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ name: 'Public', catalogId: 'public', productCount: 2 });
    expect(body[0]).not.toHaveProperty('products');
  });

  test('list view loads only the fields the list screen draws, and hides drafts from customers', async () => {
    await run({ view: 'list' });
    const [docs, options] = Catalog.populate.mock.calls[0];
    expect(docs.map((d: any) => d.name)).toEqual(['Public']);
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
