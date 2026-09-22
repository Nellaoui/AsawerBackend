#!/usr/bin/env node
/**
 * Stock orphan report - read-only.
 *
 * Answers "which stock has no product in the app?" two ways:
 *   1. StockVariant rows in the database whose product link is missing or dead.
 *   2. References in a stock worksheet file that match no product serial.
 *
 * Usage:
 *   node scripts/stockOrphanReport.js                  # database only
 *   node scripts/stockOrphanReport.js --sheet ./x.json # also check a worksheet
 *   node scripts/stockOrphanReport.js --csv out.csv    # write the orphans to CSV
 *
 * Worksheet format (same shape the September sheets were transcribed into):
 *   { "sheets": [ { "img": "...", "date": "...", "rows": [
 *       { "ref": "GOU 147", "bucket": "", "variant": "", "tq": [["9mm", 4]] }
 *   ] } ] }
 *
 * Matching rules, mirroring how the paper sheets relate to product serials:
 *   - `bucket: "sirtie"` rows are ignored entirely.
 *   - `bucket: "sample"` looks for the reference with an " S" suffix.
 *   - A size ending in `mm` is a HEIGHT and may be part of the serial itself
 *     (`GOU 147` + `11mm` -> `GOU 147 11 MM`). A plain number is a size and
 *     stays a size.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const SHEET = flag('--sheet');
const CSV = flag('--csv');

const key = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isHeight = (size) => /mm$/i.test(String(size));
const heightValue = (size) => String(size).replace(/mm$/i, '').trim();

const candidatesFor = (row, size) => {
  const suffixes = row.bucket === 'sample' ? [' S'] : [''];
  const bases = row.variant ? [`${row.ref} ${row.variant}`, row.ref] : [row.ref];
  const out = [];
  for (const base of bases) {
    for (const suffix of suffixes) {
      if (isHeight(size)) {
        out.push(`${base} ${heightValue(size)} MM${suffix}`);
        out.push(`${base} ${heightValue(size)}MM${suffix}`);
      }
      out.push(`${base}${suffix}`);
    }
  }
  return out;
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/product-portfolio');
  const Product = require('../models/Product');
  const StockVariant = require('../models/StockVariant');

  const products = await Product.find({}).select('serialNumber name type').lean();
  const bySerial = new Map();
  const byId = new Map();
  for (const product of products) {
    byId.set(String(product._id), product);
    const k = key(product.serialNumber);
    if (!k) continue;
    if (!bySerial.has(k)) bySerial.set(k, []);
    bySerial.get(k).push(product);
  }
  console.log(`products: ${products.length}`);

  const orphanRows = [];

  // ---- 1. StockVariant rows whose product link is broken -------------------
  const variants = await StockVariant.find({}).lean();
  const deadVariants = variants.filter((variant) => {
    const ids = (variant.productIds || []).map(String);
    const alive = ids.filter((id) => byId.has(id));
    return alive.length === 0;
  });
  console.log(`stock variants: ${variants.length}  with no live product: ${deadVariants.length}`);
  for (const variant of deadVariants) {
    orphanRows.push({
      source: 'stock-variant',
      reference: variant.displayReference || variant.canonicalReference,
      size: variant.size,
      quantity: variant.onHandQuantity,
      note: 'StockVariant has no live product'
    });
  }

  // ---- 2. Worksheet references with no product ----------------------------
  if (SHEET) {
    const file = path.resolve(SHEET);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let matched = 0, matchedUnits = 0, skipped = 0, skippedUnits = 0;
    const missing = new Map();

    for (const sheet of data.sheets || []) {
      for (const row of sheet.rows || []) {
        if (row.bucket === 'sirtie') {
          skipped += row.tq.length;
          skippedUnits += row.tq.reduce((sum, [, q]) => sum + (q || 0), 0);
          continue;
        }
        for (const [size, quantity] of row.tq) {
          const hit = candidatesFor(row, size)
            .map((candidate) => bySerial.get(key(candidate)))
            .find((hits) => hits && hits.length);
          if (hit) {
            matched += 1;
            matchedUnits += quantity || 0;
            continue;
          }
          const label = [row.ref, row.bucket, row.variant].filter(Boolean).join(' ');
          if (!missing.has(label)) missing.set(label, { sizes: [], units: 0, sheet: sheet.img });
          const entry = missing.get(label);
          entry.sizes.push(size);
          entry.units += quantity || 0;
        }
      }
    }

    console.log('');
    console.log(`sheet ${path.basename(file)}`);
    console.log(`  ignored (sirtie): ${skipped} rows, ${skippedUnits} units`);
    console.log(`  matched         : ${matched} rows, ${matchedUnits} units`);
    console.log(`  no product      : ${[...missing.values()].reduce((s, m) => s + m.sizes.length, 0)} rows, ` +
                `${[...missing.values()].reduce((s, m) => s + m.units, 0)} units, ${missing.size} references`);
    console.log('');
    console.log('  REFERENCES THAT NEED A PRODUCT');
    for (const [label, entry] of [...missing.entries()].sort((a, b) => b[1].units - a[1].units)) {
      console.log(`    ${label.padEnd(30)} ${String(entry.units).padStart(4)}u  ${entry.sheet}  sizes: ${entry.sizes.join(', ')}`);
      orphanRows.push({
        source: entry.sheet,
        reference: label,
        size: entry.sizes.join(' | '),
        quantity: entry.units,
        note: 'no product with this serial'
      });
    }
  }

  if (CSV) {
    const header = 'source,reference,size,quantity,note\n';
    const body = orphanRows
      .map((r) => [r.source, r.reference, r.size, r.quantity, r.note]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    fs.writeFileSync(path.resolve(CSV), header + body + '\n', 'utf8');
    console.log('');
    console.log(`wrote ${orphanRows.length} orphan rows -> ${path.resolve(CSV)}`);
  }

  await mongoose.disconnect();
})().catch((error) => {
  console.error('ERROR', error.message);
  process.exit(1);
});
