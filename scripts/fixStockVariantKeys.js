#!/usr/bin/env node
/**
 * One-off: size stock added from the portal was keyed with the bracelet-only
 * reference form ("BA 659" -> "BRABA659"), so it never lined up with the
 * imported stock ("BA659"). Re-key those rows; where the correct row already
 * exists, fold the stray (empty) row into it.
 *
 *   node scripts/fixStockVariantKeys.js            (dry run)
 *   node scripts/fixStockVariantKeys.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const StockVariant = require('../models/StockVariant');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const { createDatabaseBackup } = require('../utils/backupService');
const { canonicalProductReference } = require('../utils/stockReference');

const apply = process.argv.includes('--apply');

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const variants = await StockVariant.find({}).lean();
  const byKey = new Map(variants.map(v => [`${v.canonicalReference}|${v.printMethod}|${v.sizeKey}`, v]));
  const stray = variants.filter(v => v.displayReference && canonicalProductReference(v.displayReference) !== v.canonicalReference);
  const plan = stray.map(v => {
    const target = byKey.get(`${canonicalProductReference(v.displayReference)}|${v.printMethod}|${v.sizeKey}`);
    return { stray: v, target };
  });
  const withStock = plan.filter(({ stray: v }) => v.onHandQuantity || v.reservedQuantity);
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    strayRows: stray.length,
    rekey: plan.filter(row => !row.target).length,
    foldIntoExisting: plan.filter(row => row.target).length,
    rowsHoldingStock: withStock.length
  };
  if (withStock.length) throw new Error(`Stopped: ${withStock.length} stray row(s) hold stock; review them by hand`);
  if (!apply) return console.log(report);

  const admin = await User.findOne({ isAdmin: true }).select('_id');
  const actorId = admin?._id || 'system:fix-stock-keys';
  const backup = await createDatabaseBackup({ reason: 'before_fix_stock_variant_keys', actorId });
  const session = await mongoose.startSession();
  await session.withTransaction(async () => {
    for (const { stray: v, target } of plan) {
      if (target) {
        await StockVariant.updateOne({ _id: target._id }, { $addToSet: { productIds: { $each: v.productIds } } }, { session });
        await StockVariant.deleteOne({ _id: v._id, onHandQuantity: 0, reservedQuantity: 0 }, { session });
      } else {
        await StockVariant.updateOne({ _id: v._id }, { $set: { canonicalReference: canonicalProductReference(v.displayReference) } }, { session });
      }
    }
    await AuditLog.create([{
      category: 'inventory',
      action: 'stock_variant_keys_fixed',
      actorId,
      entityType: 'stock_variant',
      entityId: 'bulk',
      details: { ...report, backup: backup.fileName, rows: plan.map(({ stray: v, target }) => ({ id: String(v._id), reference: v.displayReference, size: v.size, foldedInto: target ? String(target._id) : null })) }
    }], { session });
  });
  await session.endSession();
  console.log({ ...report, backup: backup.fileName });
};

main()
  .then(() => mongoose.disconnect())
  .catch(async error => {
    console.error('ERROR', error.message);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  });
