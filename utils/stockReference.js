const normalizeText = (value) => String(value || '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, ' ');

const displayStockReference = (value) => {
  const cleaned = normalizeText(value).replace(/^BRA[\s_-]*/i, '').trim();
  return cleaned ? `BRA ${cleaned}` : '';
};

const canonicalStockReference = (value) => displayStockReference(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');

const normalizeStockSize = (value) => {
  const cleaned = normalizeText(value).replace(',', '.').toUpperCase();
  return cleaned.replace(/\.0+$/, '');
};

module.exports = {
  canonicalStockReference,
  displayStockReference,
  normalizeStockSize
};
