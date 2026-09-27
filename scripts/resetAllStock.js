#!/usr/bin/env node

require('dotenv').config();

const mongoose = require('mongoose');
const Product = require('../models/Product');
const StockVariant = require('../models/StockVariant');
const StockOrphan = require('../models/StockOrphan');
const Order = require('../models/Order');
const InventoryMovement = require('../models/InventoryMovement');
const AuditLog = require('../models/AuditLog');
const { createDatabaseBackup } = require('../utils/backupService');

const APPLY = process.argv.includes('--confirm-reset');
const ACTOR_ID = 'system:stock-reset';

const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);

const loadState = async (session = null) => {
  const options = session ? { session } : {};
  const [products, variants, orphans, activeReservedOrders] = await Promise.all([
    Product.find({ $or: [{ stock: { $gt: 0 } }, { reservedStock: { $gt: 0 } }] })
      .select('_id name serialNumber stock reservedStock')
      .lean(options),
    StockVariant.find({
      $or: [
        { onHandQuantity: { $gt: 0 } },
        { reservedQuantity: { $gt: 0 } },
        { sourceQuantity: { $gt: 0 } }
      ]
    }).select('_id displayReference size printMethod onHandQuantity reservedQuantity sourceQuantity').lean(options),
    StockOrphan.find({ units: { $gt: 0 } }).select('_id reference units sourceSheet').lean(options),
    Order.find({ inventoryState: 'reserved', 'items.stockQuantity': { $gt: 0 } })
      .select('_id orderNumber status items.stockQuantity')
      .lean(options)
  ]);

  return { products, variants, orphans, activeReservedOrders };
};

const summary = state => ({
  productsWithQuantity: state.products.length,
  productAvailableUnits: sum(state.products, 'stock'),
  productReservedUnits: sum(state.products, 'reservedStock'),
  sizeRowsWithQuantity: state.variants.length,
  sizeOnHandUnits: sum(state.variants, 'onHandQuantity'),
  sizeReservedUnits: sum(state.variants, 'reservedQuantity'),
  unmatchedRowsWithQuantity: state.orphans.length,
  unmatchedUnits: sum(state.orphans, 'units'),
  activeOrdersWithReservedStock: state.activeReservedOrders.length
});

const insertInChunks = async (Model, documents, session) => {
  for (let index = 0; index < documents.length; index += 500) {
    await Model.insertMany(documents.slice(index, index + 500), { session });
  }
};

const main = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);

  const before = await loadState();
  const report = summary(before);
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', database: mongoose.connection.name, before: report }, null, 2));

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --confirm-reset to create a verified backup and reset stock.');
    return;
  }

  if (before.activeReservedOrders.length > 0) {
    const orderLabels = before.activeReservedOrders
      .slice(0, 10)
      .map(order => order.orderNumber || String(order._id))
      .join(', ');
    throw new Error(
      `Reset stopped: ${before.activeReservedOrders.length} active order(s) still reserve stock (${orderLabels}). `
      + 'Resolve or cancel those orders before resetting stock so order history remains consistent.'
    );
  }

  const backup = await createDatabaseBackup({ reason: 'before_stock_reset', actorId: ACTOR_ID });
  console.log(`Verified backup created: ${backup.fileName} (${backup.documentCount} documents)`);

  const session = await mongoose.startSession();
  const resetAt = new Date();
  const resetBatchId = `stock-reset-${resetAt.toISOString()}`;

  try {
    await session.withTransaction(async () => {
      const state = await loadState(session);
      if (state.activeReservedOrders.length > 0) {
        throw new Error('An order reserved stock after the dry run; reset stopped safely');
      }

      const movements = state.products.map(product => ({
        productId: product._id,
        actorId: ACTOR_ID,
        type: 'set',
        quantity: -Number(product.stock || 0),
        stockBefore: Number(product.stock || 0),
        stockAfter: 0,
        notes: `Full stock reset. Reserved stock before reset: ${Number(product.reservedStock || 0)}.`
      }));

      const auditLogs = [
        ...state.products.map(product => ({
          category: 'inventory',
          action: 'stock_reset_to_zero',
          actorId: ACTOR_ID,
          entityType: 'product',
          entityId: String(product._id),
          details: {
            reference: product.serialNumber,
            stockBefore: Number(product.stock || 0),
            reservedBefore: Number(product.reservedStock || 0),
            stockAfter: 0,
            reservedAfter: 0,
            resetBatchId
          }
        })),
        ...state.variants.map(variant => ({
          category: 'inventory',
          action: 'stock_variant_reset_to_zero',
          actorId: ACTOR_ID,
          entityType: 'stock_variant',
          entityId: String(variant._id),
          details: {
            reference: variant.displayReference,
            size: variant.size,
            printMethod: variant.printMethod,
            onHandBefore: Number(variant.onHandQuantity || 0),
            reservedBefore: Number(variant.reservedQuantity || 0),
            sourceBefore: Number(variant.sourceQuantity || 0),
            onHandAfter: 0,
            reservedAfter: 0,
            sourceAfter: 0,
            resetBatchId
          }
        })),
        ...state.orphans.map(orphan => ({
          category: 'inventory',
          action: 'unmatched_stock_reset_to_zero',
          actorId: ACTOR_ID,
          entityType: 'stock_orphan',
          entityId: String(orphan._id),
          details: {
            reference: orphan.reference,
            sourceSheet: orphan.sourceSheet,
            unitsBefore: Number(orphan.units || 0),
            unitsAfter: 0,
            resetBatchId
          }
        }))
      ];

      await Promise.all([
        Product.updateMany({}, { $set: { stock: 0, reservedStock: 0, updatedAt: resetAt } }, { session }),
        StockVariant.updateMany({}, {
          $set: {
            onHandQuantity: 0,
            reservedQuantity: 0,
            sourceQuantity: 0,
            lastSyncedAt: resetAt,
            syncBatchId: resetBatchId
          }
        }, { session }),
        StockOrphan.updateMany({}, { $set: { units: 0, batchId: resetBatchId } }, { session })
      ]);

      await insertInChunks(InventoryMovement, movements, session);
      await insertInChunks(AuditLog, auditLogs, session);
      await AuditLog.create([{
        category: 'inventory',
        action: 'all_stock_reset_completed',
        actorId: ACTOR_ID,
        entityType: 'inventory',
        entityId: resetBatchId,
        details: { before: summary(state), backupFileName: backup.fileName, resetBatchId }
      }], { session });
    });
  } finally {
    await session.endSession();
  }

  const after = await loadState();
  const afterReport = summary(after);
  console.log(JSON.stringify({ status: 'completed', resetBatchId, backupFileName: backup.fileName, after: afterReport }, null, 2));

  const remaining = Object.entries(afterReport)
    .filter(([key]) => key !== 'activeOrdersWithReservedStock')
    .some(([, value]) => value !== 0);
  if (remaining) throw new Error('Verification failed: at least one stock quantity is not zero');
};

main()
  .then(() => mongoose.disconnect())
  .catch(async error => {
    console.error(`ERROR: ${error.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
