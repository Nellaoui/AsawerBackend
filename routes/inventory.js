const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Catalog = require('../models/Catalog');
const InventoryMovement = require('../models/InventoryMovement');
const Order = require('../models/Order');
const WorkflowCase = require('../models/WorkflowCase');
const StockVariant = require('../models/StockVariant');
const StockOrphan = require('../models/StockOrphan');
const User = require('../models/User');
const { operationsAuth } = require('../middlewares/auth');
const { normalizeProductReference, canonicalProductReference, canonicalStockReference, normalizeStockSize } = require('../utils/stockReference');
const { findTeamAssignee } = require('../utils/workflowAssignment');
const { teamForStatus, targetMinutesForTeam } = require('../utils/workflowRules');
const { notifyCaseAssignment } = require('../utils/workflowNotifications');

const router = express.Router();

const inventoryRoleAuth = (req, res, next) => {
  const allowed = req.user?.isAdmin
    || req.user?.role === 'admin'
    || (req.user?.role === 'employee' && ['stock', 'boss'].includes(req.user?.workRole));
  if (!allowed) {
    return res.status(403).json({ message: 'Product management is limited to stock staff and the boss' });
  }
  next();
};


// Product setup is wider than stock control. Customer service hears about a
// bad or missing product first, so they can view the problem list, flag a
// product, and create a draft - but never price it, publish it or touch stock.
const productSetupAuth = (req, res, next) => {
  const allowed = req.user?.isAdmin
    || req.user?.role === 'admin'
    || (req.user?.role === 'employee' && ['stock', 'boss', 'customer_service'].includes(req.user?.workRole));
  if (!allowed) {
    return res.status(403).json({ message: 'Product setup is limited to operations staff' });
  }
  next();
};

const canPublishProducts = (user) => Boolean(
  user?.isAdmin || user?.role === 'admin'
  || (user?.role === 'employee' && ['stock', 'boss'].includes(user?.workRole))
);

const PLACEHOLDER_IMAGE = 'https://via.placeholder.com/150';
const FULFILLMENT_POLICIES = ['stock_only', 'print_on_demand', 'stock_then_print'];
const PRINT_METHODS = ['none', 'wax', 'resin'];

// A product counts as having a photo once the value is a real http(s) URL and
// not the placeholder stamped on a draft. Returns '' when there is no photo.
const cleanImageUrl = (value) => {
  const url = String(value || '').trim();
  if (!url || /placeholder/i.test(url)) return '';
  const lower = url.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') ? url : '';
};

// Every product is either held in stock or printed, and a printed one needs a
// method. Anything else leaves the workshop unable to supply it.
const hasSupplyRoute = (product) => product.fulfillmentPolicy === 'stock_only'
  || (Boolean(product.printMethod) && product.printMethod !== 'none');

const safelyNotify = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    console.error('Inventory notification failed:', error);
    return null;
  }
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const serializeProduct = (product, stockVariants = []) => {
  const value = product.toObject ? product.toObject() : product;
  const catalog = value.catalogId && typeof value.catalogId === 'object' ? value.catalogId : null;

  return {
    ...value,
    productId: String(value._id),
    stock: Number.isFinite(value.stock) ? value.stock : 0,
    reservedStock: Number.isFinite(value.reservedStock) ? value.reservedStock : 0,
    lowStockThreshold: Number.isFinite(value.lowStockThreshold) ? value.lowStockThreshold : 2,
    stockLocation: value.stockLocation || '',
    catalogName: catalog?.name || '',
    stockSyncState: value.stockSyncState || 'manual',
    stockVariants: stockVariants.map(variant => ({
      id: String(variant._id),
      reference: variant.displayReference,
      printMethod: variant.printMethod,
      size: variant.size,
      onHandQuantity: Number(variant.onHandQuantity || 0),
      reservedQuantity: Number(variant.reservedQuantity || 0),
      availableQuantity: Math.max(Number(variant.onHandQuantity || 0) - Number(variant.reservedQuantity || 0), 0),
      sourceSheet: variant.sourceSheet,
      lastSyncedAt: variant.lastSyncedAt
    }))
  };
};

// Product.stock is the sum of its size stock; keep it in step after any size change.
const recomputeProductStock = async (productIds, session = null) => {
  const ids = productIds.map(id => new mongoose.Types.ObjectId(String(id)));
  const totals = await StockVariant.aggregate([
    { $match: { productIds: { $in: ids } } },
    { $unwind: '$productIds' },
    { $match: { productIds: { $in: ids } } },
    { $group: { _id: '$productIds', onHand: { $sum: '$onHandQuantity' }, reserved: { $sum: '$reservedQuantity' } } }
  ]).session(session);
  if (!totals.length) return;
  await Product.bulkWrite(totals.map(total => ({
    updateOne: {
      filter: { _id: total._id },
      update: { $set: { stock: Math.max(total.onHand - total.reserved, 0), reservedStock: total.reserved } }
    }
  })), { session });
};

const serializeVariant = (variant) => ({
  id: String(variant._id),
  reference: variant.displayReference,
  printMethod: variant.printMethod,
  size: variant.size,
  onHandQuantity: Number(variant.onHandQuantity || 0),
  reservedQuantity: Number(variant.reservedQuantity || 0),
  availableQuantity: Math.max(Number(variant.onHandQuantity || 0) - Number(variant.reservedQuantity || 0), 0),
  sourceSheet: variant.sourceSheet,
  lastSyncedAt: variant.lastSyncedAt
});

