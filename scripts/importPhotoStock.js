#!/usr/bin/env node
/**
 * Import an approved handwritten stock count.
 *
 * Dry run:
 *   node scripts/importPhotoStock.js --in scripts/photo-stock-2026-09.json
 * Apply after review:
 *   node scripts/importPhotoStock.js --in scripts/photo-stock-2026-09.json --apply
 *
 * The import is idempotent for its batch id. Missing catalogue references are
 * created as inactive draft products in a private staging catalogue. Every
 * mutation is audited and a verified database backup is created first.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Catalog = require('../models/Catalog');
const Product = require('../models/Product');
const StockVariant = require('../models/StockVariant');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const Order = require('../models/Order');
const { createDatabaseBackup } = require('../utils/backupService');
const { canonicalProductReference, normalizeProductReference, normalizeStockSize } = require('../utils/stockReference');

const args = process.argv.slice(2);
const valueAfter = name => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
};
const inputPath = valueAfter('--in');
const apply = args.includes('--apply');

const inferType = reference => {
  if (/^BA\b/i.test(reference)) return 'Ring';
  if (/^BRA\b/i.test(reference)) return 'Bracelet';
  if (/^GOU\b/i.test(reference)) return 'Gourmette';
  if (/^COL\b/i.test(reference)) return 'Necklace';
  return 'Unclassified';
};

// New products land in the catalogue the app shows them in, chosen by
// reference prefix. Anything else waits in the staging catalogue to be placed
// by hand from the portal's Fix form.
const CATALOG_BY_PREFIX = [
  [/^BA\b/i, '6a763210450ef2bdc513f253'], // Bague
  [/^BRA\b/i, '693076cff9e91e6c191eda05'], // Braclet
  [/^GOU\b/i, '69f8e8015657beec11ad8387'] // gourmette - كورميط
];
const catalogIdFor = (reference, stagingCatalog) => {
  const match = CATALOG_BY_PREFIX.find(([pattern]) => pattern.test(reference));
  return match ? new mongoose.Types.ObjectId(match[1]) : stagingCatalog._id;
};

// Reuse inactive setup drafts too. They are real catalogue records waiting for
// images/details; creating another record would reintroduce duplicate products.
const unmerged = product => !product.mergedInto;

const loadRows = file => {
  const source = JSON.parse(fs.readFileSync(file, 'utf8'));
  const method = String(source.printMethod || '').toLowerCase();
  if (!source.batchId || !['wax', 'resin'].includes(method)) {
    throw new Error('Input requires batchId and printMethod (wax or resin)');
  }

  const grouped = new Map();
  for (const item of source.items || []) {
    const reference = normalizeProductReference(item.reference);
    const canonicalReference = canonicalProductReference(reference);
    for (const [rawSize, rawQuantity] of Object.entries(item.sizes || {})) {
      const size = String(rawSize).trim();
      const sizeKey = normalizeStockSize(size);
      const quantity = Number(rawQuantity);
      if (!canonicalReference || !sizeKey || !Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new Error(`Invalid row: ${item.reference} / ${rawSize} / ${rawQuantity}`);
      }
      const key = `${canonicalReference}|${method}|${sizeKey}`;
      const row = grouped.get(key) || {
        reference,
        canonicalReference,
        printMethod: method,
        size,
        sizeKey,
        quantity: 0,
        photos: []
      };
      row.quantity += quantity;
      if (!row.photos.includes(item.photo)) row.photos.push(item.photo);
      grouped.set(key, row);
    }
  }
  return { source, rows: [...grouped.values()] };
};

const getStagingCatalog = async ({ admin, session }) => {
  let catalog = await Catalog.findOne({ name: 'Stock imports - needs details' }).session(session);
  if (!catalog) {
    catalog = new Catalog({
      name: 'Stock imports - needs details',
      description: 'Inactive products created from physical stock counts. Add images and details before publishing.',
      ownerId: admin?._id || 'system:photo-stock-import',
      isPublic: false,
      products: []
    });
    await catalog.save({ session });
  }
  return catalog;
};

const main = async () => {
  if (!inputPath) throw new Error('--in <photo-stock.json> is required');
  const absoluteInput = path.resolve(inputPath);
  const { source, rows } = loadRows(absoluteInput);
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/product-portfolio');

  const allProducts = await Product.find({}).select('_id name serialNumber canonicalReference catalogId isActive mergedInto availableSizes printMethod stockSyncState').lean();
  const byReference = new Map();
  for (const product of allProducts.filter(unmerged)) {
    const canonical = canonicalProductReference(product.serialNumber || product.canonicalReference);
    if (!canonical) continue;
    if (!byReference.has(canonical)) byReference.set(canonical, []);
    byReference.get(canonical).push(product);
  }

  const references = new Map();
  for (const row of rows) {
    if (!references.has(row.canonicalReference)) references.set(row.canonicalReference, { display: row.reference, sizes: new Set() });
    references.get(row.canonicalReference).sizes.add(row.size);
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    batchId: source.batchId,
    method: source.printMethod,
    inputItems: (source.items || []).length,
    groupedVariants: rows.length,
    references: references.size,
    totalUnits: rows.reduce((sum, row) => sum + row.quantity, 0),
    matchedReferences: 0,
    draftProductsToCreate: [],
    duplicateActiveReferences: [],
    savedRouteMismatches: [],
    variantsToCreate: 0,
    variantsToUpdate: 0,
    unchangedVariants: 0,
    excluded: source.excluded || []
  };

  for (const [canonical, entry] of references) {
    const products = byReference.get(canonical) || [];
    if (!products.length) report.draftProductsToCreate.push(entry.display);
    else {
      report.matchedReferences += 1;
      if (products.length > 1) report.duplicateActiveReferences.push({ reference: entry.display, productIds: products.map(product => String(product._id)) });
      const mismatches = products.filter(product => product.printMethod && product.printMethod !== 'none' && product.printMethod !== source.printMethod);
      if (mismatches.length) {
        report.savedRouteMismatches.push({
          reference: entry.display,
          routes: mismatches.map(product => ({ productId: String(product._id), printMethod: product.printMethod }))
        });
      }
    }
  }

  const variants = await StockVariant.find({ printMethod: source.printMethod }).lean();
  const variantByKey = new Map(variants.map(variant => [`${variant.canonicalReference}|${variant.printMethod}|${variant.sizeKey}`, variant]));
  for (const row of rows) {
    const existing = variantByKey.get(`${row.canonicalReference}|${row.printMethod}|${row.sizeKey}`);
    if (!existing) report.variantsToCreate += 1;
    else if (existing.syncBatchId === source.batchId && Number(existing.sourceQuantity || 0) === row.quantity) report.unchangedVariants += 1;
    else report.variantsToUpdate += 1;
  }

  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    console.log('\nDry run only. Re-run with --apply after reviewing this report.');
    return;
  }

  // Only reservations on products this batch touches can collide with the import.
  const batchProductIds = [...references.keys()].flatMap(canonical => (byReference.get(canonical) || []).map(product => product._id));
  const activeReservations = await Order.countDocuments({
    inventoryState: 'reserved',
    items: { $elemMatch: { stockQuantity: { $gt: 0 }, productId: { $in: batchProductIds } } }
  });
  if (activeReservations) throw new Error(`Import stopped: ${activeReservations} active order(s) currently reserve stock for products in this batch`);

  const admin = await User.findOne({ isAdmin: true }).select('_id');
  const backup = await createDatabaseBackup({ reason: `before_${source.batchId}`, actorId: admin?._id || 'system:photo-stock-import' });
  report.backup = { id: String(backup._id), fileName: backup.fileName, checksum: backup.checksum };

  const session = await mongoose.startSession();
  await session.withTransaction(async () => {
    const stagingCatalog = await getStagingCatalog({ admin, session });
    const mutableByReference = new Map(byReference);
    const createdByCatalog = new Map();

    for (const [canonical, entry] of references) {
      let products = mutableByReference.get(canonical) || [];
      const sizes = [...entry.sizes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!products.length) {
        const product = new Product({
          name: entry.display,
          description: 'Created from the September 2026 physical stock count. Add an image, price and customer-facing details before publishing.',
          type: inferType(entry.display),
          serialNumber: entry.display,
          canonicalReference: canonical,
          imageUrl: 'https://via.placeholder.com/150',
          price: 0,
          stock: 0,
          reservedStock: 0,
          availableSizes: sizes,
          catalogId: catalogIdFor(entry.display, stagingCatalog),
          createdBy: admin?._id || 'system:photo-stock-import',
          isActive: false,
          fulfillmentPolicy: 'stock_then_print',
          printMethod: source.printMethod,
          stockSyncState: 'needs_details'
        });
        await product.save({ session });
        products = [product.toObject()];
        mutableByReference.set(canonical, products);
        const catalogKey = String(product.catalogId);
        if (!createdByCatalog.has(catalogKey)) createdByCatalog.set(catalogKey, []);
        createdByCatalog.get(catalogKey).push(product._id);
        await AuditLog.create([{
          category: 'inventory',
          action: 'draft_product_created_from_photo_stock',
          actorId: admin?._id || 'system:photo-stock-import',
          entityType: 'product',
          entityId: String(product._id),
          details: { batchId: source.batchId, reference: entry.display, sizes, printMethod: source.printMethod }
        }], { session });
      } else {
        const ids = products.map(product => product._id);
        const routeChanges = products.filter(product => product.printMethod !== source.printMethod);
        if (routeChanges.length) {
          await AuditLog.insertMany(routeChanges.map(product => ({
            category: 'inventory',
            action: 'product_print_route_set_from_photo_stock',
            actorId: admin?._id || 'system:photo-stock-import',
            entityType: 'product',
            entityId: String(product._id),
            details: {
              batchId: source.batchId,
              reference: entry.display,
              routeBefore: product.printMethod || 'none',
              routeAfter: source.printMethod
            }
          })), { session });
        }
        await Product.updateMany(
          { _id: { $in: ids } },
          {
            $set: {
              canonicalReference: canonical,
              printMethod: source.printMethod,
              fulfillmentPolicy: 'stock_then_print'
            },
            $addToSet: { availableSizes: { $each: sizes } }
          },
          { session }
        );
      }
    }

    for (const [catalogId, ids] of createdByCatalog) {
      await Catalog.updateOne({ _id: catalogId }, { $addToSet: { products: { $each: ids } } }, { session });
    }

    for (const row of rows) {
      const products = mutableByReference.get(row.canonicalReference) || [];
      if (!products.length) throw new Error(`No product resolved for ${row.reference}`);
      const productIds = products.map(product => product._id);
      const selector = { canonicalReference: row.canonicalReference, printMethod: row.printMethod, sizeKey: row.sizeKey };
      let variant = await StockVariant.findOne(selector).session(session);
      const before = variant ? Number(variant.onHandQuantity || 0) : 0;
      const priorBatchQuantity = variant?.syncBatchId === source.batchId ? Number(variant.sourceQuantity || 0) : 0;
      const delta = row.quantity - priorBatchQuantity;

      if (!variant) {
        variant = new StockVariant({
          ...selector,
          displayReference: row.reference,
          productIds,
          primaryProductId: productIds[0],
          size: row.size,
          onHandQuantity: row.quantity,
          reservedQuantity: 0,
          sourceQuantity: row.quantity,
          sourceSheet: source.printMethod === 'wax' ? 'Wax' : 'Resin',
          sourceRows: row.photos,
          notes: `Photos ${row.photos.join(', ')}; batch=${source.batchId}`,
          lastSyncedAt: new Date(),
          syncBatchId: source.batchId
        });
      } else {
        variant.displayReference = row.reference;
        variant.productIds = productIds;
        variant.primaryProductId = productIds[0];
        variant.size = row.size;
        variant.onHandQuantity = Math.max(before + delta, Number(variant.reservedQuantity || 0));
        variant.sourceQuantity = row.quantity;
        variant.sourceSheet = source.printMethod === 'wax' ? 'Wax' : 'Resin';
        variant.sourceRows = row.photos;
        variant.notes = `Photos ${row.photos.join(', ')}; batch=${source.batchId}`;
        variant.lastSyncedAt = new Date();
        variant.syncBatchId = source.batchId;
      }
      await variant.save({ session });
      await AuditLog.create([{
        category: 'inventory',
        action: 'photo_stock_imported',
        actorId: admin?._id || 'system:photo-stock-import',
        entityType: 'stock_variant',
        entityId: String(variant._id),
        details: {
          batchId: source.batchId,
          reference: row.reference,
          size: row.size,
          printMethod: row.printMethod,
          quantityFromPhotos: row.quantity,
          stockBefore: before,
          stockAfter: Number(variant.onHandQuantity || 0),
          delta,
          photos: row.photos
        }
      }], { session });
    }

    const totals = await StockVariant.aggregate([
      { $unwind: '$productIds' },
      { $group: { _id: '$productIds', onHand: { $sum: '$onHandQuantity' }, reserved: { $sum: '$reservedQuantity' } } }
    ]).session(session);
    if (totals.length) {
      await Product.bulkWrite(totals.map(total => ({
        updateOne: {
          filter: { _id: total._id },
          update: { $set: { stock: Math.max(Number(total.onHand || 0) - Number(total.reserved || 0), 0), reservedStock: Number(total.reserved || 0), updatedAt: new Date() } }
        }
      })), { session });
    }

    await AuditLog.create([{
      category: 'inventory',
      action: 'photo_stock_batch_imported',
      actorId: admin?._id || 'system:photo-stock-import',
      entityType: 'stock_import_batch',
      entityId: source.batchId,
      details: {
        source: source.source,
        printMethod: source.printMethod,
        references: report.references,
        groupedVariants: report.groupedVariants,
        totalUnits: report.totalUnits,
        createdDraftProducts: report.draftProductsToCreate,
        excluded: report.excluded,
        backupId: String(backup._id)
      }
    }], { session });
  });
  await session.endSession();

  const verification = await StockVariant.aggregate([
    { $match: { syncBatchId: source.batchId } },
    { $group: { _id: null, variants: { $sum: 1 }, units: { $sum: '$sourceQuantity' } } }
  ]);
  report.verification = verification[0] || { variants: 0, units: 0 };
  console.log(JSON.stringify(report, null, 2));
};

main()
  .then(() => mongoose.disconnect())
  .catch(async error => {
    console.error('ERROR', error.message);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  });
