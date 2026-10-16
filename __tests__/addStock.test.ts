export {};

// Quick "Add stock": pieces are added to one size and clasp without overwriting anyone else's count.
jest.mock('express', () => ({ Router: () => ({
  stack: [] as any[],
  get: jest.fn(), put: jest.fn(), delete: jest.fn(), patch: jest.fn(),
  post(path: string, ...handlers: any[]) { this.stack.push({ route: { path, stack: handlers.map(handle => ({ handle })) } }); },
}) }), { virtual: true });
jest.mock('../models/Product', () => ({ findById: jest.fn() }));
jest.mock('../models/SizePreset', () => ({ find: () => ({ lean: async () => [] }) }));
jest.mock('../models/InventoryMovement', () => ({ create: jest.fn() }));
jest.mock('../models/StockVariant', () => ({ findOne: jest.fn(), findByIdAndUpdate: jest.fn(), create: jest.fn(), updateMany: jest.fn(), find: jest.fn() }));
jest.mock('../middlewares/auth', () => ({ operationsAuth: jest.fn() }));
jest.mock('../utils/stockCount', () => ({ recomputeProductStock: jest.fn().mockResolvedValue(undefined) }));

const Product = require('../models/Product');
const StockVariant = require('../models/StockVariant');
const InventoryMovement = require('../models/InventoryMovement');
const router = require('../routes/inventory');
const route = router.stack.find((layer: any) => layer.route?.path === '/products/:id/add-stock').route;
const handler = route.stack[route.stack.length - 1].handle;

const ID = '507f1f77bcf86cd799439011';
const request = (body: any) => ({ params: { id: ID }, user: { id: 'employee-id' }, body });
let response: any;

beforeEach(() => {
  jest.clearAllMocks();
  response = { status: jest.fn().mockReturnThis(), json: jest.fn(), headersSent: false };
  jest.spyOn(console, 'error').mockImplementation(() => {});
  Product.findById.mockResolvedValue({ _id: ID, serialNumber: 'GOU 191 S', type: 'Gourmette', availableSizes: ['18'], save: jest.fn() });
});

test('adds pieces to the existing clasp row instead of replacing its count', async () => {
  StockVariant.findOne.mockResolvedValueOnce({ _id: 'v1', onHandQuantity: 2, productIds: [ID] });
  StockVariant.findByIdAndUpdate.mockResolvedValue({ _id: 'v1', size: '18', clasp: 'MO_SIMPLE', printMethod: 'wax', onHandQuantity: 7, productIds: [ID] });
  await handler(request({ printMethod: 'wax', clasp: 'MO_SIMPLE', size: '18', quantity: 5 }), response);
  expect(StockVariant.findOne).toHaveBeenCalledWith(expect.objectContaining({ clasp: 'MO_SIMPLE', sizeKey: expect.any(String) }));
  expect(StockVariant.findByIdAndUpdate).toHaveBeenCalledWith('v1', { $inc: { onHandQuantity: 5 } }, { new: true });
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ onHandQuantity: 7, clasp: 'MO_SIMPLE' }));
  expect(InventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'receive', quantity: 5, stockBefore: 2, stockAfter: 7 }));
});

test('FR and FRN go to the product own stock (no clasp)', async () => {
  StockVariant.findOne.mockResolvedValue(null);
  StockVariant.create.mockResolvedValue({ _id: 'v2', size: '18', clasp: '', printMethod: 'wax', onHandQuantity: 3, productIds: [ID] });
  await handler(request({ printMethod: 'wax', clasp: 'FR', size: '18', quantity: 3 }), response);
  expect(StockVariant.create).toHaveBeenCalledWith(expect.objectContaining({ clasp: '', onHandQuantity: 3 }));
});

test.each([0, -2, 1.5, '', null])('refuses quantity %j', async quantity => {
  await handler(request({ printMethod: 'wax', size: '18', quantity }), response);
  expect(response.status).toHaveBeenCalledWith(400);
  expect(Product.findById).not.toHaveBeenCalled();
});

test('refuses a missing size', async () => {
  await handler(request({ printMethod: 'wax', size: '', quantity: 1 }), response);
  expect(response.status).toHaveBeenCalledWith(400);
});