// GET /api/inventory - Searchable stock list and dashboard totals.
router.get('/', operationsAuth, inventoryRoleAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const search = String(req.query.search || '').trim();
    const lowStockOnly = String(req.query.lowStock || '') === 'true';
    const filter = {};

    if (search) {
      const pattern = new RegExp(escapeRegExp(search), 'i');
      filter.$or = [{ name: pattern }, { serialNumber: pattern }, { type: pattern }, { stockLocation: pattern }];
    }

    if (lowStockOnly) {
      filter.$expr = {
        $lte: [
          { $ifNull: ['$stock', 0] },
          { $ifNull: ['$lowStockThreshold', 2] }
        ]
      };
    }

    const [products, total, totals] = await Promise.all([
      Product.find(filter)
        .populate('catalogId', 'name')
        .sort({ stock: 1, name: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(filter),
      Product.aggregate([
        {
          $group: {
            _id: null,
            products: { $sum: 1 },
            availableUnits: { $sum: { $ifNull: ['$stock', 0] } },
            reservedUnits: { $sum: { $ifNull: ['$reservedStock', 0] } },
            lowStockProducts: {
              $sum: {
                $cond: [
                  { $lte: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$lowStockThreshold', 2] }] },
                  1,
                  0
                ]
              }
            },
            outOfStockProducts: {
              $sum: { $cond: [{ $lte: [{ $ifNull: ['$stock', 0] }, 0] }, 1, 0] }
            }
          }
        }
      ])
    ]);

    const variants = products.length
      ? await StockVariant.find({ productIds: { $in: products.map(product => product._id) } }).sort({ printMethod: 1, sizeKey: 1 }).lean()
      : [];
    const variantsByProduct = new Map();
    for (const variant of variants) {
      for (const productId of variant.productIds || []) {
        const id = String(productId);
        if (!variantsByProduct.has(id)) variantsByProduct.set(id, []);
        variantsByProduct.get(id).push(variant);
      }
    }

    res.json({
      products: products.map(product => serializeProduct(product, variantsByProduct.get(String(product._id)) || [])),
      summary: totals[0] || {
        products: 0,
        availableUnits: 0,
        reservedUnits: 0,
        lowStockProducts: 0,
        outOfStockProducts: 0
      },
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(Math.ceil(total / limit), 1)
      }
    });
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ message: 'Failed to fetch inventory' });
  }
});

// GET /api/inventory/movements - Recent, immutable stock audit trail.
router.get('/movements', operationsAuth, inventoryRoleAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const filter = {};
    if (req.query.productId && mongoose.Types.ObjectId.isValid(req.query.productId)) {
      filter.productId = req.query.productId;
    }

    const movements = await InventoryMovement.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('productId', 'name serialNumber imageUrl')
      .lean();

    // actorId deliberately accepts both a User ObjectId and immutable labels
    // such as "system:stock-reset". Populating the mixed field directly makes
    // Mongoose cast those labels to ObjectId and rejects the entire history
    // response. Resolve only genuine user ids and leave system labels intact.
    const userActorIds = [...new Set(movements
      .map(movement => movement.actorId)
      .filter(actorId => actorId instanceof mongoose.Types.ObjectId)
      .map(actorId => String(actorId)))];
    const actors = userActorIds.length
      ? await User.find({ _id: { $in: userActorIds } }).select('name email').lean()
      : [];
    const actorsById = new Map(actors.map(actor => [String(actor._id), actor]));

    const serializedMovements = movements.map(movement => {
      const actor = actorsById.get(String(movement.actorId));
      return actor ? { ...movement, actorId: actor } : movement;
    });

    res.json(serializedMovements);
  } catch (error) {
    console.error('Error fetching inventory movements:', error);
    res.status(500).json({ message: 'Failed to fetch inventory history' });
  }
});

// GET /api/inventory/orphans - Counted stock that has no product in the app.
// These rows come off the paper worksheets; somebody has to create the product
// before the quantity can become sellable stock.
router.get('/orphans', operationsAuth, productSetupAuth, async (req, res) => {
  try {
    const status = ['pending', 'resolved', 'ignored'].includes(req.query.status)
      ? req.query.status
      : 'pending';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);

    const [orphans, counts, deadVariants] = await Promise.all([
      StockOrphan.find({ status }).sort({ units: -1, reference: 1 }).limit(limit).lean(),
      StockOrphan.aggregate([
        { $group: { _id: '$status', rows: { $sum: 1 }, units: { $sum: '$units' } } }
      ]),
      // A StockVariant whose products have all been deleted is orphaned too.
      StockVariant.aggregate([
        { $lookup: { from: 'products', localField: 'productIds', foreignField: '_id', as: 'live' } },
        { $match: { live: { $size: 0 } } },
        { $project: { displayReference: 1, size: 1, onHandQuantity: 1 } }
      ])
    ]);

    const summary = { pending: { rows: 0, units: 0 }, resolved: { rows: 0, units: 0 }, ignored: { rows: 0, units: 0 } };
    for (const row of counts) {
      if (summary[row._id]) summary[row._id] = { rows: row.rows, units: row.units };
    }

    res.json({
      status,
      summary,
      orphans,
      danglingVariants: deadVariants,
      totalUnits: orphans.reduce((sum, row) => sum + (row.units || 0), 0)
    });
  } catch (error) {
    console.error('Error fetching stock orphans:', error);
    res.status(500).json({ message: 'Failed to fetch stock without products' });
  }
});

