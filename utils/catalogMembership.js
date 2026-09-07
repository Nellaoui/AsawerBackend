const catalogProductIdSet = (catalog) => new Set(
  (catalog?.products || []).map(product => String(product?._id || product))
);

const catalogIncludesProduct = (productIds, productId) => productIds.has(String(productId));

module.exports = { catalogIncludesProduct, catalogProductIdSet };
