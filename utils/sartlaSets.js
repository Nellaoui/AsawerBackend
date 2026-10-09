const mongoose = require('mongoose');
const Product = require('../models/Product');
const Sartla = require('./sartla');
const { canonicalProductReference } = require('./stockReference');

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A sartla's bracelet lists, checked against the catalogue: every line must
// point at a real bracelet, named by id or by reference (BRA 490, bra490...).
// The stored reference is the bracelet's own spelling.
const resolveSartlaSets = async (input) => {
  const { sets, error } = Sartla.cleanSets(input);
  if (error) return { error };
  const lines = sets.flatMap(set => set.bracelets);
  const ids = [...new Set(lines.filter(item => item.productId).map(item => item.productId))];
  if (ids.some(id => !mongoose.Types.ObjectId.isValid(id))) return { error: 'A bracelet in the lists was not found' };
  const byId = new Map();
  if (ids.length) {
    for (const bracelet of await Product.find({ _id: { $in: ids } }).select('_id serialNumber type').lean()) byId.set(String(bracelet._id), bracelet);
  }
  const byReference = new Map();
  for (const reference of new Set(lines.filter(item => !item.productId).map(item => item.reference))) {
    const canonical = canonicalProductReference(reference);
    const number = (reference.match(/[0-9]+/) || [])[0];
    const candidates = number
      ? await Product.find({ serialNumber: new RegExp(`(^|[^0-9])${number}([^0-9]|$)`), mergedInto: null }).select('_id serialNumber type').limit(100).lean()
      : await Product.find({ serialNumber: new RegExp(`^\\s*${escapeRegExp(reference)}\\s*$`, 'i'), mergedInto: null }).select('_id serialNumber type').limit(100).lean();
    const matches = candidates.filter(row => canonicalProductReference(row.serialNumber) === canonical);
    byReference.set(reference, matches.find(row => Sartla.isBraceletType(row.type)) || matches[0] || null);
  }
  for (const set of sets) {
    for (const item of set.bracelets) {
      const bracelet = item.productId ? byId.get(item.productId) : byReference.get(item.reference);
      if (!bracelet) return { error: `${item.reference || 'A bracelet'} was not found. Check the reference in the ${set.count}-bracelet list.` };
      if (!Sartla.isBraceletType(bracelet.type)) return { error: `${bracelet.serialNumber} is not a bracelet` };
      item.productId = String(bracelet._id);
      item.reference = bracelet.serialNumber;
    }
    set.bracelets = Sartla.mergeLines(set.bracelets);
  }
  return { sets };
};


module.exports = { resolveSartlaSets };