// PATCH /api/inventory/orphans/:id - Mark an orphan resolved or ignored.
router.patch('/orphans/:id', operationsAuth, productSetupAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: 'Invalid id' });
  }
  const status = req.body?.status;
  if (!['pending', 'resolved', 'ignored'].includes(status)) {
    return res.status(400).json({ message: 'status must be pending, resolved or ignored' });
  }
  try {
    const orphan = await StockOrphan.findById(req.params.id);
    if (!orphan) return res.status(404).json({ message: 'Not found' });
    orphan.status = status;
    orphan.resolvedAt = status === 'pending' ? null : new Date();
    orphan.resolvedBy = status === 'pending' ? null : req.user.id;
    if (req.body?.productId && mongoose.Types.ObjectId.isValid(req.body.productId)) {
      orphan.resolvedProductId = req.body.productId;
    }
    await orphan.save();
    res.json(orphan);
  } catch (error) {
    console.error('Error updating stock orphan:', error);
    res.status(500).json({ message: 'Failed to update' });
  }
});

// GET /api/inventory/needs-setup - Products that are not ready to sell.
// Same rules the boss dashboard uses, but reachable by anyone doing setup.
// The app lists a catalogue's products from Catalog.products, so a product's
// catalogId and that array must always move together.
const findCatalog = async (catalogId) => (
  catalogId && mongoose.Types.ObjectId.isValid(catalogId) ? Catalog.findById(catalogId).select('_id name') : null
);
const syncCatalogMembership = async (productId, catalogId) => {
  await Catalog.updateMany({ _id: { $ne: catalogId }, products: productId }, { $pull: { products: productId } });
  if (catalogId) await Catalog.updateOne({ _id: catalogId }, { $addToSet: { products: productId } });
};

// GET /api/inventory/catalogs - Catalogue choices for the product form.
router.get('/catalogs', operationsAuth, productSetupAuth, async (req, res) => {
  try {
    const catalogs = await Catalog.find({}).select('name isPublic').sort({ name: 1 }).lean();
    res.json(catalogs.map(catalog => ({ _id: catalog._id, name: catalog.name, isPublic: catalog.isPublic !== false })));
  } catch (error) {
    console.error('Error fetching catalogues:', error);
    res.status(500).json({ message: 'Failed to fetch catalogues' });
  }
});

router.get('/needs-setup', operationsAuth, productSetupAuth, async (req, res) => {
  try {
    const products = await Product.find({})
      .select('name serialNumber type imageUrl price isActive stockSyncState fulfillmentPolicy printMethod catalogId availableSizes setupIssue stock')
      .sort({ updatedAt: -1 })
      .limit(400)
      .lean();

    const flagged = products.map((product) => {
      const needsImage = !product.imageUrl || /placeholder/i.test(product.imageUrl);
      const needsDetails = product.stockSyncState === 'needs_details' || product.isActive === false;
      const needsClassification = product.fulfillmentPolicy !== 'stock_only'
        && (!product.printMethod || product.printMethod === 'none');
      const needsPrice = !product.price || Number(product.price) <= 0;
      const reported = Boolean(product.setupIssue?.open);
      return { ...product, needsImage, needsDetails, needsClassification, needsPrice, reported };
    // Only a missing photo, missing details, or a reported fault is a problem.
    // `needsPrice` and `needsClassification` are still reported so the form can
    // show them, but neither holds a product back: it is priced and routed when
    // it is ready to sell.
    }).filter((product) => product.needsImage || product.needsDetails || product.reported);
    const catalogNames = new Map((await Catalog.find({ _id: { $in: flagged.map(p => p.catalogId).filter(Boolean) } }).select('name').lean())
      .map(catalog => [String(catalog._id), catalog.name]));
    for (const product of flagged) product.catalogName = catalogNames.get(String(product.catalogId)) || '';

    res.json({
      total: flagged.length,
      reported: flagged.filter((product) => product.reported).length,
      canPublish: canPublishProducts(req.user),
      products: flagged.slice(0, 200)
    });
  } catch (error) {
    console.error('Error fetching products needing setup:', error);
    res.status(500).json({ message: 'Failed to fetch products needing setup' });
  }
});

