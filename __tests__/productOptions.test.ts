export {};
const options = require('../utils/productOptions');

const presets = {
  bague: { availableSizes: ['52', '50'] },
  collier: { availableSizes: ['45', '40'], applyToAll: true },
  gourmette: { availableSizes: ['18'] },
};

describe('productOptionsFor', () => {
  it('gives bague and bracelet the preset sizes', () => {
    expect(options.productOptionsFor('Bague', { availableSizes: ['60'] }, presets).availableSizes).toEqual(['50', '52']);
  });

  it('keeps the typed sizes for a preset type when presets are unknown', () => {
    expect(options.productOptionsFor('bracelet', { availableSizes: ['5.5', '5.5'] }).availableSizes).toEqual(['5.5']);
  });

  it('uses the preset for a category switched to apply to all', () => {
    expect(options.productOptionsFor('collier', { availableSizes: ['60'] }, presets).availableSizes).toEqual(['40', '45']);
  });

  it('never stores sizes for boucle or pendantif', () => {
    expect(options.productOptionsFor('Boucle', { availableSizes: ['One size'] }, presets).availableSizes).toEqual([]);
    expect(options.productOptionsFor('pendantif', { availableSizes: ['3'] }).availableSizes).toEqual([]);
  });

  it('no longer has any height option', () => {
    const col = options.productOptionsFor('Collier', { availableHeights: ['6', '4'], availableClasps: ['FR'] });
    expect(col).toEqual({ availableSizes: [], availableWidths: [], availableClasps: ['FR'] });
    expect(options.presetHeights).toBeUndefined();
    expect(options.typeHasHeights).toBeUndefined();
  });

  it('keeps clasps only for gourmette and collier', () => {
    const gou = options.productOptionsFor('Gourmette', { availableSizes: ['19', '18'], availableClasps: ['SIMPLE', 'FR', 'XX'] }, presets);
    expect(gou).toEqual({ availableSizes: ['18', '19'], availableWidths: [], availableClasps: ['FR', 'SIMPLE'] });
    const bague = options.productOptionsFor('bague', { availableClasps: ['FR'] }, presets);
    expect(bague.availableClasps).toEqual([]);
    expect(options.productOptionsFor('collier', { availableClasps: ['FR'] }).availableClasps).toEqual(['FR']);
  });

  it('includes the FR clasp', () => {
    expect(options.CLASP_TYPES).toContain('FR');
    expect(options.CLASP_LABELS.FR).toBe('FR');
  });
});

describe('stockClaspFor', () => {
  it('keeps FR, FRN and no clasp on the product own stock', () => {
    for (const clasp of ['FR', 'FRN', '', undefined, 'unknown']) {
      expect(options.stockClaspFor('Collier', clasp)).toBe('');
    }
  });

  it('counts every other clasp of a collier or gourmette on its own', () => {
    expect(options.stockClaspFor('Collier', 'MO_SIMPLE')).toBe('MO_SIMPLE');
    expect(options.stockClaspFor('gourmette', 'SIMPLE')).toBe('SIMPLE');
  });

  it('ignores a clasp on types that have none', () => {
    expect(options.stockClaspFor('Bague', 'MO_SIMPLE')).toBe('');
  });
});

describe('StockVariant clasp', () => {
  it('allows one row per clasp for the same size', () => {
    const StockVariant = require('../models/StockVariant');
    const unique = StockVariant.schema.indexes().find(([, o]: any) => o.unique);
    expect(unique[0]).toEqual({ canonicalReference: 1, printMethod: 1, sizeKey: 1, clasp: 1, width: 1 });
    expect(StockVariant.schema.path('width').options.default).toBe('');
    expect(StockVariant.schema.path('clasp').options.default).toBe('');
  });
});

describe('widths', () => {
  it('keeps widths only for collier and gourmette, as plain mm numbers', () => {
    const gou = options.productOptionsFor('Gourmette', { availableSizes: ['18'], availableWidths: ['5 mm', '3', '5', ''] }, presets);
    expect(gou.availableWidths).toEqual(['3', '5']);
    expect(options.productOptionsFor('collier', { availableWidths: ['4'] }, presets).availableWidths).toEqual(['4']);
    expect(options.productOptionsFor('bague', { availableWidths: ['4'] }, presets).availableWidths).toEqual([]);
  });

  it('no widths ticked means the product has none', () => {
    expect(options.productOptionsFor('gourmette', { availableSizes: ['18'] }, presets).availableWidths).toEqual([]);
  });

  it('stock width is empty for types without widths', () => {
    expect(options.stockWidthFor('gourmette', ' 5 mm ')).toBe('5');
    expect(options.stockWidthFor('bague', '5')).toBe('');
    expect(options.stockWidthFor('collier', undefined)).toBe('');
  });
});
