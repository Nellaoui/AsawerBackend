export {};

// Isolate the route handler so these tests never connect to a real database.
jest.mock('mongoose', () => ({
  startSession: jest.fn(),
  Types: { ObjectId: { isValid: (value: string) => /^[a-f\d]{24}$/i.test(value) } },
}), { virtual: true });
jest.mock('express', () => ({ Router: () => ({
  stack: [] as any[],
  get: jest.fn(),
  patch(path: string, ...handlers: any[]) {
    this.stack.push({ route: { path, stack: handlers.map(handle => ({ handle })) } });
  },
}) }), { virtual: true });
jest.mock('../models/Product', () => ({ updateOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/InventoryMovement', () => ({ create: jest.fn() }));
jest.mock('../middlewares/auth', () => ({ operationsAuth: jest.fn() }));

const mongoose = require('mongoose');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const router = require('../routes/inventory');
const route = router.stack.find((layer: any) => layer.route?.path === '/products/:id').route;
const handler = route.stack[route.stack.length - 1].handle;

describe('existing product stock receipts (mock database)', () => {
  let product: any;
  let session: any;
  let response: any;
  let sessionSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    session = { withTransaction: jest.fn(async (callback: () => Promise<void>) => callback()), endSession: jest.fn() };
    sessionSpy = jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    product = {
      _id: '507f1f77bcf86cd799439011', name: 'Existing bracelet', stock: 8, reservedStock: 2,
      lowStockThreshold: 3, stockLocation: 'Shelf B',
      save: jest.fn().mockResolvedValue(undefined), populate: jest.fn().mockResolvedValue(undefined),
    };
    Product.findById.mockReturnValue({ session: jest.fn().mockResolvedValue(product) });
    response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => { sessionSpy.mockRestore(); jest.restoreAllMocks(); });

  const request = (body: any) => ({ params: { id: '507f1f77bcf86cd799439011' }, user: { id: 'employee-id' }, body });

  test('adds units to the selected product and records the employee without changing reserved units/settings', async () => {
    await handler(request({ action: 'receive', quantity: 5, notes: 'Receipt 42' }), response);
    expect(product.stock).toBe(13);
    expect(product.reservedStock).toBe(2);
    expect(product.lowStockThreshold).toBe(3);
    expect(product.stockLocation).toBe('Shelf B');
    expect(Product.findById).toHaveBeenCalledWith(product._id);
    expect(product.save).toHaveBeenCalledWith({ session });
    expect(InventoryMovement.create).toHaveBeenCalledWith([expect.objectContaining({
      productId: product._id, actorId: 'employee-id', type: 'receive', quantity: 5,
      stockBefore: 8, stockAfter: 13, notes: 'Receipt 42',
    })], { session });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ productId: product._id, stock: 13, reservedStock: 2 }));
    expect(session.endSession).toHaveBeenCalled();
  });

  test.each([0, -1, 1.5, null, '', '5', Number.MAX_SAFE_INTEGER + 1])('rejects invalid receive quantity %j before database access', async quantity => {
    await handler(request({ action: 'receive', quantity }), response);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(mongoose.startSession).not.toHaveBeenCalled();
    expect(InventoryMovement.create).not.toHaveBeenCalled();
  });

  test('does not create a new product when the selected one no longer exists', async () => {
    Product.findById.mockReturnValue({ session: jest.fn().mockResolvedValue(null) });
    await handler(request({ action: 'receive', quantity: 5 }), response);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(InventoryMovement.create).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalled();
  });

  test('does not save a negative stock quantity', async () => {
    await handler(request({ action: 'remove', quantity: 9 }), response);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(product.save).not.toHaveBeenCalled();
  });

  test('allows an exact zero count without changing reservations', async () => {
    await handler(request({ action: 'set', quantity: 0 }), response);
    expect(product.stock).toBe(0);
    expect(product.reservedStock).toBe(2);
  });

  test('rejects stock overflow before saving', async () => {
    product.stock = Number.MAX_SAFE_INTEGER;
    await handler(request({ action: 'receive', quantity: 1 }), response);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(product.save).not.toHaveBeenCalled();
  });

  test('returns an error instead of hanging if the database session cannot start', async () => {
    sessionSpy.mockRejectedValueOnce(new Error('Database unavailable'));
    await handler(request({ action: 'receive', quantity: 1 }), response);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(product.save).not.toHaveBeenCalled();
  });

  test('initializes only a missing stock count at zero, without overwriting other fields', async () => {
    product.stock = 0;
    await handler(request({ action: 'receive', quantity: 5 }), response);
    expect(Product.updateOne).toHaveBeenCalledWith(
      { _id: product._id, stock: { $exists: false } },
      { $set: { stock: 0 } }, { session }
    );
    expect(product.stock).toBe(5);
    expect(product.reservedStock).toBe(2);
    expect(product.stockLocation).toBe('Shelf B');
  });
});
