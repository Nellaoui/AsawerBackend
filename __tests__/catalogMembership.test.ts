const { catalogIncludesProduct, catalogProductIdSet } = require('../utils/catalogMembership');

describe('order catalog membership', () => {
  test('accepts a product listed by the selected catalog', () => {
    const listedProducts = catalogProductIdSet({ products: ['product-a', 'product-b'] });
    expect(catalogIncludesProduct(listedProducts, 'product-b')).toBe(true);
  });

  test('does not depend on a product primary catalog field', () => {
    const product = { _id: 'product-a', catalogId: 'primary-catalog' };
    const listedProducts = catalogProductIdSet({ products: [product._id] });
    expect(catalogIncludesProduct(listedProducts, product._id)).toBe(true);
  });

  test('rejects a product absent from the selected catalog list', () => {
    const listedProducts = catalogProductIdSet({ products: ['product-a'] });
    expect(catalogIncludesProduct(listedProducts, 'product-z')).toBe(false);
  });
});
