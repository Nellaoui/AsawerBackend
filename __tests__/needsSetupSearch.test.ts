export {};

// Isolate the route handler so these tests never connect to a real database.
jest.mock('express', () => ({ Router: () => ({
  stack: [] as any[],
  get(path: string, ...handlers: any[]) {
    this.stack.push({ route: { path, stack: handlers.map(handle => ({ handle })) } });
  },
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
}) }), { virtual: true });
jest.mock('../models/Product', () => ({ find: jest.fn() }));
jest.mock('../models/Catalog', () => ({ find: jest.fn() }));
jest.mock('../models/SizePreset', () => ({ find: () => ({ lean: async () => [] }) }));
jest.mock('../middlewares/auth', () => ({ operationsAuth: jest.fn() }));

const Product = require('../models/Product');
const Catalog = require('../models/Catalog');
const router = require('../routes/inventory');
const route = router.stack.find((layer: any) => layer.route?.path === '/needs-setup').route;
const handler = route.stack[route.stack.length - 1].handle;

const chain = (rows: any[]) => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) }) });

describe('products with an issue: search', () => {
  let response: any;
  beforeEach(() => {
    jest.clearAllMocks();
    response = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    Product.find.mockReturnValue(chain([{ _id: 'p1', name: 'Bague 150', catalogId: 'c1', imageUrl: '' }]));
    Catalog.find.mockImplementation((query: any) => (query?._id
      ? { select: () => ({ lean: async () => [{ _id: 'c1', name: 'Bagues' }] }) }
      : { distinct: async () => ['c1'] }));
  });

  it('lists every problem product when there is no search', async () => {
    await handler({ query: {}, user: { isAdmin: true } }, response);
    expect(Product.find).toHaveBeenCalledWith({});
    expect(response.json.mock.calls[0][0].products).toHaveLength(1);
  });

  it('matches name, reference, type and catalogue name', async () => {
    await handler({ query: { search: 'bag' }, user: { isAdmin: true } }, response);
    const filter = Product.find.mock.calls[0][0];
    const fields = filter.$or.map((condition: any) => Object.keys(condition)[0]);
    expect(fields).toEqual(['name', 'serialNumber', 'type', 'catalogId']);
    expect(filter.$or[0].name.test('BAGUE 150')).toBe(true);
    expect(filter.$or[3].catalogId).toEqual({ $in: ['c1'] });
  });

  it('treats search text literally', async () => {
    await handler({ query: { search: 'BA (5mm' }, user: { isAdmin: true } }, response);
    const filter = Product.find.mock.calls[0][0];
    expect(filter.$or[1].serialNumber.test('BA (5mm)')).toBe(true);
  });
});
