jest.mock('../middlewares/auth', () => ({ auth: (req: any, res: any, next: any) => next() }));
jest.mock('../utils/pushNotification', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../models/Catalog', () => ({ findById: jest.fn(), find: jest.fn() }));

const Catalog = require('../models/Catalog');
const router = require('../routes/catalogs');
const { limitRelatedProducts } = require('../utils/relatedProductAccess');

const catalogAccess = (id: string, allowed: string[], isPublic = false) => ({
  _id: id,
  hasUserAccess: (userId: string) => isPublic || allowed.includes(userId),
});

const related = (id: string, catalogId: string | null) => ({ _id: id, name: id, catalogId });
const product = (id: string, relatedProducts: any[]) => ({ _id: id, productId: id, relatedProducts });

describe('related products respect catalogue access', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a customer does not get related products that only live in a private catalogue', async () => {
    Catalog.find.mockResolvedValue([catalogAccess('public', [], true), catalogAccess('tawfik-private', ['tawfik'])]);
    const [result] = await limitRelatedProducts(
      [product('p1', [related('ok', 'public'), related('secret', 'tawfik-private'), related('loose', null)])],
      { id: 'yassine', role: 'user' }
    );
    expect(result.relatedProducts.map((r: any) => r._id)).toEqual(['ok', 'loose']);
  });

  test('the same product is kept for the customer who may enter that catalogue', async () => {
    Catalog.find.mockResolvedValue([catalogAccess('tawfik-private', ['tawfik'])]);
    const [result] = await limitRelatedProducts([product('p1', [related('secret', 'tawfik-private')])], { id: 'tawfik', role: 'user' });
    expect(result.relatedProducts).toHaveLength(1);
  });

  test('a related product from a catalogue that no longer exists is dropped', async () => {
    Catalog.find.mockResolvedValue([]);
    const [result] = await limitRelatedProducts([product('p1', [related('gone', 'deleted')])], { id: 'yassine', role: 'user' });
    expect(result.relatedProducts).toEqual([]);
  });

  test('admins see everything and no lookup is made', async () => {
    const products = [product('p1', [related('secret', 'tawfik-private')])];
    expect(await limitRelatedProducts(products, { id: 'a', role: 'admin' })).toBe(products);
    expect(Catalog.find).not.toHaveBeenCalled();
  });

  test('GET /:id applies the filter to the catalogue a customer opens', async () => {
    const open = {
      _id: { toString: () => 'public' },
      hasUserAccess: () => true,
      toObject: () => ({ name: 'Public', products: [product('p1', [related('secret', 'tawfik-private')])].map(p => ({ ...p })) }),
    };
    Catalog.findById.mockReturnValue({ populate: () => Promise.resolve(open) });
    Catalog.find.mockResolvedValue([catalogAccess('tawfik-private', ['tawfik'])]);
    const handle = router.stack.find((l: any) => l.route?.path === '/:id' && l.route.methods.get).route.stack.slice(-1)[0].handle;
    let body: any;
    await handle({ params: { id: 'public' }, user: { id: 'yassine', role: 'user' } }, { json: (b: any) => { body = b; }, status: () => ({ json: (b: any) => { body = b; } }) });
    expect(body.products[0].relatedProducts).toEqual([]);
  });
});
