export {};
const options = require('../utils/productOptions');

const presets = {
  bague: { availableSizes: ['52', '50'] },
  collier: { availableSizes: ['45', '40'], applyToAll: true },
  gourmette: { availableSizes: ['18'], availableHeights: ['5', '4'] },
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

  it('keeps heights for collier too, with its own preset list', () => {
    const col = options.productOptionsFor('Collier', { availableHeights: ['6', '4'], availableClasps: ['FR'] });
    expect(col.availableHeights).toEqual(['4', '6']);
    expect(options.presetHeights('collier', { collier: { availableHeights: ['3'] } })).toEqual(['3']);
  });

  it('keeps heights only for gourmette and collier, and clasps only for gourmette and collier', () => {
    const gou = options.productOptionsFor('Gourmette', { availableSizes: ['19', '18'], availableHeights: ['5', '4'], availableClasps: ['SIMPLE', 'FR', 'XX'] }, presets);
    expect(gou).toEqual({ availableSizes: ['18', '19'], availableHeights: ['4', '5'], availableClasps: ['FR', 'SIMPLE'] });
    const bague = options.productOptionsFor('bague', { availableHeights: ['4'], availableClasps: ['FR'] }, presets);
    expect(bague.availableHeights).toEqual([]);
    expect(bague.availableClasps).toEqual([]);
    expect(options.productOptionsFor('collier', { availableClasps: ['FR'] }).availableClasps).toEqual(['FR']);
  });

  it('includes the FR clasp', () => {
    expect(options.CLASP_TYPES).toContain('FR');
    expect(options.CLASP_LABELS.FR).toBe('FR');
  });
});
