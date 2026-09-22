#!/usr/bin/env node
/**
 * Apply transcribed worksheet stock to StockVariant records.
 *
 * ADDITIVE: quantities are added to onHandQuantity, never overwritten. Every
 * touched row is tagged with a syncBatchId so a batch can be reversed.
 *
 *   node scripts/applySheetStock.js --in matched.json                 # dry run
 *   node scripts/applySheetStock.js --in matched.json --apply
 *   node scripts/applySheetStock.js --revert sheets-2026-09-21
 *
 * Input is the matched-rows array produced by the sheet matcher:
 *   [{ serial, size, qty, ref, bucket, variant, img }]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { normalizeStockSize } = require('../utils/stockReference');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const APPLY = args.includes('--apply');
const IN = flag('--in');
const REVERT = flag('--revert');
const BATCH = flag('--batch') || 'sheets-2026-09-21';
const METHOD = (flag('--method') || 'wax').toLowerCase();
const SOURCE_SHEET = METHOD === 'resin' ? 'Resin' : 'Wax';

const canonical = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/product-portfolio');
  const Product = require('../models/Product');
  const StockVariant = require('../models/StockVariant');

  // ---- revert ------------------------------------------------------------
  if (REVERT) {
    const touched = await StockVariant.find({ syncBatchId: REVERT });
    console.log(`batch ${REVERT}: ${touched.length} variant(s)`);
    let removed = 0, decremented = 0;
    for (const variant of touched) {
      const delta = Number(variant.notes.match(/batchDelta=(\d+)/)?.[1] || 0);
      if (!APPLY) { console.log(`  would undo ${variant.displayReference} ${variant.size} -${delta}`); continue; }
      if (delta >= variant.onHandQuantity && variant.reservedQuantity === 0) {
        await StockVariant.deleteOne({ _id: variant._id });
        removed += 1;
      } else {
        variant.onHandQuantity = Math.max(0, variant.onHandQuantity - delta);
        variant.notes = variant.notes.replace(/\s*batchDelta=\d+/, '');
        variant.syncBatchId = '';
        await variant.save();
        decremented += 1;
      }
    }
    console.log(APPLY ? `reverted: ${removed} deleted, ${decremented} decremented` : '(dry run)');
    await mongoose.disconnect();
    return;
  }

  // ---- apply -------------------------------------------------------------
  if (!IN) throw new Error('--in <matched.json> is required');
  const rows = JSON.parse(fs.readFileSync(path.resolve(IN), 'utf8'));

  const serials = [...new Set(rows.map((r) => r.serial))];
  const products = await Product.find({ serialNumber: { $in: serials } }).select('serialNumber name type').lean();
  const bySerial = new Map(products.map((p) => [p.serialNumber, p]));

  let created = 0, updated = 0, units = 0, skipped = 0;
  const log = [];

  for (const row of rows) {
    const product = bySerial.get(row.serial);
    const quantity = Number(row.qty);
    if (!product || !Number.isSafeInteger(quantity) || quantity <= 0) { skipped += 1; continue; }

    const sizeKey = normalizeStockSize(row.size);
    if (!sizeKey) { skipped += 1; continue; }

    const selector = {
      canonicalReference: canonical(product.serialNumber),
      printMethod: METHOD,
      sizeKey
    };
    const existing = await StockVariant.findOne(selector);
    units += quantity;

    if (existing) {
      updated += 1;
      log.push(`  + ${product.serialNumber} ${row.size}  ${existing.onHandQuantity} -> ${existing.onHandQuantity + quantity}`);
      if (APPLY) {
        existing.onHandQuantity += quantity;
        existing.notes = `${existing.notes || ''} batchDelta=${quantity}`.trim();
        existing.syncBatchId = BATCH;
        existing.lastSyncedAt = new Date();
        if (!existing.productIds.some((id) => String(id) === String(product._id))) {
          existing.productIds.push(product._id);
        }
        await existing.save();
      }
    } else {
      created += 1;
      log.push(`  N ${product.serialNumber} ${row.size}  0 -> ${quantity}`);
      if (APPLY) {
        await StockVariant.create({
          ...selector,
          displayReference: product.serialNumber,
          productIds: [product._id],
          primaryProductId: product._id,
          size: String(row.size),
          onHandQuantity: quantity,
          reservedQuantity: 0,
          sourceQuantity: quantity,
          sourceSheet: SOURCE_SHEET,
          notes: `${row.img} ${row.bucket || ''} ${row.variant || ''} batchDelta=${quantity}`.replace(/\s+/g, ' ').trim(),
          lastSyncedAt: new Date(),
          syncBatchId: BATCH
        });
      }
    }
  }

  console.log(log.join('\n'));
  console.log('');
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}  batch=${BATCH}  method=${METHOD}`);
  console.log(`  new variants     : ${created}`);
  console.log(`  updated variants : ${updated}`);
  console.log(`  units added      : ${units}`);
  console.log(`  skipped rows     : ${skipped}`);
  if (!APPLY) console.log('\nre-run with --apply to write. Undo later with --revert ' + BATCH + ' --apply');

  await mongoose.disconnect();
})().catch((error) => {
  console.error('ERROR', error.message);
  process.exit(1);
});
