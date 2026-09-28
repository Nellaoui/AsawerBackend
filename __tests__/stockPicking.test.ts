export {};

const Order = require('../models/Order');
const Product = require('../models/Product');
const StockVariant = require('../models/StockVariant');
const InventoryMovement = require('../models/InventoryMovement');
const { takePickedStockOffShelf } = require('../utils/stockPicking');

const orderId = '507f1f77bcf86cd799439011';
const itemId = '507f1f77bcf86cd799439031';
const productId = '507f1f77bcf86cd799439041';
const variantId = '507f1f77bcf86cd799439051';

const query = (value: any) => {
  const q: any = { session: jest.fn(() => q) };
  q.then = (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject);
  return q;
};

describe('stock team completes a stock picking task', () => {
  let order: any;
  let orderItem: any;
  const workflowCase = { requestType: 'stock_pick', orderId, orderItemId: itemId, quantity: 2 };
  const session = {};

  beforeEach(() => {
    orderItem = { _id: itemId, productId, inventoryVariantId: variantId, size: '54', stockQuantity: 2, stockPickedQuantity: 0 };
    order = {
      _id: orderId, orderNumber: 'ASW-1', inventoryState: 'reserved',
      items: { id: (id: string) => (id === itemId ? orderItem : null) }
    };
    jest.spyOn(Order, 'findById').mockImplementation(() => query(order));
    jest.spyOn(Order, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(StockVariant, 'findOneAndUpdate').mockResolvedValue({ _id: variantId, productIds: [productId], onHandQuantity: 3, reservedQuantity: 0 });
    jest.spyOn(Product, 'updateMany').mockResolvedValue({});
    jest.spyOn(Product, 'findOneAndUpdate').mockResolvedValue({ _id: productId, stock: 4, reservedStock: 0 });
    jest.spyOn(InventoryMovement, 'create').mockResolvedValue([]);
  });

  afterEach(() => jest.restoreAllMocks());

  test('takes the picked size units off the on-hand count', async () => {
    const taken = await takePickedStockOffShelf({ workflowCase, actorId: 'stock-user', session });
    expect(taken).toBe(2);
    expect(Order.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: orderId }),
      { $set: { 'items.$.stockPickedQuantity': 2 } },
      { session }
    );
    expect(StockVariant.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: variantId }),
      { $inc: { reservedQuantity: -2, onHandQuantity: -2 } },
      expect.anything()
    );
    expect(Product.updateMany).toHaveBeenCalledWith({ _id: { $in: [productId] } }, { $inc: { reservedStock: -2 } }, { session });
    const [[movement]] = (InventoryMovement.create as jest.Mock).mock.calls[0];
    expect(movement).toMatchObject({ quantity: -2, stockBefore: 5, stockAfter: 3 });
  });

  test('takes manual-stock units out of the reserved count', async () => {
    orderItem.inventoryVariantId = null;
    await takePickedStockOffShelf({ workflowCase, actorId: 'stock-user', session });
    expect(Product.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: productId, reservedStock: { $gte: 2 } },
      { $inc: { reservedStock: -2 } },
      expect.anything()
    );
    expect(StockVariant.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('does not take stock twice when the item was already picked', async () => {
    orderItem.stockPickedQuantity = 2;
    expect(await takePickedStockOffShelf({ workflowCase, actorId: 'stock-user', session })).toBe(0);
    expect(Order.updateOne).not.toHaveBeenCalled();
    expect(StockVariant.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('does not take stock when a concurrent completion claimed it first', async () => {
    (Order.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 0 });
    expect(await takePickedStockOffShelf({ workflowCase, actorId: 'stock-user', session })).toBe(0);
    expect(StockVariant.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('leaves orders without reserved stock alone', async () => {
    order.inventoryState = 'untracked';
    expect(await takePickedStockOffShelf({ workflowCase, actorId: 'stock-user', session })).toBe(0);
    expect(Order.updateOne).not.toHaveBeenCalled();
  });
});