// POST /api/inventory/products - Create a product from the portal.
// A photo and a supply route can be supplied here, in which case the product is
// born ready and never reaches the problem list. Without them it is created as
// a draft, exactly as before. Price is optional either way.
router.post('/products', operationsAuth, productSetupAuth, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const type = String(req.body?.type || '').trim();
    // Store one spelling. bra312, BRA-312, BRA312 sertie and BRA 312 Simple
    // are the same bracelet written four ways; they all land as BRA 312 or
    // BRA 312 S so the catalogue never collects duplicates of one reference.
    const serialNumber = normalizeProductReference(req.body?.serialNumber);
    if (!name || !serialNumber || !type) {
      return res.status(400).json({ message: 'Name, reference and type are required' });
    }

    // Look for the product however its reference happens to be written. An
    // exact match on the stored string would miss BRA312 when BRA 312 exists,
    // so narrow with the family and number, then compare canonical forms.
    const canonical = canonicalProductReference(serialNumber);
    const parts = serialNumber.match(/^([A-Za-z]+)\s*([0-9]+)/);
    const candidates = parts
      ? await Product.find({ serialNumber: new RegExp(`^\\s*${parts[1]}[\\s_-]*${parts[2]}\\b`, 'i') })
        .select('_id name serialNumber type imageUrl price isActive availableSizes fulfillmentPolicy printMethod setupIssue')
        .limit(50)
        .lean()
      : await Product.find({ serialNumber }).select('_id name serialNumber type imageUrl price isActive availableSizes fulfillmentPolicy printMethod setupIssue').limit(50).lean();
    const duplicate = candidates.find((row) => canonicalProductReference(row.serialNumber) === canonical);

    if (duplicate) {
      // The portal opens this product for editing instead of creating a second
      // one, so hand back enough to do that without another round trip.
      return res.status(409).json({
        message: `"${duplicate.serialNumber}" already exists. Open it and add what is missing instead of creating it again.`,
        productId: duplicate._id,
        existing: duplicate,
        normalizedReference: serialNumber
      });
    }

    const initialStockBySize = req.body?.initialStockBySize;
    if (initialStockBySize !== undefined && (!Array.isArray(initialStockBySize) || initialStockBySize.length > 50)) {
      return res.status(400).json({ message: 'Add no more than 50 stock sizes' });
    }
    if (initialStockBySize?.length && !canPublishProducts(req.user)) {
      return res.status(403).json({ message: 'Only stock staff or a manager can enter starting stock' });
    }
    const printMethod = PRINT_METHODS.includes(req.body?.printMethod) ? req.body.printMethod : 'none';
    if (initialStockBySize?.length && !['wax', 'resin'].includes(printMethod)) {
      return res.status(400).json({ message: 'Choose Wax or Resin for sized stock' });
    }
    const stockSizes = [];
    const seenSizes = new Set();
    for (const row of initialStockBySize || []) {
      const size = String(row?.size || '').trim();
      const sizeKey = normalizeStockSize(size);
      const quantity = Number(row?.quantity);
      if (!size || !sizeKey || size.length > 80 || !Number.isSafeInteger(quantity) || quantity < 0) {
        return res.status(400).json({ message: 'Each size needs a valid name and non-negative whole-number quantity' });
      }
      if (seenSizes.has(sizeKey)) return res.status(400).json({ message: `Size ${size} was entered more than once` });
      seenSizes.add(sizeKey);
      stockSizes.push({ size, sizeKey, quantity });
    }
    const startingTotal = stockSizes.reduce((total, row) => total + row.quantity, 0);
    if (!Number.isSafeInteger(startingTotal)) return res.status(400).json({ message: 'Starting stock total is too large' });

    const sizes = Array.isArray(req.body?.availableSizes)
      ? req.body.availableSizes.map((size) => String(size).trim()).filter(Boolean)
      : [];
    for (const row of stockSizes) if (!sizes.some(size => normalizeStockSize(size) === row.sizeKey)) sizes.push(row.size);

    const imageUrl = cleanImageUrl(req.body?.imageUrl);
    const rawPrice = Number(req.body?.price);
    const price = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : 0;
    const fulfillmentPolicy = FULFILLMENT_POLICIES.includes(req.body?.fulfillmentPolicy)
      ? req.body.fulfillmentPolicy
      : 'stock_then_print';
    const ready = Boolean(imageUrl);
    const catalog = await findCatalog(req.body?.catalogId);
    if (req.body?.catalogId && !catalog) return res.status(400).json({ message: 'That catalogue no longer exists' });

    const productFields = {
      name,
      serialNumber,
      type,
      description: String(req.body?.description || '').trim()
        || (ready
          ? `${name} (${type}) - added from the operations portal.`
          : 'Created from the operations portal. Add the image, price and customer-facing details before publishing.'),
      imageUrl: imageUrl || PLACEHOLDER_IMAGE,
      price,
      stock: startingTotal,
      reservedStock: 0,
      availableSizes: sizes,
      catalogId: catalog?._id,
      createdBy: req.user.id,
      isActive: ready,
      fulfillmentPolicy,
      printMethod,
      stockSyncState: ready ? 'manual' : 'needs_details',
      setupIssue: ready
        ? { open: false, note: '', resolvedBy: req.user.id, resolvedAt: new Date() }
        : {
          open: true,
          note: String(req.body?.note || '').trim() || 'New product created from the portal. Needs image, price and details.',
          reportedBy: req.user.id,
          reportedAt: new Date()
        }
    };

    let product;
    if (stockSizes.length) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          [product] = await Product.create([productFields], { session });
          const canonicalReference = canonicalProductReference(product.serialNumber || serialNumber);
          await StockVariant.create(stockSizes.map(row => ({
            canonicalReference,
            displayReference: product.serialNumber,
            productIds: [product._id],
            primaryProductId: product._id,
            printMethod,
            size: row.size,
            sizeKey: row.sizeKey,
            onHandQuantity: row.quantity,
            reservedQuantity: 0,
            sourceSheet: printMethod === 'wax' ? 'Wax' : 'Resin',
            notes: 'Starting stock entered with product creation'
          })), { session });
          const movements = stockSizes.filter(row => row.quantity > 0).map(row => ({
            productId: product._id,
            actorId: req.user.id,
            type: 'receive',
            quantity: row.quantity,
            stockBefore: 0,
            stockAfter: row.quantity,
            notes: `Starting stock: size ${row.size} (${printMethod})`
          }));
          if (movements.length) await InventoryMovement.create(movements, { session });
        });
      } finally {
        await session.endSession();
      }
    } else {
      product = await Product.create(productFields);
    }
    if (catalog) await syncCatalogMembership(product._id, catalog._id);

    res.status(201).json({ ...product.toObject(), ready });
  } catch (error) {
    console.error('Error creating product from portal:', error);
    res.status(500).json({ message: 'Failed to create the product' });
  }
});

