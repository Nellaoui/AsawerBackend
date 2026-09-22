export {};

const { buildCustomerInsights, recommendProducts } = require('../utils/customerInsights');

describe('customer analytics and product recommendations', () => {
  const product = {
    _id: '507f1f77bcf86cd799439011',
    name: 'BRA 539',
    serialNumber: 'BRA 539',
    imageUrl: 'https://example.test/bra-539.jpg',
    type: 'Bracelet',
    size: '5.5',
    availableSizes: ['5.5', '5.8'],
    relatedProducts: [],
    fulfillmentPolicy: 'print_on_demand',
    printMethod: 'wax',
    isActive: true,
    price: 200
  };

  test('summarizes customer orders without cancelled orders', () => {
    const insights = buildCustomerInsights([
      {
        status: 'delivered',
        totalAmount: 400,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T12:00:00.000Z',
        items: [{ productId: product, quantity: 2, size: '5.5', productionMethod: 'wax', printQuantity: 2 }]
      },
      {
        status: 'cancelled',
        totalAmount: 999,
        createdAt: '2026-09-02T10:00:00.000Z',
        items: [{ productId: product, quantity: 9, size: '5.8', productionMethod: 'resin', printQuantity: 9 }]
      }
    ], []);

    expect(insights.metrics.totalOrders).toBe(1);
    expect(insights.metrics.cancelledOrders).toBe(1);
    expect(insights.metrics.totalUnits).toBe(2);
    expect(insights.metrics.totalSpent).toBe(400);
    expect(insights.metrics.averageCompletionMinutes).toBe(120);
    expect(insights.routeBreakdown.wax).toBe(2);
    expect(insights.topSizes[0]).toEqual({ value: '5.5', count: 2 });
  });

  test('explains recommendations and enforces the customer printing route', () => {
    const insights = buildCustomerInsights([{
      status: 'delivered',
      totalAmount: 400,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z',
      items: [{ productId: product, quantity: 2, size: '5.5', productionMethod: 'wax', printQuantity: 2 }]
    }], []);
    const resinProduct = { ...product, _id: '507f1f77bcf86cd799439012', name: 'Resin bracelet', printMethod: 'resin' };

    const recommendations = recommendProducts({
      products: [product, resinProduct],
      insights,
      forcedProductionMethod: 'wax',
      wishlistProductIds: [String(product._id)],
      globalProductUnits: new Map([[String(product._id), 12]])
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].productId).toBe(String(product._id));
    expect(recommendations[0].reasons).toContain('saved in wishlist');
    expect(recommendations[0].reasons.some((reason: string) => reason.includes('preferred size'))).toBe(true);
  });

  test('does not recommend incomplete products', () => {
    const insights = buildCustomerInsights([], []);
    const recommendations = recommendProducts({
      products: [{ ...product, imageUrl: 'https://via.placeholder.com/150' }],
      insights,
      wishlistProductIds: [String(product._id)]
    });
    expect(recommendations).toEqual([]);
  });
});
