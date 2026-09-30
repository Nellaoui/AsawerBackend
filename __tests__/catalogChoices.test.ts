export {};

const { pickCatalogChoices, catalogNameKey } = require('../utils/catalogChoices');

describe('catalogue pickers list each name once', () => {
  test('keeps the twin holding the most products and remembers the others', () => {
    const choices = pickCatalogChoices([
      { _id: 'a', name: 'Bagues', isPublic: true, productCount: 2 },
      { _id: 'b', name: 'bagues ', isPublic: true, productCount: 14 },
      { _id: 'c', name: 'Bagues', isPublic: false, productCount: 0 },
      { _id: 'd', name: 'Colliers', isPublic: true, productCount: 3 },
    ]);
    expect(choices.map((c: any) => c._id)).toEqual(['b', 'd']);
    expect(choices[0].sameNameIds).toEqual(['a', 'c']);
    expect(choices[1].sameNameIds).toEqual([]);
  });

  test('prefers a public catalogue when the counts tie', () => {
    const choices = pickCatalogChoices([
      { _id: 'x', name: 'Or', isPublic: false, productCount: 1 },
      { _id: 'y', name: 'Or', isPublic: true, productCount: 1 },
    ]);
    expect(choices).toHaveLength(1);
    expect(choices[0]._id).toBe('y');
  });

  test('name key ignores case and extra spaces', () => {
    expect(catalogNameKey('  Bagues   Or ')).toBe(catalogNameKey('bagues or'));
  });
});
