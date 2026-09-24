const normalizeText = (value) => String(value || '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, ' ');

const displayStockReference = (value) => {
  const cleaned = normalizeText(value).replace(/^BRA[\s_-]*/i, '').trim();
  return cleaned ? `BRA ${cleaned}` : '';
};

// The workshop writes the same bracelet two ways. A plain reference is the set
// piece, and the unset one carries an S:
//
//   BRA 628 sertie  ==  BRA 628
//   BRA 628 simple  ==  BRA 628 S
//
// Sheets spell it out in words, the catalogue uses the short form, and before
// this the two never matched - the sheet row landed in "counted stock with no
// product" even though the product existed. Folding the words into the short
// form here means matching sees one reference. Only the canonical form is
// folded: `displayStockReference` keeps whatever the sheet actually said, so a
// row still reads the way the person who counted it wrote it.
const foldSetWords = (value) => value
  .replace(/\b(simples?)\b/gi, 'S')
  .replace(/\b(serties?|sertis?)\b/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const canonicalStockReference = (value) => foldSetWords(displayStockReference(value))
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');

// Every product reference is written the same way once it is stored:
// family, one space, number, then any qualifier - BRA 312, BRA 312 S.
// The shop writes bra312, BRA-312, BRA312 sertie and BRA 312 Simple for what
// is one product, so normalise on the way in rather than letting the
// catalogue collect five spellings of the same bracelet.
// Unlike displayStockReference this keeps the real family (GOU, COL, BO...)
// instead of forcing BRA onto everything.
const normalizeProductReference = (value) => {
  const folded = foldSetWords(normalizeText(value));
  const match = folded.match(/^([A-Za-z]+)[s_-]*([0-9]+)s*(.*)$/);
  if (!match) return folded.toUpperCase();
  const [, family, number, rest] = match;
  const tail = rest.trim().replace(/s+/g, " ").toUpperCase();
  return [family.toUpperCase(), number, tail].filter(Boolean).join(" ");
};

// Two references are the same product when this matches. Leading zeros are
// kept on purpose: BRA 028 and BRA 28 are different bracelets.
const canonicalProductReference = (value) => normalizeProductReference(value)
  .normalize("NFKD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^A-Z0-9]/g, "");

const normalizeStockSize = (value) => {
  const cleaned = normalizeText(value).replace(',', '.').toUpperCase();
  return cleaned.replace(/\.0+$/, '');
};

module.exports = {
  canonicalStockReference,
  canonicalProductReference,
  displayStockReference,
  normalizeProductReference,
  normalizeStockSize
};
