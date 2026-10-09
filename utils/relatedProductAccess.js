const Catalog = require('../models/Catalog');

// "Goes well with" products come from any catalogue, so a customer opening a
// public catalogue must not learn about products that only live in a private
// catalogue they are not allowed into. Admins see everything.
async function limitRelatedProducts(products, user) {
  if (!user || user.role === 'admin') return products;

  const catalogIds = new Set();
  for (const product of products || []) {
    for (const related of product?.relatedProducts || []) {
      if (related && typeof related === 'object' && related.catalogId) catalogIds.add(String(related.catalogId));
    }
  }
  if (!catalogIds.size) return products;

  const catalogs = await Catalog.find({ _id: { $in: [...catalogIds] } });
  const allowed = new Set(catalogs.filter(catalog => catalog.hasUserAccess(user.id)).map(catalog => String(catalog._id)));

  return (products || []).map(product => {
    if (!product || !Array.isArray(product.relatedProducts)) return product;
    return {
      ...product,
      relatedProducts: product.relatedProducts.filter(related => {
        // Not populated, or not in any catalogue: nothing to check.
        if (!related || typeof related !== 'object' || !related.catalogId) return true;
        return allowed.has(String(related.catalogId));
      }),
    };
  });
}

module.exports = { limitRelatedProducts };
