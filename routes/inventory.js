const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const Order = require('../models/Order');
const WorkflowCase = require('../models/WorkflowCase');
const { operationsAuth } = require('../middlewares/auth');
const { findTeamAssignee } = require('../utils/workflowAssignment');
const { teamForStatus, targetMinutesForTeam } = require('../utils/workflowRules');
const { notifyCaseAssignment, notifyLowStock } = require('../utils/workflowNotifications');

const router = express.Router();

const safelyNotify = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    console.error('Inventory notification failed:', error);
    return null;
  }
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const serializeProduct = (product) => {
  const value = product.toObject ? product.toObject() : product;
  const catalog = value.catalogId && typeof value.catalogId === 'object' ? value.catalogId : null;

  return {
    ...value,
    productId: String(value._id),
    stock: Number.isFinite(value.stock) ? value.stock : 0,
    reservedStock: Number.isFinite(value.reservedStock) ? value.reservedStock : 0,
    lowStockThreshold: Number.isFinite(value.lowStockThreshold) ? value.lowStockThreshold : 2,
    stockLocation: value.stockLocation || '',
    catalogName: catalog?.name || ''
  };
};

// GET /api/inventory - Searchable stock list and dashboard totals.
router.get('/', operationsAuth, async (req, res) => {
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

    res.json({
      products: products.map(serializeProduct),
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
router.get('/movements', operationsAuth, async (req, res) => {
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

// PATCH /api/inventory/products/:id - Receive, remove, or set available stock.
router.patch('/products/:id', operationsAuth, async (req, res) => {
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
  let stockBeforeValue;
  let thresholdBeforeValue;

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
      stockBeforeValue = stockBefore;
      thresholdBeforeValue = Number(product.lowStockThreshold ?? 2);
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
    const wasLowStock = Number(stockBeforeValue) <= Number(thresholdBeforeValue);
    const isLowStock = Number(updatedProduct.stock) <= Number(updatedProduct.lowStockThreshold ?? 2);
    if (
      isLowStock
      && (!wasLowStock || Number(updatedProduct.stock) < Number(stockBeforeValue))
    ) {
      await safelyNotify(() => notifyLowStock(req.app, updatedProduct, `inventory:${Date.now()}`));
    }
    res.json(serializeProduct(updatedProduct));
  } catch (error) {
    console.error('Error updating stock:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update stock' });
  } finally {
    if (session) await session.endSession();
  }
});

// POST /api/inventory/products/:id/damage - Record a broken unit and route its replacement.
router.post('/products/:id/damage', operationsAuth, async (req, res) => {
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
  let damagedProduct;
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
      damagedProduct = product.toObject();
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
    await safelyNotify(() => notifyLowStock(req.app, damagedProduct, `damage:${workflowCaseId}`));

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
