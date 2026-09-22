const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Catalog = require('../models/Catalog');
const Product = require('../models/Product');
const StockVariant = require('../models/StockVariant');
const User = require('../models/User');
const snapshot = require('./stock-sheet-snapshot.json');
const {
  canonicalStockReference,
  displayStockReference,
  normalizeStockSize
} = require('../utils/stockReference');

const applyChanges = process.argv.includes('--apply');

const chooseStockCatalog = async () => {
  if (process.env.STOCK_IMPORT_CATALOG_ID && mongoose.Types.ObjectId.isValid(process.env.STOCK_IMPORT_CATALOG_ID)) {
    return Catalog.findById(process.env.STOCK_IMPORT_CATALOG_ID);
  }
  const candidates = await Catalog.find({ name: /^braclet$/i });
  return candidates.sort((a, b) => (b.products?.length || 0) - (a.products?.length || 0))[0] || null;
};

const groupedRows = () => {
  const variants = new Map();
  for (const row of snapshot.rows || []) {
    const canonicalReference = canonicalStockReference(row.reference);
    const displayReference = displayStockReference(row.reference);
    const sizeKey = normalizeStockSize(row.size);
    const printMethod = String(row.printMethod || '').toLowerCase();
    const quantity = Number(row.quantity);
    if (!canonicalReference || !sizeKey || !['wax', 'resin'].includes(printMethod) || !Number.isSafeInteger(quantity) || quantity < 0) continue;
    const key = `${canonicalReference}|${printMethod}|${sizeKey}`;
    const existing = variants.get(key) || {
      canonicalReference,
      displayReference,
      printMethod,
      size: String(row.size).trim(),
      sizeKey,
      onHandQuantity: 0,
      sourceSheet: row.sourceSheet,
      sourceRows: [],
      notes: []
    };
    existing.onHandQuantity += quantity;
    existing.sourceRows.push(Number(row.sourceRow));
    if (row.notes && !existing.notes.includes(String(row.notes).trim())) existing.notes.push(String(row.notes).trim());
    variants.set(key, existing);
  }
  return [...variants.values()];
};

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/product-portfolio');
  const catalog = await chooseStockCatalog();
  if (!catalog) throw new Error('No bracelet catalog found. Set STOCK_IMPORT_CATALOG_ID before syncing.');

  const admin = await User.findOne({ isAdmin: true }).select('_id');
  const variants = groupedRows();
  const methodsByReference = new Map();
  const sizesByReference = new Map();
  const displayByReference = new Map();
  for (const variant of variants) {
    if (!methodsByReference.has(variant.canonicalReference)) methodsByReference.set(variant.canonicalReference, new Set());
    if (!sizesByReference.has(variant.canonicalReference)) sizesByReference.set(variant.canonicalReference, new Set());
    methodsByReference.get(variant.canonicalReference).add(variant.printMethod);
    sizesByReference.get(variant.canonicalReference).add(variant.size);
    displayByReference.set(variant.canonicalReference, variant.displayReference);
  }

  const allProducts = await Product.find({}).sort({ createdAt: 1 });
  const productsByReference = new Map();
  for (const product of allProducts) {
    const canonicalReference = canonicalStockReference(product.serialNumber || product.canonicalReference);
    if (!canonicalReference) continue;
    if (!productsByReference.has(canonicalReference)) productsByReference.set(canonicalReference, []);
    productsByReference.get(canonicalReference).push(product);
  }

  const report = {
    mode: applyChanges ? 'applied' : 'dry-run',
    sourceRows: snapshot.rows?.length || 0,
    stockVariants: variants.length,
    references: methodsByReference.size,
    matchedReferences: 0,
    createdDraftProducts: [],
    existingDuplicateReferences: [],
    variantsToCreate: 0,
    variantsToUpdate: 0,
    initialQuantityToCreate: 0,
    sourceQuantityDelta: 0,
    catalog: { id: String(catalog._id), name: catalog.name }
  };

  const batchId = `sheet-${new Date(snapshot.capturedAt || Date.now()).toISOString()}`;
  const createdProductIds = [];

  for (const [canonicalReference, methods] of methodsByReference) {
    let products = productsByReference.get(canonicalReference) || [];
    const sizes = [...sizesByReference.get(canonicalReference)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const displayReference = displayByReference.get(canonicalReference);
    const method = methods.size === 1 ? [...methods][0] : 'none';

    if (!products.length) {
      report.createdDraftProducts.push(displayReference);
      if (applyChanges) {
        const product = await Product.create({
          name: displayReference,
          description: 'Created from the stock worksheet. Add the image, price and customer-facing details before publishing.',
          type: 'Bracelet',
          serialNumber: displayReference,
          canonicalReference,
          imageUrl: 'https://via.placeholder.com/150',
          price: 0,
          stock: 0,
          reservedStock: 0,
          availableSizes: sizes,
          catalogId: catalog._id,
          createdBy: admin?._id || 'stock-sheet-sync',
          isActive: false,
          fulfillmentPolicy: 'stock_then_print',
          printMethod: method,
          stockSyncState: 'needs_details'
        });
        products = [product];
        productsByReference.set(canonicalReference, products);
        createdProductIds.push(product._id);
      }
    } else {
      report.matchedReferences += 1;
      if (products.length > 1) {
        report.existingDuplicateReferences.push({ reference: displayReference, productIds: products.map(product => String(product._id)) });
      }
      if (applyChanges) {
        for (const product of products) {
          product.canonicalReference = canonicalReference;
          product.availableSizes = [...new Set([...(product.availableSizes || []).map(String), ...sizes])]
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          if (!product.printMethod || product.printMethod === 'none') product.printMethod = method;
          if (product.stockSyncState === 'manual') product.stockSyncState = 'synced';
          await product.save();
        }
      }
    }

    if (!products.length) continue;
    const primaryProduct = products.find(product => String(product.catalogId) === String(catalog._id)) || products[0];
    const productIds = products.map(product => product._id);
    const referenceVariants = variants.filter(variant => variant.canonicalReference === canonicalReference);
    for (const variant of referenceVariants) {
      const key = {
        canonicalReference,
        printMethod: variant.printMethod,
        sizeKey: variant.sizeKey
      };
      const existingVariant = await StockVariant.findOne(key);
      const previousSourceQuantity = Number.isFinite(existingVariant?.sourceQuantity)
        ? existingVariant.sourceQuantity
        : null;
      const sourceDelta = previousSourceQuantity === null
        ? 0
        : variant.onHandQuantity - previousSourceQuantity;
      report.sourceQuantityDelta += sourceDelta;

      if (!existingVariant) {
        report.variantsToCreate += 1;
        report.initialQuantityToCreate += variant.onHandQuantity;
        if (!applyChanges) continue;
        await StockVariant.create({
          ...key,
          displayReference,
          productIds,
          primaryProductId: primaryProduct._id,
          size: variant.size,
          onHandQuantity: variant.onHandQuantity,
          reservedQuantity: 0,
          sourceQuantity: variant.onHandQuantity,
          sourceSheet: variant.sourceSheet,
          sourceRows: variant.sourceRows,
          notes: variant.notes.join(' | '),
          lastSyncedAt: new Date(),
          syncBatchId: batchId
        });
        continue;
      }

      report.variantsToUpdate += 1;
      if (!applyChanges) continue;
      existingVariant.displayReference = displayReference;
      existingVariant.productIds = productIds;
      existingVariant.primaryProductId = primaryProduct._id;
      existingVariant.size = variant.size;
      existingVariant.sourceQuantity = variant.onHandQuantity;
      existingVariant.sourceSheet = variant.sourceSheet;
      existingVariant.sourceRows = variant.sourceRows;
      existingVariant.notes = variant.notes.join(' | ');
      existingVariant.lastSyncedAt = new Date();
      existingVariant.syncBatchId = batchId;
      if (previousSourceQuantity !== null && sourceDelta !== 0) {
        existingVariant.onHandQuantity = Math.max(
          existingVariant.onHandQuantity + sourceDelta,
          existingVariant.reservedQuantity
        );
      }
      await existingVariant.save();
    }
  }

  if (applyChanges && createdProductIds.length) {
    await Catalog.updateOne({ _id: catalog._id }, { $addToSet: { products: { $each: createdProductIds } } });
  }

  if (applyChanges) {
    const totals = await StockVariant.aggregate([
      { $unwind: '$productIds' },
      {
        $group: {
          _id: '$productIds',
          onHand: { $sum: '$onHandQuantity' },
          reserved: { $sum: '$reservedQuantity' }
        }
      }
    ]);
    if (totals.length) {
      await Product.bulkWrite(totals.map(total => ({
        updateOne: {
          filter: { _id: total._id },
          update: {
            $set: {
              stock: Math.max(Number(total.onHand || 0) - Number(total.reserved || 0), 0),
              reservedStock: Number(total.reserved || 0)
            }
          }
        }
      })));
    }
  }

  report.createdDraftCount = report.createdDraftProducts.length;
  report.existingDuplicateCount = report.existingDuplicateReferences.length;
  console.log(JSON.stringify(report, null, 2));
};

main()
  .then(() => mongoose.disconnect())
  .catch(async error => {
    console.error(error);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  });