// PATCH /api/inventory/products/:id/issue - Raise or clear a setup issue.
router.patch('/products/:id/issue', operationsAuth, productSetupAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: 'Invalid id' });
  }
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const open = req.body?.open !== false;
    if (open) {
      product.setupIssue = {
        open: true,
        note: String(req.body?.note || '').trim().slice(0, 500),
        reportedBy: req.user.id,
        reportedAt: new Date(),
        resolvedBy: null,
        resolvedAt: null
      };
    } else {
      // Only somebody who could fix it may declare it fixed.
      if (!canPublishProducts(req.user)) {
        return res.status(403).json({ message: 'Only stock staff or an admin can close a product issue' });
      }
      product.setupIssue = {
        ...(product.setupIssue || {}),
        open: false,
        resolvedBy: req.user.id,
        resolvedAt: new Date()
      };
    }
    await product.save();
    res.json({ productId: product._id, setupIssue: product.setupIssue });
  } catch (error) {
    console.error('Error updating product issue:', error);
    res.status(500).json({ message: 'Failed to update the product issue' });
  }
});

// PATCH /api/inventory/products/:id/setup - Fill in what a product is missing.
// Deliberately open to everyone who can reach the portal: whoever spots the gap
// can close it, rather than reporting it and waiting. Price is optional, so a
// product leaves the problem list once it has a photo and a supply route.
router.patch('/products/:id/setup', operationsAuth, productSetupAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: 'Invalid product ID' });
  }
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ message: 'Name cannot be empty' });
      product.name = name;
    }

    if (req.body?.type !== undefined) {
      const type = String(req.body.type).trim();
      if (!type) return res.status(400).json({ message: 'Type cannot be empty' });
      product.type = type;
    }

    if (req.body?.imageUrl !== undefined) {
      const imageUrl = cleanImageUrl(req.body.imageUrl);
      if (!imageUrl) {
        return res.status(400).json({ message: 'Upload a photo first, then save' });
      }
      product.imageUrl = imageUrl;
    }

    if (req.body?.price !== undefined) {
      const price = Number(req.body.price);
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ message: 'Price must be zero or more' });
      }
      product.price = price;
    }

    if (req.body?.fulfillmentPolicy !== undefined) {
      if (!FULFILLMENT_POLICIES.includes(req.body.fulfillmentPolicy)) {
        return res.status(400).json({ message: 'Unknown supply route' });
      }
      product.fulfillmentPolicy = req.body.fulfillmentPolicy;
    }

    if (req.body?.printMethod !== undefined) {
      if (!PRINT_METHODS.includes(req.body.printMethod)) {
        return res.status(400).json({ message: 'Print method must be none, wax or resin' });
      }
      product.printMethod = req.body.printMethod;
    }

    if (Array.isArray(req.body?.availableSizes)) {
      product.availableSizes = req.body.availableSizes
        .map((size) => String(size).trim())
        .filter(Boolean);
    }

    if (req.body?.description !== undefined) {
      product.description = String(req.body.description).trim().slice(0, 2000);
    }

    if (req.body?.stockLocation !== undefined) {
      product.stockLocation = String(req.body.stockLocation).trim().slice(0, 120);
    }

    let catalogChanged = false;
    if (req.body?.catalogId !== undefined) {
      const catalog = await findCatalog(req.body.catalogId);
      if (!catalog) return res.status(400).json({ message: 'Choose a catalogue for this product' });
      catalogChanged = String(product.catalogId || '') !== String(catalog._id);
      product.catalogId = catalog._id;
    }

    // A photo is the only thing a product cannot be sold without. Price and
    // print method are optional and are filled in when they are known.
    const ready = Boolean(cleanImageUrl(product.imageUrl));
    if (ready) {
      product.isActive = true;
      // Leave a sheet-synced product synced; only a draft graduates to manual.
      if (product.stockSyncState === 'needs_details') product.stockSyncState = 'manual';
      product.setupIssue = {
        ...(product.setupIssue || {}),
        open: false,
        resolvedBy: req.user.id,
        resolvedAt: new Date()
      };
    }

    await product.save();
    if (catalogChanged) await syncCatalogMembership(product._id, product.catalogId);

    res.json({
      ready,
      stillMissing: {
        image: !cleanImageUrl(product.imageUrl),
        supplyRoute: !hasSupplyRoute(product)
      },
      // `supplyRoute` is reported for the badge only; it never blocks.
      product: {
        _id: product._id,
        name: product.name,
        serialNumber: product.serialNumber,
        type: product.type,
        imageUrl: product.imageUrl,
        price: product.price,
        isActive: product.isActive,
        fulfillmentPolicy: product.fulfillmentPolicy,
        printMethod: product.printMethod,
        availableSizes: product.availableSizes,
        catalogId: product.catalogId,
        stockSyncState: product.stockSyncState,
        setupIssue: product.setupIssue
      }
    });
  } catch (error) {
    console.error('Error completing product setup:', error);
    res.status(500).json({ message: 'Failed to save the product details' });
  }
});

