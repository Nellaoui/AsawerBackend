#!/usr/bin/env node
/**
 * Remove a handwritten STOCK OUT sheet from size stock.
 *
 *   node scripts/applyStockOut.js --in scripts/stock-out-2026-09-24.json          (dry run)
 *   node scripts/applyStockOut.js --in scripts/stock-out-2026-09-24.json --apply
 *
 * Only exact reference + size matches are deducted, never below what is not
 * reserved. Everything else is reported for manual follow-up. Runs once per batch.
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const StockVariant = require('../models/StockVariant');
const InventoryMovement = require('../models/InventoryMovement');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const { createDatabaseBackup } = require('../utils/backupService');
const { canonicalProductReference, canonicalStockReference, normalizeStockSize } = require('../utils/stockReference');

const args = process.argv.slice(2);
const inputPath = args[args.indexOf('--in') + 1];
const apply = args.includes('--apply');

const main = async () => {
  if (!args.includes('--in')) throw new Error('--in <stock-out.json> is required');
  const source = require(path.resolve(inputPath));
  await mongoose.connect(process.env.MONGODB_URI);
  if (await AuditLog.exists({ action: 'stock_out_batch_applied', entityId: source.batchId })) {
    throw new Error(`Batch ${source.batchId} was already applied`);
  }

  const lines = new Map();
  for (const item of source.items) {
    for (const [size, quantity] of Object.entries(item.sizes)) {
      const key = `${item.reference}|${size}`;
      const line = lines.get(key) || { reference: item.reference, size, quantity: 0, photos: [] };
      line.quantity += Number(quantity);
      if (!line.photos.includes(item.photo)) line.photos.push(item.photo);
      lines.set(key, line);
    }
  }

  const variants = await StockVariant.find({}).lean();
  const plan = [];
  const skipped = [];
  const short = [];
  for (const line of lines.values()) {
    const keys = [canonicalProductReference(line.reference), canonicalStockReference(line.reference)];
    const sizeKey = normalizeStockSize(line.size);
    const matches = variants.filter(v => keys.includes(v.canonicalReference) && v.sizeKey === sizeKey);
    if (!matches.length) { skipped.push(line); continue; }
    let remaining = line.quantity;
    for (const variant of matches) {
      const free = Math.max(Number(variant.onHandQuantity || 0) - Number(variant.reservedQuantity || 0), 0);
      const take = Math.min(free, remaining);
      if (take > 0) plan.push({ variant, take, line });
      remaining -= take;
    }
    if (remaining > 0) short.push({ ...line, missing: remaining });
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    batchId: source.batchId,
    unitsDeducted: plan.reduce((sum, row) => sum + row.take, 0),
    sizesTouched: plan.length,
    short: short.map(l => `${l.reference} ${l.size}: ${l.missing} more than in stock (${l.photos.join(', ')})`),
    skipped: skipped.map(l => `${l.reference} ${l.size} x${l.quantity} (${l.photos.join(', ')})`)
  };
  if (!apply) return console.log(JSON.stringify(report, null, 2));

  const admin = await User.findOne({ isAdmin: true }).select('_id');
  const actorId = admin?._id || 'system:stock-out';
  const backup = await createDatabaseBackup({ reason: `before_${source.batchId}`, actorId });
  report.backup = backup.fileName;

  const session = await mongoose.startSession();
  await session.withTransaction(async () => {
    for (const { variant, take, line } of plan) {
      const updated = await StockVariant.findOneAndUpdate(
        { _id: variant._id, onHandQuantity: variant.onHandQuantity },
        { $inc: { onHandQuantity: -take } },
        { new: true, session }
      );
      if (!updated) throw new Error(`Stock changed while applying ${line.reference} ${line.size}; nothing was saved`);
      const before = Number(variant.onHandQuantity);
      await InventoryMovement.create([{
        productId: variant.primaryProductId || variant.productIds[0],
        actorId,
        type: 'remove',
        quantity: -take,
        stockBefore: before,
        stockAfter: before - take,
        notes: `Stock out ${line.reference} size ${variant.size} (${line.photos.join(', ')}); batch=${source.batchId}`
      }], { session });
      await AuditLog.create([{
        category: 'inventory',
        action: 'stock_out_applied',
        actorId,
        entityType: 'stock_variant',
        entityId: String(variant._id),
        details: { batchId: source.batchId, reference: line.reference, size: variant.size, stockBefore: before, stockAfter: before - take, photos: line.photos }
      }], { session });
    }

    const productIds = [...new Set(plan.flatMap(({ variant }) => variant.productIds.map(String)))];
    const totals = await StockVariant.aggregate([
      { $unwind: '$productIds' },
      { $match: { productIds: { $in: productIds.map(id => new mongoose.Types.ObjectId(id)) } } },
      { $group: { _id: '$productIds', onHand: { $sum: '$onHandQuantity' }, reserved: { $sum: '$reservedQuantity' } } }
    ]).session(session);
    if (totals.length) {
      await Product.bulkWrite(totals.map(total => ({
        updateOne: {
          filter: { _id: total._id },
          update: { $set: { stock: Math.max(total.onHand - total.reserved, 0), reservedStock: total.reserved, updatedAt: new Date() } }
        }
      })), { session });
    }

    await AuditLog.create([{
      category: 'inventory',
      action: 'stock_out_batch_applied',
      actorId,
      entityType: 'stock_import_batch',
      entityId: source.batchId,
      details: { source: source.source, unitsDeducted: report.unitsDeducted, short: report.short, skipped: report.skipped, backup: backup.fileName }
    }], { session });
  });
  await session.endSession();
  console.log(JSON.stringify(report, null, 2));
};

main()
  .then(() => mongoose.disconnect())
  .catch(async error => {
    console.error('ERROR', error.message);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  });
