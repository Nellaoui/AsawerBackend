// Which sizes and clasps a product type can have. Used by the backend
// routes and loaded as-is by the operations portal (window.ProductOptions), so
// both apply the same rules. The mobile app mirrors them in
// src/utils/productSizes.ts and src/utils/productClasps.ts.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProductOptions = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Every bague and bracelet offers the whole Size Presets list. A sartla is a
  // set of bracelets, so it offers the bracelet sizes.
  const PRESET_SIZE_TYPES = ['bague', 'bracelet', 'sartla'];
  // Earrings and pendants never have a size. Their stock is kept as "One size".
  const NO_SIZE_TYPES = ['boucle', 'pendantif'];
  const ONE_SIZE = 'One size';
  const CLASP_TYPES = ['FRN', 'FR', 'MO_PAVE', 'MO_SERTIE', 'MO_SIMPLE', 'SIMPLE'];
  const CLASP_LABELS = {
    FRN: 'FRN', FR: 'FR', MO_PAVE: 'MO Pavé', MO_SERTIE: 'MO Sertie', MO_SIMPLE: 'MO Simple', SIMPLE: 'Simple',
  };

  const normalizeType = (type) => {
    const lower = String(type || '').trim().toLowerCase();
    return lower === 'braclet' ? 'bracelet' : lower;
  };
  // The Size Presets entry a type reads its sizes from.
  const presetKey = (type) => (normalizeType(type) === 'sartla' ? 'bracelet' : normalizeType(type));
  const typeHasSizes = (type) => !NO_SIZE_TYPES.includes(normalizeType(type));
  const typeHasWidths = (type) => ['gourmette', 'collier'].includes(normalizeType(type));
  /** Width as stored on stock rows and orders: '5 mm' and '5' are the same. '' for types without widths. */
  const cleanWidth = (value) => String(value ?? '').trim().replace(/\s*mm$/i, '').trim();
  const stockWidthFor = (type, width) => (typeHasWidths(type) ? cleanWidth(width) : '');
  const typeHasClasps = (type) => ['gourmette', 'collier'].includes(normalizeType(type));

  /** True when every product of this type offers the preset sizes. */
  const usesPresetSizes = (type, presets) => {
    const t = normalizeType(type);
    if (!typeHasSizes(t)) return false;
    return PRESET_SIZE_TYPES.includes(t) || Boolean(presets && presets[presetKey(t)] && presets[presetKey(t)].applyToAll === true);
  };

  /** Trimmed, de-duplicated, numeric-aware sorted list of strings. */
  const cleanList = (values) => {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(values) ? values : []) {
      const value = String(raw == null ? '' : raw).trim();
      if (value && !seen.has(value.toLowerCase())) { seen.add(value.toLowerCase()); out.push(value); }
    }
    return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  };

  // FR and FRN are fixed to the product, so they share the product's own stock.
  // Every other clasp is counted on its own, with its own sizes.
  const PRODUCT_FIXED_CLASPS = ['FR', 'FRN'];
  /** The clasp a stock row is kept under: '' for the product's own stock. */
  const stockClaspFor = (type, clasp) => {
    const value = String(clasp == null ? '' : clasp).trim();
    if (!typeHasClasps(type) || !CLASP_TYPES.includes(value) || PRODUCT_FIXED_CLASPS.includes(value)) return '';
    return value;
  };

  /** Known clasp types only, in display order. */
  const cleanClasps = (values) => {
    const wanted = new Set((Array.isArray(values) ? values : []).map((v) => String(v == null ? '' : v).trim()));
    return CLASP_TYPES.filter((c) => wanted.has(c));
  };

  const presetSizes = (type, presets) => cleanList(presets && presets[presetKey(type)] && presets[presetKey(type)].availableSizes);

  /**
   * The size and clasp lists to store for a product of this type.
   * Sizes of preset types come from the presets when they are known.
   */
  const productOptionsFor = (type, input, presets) => {
    const body = input || {};
    let availableSizes = [];
    if (typeHasSizes(type)) {
      const fromPreset = usesPresetSizes(type, presets) ? presetSizes(type, presets) : [];
      availableSizes = fromPreset.length ? fromPreset : cleanList(body.availableSizes);
    }
    return {
      availableSizes,
      availableWidths: typeHasWidths(type) ? cleanList((Array.isArray(body.availableWidths) ? body.availableWidths : []).map(cleanWidth)) : [],
      availableClasps: typeHasClasps(type) ? cleanClasps(body.availableClasps) : [],
    };
  };

  return {
    PRESET_SIZE_TYPES, NO_SIZE_TYPES, ONE_SIZE, CLASP_TYPES, CLASP_LABELS,
    normalizeType, presetKey, typeHasSizes, typeHasWidths, cleanWidth, stockWidthFor, typeHasClasps, usesPresetSizes,
    PRODUCT_FIXED_CLASPS, stockClaspFor, cleanList, cleanClasps, presetSizes, productOptionsFor,
  };
});