// POST /api/inventory/products/:id/variants - Add a sellable stock size.
// Size stock is kept separately because an order must reserve the exact size.
router.post('/products/:id/variants', operationsAuth, inventoryRoleAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid product ID' });
  const size = String(req.body.size || '').trim();
  const sizeKey = normalizeStockSize(size);
  const printMethod = String(req.body.printMethod || '').toLowerCase();
  const quantity = Number(req.body.quantity || 0);
  if (!size || !sizeKey || size.length > 80) return res.status(400).json({ message: 'Enter a valid size' });
  if (!['wax', 'resin'].includes(printMethod)) return res.status(400).json({ message: 'Choose Wax or Resin' });
  if (!Number.isSafeInteger(quantity) || quantity < 0) return res.status(400).json({ message: 'Quantity must be a non-negative whole number' });
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const canonicalReference = canonicalProductReference(product.serialNumber || product.canonicalReference);
    const variant = await StockVariant.create({
      canonicalReference,
      displayReference: product.serialNumber,
      productIds: [product._id],
      primaryProductId: product._id,
      printMethod,
      size,
      sizeKey,
      onHandQuantity: quantity,
      reservedQuantity: 0,
      sourceSheet: printMethod === 'wax' ? 'Wax' : 'Resin',
      notes: 'Created manually in the stock portal'
    });
    product.availableSizes = [...new Set([...(product.availableSizes || []).map(String), size])]
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    await product.save();
    if (quantity) await InventoryMovement.create({ productId: product._id, actorId: req.user.id, type: 'receive', quantity, stockBefore: 0, stockAfter: quantity, notes: `Size ${size} (${printMethod}): created in stock portal` });
    await recomputeProductStock([product._id]);
    res.status(201).json(serializeVariant(variant));
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'That size already exists for this printing method' });
    console.error('Error adding stock size:', error);
    res.status(500).json({ message: 'Failed to add stock size' });
  }
});

// PUT /api/inventory/products/:id/size-stock - Set the on-hand quantity of
// several sizes at once. Missing sizes are created; each change is logged.
router.put('/products/:id/size-stock', operationsAuth, inventoryRoleAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid product ID' });
  const printMethod = String(req.body.printMethod || '').toLowerCase();
  if (!['wax', 'resin'].includes(printMethod)) return res.status(400).json({ message: 'Choose Wax or Resin' });
  const rows = Array.isArray(req.body.sizes) ? req.body.sizes : [];
  if (!rows.length || rows.length > 60) return res.status(400).json({ message: 'Send between 1 and 60 sizes' });
  const cleaned = [];
  for (const row of rows) {
    const size = String(row?.size || '').trim();
    const sizeKey = normalizeStockSize(size);
    const quantity = Number(row?.quantity);
    if (!size || !sizeKey || size.length > 80) return res.status(400).json({ message: 'Every row needs a size' });
    if (!Number.isSafeInteger(quantity) || quantity < 0) return res.status(400).json({ message: `Size ${size}: quantity must be a whole number, 0 or more` });
    if (cleaned.some(item => item.sizeKey === sizeKey)) return res.status(400).json({ message: `Size ${size} is listed twice` });
    cleaned.push({ size, sizeKey, quantity });
  }

  const session = await mongoose.startSession();
  try {
    const changed = [];
    await session.withTransaction(async () => {
      changed.length = 0;
      const product = await Product.findById(req.params.id).session(session);
      if (!product) throw Object.assign(new Error('Product not found'), { status: 404 });
      const canonicalReference = canonicalProductReference(product.serialNumber || product.canonicalReference);
      for (const row of cleaned) {
        let variant = await StockVariant.findOne({ productIds: product._id, printMethod, sizeKey: row.sizeKey }).session(session)
          || await StockVariant.findOne({ canonicalReference, printMethod, sizeKey: row.sizeKey }).session(session);
        const before = Number(variant?.onHandQuantity || 0);
        if (variant && row.quantity < Number(variant.reservedQuantity || 0)) {
          throw Object.assign(new Error(`Size ${row.size}: ${variant.reservedQuantity} unit(s) are reserved for orders`), { status: 409 });
        }
        if (!variant) {
          if (!row.quantity) continue;
          variant = new StockVariant({
            canonicalReference,
            displayReference: product.serialNumber,
            productIds: [product._id],
            primaryProductId: product._id,
            printMethod,
            size: row.size,
            sizeKey: row.sizeKey,
            onHandQuantity: 0,
            reservedQuantity: 0,
            sourceSheet: printMethod === 'wax' ? 'Wax' : 'Resin',
            notes: 'Created in the stock portal'
          });
        } else if (!variant.productIds.some(id => String(id) === String(product._id))) {
          variant.productIds.push(product._id);
        }
        if (before === row.quantity && !variant.isNew) continue;
        variant.onHandQuantity = row.quantity;
        await variant.save({ session });
        changed.push({ size: row.size, before, after: row.quantity });
        await InventoryMovement.create([{
          productId: product._id,
          actorId: req.user.id,
          type: 'set',
          quantity: row.quantity - before,
          stockBefore: before,
          stockAfter: row.quantity,
          notes: `Size ${row.size} (${printMethod}): set in stock portal`
        }], { session });
      }
      product.availableSizes = [...new Set([...(product.availableSizes || []).map(String), ...cleaned.map(row => row.size)])]
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      await product.save({ session });
      await recomputeProductStock([product._id], session);
    });
    res.json({ changed });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error('Error saving size stock:', error);
    res.status(500).json({ message: 'Failed to save size stock' });
  } finally {
    await session.endSession();
  }
});

