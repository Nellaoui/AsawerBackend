// Catalogue pickers show each name once.
//
// The app used to accept a new catalogue whose name was already taken, so the
// database can hold several catalogues called "Bagues". A picker lists one of
// them - the one holding the most products, then a public one, then the
// oldest - and records the others in `sameNameIds` so a product sitting in a
// twin still finds its catalogue in the list.
const catalogNameKey = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

const pickCatalogChoices = (catalogs) => {
  const groups = new Map();
  for (const catalog of catalogs) {
    const key = catalogNameKey(catalog.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(catalog);
  }
  const rank = (catalog) => [-(catalog.productCount || 0), catalog.isPublic === false ? 1 : 0, String(catalog._id)];
  const compare = (a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i += 1) {
      if (ra[i] < rb[i]) return -1;
      if (ra[i] > rb[i]) return 1;
    }
    return 0;
  };
  const choices = [...groups.values()].map((group) => {
    const [main, ...twins] = [...group].sort(compare);
    return { ...main, sameNameIds: twins.map(twin => String(twin._id)) };
  });
  return choices.sort((a, b) => catalogNameKey(a.name).localeCompare(catalogNameKey(b.name)));
};

module.exports = { catalogNameKey, pickCatalogChoices };
