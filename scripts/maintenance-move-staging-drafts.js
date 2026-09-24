// One-off: move staging drafts into their catalogue by prefix (kept inactive).
require('dotenv').config();
const mongoose = require('mongoose');
const Catalog = require('../models/Catalog');
const Product = require('../models/Product');
const AuditLog = require('../models/AuditLog');
const STAGING = '6ab43a145101a96f66c8456b';
const MAP = [[/^BA\b/i, '6a763210450ef2bdc513f253'], [/^BRA\b/i, '693076cff9e91e6c191eda05'], [/^GOU\b/i, '69f8e8015657beec11ad8387']];
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const drafts = await Product.find({ catalogId: STAGING }).select('serialNumber isActive').lean();
  const moves = {};
  for (const p of drafts) {
    const hit = MAP.find(([re]) => re.test(p.serialNumber));
    if (hit) (moves[hit[1]] = moves[hit[1]] || []).push(p);
  }
  for (const [catalogId, products] of Object.entries(moves)) {
    const ids = products.map(p => p._id);
    await Product.updateMany({ _id: { $in: ids } }, { $set: { catalogId, isActive: false } });
    await Catalog.updateOne({ _id: STAGING }, { $pull: { products: { $in: ids } } });
    await Catalog.updateOne({ _id: catalogId }, { $addToSet: { products: { $each: ids } } });
    await AuditLog.create({ category: 'inventory', action: 'staging_drafts_moved_to_catalog', actorId: 'system:photo-stock-import', entityType: 'catalog', entityId: catalogId, details: { references: products.map(p => p.serialNumber) } });
    console.log(catalogId, products.length);
  }
  console.log('left in staging', await Product.countDocuments({ catalogId: STAGING }));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
