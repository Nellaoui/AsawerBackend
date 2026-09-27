// Which sizes, heights and clasps a product type can have. Used by the backend
// routes and loaded as-is by the operations portal (window.ProductOptions), so
// both apply the same rules. The mobile app mirrors them in
// src/utils/productSizes.ts and src/utils/productClasps.ts.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProductOptions = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Every bague and bracelet offers the whole Size Presets list.
  const PRESET_SIZE_TYPES = ['bague', 'bracelet'];
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
  const typeHasSizes = (type) => !NO_SIZE_TYPES.includes(normalizeType(type));
  const typeHasHeights = (type) => ['gourmette', 'collier'].includes(normalizeType(type));
  const typeHasClasps = (type) => ['gourmette', 'collier'].includes(normalizeType(type));

  /** True when every product of this type offers the preset sizes. */
  const usesPresetSizes = (type, presets) => {
    const t = normalizeType(type);
    if (!typeHasSizes(t)) return false;
    return PRESET_SIZE_TYPES.includes(t) || Boolean(presets && presets[t] && presets[t].applyToAll === true);
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

  /** Known clasp types only, in display order. */
  const cleanClasps = (values) => {
    const wanted = new Set((Array.isArray(values) ? values : []).map((v) => String(v == null ? '' : v).trim()));
    return CLASP_TYPES.filter((c) => wanted.has(c));
  };

  const presetSizes = (type, presets) => cleanList(presets && presets[normalizeType(type)] && presets[normalizeType(type)].availableSizes);
  const presetHeights = (type, presets) => (typeHasHeights(type)
    ? cleanList(presets && presets[normalizeType(type)] && presets[normalizeType(type)].availableHeights)
    : []);

  /**
   * The size, height and clasp lists to store for a product of this type.
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
      availableHeights: typeHasHeights(type) ? cleanList(body.availableHeights) : [],
      availableClasps: typeHasClasps(type) ? cleanClasps(body.availableClasps) : [],
    };
  };

  return {
    PRESET_SIZE_TYPES, NO_SIZE_TYPES, ONE_SIZE, CLASP_TYPES, CLASP_LABELS,
    normalizeType, typeHasSizes, typeHasHeights, typeHasClasps, usesPresetSizes,
    cleanList, cleanClasps, presetSizes, presetHeights, productOptionsFor,
  };
});
