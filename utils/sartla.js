// A sartla is a set of 3, 5 or 7 bracelets sold as one piece. It has its own
// reference and photo (SARTLA 490) and usually holds the bracelet of the same
// series (BRA 490), though a set may mix bracelets. The customer picks how
// many bracelets they want; each count the shop makes has its own list.
//
// Used by the backend routes and loaded as-is by the operations portal
// (window.Sartla), so both apply the same rules. The mobile app mirrors the
// customer-facing parts in src/utils/sartla.ts.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Sartla = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SARTLA_COUNTS = [3, 5, 7];

  const isSartlaType = (type) => String(type || '').trim().toLowerCase() === 'sartla';
  const isBraceletType = (type) => ['bracelet', 'braclet'].includes(String(type || '').trim().toLowerCase());

  /** SARTLA 490 -> BRA 490, SARTLA-490 S -> BRA 490 S. Empty when there is no number. */
  const linkedBraceletReference = (reference) => {
    const match = String(reference || '').trim().match(/^[A-Za-z]*[\s_-]*([0-9]+)\s*(.*)$/);
    if (!match) return '';
    const tail = match[2].trim().replace(/\s+/g, ' ').toUpperCase();
    return ['BRA', match[1], tail].filter(Boolean).join(' ');
  };

  /** The list that fills a count with one bracelet. */
  const defaultSet = (count, bracelet) => ({
    count,
    price: 0,
    bracelets: bracelet ? [{ productId: String(bracelet._id || bracelet.productId || ''), reference: bracelet.serialNumber || bracelet.reference || '', quantity: count }] : [],
  });

  /**
   * Checks the bracelet lists sent for a sartla. Each count appears once, and
   * the bracelets in a list add up to that count. A line names its bracelet by
   * id or by reference (BRA 490); the caller checks both against the catalogue
   * and merges lines that turn out to be the same bracelet.
   */
  const cleanSets = (input) => {
    if (input === undefined || input === null) return { sets: [] };
    if (!Array.isArray(input)) return { error: 'The bracelet lists are not valid' };
    const sets = [];
    for (const raw of input) {
      const count = Number(raw && raw.count);
      if (!SARTLA_COUNTS.includes(count)) return { error: 'A sartla holds 3, 5 or 7 bracelets' };
      if (sets.some((set) => set.count === count)) return { error: `The ${count}-bracelet list is there twice` };
      const price = raw.price === undefined || raw.price === null || raw.price === '' ? 0 : Number(raw.price);
      if (!Number.isFinite(price) || price < 0) return { error: `The price for ${count} bracelets must be zero or more` };
      const bracelets = [];
      for (const line of Array.isArray(raw.bracelets) ? raw.bracelets : []) {
        const productId = String((line && line.productId) || '').trim();
        const reference = String((line && line.reference) || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        const quantity = Number(line && line.quantity);
        if (!productId && !reference) return { error: `Write a bracelet reference on every line of the ${count}-bracelet list` };
        if (!Number.isSafeInteger(quantity) || quantity < 1) return { error: `Each bracelet in the ${count}-bracelet list needs a number of 1 or more` };
        bracelets.push({ productId, reference, quantity });
      }
      if (!bracelets.length) continue; // an empty list means this count is not made
      const total = bracelets.reduce((sum, item) => sum + item.quantity, 0);
      if (total !== count) return { error: `The ${count}-bracelet list holds ${total} bracelet(s). It must hold ${count}.` };
      sets.push({ count, price, bracelets });
    }
    sets.sort((a, b) => a.count - b.count);
    return { sets };
  };

  /** Lines naming the same bracelet become one line. */
  const mergeLines = (bracelets) => {
    const out = [];
    for (const item of bracelets) {
      const same = out.find((line) => String(line.productId) === String(item.productId));
      if (same) same.quantity += item.quantity;
      else out.push({ ...item });
    }
    return out;
  };

  /** Counts a customer can choose, smallest first. */
  const offeredCounts = (product) => ((product && product.sartlaSets) || [])
    .filter((set) => SARTLA_COUNTS.includes(Number(set.count)) && (set.bracelets || []).length)
    .map((set) => Number(set.count))
    .sort((a, b) => a - b);

  const setFor = (product, count) => ((product && product.sartlaSets) || [])
    .find((set) => Number(set.count) === Number(count) && (set.bracelets || []).length) || null;

  /** What a customer pays for one sartla of this count. */
  const priceFor = (product, count) => {
    const set = setFor(product, count);
    return set && Number(set.price) > 0 ? Number(set.price) : Number((product && product.price) || 0);
  };

  /**
   * Finished sartlas are counted per size and per number of bracelets, so the
   * stock size reads "5.4 x5". A sartla without a size is just "x5".
   */
  const stockSize = (size, count) => [String(size || '').trim(), `x${count}`].filter(Boolean).join(' ');

  /** The bracelet lines needed to make `quantity` sartlas from this list. */
  const braceletsNeeded = (set, quantity) => ((set && set.bracelets) || [])
    .map((item) => ({ productId: String(item.productId), reference: item.reference || '', quantity: Number(item.quantity) * Number(quantity) }))
    .filter((item) => item.quantity > 0);

  const label = (count) => `${count} bracelets`;

  return {
    SARTLA_COUNTS, isSartlaType, isBraceletType, linkedBraceletReference, defaultSet,
    cleanSets, mergeLines, offeredCounts, setFor, priceFor, stockSize, braceletsNeeded, label,
  };
});
