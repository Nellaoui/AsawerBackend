jest.mock('../middlewares/auth', () => ({ auth: (req: any, res: any, next: any) => next() }));
jest.mock('../models/Wishlist', () => {
  const Wishlist: any = jest.fn().mockImplementation(() => ({ save: jest.fn().mockResolvedValue(undefined) }));
  Wishlist.findOne = jest.fn();
  return Wishlist;
});
jest.mock('../models/Product', () => ({ exists: jest.fn() }));

const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const router = require('../routes/wishlist');

const addHandler = router.stack
  .find((layer: any) => layer.route?.path === '/:productId' && layer.route.methods.post)
  .route.stack.slice(-1)[0].handle;

const run = async () => {
  const res: any = { status: jest.fn(() => res), json: jest.fn() };
  await addHandler({ params: { productId: 'p1' }, user: { id: 'u1' } }, res);
  return res;
};

describe('adding to the wishlist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Wishlist.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
  });

  test('saves a product that exists and is not there yet', async () => {
    Product.exists.mockResolvedValue({ _id: 'p1' });
    const res = await run();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('says 404 for a missing product and 400 for one already saved', async () => {
    Product.exists.mockResolvedValue(null);
    expect((await run()).status).toHaveBeenCalledWith(404);

    Product.exists.mockResolvedValue({ _id: 'p1' });
    Wishlist.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ _id: 'w1' }) }) });
    expect((await run()).status).toHaveBeenCalledWith(400);
  });
});
