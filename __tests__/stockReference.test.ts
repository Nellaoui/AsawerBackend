export {};

const {
  canonicalStockReference,
  displayStockReference,
  normalizeStockSize,
} = require('../utils/stockReference');

describe('folding "simple" and "sertie" into the short reference', () => {
  test('the pairs the workshop actually uses match', () => {
    expect(canonicalStockReference('BRA 628 simple')).toBe(canonicalStockReference('BRA 628 S'));
    expect(canonicalStockReference('BRA 628 sertie')).toBe(canonicalStockReference('BRA 628'));
  });

  test('simple becomes S and sertie disappears', () => {
    expect(canonicalStockReference('BRA 628 simple')).toBe('BRA628S');
    expect(canonicalStockReference('BRA 628 sertie')).toBe('BRA628');
  });

  test('the set and unset pieces stay apart from each other', () => {
    expect(canonicalStockReference('BRA 628 simple')).not.toBe(canonicalStockReference('BRA 628 sertie'));
  });

  test('the words are folded however the sheet spaces or cases them', () => {
    for (const written of ['BRA649 simple', 'BRA 649 SIMPLE', 'bra649  Simple', 'BRA-649 simples']) {
      expect(canonicalStockReference(written)).toBe('BRA649S');
    }
    for (const written of ['BRA650 sertie', 'BRA 650 SERTIE', 'bra650  Sertie', 'BRA_650 serti']) {
      expect(canonicalStockReference(written)).toBe('BRA650');
    }
  });

  test('a reference with no BRA prefix folds the same way', () => {
    expect(canonicalStockReference('668 sertie')).toBe('BRA668');
    expect(canonicalStockReference('684 sertie')).toBe(canonicalStockReference('684'));
  });

  test('a qualifier after the word survives the fold', () => {
    // '668 sertie M2' is the M2 mould of the set piece, not a different family.
    expect(canonicalStockReference('668 sertie M2')).toBe('BRA668M2');
    expect(canonicalStockReference('668 sertie M2')).not.toBe(canonicalStockReference('668 sertie'));
  });

  test('other qualifiers are left alone', () => {
    expect(canonicalStockReference('BRA309 carre')).toBe('BRA309CARRE');
    expect(canonicalStockReference('BRA309 cercle')).toBe('BRA309CERCLE');
    expect(canonicalStockReference('BRA309 carre')).not.toBe(canonicalStockReference('BRA309 cercle'));
  });

  test('a word that merely contains the letters is not folded', () => {
    // Nothing in the catalogue should lose part of a longer word.
    expect(canonicalStockReference('BRA 700 simplex')).toBe('BRA700SIMPLEX');
    expect(canonicalStockReference('BRA 700 sertissage')).toBe('BRA700SERTISSAGE');
  });

  test('the display reference keeps what the counter wrote', () => {
    expect(displayStockReference('BRA628 sertie')).toBe('BRA 628 sertie');
    expect(displayStockReference('628 simple')).toBe('BRA 628 simple');
  });
});

describe('reference normalisation that was already in place', () => {
  test('the BRA prefix is optional and folded away', () => {
    expect(canonicalStockReference('BRA636 S')).toBe(canonicalStockReference('636 S'));
    expect(canonicalStockReference('BRA 200')).toBe(canonicalStockReference('BRA200'));
  });

  test('accents and punctuation do not split a reference', () => {
    expect(canonicalStockReference('BRA 309 carré')).toBe('BRA309CARRE');
  });

  test('an empty reference stays empty rather than becoming a bare prefix', () => {
    expect(canonicalStockReference('')).toBe('');
    expect(canonicalStockReference(null)).toBe('');
    expect(displayStockReference('   ')).toBe('');
  });

  test('sizes normalise independently of the reference', () => {
    expect(normalizeStockSize('16,5')).toBe('16.5');
    expect(normalizeStockSize('17.0')).toBe('17');
  });
});