// PATCH /api/inventory/products/:id/variants/:variantId - Adjust one exact size.
router.patch('/products/:id/variants/:variantId', operationsAuth, inventoryRoleAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id) || !mongoose.Types.ObjectId.isValid(req.params.variantId)) return res.status(400).json({ message: 'Invalid product or size ID' });
  const action = String(req.body.action || '').toLowerCase();
  const quantity = Number(req.body.quantity);
  const notes = String(req.body.notes || '').trim();
  if (!['receive', 'remove', 'set'].includes(action)) return res.status(400).json({ message: 'Action must be receive, remove, or set' });
  if (!Number.isSafeInteger(quantity) || quantity < 0 || (action !== 'set' && quantity === 0)) return res.status(400).json({ message: 'Quantity must be a valid whole number' });
  if (notes.length > 500) return res.status(400).json({ message: 'Reference or note must be 500 characters or fewer' });
  try {
    const variant = await StockVariant.findOne({ _id: req.params.variantId, productIds: req.params.id });
    if (!variant) return res.status(404).json({ message: 'Size stock was not found for this product' });
    const before = Number(variant.onHandQuantity || 0);
    const after = action === 'set' ? quantity : before + (action === 'receive' ? quantity : -quantity);
    if (after < Number(variant.reservedQuantity || 0)) return res.status(409).json({ message: `Cannot set below ${variant.reservedQuantity || 0} reserved unit(s)` });
    variant.onHandQuantity = after;
    await variant.save();
    await InventoryMovement.create({ productId: req.params.id, actorId: req.user.id, type: action, quantity: after - before, stockBefore: before, stockAfter: after, notes: `Size ${variant.size} (${variant.printMethod})${notes ? `: ${notes}` : ''}` });
    await recomputeProductStock(variant.productIds);
    res.json(serializeVariant(variant));
  } catch (error) {
    console.error('Error updating stock size:', error);
    res.status(500).json({ message: 'Failed to update stock size' });
  }
});

// PATCH /api/inventory/products/:id - Receive, remove, or set available stock.
router.patch('/products/:id', operationsAuth, inventoryRoleAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: 'Invalid product ID' });
  }

  const action = String(req.body.action || '').toLowerCase();
  const quantity = Number(req.body.quantity);
  const notes = String(req.body.notes || '').trim();
  const allowedActions = ['receive', 'remove', 'set'];

  if (!allowedActions.includes(action)) {
    return res.status(400).json({ message: 'Action must be receive, remove, or set' });
  }
  if (typeof req.body.quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0 || (action !== 'set' && quantity === 0)) {
    return res.status(400).json({ message: 'Quantity must be a valid whole number' });
  }
  if (notes.length > 500) {
    return res.status(400).json({ message: 'Reference or note must be 500 characters or fewer' });
  }

  let session;
  let updatedProduct;

  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // Backfill products created before inventory tracking was introduced.
      await Product.updateOne(
        { _id: req.params.id, stock: { $exists: false } },
        { $set: { stock: 0 } },
        { session }
      );

      const product = await Product.findById(req.params.id).session(session);
      if (!product) {
        const error = new Error('Product not found');
        error.statusCode = 404;
        throw error;
      }

      const stockBefore = product.stock;
      const stockAfter = action === 'set'
        ? quantity
        : stockBefore + (action === 'receive' ? quantity : -quantity);

      if (stockAfter < 0) {
        const error = new Error(`Only ${stockBefore} unit(s) are available`);
        error.statusCode = 409;
        throw error;
      }
      if (!Number.isSafeInteger(stockAfter)) {
        const error = new Error('The resulting stock quantity is too large');
        error.statusCode = 400;
        throw error;
      }

      product.stock = stockAfter;
      if (req.body.lowStockThreshold !== undefined) {
        const threshold = Number(req.body.lowStockThreshold);
        if (typeof req.body.lowStockThreshold !== 'number' || !Number.isSafeInteger(threshold) || threshold < 0) {
          const error = new Error('Low-stock threshold must be a non-negative whole number');
          error.statusCode = 400;
          throw error;
        }
        product.lowStockThreshold = threshold;
      }
      if (req.body.stockLocation !== undefined) {
        product.stockLocation = String(req.body.stockLocation || '').trim();
      }
      await product.save({ session });

      const delta = stockAfter - stockBefore;
      await InventoryMovement.create([{
        productId: product._id,
        actorId: req.user.id,
        type: action,
        quantity: delta,
        stockBefore,
        stockAfter,
        notes
      }], { session });

      updatedProduct = product;
    });

    await updatedProduct.populate('catalogId', 'name');
    res.json(serializeProduct(updatedProduct));
  } catch (error) {
    console.error('Error updating stock:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update stock' });
  } finally {
    if (session) await session.endSession();
  }
});

