export {};

// Isolate the route handlers so these tests never connect to a real database.
// The router mock records both POST and PATCH so the create and setup handlers
// can be pulled out and called directly.
jest.mock('express', () => ({ Router: () => ({
  stack: [] as any[],
  get: jest.fn(),
  delete: jest.fn(),
  post(path: string, ...handlers: any[]) {
    this.stack.push({ method: 'post', route: { path, stack: handlers.map(handle => ({ handle })) } });
  },
  patch(path: string, ...handlers: any[]) {
    this.stack.push({ method: 'patch', route: { path, stack: handlers.map(handle => ({ handle })) } });
  },
}) }), { virtual: true });
jest.mock('../models/Product', () => ({ create: jest.fn(), findOne: jest.fn(), findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/InventoryMovement', () => ({ create: jest.fn() }));
jest.mock('../models/Order', () => ({}));
jest.mock('../models/WorkflowCase', () => ({}));
jest.mock('../models/StockVariant', () => ({ aggregate: jest.fn() }));
jest.mock('../models/StockOrphan', () => ({ find: jest.fn(), aggregate: jest.fn() }));
jest.mock('../middlewares/auth', () => ({ operationsAuth: jest.fn() }));
jest.mock('../utils/workflowAssignment', () => ({ findTeamAssignee: jest.fn() }));
jest.mock('../utils/workflowRules', () => ({ teamForStatus: jest.fn(), targetMinutesForTeam: jest.fn() }));
jest.mock('../utils/workflowNotifications', () => ({ notifyCaseAssignment: jest.fn() }));

const Product = require('../models/Product');
const router = require('../routes/inventory');

const pick = (method: string, path: string) => {
  const layer = router.stack.find((entry: any) => entry.method === method && entry.route?.path === path);
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} is not registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const setupHandler = pick('patch', '/products/:id/setup');
const createHandler = pick('post', '/products');

const PRODUCT_ID = '507f1f77bcf86cd799439011';
const PHOTO = 'https://res.cloudinary.com/demo/image/upload/v1/products/ba-150.jpg';

const makeResponse = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() } as any);
const request = (body: any) => ({ params: { id: PRODUCT_ID }, user: { id: 'employee-id' }, body });

describe('completing a flagged product from the portal', () => {
  let product: any;
  let response: any;

  beforeEach(() => {
    jest.clearAllMocks();
    product = {
      _id: PRODUCT_ID,
      name: 'Bague 150',
      serialNumber: 'BA 150 5mm',
      type: 'Bague',
      imageUrl: 'https://via.placeholder.com/150',
      price: 0,
      isActive: false,
      fulfillmentPolicy: 'stock_then_print',
      printMethod: 'none',
      availableSizes: [],
      stockSyncState: 'needs_details',
      setupIssue: { open: true, note: 'Needs image, price and details.' },
      save: jest.fn().mockResolvedValue(undefined),
    };
    Product.findById.mockResolvedValue(product);
    response = makeResponse();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test('a photo and a supply route publish the product and close the issue', async () => {
    await setupHandler(request({ imageUrl: PHOTO, fulfillmentPolicy: 'stock_only', printMethod: 'none' }), response);

    expect(product.imageUrl).toBe(PHOTO);
    expect(product.isActive).toBe(true);
    expect(product.stockSyncState).toBe('manual');
    expect(product.setupIssue.open).toBe(false);
    expect(product.setupIssue.resolvedBy).toBe('employee-id');
    expect(product.save).toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ ready: true }));
  });

  test('no price is not a reason to hold a product back', async () => {
    await setupHandler(request({ imageUrl: PHOTO, fulfillmentPolicy: 'stock_only' }), response);

    expect(product.price).toBe(0);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ ready: true }));
  });

  test('a price of zero is accepted and stored', async () => {
    await setupHandler(request({ imageUrl: PHOTO, price: 0, fulfillmentPolicy: 'stock_only' }), response);

    expect(product.price).toBe(0);
    expect(response.status).not.toHaveBeenCalledWith(400);
  });

  test('a photo alone leaves the product unfinished when it has no supply route', async () => {
    await setupHandler(request({ imageUrl: PHOTO }), response);

    expect(product.isActive).toBe(false);
    expect(product.setupIssue.open).toBe(true);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      ready: false,
      stillMissing: { image: false, supplyRoute: true },
    }));
  });

  test('a supply route alone leaves the product unfinished when it has no photo', async () => {
    await setupHandler(request({ fulfillmentPolicy: 'stock_only' }), response);

    expect(product.isActive).toBe(false);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      ready: false,
      stillMissing: { image: true, supplyRoute: false },
    }));
  });

  test('the placeholder image is never accepted as a real photo', async () => {
    await setupHandler(request({ imageUrl: 'https://via.placeholder.com/150' }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(product.save).not.toHaveBeenCalled();
  });

  test('a non-http image value is rejected rather than stored', async () => {
    await setupHandler(request({ imageUrl: 'javascript:alert(1)' }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(product.imageUrl).toBe('https://via.placeholder.com/150');
  });

  test('a negative price is rejected', async () => {
    await setupHandler(request({ price: -5 }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(product.save).not.toHaveBeenCalled();
  });

  test('an unknown print method is rejected', async () => {
    await setupHandler(request({ printMethod: 'clay' }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(product.save).not.toHaveBeenCalled();
  });

  test('a sheet-synced product stays synced when it is completed', async () => {
    product.stockSyncState = 'synced';
    await setupHandler(request({ imageUrl: PHOTO, fulfillmentPolicy: 'stock_only' }), response);

    expect(product.stockSyncState).toBe('synced');
    expect(product.isActive).toBe(true);
  });

  test('sizes and name are trimmed and empty entries dropped', async () => {
    await setupHandler(request({ name: '  Bague 150 5mm  ', availableSizes: [' 54 ', '', '56'] }), response);

    expect(product.name).toBe('Bague 150 5mm');
    expect(product.availableSizes).toEqual(['54', '56']);
  });

  test('an empty name is rejected instead of wiping the product name', async () => {
    await setupHandler(request({ name: '   ' }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(product.name).toBe('Bague 150');
  });

  test('a missing product answers 404', async () => {
    Product.findById.mockResolvedValue(null);
    await setupHandler(request({ imageUrl: PHOTO }), response);

    expect(response.status).toHaveBeenCalledWith(404);
  });

  test('an invalid id is refused before the database is touched', async () => {
    await setupHandler({ params: { id: 'not-an-id' }, user: { id: 'employee-id' }, body: {} }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(Product.findById).not.toHaveBeenCalled();
  });
});

describe('creating a product from the portal', () => {
  let response: any;

  beforeEach(() => {
    jest.clearAllMocks();
    Product.findOne.mockResolvedValue(null);
    Product.create.mockImplementation(async (doc: any) => ({ ...doc, _id: PRODUCT_ID, toObject: () => ({ ...doc, _id: PRODUCT_ID }) }));
    response = makeResponse();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const body = (extra: any = {}) => ({
    name: 'Bague 150 5mm', serialNumber: 'BA 150 5mm', type: 'Bague', ...extra,
  });

  test('a product created with a photo and a supply route is live immediately', async () => {
    await createHandler({ user: { id: 'employee-id' }, body: body({ imageUrl: PHOTO, fulfillmentPolicy: 'stock_only' }) }, response);

    const created = Product.create.mock.calls[0][0];
    expect(created.imageUrl).toBe(PHOTO);
    expect(created.isActive).toBe(true);
    expect(created.stockSyncState).toBe('manual');
    expect(created.setupIssue.open).toBe(false);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ ready: true }));
  });

  test('a product created without a photo still becomes a draft with an open issue', async () => {
    await createHandler({ user: { id: 'employee-id' }, body: body({ note: 'Counted on the wax sheet' }) }, response);

    const created = Product.create.mock.calls[0][0];
    expect(created.imageUrl).toBe('https://via.placeholder.com/150');
    expect(created.isActive).toBe(false);
    expect(created.stockSyncState).toBe('needs_details');
    expect(created.setupIssue.open).toBe(true);
    expect(created.setupIssue.note).toBe('Counted on the wax sheet');
  });

  test('a price given at creation is kept, and an absent one becomes zero', async () => {
    await createHandler({ user: { id: 'employee-id' }, body: body({ price: 240.5 }) }, response);
    expect(Product.create.mock.calls[0][0].price).toBe(240.5);

    Product.create.mockClear();
    await createHandler({ user: { id: 'employee-id' }, body: body() }, response);
    expect(Product.create.mock.calls[0][0].price).toBe(0);
  });

  test('an unknown supply route falls back to the safe default rather than failing', async () => {
    await createHandler({ user: { id: 'employee-id' }, body: body({ fulfillmentPolicy: 'teleport', printMethod: 'clay' }) }, response);

    const created = Product.create.mock.calls[0][0];
    expect(created.fulfillmentPolicy).toBe('stock_then_print');
    expect(created.printMethod).toBe('none');
    expect(created.isActive).toBe(false);
  });

  test('a duplicate reference is refused with the existing product id', async () => {
    Product.findOne.mockResolvedValue({ _id: 'existing-id' });
    await createHandler({ user: { id: 'employee-id' }, body: body() }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(Product.create).not.toHaveBeenCalled();
  });
});
