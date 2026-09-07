const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Product = require('../models/Product');
const Order = require('../models/Order');

async function migrateInventory() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const [stockResult, reservedResult, thresholdResult, locationResult, orderResult] = await Promise.all([
    Product.updateMany({ stock: { $exists: false } }, { $set: { stock: 0 } }),
    Product.updateMany({ reservedStock: { $exists: false } }, { $set: { reservedStock: 0 } }),
    Product.updateMany({ lowStockThreshold: { $exists: false } }, { $set: { lowStockThreshold: 2 } }),
    Product.updateMany({ stockLocation: { $exists: false } }, { $set: { stockLocation: '' } }),
    Order.updateMany({ inventoryState: { $exists: false } }, { $set: { inventoryState: 'untracked' } })
  ]);

  console.log(JSON.stringify({
    productsWithStockAdded: stockResult.modifiedCount,
    productsWithReservedStockAdded: reservedResult.modifiedCount,
    productsWithThresholdAdded: thresholdResult.modifiedCount,
    productsWithLocationAdded: locationResult.modifiedCount,
    legacyOrdersMarkedUntracked: orderResult.modifiedCount
  }, null, 2));
}

migrateInventory()
  .catch((error) => {
    console.error('Inventory migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
