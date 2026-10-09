jest.mock('../middlewares/auth', () => ({ auth: (req: any, res: any, next: any) => next() }));
jest.mock('../utils/pushNotification', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../models/AuditLog', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../models/Catalog', () => ({ findById: jest.fn(), find: jest.fn(), findByIdAndDelete: jest.fn() }));
jest.mock('../models/Product', () => ({ deleteMany: jest.fn() }));

const AuditLog = require('../models/AuditLog');
const Catalog = require('../models/Catalog');
const router = require('../routes/catalogs');
const { diffIds, auditCatalogChange } = require('../utils/catalogAudit');

const handler = (path: string, method: string) => router.stack
  .find((layer: any) => layer.route?.path === path && layer.route.methods[method])
  .route.stack.slice(-1)[0].handle;

const admin = { id: 'admin-1', _id: 'admin-1', role: 'admin', email: 'a@x.com' };
const response = () => {
  const res: any = { statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
};
const catalogDoc = (fields: any = {}) => ({
  _id: 'cat-1', name: 'NEW ALLIANCE', ownerId: 'admin-1', isPublic: false, allowedUserIds: ['tawfik'], products: ['p1', 'p2'],
  save: jest.fn(async () => undefined),
  canUserEdit: () => true,
  ...fields,
});

describe('catalog access changes are written to the audit trail', () => {
  beforeEach(() => jest.clearAllMocks());

  test('permissions: who was added, who was removed and the public flag', async () => {
    const catalog = catalogDoc();
    Catalog.findById.mockResolvedValue(catalog);
    const res = response();
    await handler('/:id/permissions', 'put')({ params: { id: 'cat-1' }, body: { allowedUserIds: ['yassine'], isPublic: true }, user: admin }, res);

    expect(res.statusCode).toBe(200);
    expect(AuditLog.create).toHaveBeenCalledTimes(1);
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      category: 'access',
      action: 'catalog.access_changed',
      actorId: 'admin-1',
      entityId: 'cat-1',
      details: expect.objectContaining({
        via: 'permissions',
        isPublic: { before: false, after: true },
        allowedAdded: ['yassine'],
        allowedRemoved: ['tawfik'],
      }),
    }));
  });

  test('a save that changes nothing about access writes nothing', async () => {
    Catalog.findById.mockResolvedValue(catalogDoc());
    await handler('/:id/permissions', 'put')({ params: { id: 'cat-1' }, body: { allowedUserIds: ['tawfik'], isPublic: false }, user: admin }, response());
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  test('editing a catalogue through PUT /:id is audited when it changes access', async () => {
    Catalog.findById.mockResolvedValue(catalogDoc());
    await handler('/:id', 'put')({ params: { id: 'cat-1' }, body: { isPublic: true }, user: admin }, response());
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'catalog.access_changed',
      details: expect.objectContaining({ via: 'catalog_edit', isPublic: { before: false, after: true } }),
    }));
  });

  test('renaming a catalogue alone is not an access change', async () => {
    Catalog.findById.mockResolvedValue(catalogDoc());
    await handler('/:id', 'put')({ params: { id: 'cat-1' }, body: { name: 'Other' }, user: admin }, response());
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  test('deleting a catalogue records its name and who could see it', async () => {
    Catalog.findById.mockResolvedValue(catalogDoc());
    await handler('/:id', 'delete')({ params: { id: 'cat-1' }, user: admin }, response());
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'catalog.deleted',
      details: expect.objectContaining({ name: 'NEW ALLIANCE', productCount: 2, allowedUserIds: ['tawfik'] }),
    }));
  });

  test('a failing audit write never fails the change', async () => {
    AuditLog.create.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const catalog = catalogDoc();
    Catalog.findById.mockResolvedValue(catalog);
    const res = response();
    await handler('/:id/permissions', 'put')({ params: { id: 'cat-1' }, body: { isPublic: true }, user: admin }, res);
    expect(res.statusCode).toBe(200);
    expect(catalog.save).toHaveBeenCalled();
  });

  test('diffIds compares string and object ids alike', () => {
    expect(diffIds([{ toString: () => 'a' }, 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
    expect(diffIds(undefined, ['x'])).toEqual({ added: ['x'], removed: [] });
  });

  test('auditCatalogChange tolerates a missing user', async () => {
    await auditCatalogChange({}, 'catalog.test', 'c1');
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ actorId: null }));
  });
});
