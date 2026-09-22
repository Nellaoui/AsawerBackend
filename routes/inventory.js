const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const Order = require('../models/Order');
const WorkflowCase = require('../models/WorkflowCase');
const StockVariant = require('../models/StockVariant');
const StockOrphan = require('../models/StockOrphan');
const { operationsAuth } = require('../middlewares/auth');
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
      .populate('actorId', 'name email');

    res.json(movements);
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
    // `needsPrice` is still reported so the form can show it, but a product
    // with no price is not a problem - it is priced when it is ready to sell.
    }).filter((product) => product.needsImage || product.needsDetails
      || product.needsClassification || product.reported);

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
    const serialNumber = String(req.body?.serialNumber || '').trim();
    const type = String(req.body?.type || '').trim();
    if (!name || !serialNumber || !type) {
      return res.status(400).json({ message: 'Name, reference and type are required' });
    }

    const duplicate = await Product.findOne({ serialNumber });
    if (duplicate) {
      return res.status(409).json({
        message: `A product with reference "${serialNumber}" already exists`,
        productId: duplicate._id
      });
    }

    const sizes = Array.isArray(req.body?.availableSizes)
      ? req.body.availableSizes.map((size) => String(size).trim()).filter(Boolean)
      : [];

    const imageUrl = cleanImageUrl(req.body?.imageUrl);
    const rawPrice = Number(req.body?.price);
    const price = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : 0;
    const fulfillmentPolicy = FULFILLMENT_POLICIES.includes(req.body?.fulfillmentPolicy)
      ? req.body.fulfillmentPolicy
      : 'stock_then_print';
    const printMethod = PRINT_METHODS.includes(req.body?.printMethod) ? req.body.printMethod : 'none';
    const ready = Boolean(imageUrl) && hasSupplyRoute({ fulfillmentPolicy, printMethod });

    const product = await Product.create({
      name,
      serialNumber,
      type,
      description: String(req.body?.description || '').trim()
        || (ready
          ? `${name} (${type}) - added from the operations portal.`
          : 'Created from the operations portal. Add the image, price and customer-facing details before publishing.'),
      imageUrl: imageUrl || PLACEHOLDER_IMAGE,
      price,
      stock: 0,
      reservedStock: 0,
      availableSizes: sizes,
      catalogId: req.body?.catalogId && mongoose.Types.ObjectId.isValid(req.body.catalogId)
        ? req.body.catalogId
        : undefined,
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
    });

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

    // Price is intentionally absent from this check.
    const ready = Boolean(cleanImageUrl(product.imageUrl)) && hasSupplyRoute(product);
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

    res.json({
      ready,
      stillMissing: {
        image: !cleanImageUrl(product.imageUrl),
        supplyRoute: !hasSupplyRoute(product)
      },
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
        stockSyncState: product.stockSyncState,
        setupIssue: product.setupIssue
      }
    });
  } catch (error) {
    console.error('Error completing product setup:', error);
    res.status(500).json({ message: 'Failed to save the product details' });
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
