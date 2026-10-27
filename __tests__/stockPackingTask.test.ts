const { stockLinesNeedingPacking } = require('../utils/packingNeeds');

describe('stockLinesNeedingPacking', () => {
  const items = [
    { _id: 'a', stockPickedQuantity: 2 },
    { _id: 'b', stockPickedQuantity: 0 },
    { _id: 'c', stockPickedQuantity: 1 },
  ];

  test('a finished stock check with picked units needs packing', () => {
    const cases = [{ requestType: 'stock_pick', status: 'completed', orderItemId: 'a' }];
    expect(stockLinesNeedingPacking({ cases, orderItems: items })).toEqual(['a']);
  });

  test('an open stock check or a check where nothing was found needs nothing', () => {
    const cases = [
      { requestType: 'stock_pick', status: 'stock_picking', orderItemId: 'a' },
      { requestType: 'stock_pick', status: 'completed', orderItemId: 'b' },
    ];
    expect(stockLinesNeedingPacking({ cases, orderItems: items })).toEqual([]);
  });

  test('a product that is also printed is packed through its print task', () => {
    const cases = [
      { requestType: 'stock_pick', status: 'completed', orderItemId: 'c' },
      { requestType: 'print_required', status: 'printing', orderItemId: 'c' },
    ];
    expect(stockLinesNeedingPacking({ cases, orderItems: items })).toEqual([]);
  });

  test('a cancelled print task does not hide the stock product', () => {
    const cases = [
      { requestType: 'stock_pick', status: 'completed', orderItemId: 'c' },
      { requestType: 'print_required', status: 'cancelled', orderItemId: 'c' },
    ];
    expect(stockLinesNeedingPacking({ cases, orderItems: items })).toEqual(['c']);
  });
});
