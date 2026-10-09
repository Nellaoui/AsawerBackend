const Sartla = require('../utils/sartla');
const productOptions = require('../utils/productOptions');

const BRA_490 = { _id: 'b490', serialNumber: 'BRA 490' };

describe('sartla bracelet lists', () => {
  test('SARTLA 490 is linked to BRA 490', () => {
    expect(Sartla.linkedBraceletReference('SARTLA 490')).toBe('BRA 490');
    expect(Sartla.linkedBraceletReference('sartla-490 s')).toBe('BRA 490 S');
    expect(Sartla.linkedBraceletReference('SARTLA')).toBe('');
  });

  test('a default list fills the count with the linked bracelet', () => {
    expect(Sartla.defaultSet(5, BRA_490)).toEqual({
      count: 5, price: 0, bracelets: [{ productId: 'b490', reference: 'BRA 490', quantity: 5 }],
    });
  });

  test('a list may mix bracelets but must add up to its count', () => {
    const mixed = Sartla.cleanSets([{ count: 5, bracelets: [{ reference: 'BRA 490', quantity: 3 }, { reference: 'BRA 312', quantity: 2 }] }]);
    expect(mixed.error).toBeUndefined();
    expect(mixed.sets[0].bracelets).toHaveLength(2);

    expect(Sartla.cleanSets([{ count: 5, bracelets: [{ reference: 'BRA 490', quantity: 4 }] }]).error)
      .toMatch(/holds 4 bracelet\(s\)\. It must hold 5/);
    expect(Sartla.cleanSets([{ count: 4, bracelets: [{ reference: 'BRA 490', quantity: 4 }] }]).error)
      .toMatch(/3, 5 or 7/);
    expect(Sartla.cleanSets([{ count: 3, bracelets: [{ reference: '', quantity: 3 }] }]).error)
      .toMatch(/Write a bracelet reference/);
  });

  test('an empty list means that count is not offered', () => {
    const { sets } = Sartla.cleanSets([
      { count: 7, bracelets: [{ productId: 'b490', quantity: 7 }] },
      { count: 3, bracelets: [] },
    ]);
    expect(sets.map((set: { count: number }) => set.count)).toEqual([7]);
    expect(Sartla.offeredCounts({ sartlaSets: sets })).toEqual([7]);
  });

  test('lines naming the same bracelet are merged', () => {
    expect(Sartla.mergeLines([
      { productId: 'b490', quantity: 2 },
      { productId: 'b312', quantity: 1 },
      { productId: 'b490', quantity: 2 },
    ])).toEqual([{ productId: 'b490', quantity: 4 }, { productId: 'b312', quantity: 1 }]);
  });

  test('making sartlas from bracelets multiplies each line', () => {
    const set = { count: 5, bracelets: [{ productId: 'b490', reference: 'BRA 490', quantity: 3 }, { productId: 'b312', reference: 'BRA 312', quantity: 2 }] };
    expect(Sartla.braceletsNeeded(set, 2)).toEqual([
      { productId: 'b490', reference: 'BRA 490', quantity: 6 },
      { productId: 'b312', reference: 'BRA 312', quantity: 4 },
    ]);
  });

  test('finished sartlas are counted per size and bracelet count', () => {
    expect(Sartla.stockSize('5.4', 5)).toBe('5.4 x5');
    expect(Sartla.stockSize('', 3)).toBe('x3');
  });

  test('a count with its own price uses it, otherwise the product price', () => {
    const product = { price: 100, sartlaSets: [{ count: 3, price: 0, bracelets: [{ productId: 'b', quantity: 3 }] }, { count: 5, price: 150, bracelets: [{ productId: 'b', quantity: 5 }] }] };
    expect(Sartla.priceFor(product, 3)).toBe(100);
    expect(Sartla.priceFor(product, 5)).toBe(150);
  });

  test('a sartla offers the bracelet sizes from Size Presets', () => {
    const presets = { bracelet: { availableSizes: ['5.4', '5.6'] } };
    expect(productOptions.usesPresetSizes('Sartla', presets)).toBe(true);
    expect(productOptions.presetSizes('Sartla', presets)).toEqual(['5.4', '5.6']);
    expect(productOptions.productOptionsFor('Sartla', {}, presets).availableSizes).toEqual(['5.4', '5.6']);
  });
});