// POST /api/inventory/products/:id/damage - Record a broken unit and route its replacement.
router.post('/products/:id/damage', operationsAuth, inventoryRoleAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: 'Invalid product ID' });
  }
  const quantity = Number(req.body.quantity || 1);
  const notes = String(req.body.notes || '').trim();
  const orderId = req.body.orderId || null;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: 'Damaged quantity must be a positive whole number' });
  }
  if (notes.length > 500) return res.status(400).json({ message: 'Damage note must be 500 characters or fewer' });
  if (orderId && !mongoose.Types.ObjectId.isValid(orderId)) return res.status(400).json({ message: 'Invalid order ID' });

  let session;
  let workflowCaseId;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const product = await Product.findById(req.params.id).session(session);
      if (!product) {
        const error = new Error('Product not found'); error.statusCode = 404; throw error;
      }

      const stockBefore = Number(product.stock || 0);
      let stockAfter = stockBefore;
      let order = null;
      let orderItem = null;

      if (orderId) {
        order = await Order.findById(orderId).session(session);
        if (!order) {
          const error = new Error('Order not found'); error.statusCode = 404; throw error;
        }
        orderItem = order.items.find(item => String(item.productId) === String(product._id) && Number(item.stockQuantity ?? item.quantity) >= quantity);
        if (!orderItem || product.reservedStock < quantity) {
          const error = new Error('This order does not have enough reserved units of this product'); error.statusCode = 409; throw error;
        }
        const existingStockQuantity = Number(orderItem.stockQuantity ?? orderItem.quantity);
        orderItem.stockQuantity = existingStockQuantity - quantity;
        orderItem.printQuantity = Number(orderItem.printQuantity || 0) + quantity;
        orderItem.productionMethod = ['wax', 'resin'].includes(product.printMethod) ? product.printMethod : 'undecided';
        orderItem.fulfillmentStatus = 'production';
        product.reservedStock -= quantity;
      } else {
        if (stockBefore < quantity) {
          const error = new Error(`Only ${stockBefore} available unit(s) can be marked damaged`); error.statusCode = 409; throw error;
        }
        stockAfter = stockBefore - quantity;
        product.stock = stockAfter;
      }

      const hasReadyModel = product.modelFileStatus === 'print_ready' && product.modelFileUrl && ['wax', 'resin'].includes(product.printMethod);
      const caseStatus = hasReadyModel ? 'ready_to_print' : 'boss_review';
      const assignedTeam = teamForStatus(caseStatus, ['wax', 'resin'].includes(product.printMethod) ? product.printMethod : 'undecided');
      const assignedTo = await findTeamAssignee(assignedTeam, session);
      const now = new Date();
      const createdCases = await WorkflowCase.create([{
        orderId: order?._id || null,
        orderItemId: orderItem?._id || null,
        customerId: order?.userId || null,
        productId: product._id,
        requestType: 'damaged_item',
        requestedName: product.name,
        quantity,
        status: caseStatus,
        assignedTeam,
        assignedTo: assignedTo?._id || null,
        assignedAt: assignedTo ? now : null,
        stageQueuedAt: now,
        targetMinutes: targetMinutesForTeam(assignedTeam),
        requirements: `Replace ${quantity} damaged unit(s). ${notes}`.trim(),
        productionMethod: ['wax', 'resin'].includes(product.printMethod) ? product.printMethod : 'undecided',
        customerApproval: 'not_required',
        modelVersions: hasReadyModel ? [{
          version: product.modelVersion || 1,
          fileName: product.modelFileName || 'Approved model',
          fileUrl: product.modelFileUrl,
          uploadedBy: product.createdBy || req.user.id,
          isPrintReady: true
        }] : [],
        createdBy: req.user.id,
        history: [{ actorId: req.user.id, action: 'damage_reported', toStatus: caseStatus, note: notes }]
      }], { session });
      const workflowCase = createdCases[0];
      workflowCaseId = workflowCase._id;

      if (order) {
        orderItem.workflowCaseId = workflowCase._id;
        order.workflowCaseIds.addToSet(workflowCase._id);
        order.fulfillmentState = 'in_progress';
        await order.save({ session });
      }
      await product.save({ session });
      await InventoryMovement.create([{
        productId: product._id,
        orderId: order?._id || null,
        actorId: req.user.id,
        type: 'damage',
        quantity: -quantity,
        stockBefore,
        stockAfter,
        notes: order ? `Reserved item damaged for order #${String(order._id).slice(-6).toUpperCase()}. ${notes}`.trim() : notes
      }], { session });
    });

    const workflowCase = await WorkflowCase.findById(workflowCaseId).populate('productId', 'name serialNumber printMethod modelFileStatus');
    await safelyNotify(() => notifyCaseAssignment(req.app, workflowCase));
    res.status(201).json({
      message: 'Damage recorded and replacement routed',
      workflowCase
    });
  } catch (error) {
    console.error('Error recording damaged stock:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to record damaged stock' });
  } finally {
    if (session) await session.endSession();
  }
});

module.exports = router;
