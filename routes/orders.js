const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Catalog = require('../models/Catalog');
const Product = require('../models/Product');
const Notification = require('../models/Notification');
const InventoryMovement = require('../models/InventoryMovement');
const WorkflowCase = require('../models/WorkflowCase');
const User = require('../models/User');
const { auth, operationsAuth } = require('../middlewares/auth');
const { sendPushToUser } = require('../utils/pushNotification');
const { findTeamAssignee } = require('../utils/workflowAssignment');
const { teamForStatus, targetMinutesForTeam } = require('../utils/workflowRules');
const { notifyCaseAssignment, notifyLowStock } = require('../utils/workflowNotifications');
const { catalogIncludesProduct, catalogProductIdSet } = require('../utils/catalogMembership');

const safelyNotify = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    console.error('Order workflow notification failed:', error);
    return null;
  }
};

const ORDER_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['picking', 'packed', 'shipped', 'cancelled'],
  picking: ['packed', 'shipped', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: []
};

const canManageOperations = (user) => Boolean(
  user?.isAdmin || ['admin', 'employee'].includes(user?.role)
);

const quantitiesByProduct = (items) => {
  const quantities = new Map();
  for (const item of items) {
    const productId = String(item.productId?._id || item.productId);
    const quantity = item.stockQuantity === null || item.stockQuantity === undefined
      ? Number(item.quantity)
      : Number(item.stockQuantity);
    if (quantity > 0) quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }
  return quantities;
};

const releaseReservedInventory = async (order, actorId, session) => {
  if (order.inventoryState !== 'reserved') return;

  const movements = [];
  for (const [productId, quantity] of quantitiesByProduct(order.items)) {
    const product = await Product.findOneAndUpdate(
      { _id: productId, reservedStock: { $gte: quantity } },
      { $inc: { stock: quantity, reservedStock: -quantity } },
      { new: true, session }
    );

    if (!product) {
      const error = new Error('Reserved inventory is inconsistent; cancellation was stopped');
      error.statusCode = 409;
      throw error;
    }

    movements.push({
      productId,
      orderId: order._id,
      actorId,
      type: 'order_released',
      quantity,
      stockBefore: product.stock - quantity,
      stockAfter: product.stock,
      notes: `Stock released from cancelled order #${String(order._id).slice(-6).toUpperCase()}`
    });
  }

  if (movements.length) {
    await InventoryMovement.create(movements, { session });
  }
  order.inventoryState = 'released';
  order.inventoryReleasedAt = new Date();
};

const commitReservedInventory = async (order, session) => {
  if (order.inventoryState !== 'reserved') return;

  for (const [productId, quantity] of quantitiesByProduct(order.items)) {
    const result = await Product.updateOne(
      { _id: productId, reservedStock: { $gte: quantity } },
      { $inc: { reservedStock: -quantity } },
      { session }
    );
    if (result.modifiedCount !== 1) {
      const error = new Error('Reserved inventory is inconsistent; shipment was stopped');
      error.statusCode = 409;
      throw error;
    }
  }

  order.inventoryState = 'committed';
  order.inventoryCommittedAt = new Date();
};

const transitionOrder = async (orderId, nextStatus, actorId) => {
  const session = await mongoose.startSession();
  let updatedOrder;

  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        const error = new Error('Order not found');
        error.statusCode = 404;
        throw error;
      }

      if (order.status === nextStatus) {
        updatedOrder = order;
        return;
      }

      const allowed = ORDER_TRANSITIONS[order.status] || [];
      if (!allowed.includes(nextStatus)) {
        const error = new Error(`Order cannot move from ${order.status} to ${nextStatus}`);
        error.statusCode = 409;
        throw error;
      }

      if (nextStatus === 'cancelled') {
        await releaseReservedInventory(order, actorId, session);
        await WorkflowCase.updateMany(
          { orderId: order._id, status: { $nin: ['completed', 'cancelled', 'rejected'] } },
          {
            $set: { status: 'cancelled', assignedTeam: 'none', assignedTo: null },
            $push: { history: { actorId, action: 'order_cancelled', toStatus: 'cancelled', note: 'Parent order was cancelled' } }
          },
          { session }
        );
      } else if (nextStatus === 'shipped') {
        await commitReservedInventory(order, session);
      }

      if (['packed', 'shipped'].includes(nextStatus) && order.workflowCaseIds?.length) {
        const openCases = await WorkflowCase.countDocuments({
          _id: { $in: order.workflowCaseIds },
          status: { $nin: ['completed', 'cancelled'] }
        }).session(session);
        if (openCases > 0) {
          const error = new Error(`${openCases} production or customer-service task(s) must be completed before packing`);
          error.statusCode = 409;
          throw error;
        }
      }

      order.status = nextStatus;
      await order.save({ session });
      updatedOrder = order;
    });

    return updatedOrder;
  } finally {
    await session.endSession();
  }
};

// Validation middleware for order creation
const validateOrderData = (req, res, next) => {
  const { catalogId, items } = req.body;

  if (!catalogId) {
    return res.status(400).json({ message: 'Catalog ID is required' });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Order items are required' });
  }

  // Validate each item
  for (const item of items) {
    if (!item.productId || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1) {
      return res.status(400).json({ 
        message: 'Each item must have productId and quantity >= 1' 
      });
    }
  }

  next();
};

// POST / - Create order (authenticated users)
router.post('/', auth, validateOrderData, async (req, res) => {
  try {
    const { catalogId, items, notes } = req.body;

    // Check if catalog exists and user has access
    const catalog = await Catalog.findById(catalogId);
    if (!catalog) {
      return res.status(404).json({ message: 'Catalog not found' });
    }

    if (!catalog.hasUserAccess(req.user.id)) {
      return res.status(403).json({ message: 'Access denied to catalog' });
    }

    const requestedProductIds = items.map(item => String(item.productId));
    if (requestedProductIds.some(id => !mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({ message: 'One or more product IDs are invalid' });
    }

    const session = await mongoose.startSession();
    let order;
    const lowStockProducts = new Map();

    try {
      await session.withTransaction(async () => {
        const uniqueProductIds = [...new Set(requestedProductIds)];

        // Uncounted products start at zero until an employee records real stock.
        await Product.updateMany(
          { _id: { $in: uniqueProductIds }, stock: { $exists: false } },
          { $set: { stock: 0 } },
          { session }
        );

        const products = await Product.find({ _id: { $in: uniqueProductIds } }).session(session);
        const productById = new Map(products.map(product => [String(product._id), product]));
        const catalogProductIds = catalogProductIdSet(catalog);

        if (products.length !== uniqueProductIds.length) {
          const missingId = uniqueProductIds.find(id => !productById.has(id));
          const error = new Error(`Product ${missingId} not found`);
          error.statusCode = 404;
          throw error;
        }

        const requestedQuantities = quantitiesByProduct(items);
        const allocationByProduct = new Map();
        const reservedProducts = new Map();

        for (const [productId, quantity] of requestedQuantities) {
          const product = productById.get(productId);
          // Catalog.products is the authoritative membership list shown to the
          // customer. A product can be featured in more than one catalog while
          // Product.catalogId continues to identify its primary catalog.
          if (!catalogIncludesProduct(catalogProductIds, productId)) {
            const error = new Error(`Product ${product.name} is not in this catalog`);
            error.statusCode = 400;
            throw error;
          }
          if (!product.isActive) {
            const error = new Error(`Product ${product.name} is not available`);
            error.statusCode = 409;
            throw error;
          }

          // Existing products without a saved rule use available stock first and
          // automatically route any shortage to production.
          const policy = product.fulfillmentPolicy || 'stock_then_print';
          const available = Number.isFinite(product.stock) ? product.stock : 0;
          const stockQuantity = policy === 'print_on_demand' ? 0 : Math.min(available, quantity);
          const printQuantity = quantity - stockQuantity;

          if (policy === 'stock_only' && printQuantity > 0) {
            const error = new Error(`${product.name} has only ${available} unit(s) available`);
            error.statusCode = 409;
            error.code = 'INSUFFICIENT_STOCK';
            throw error;
          }

          allocationByProduct.set(productId, { stockQuantity, printQuantity });

          if (stockQuantity > 0) {
            const reservedProduct = await Product.findOneAndUpdate(
              { _id: productId, isActive: true, stock: { $gte: stockQuantity } },
              { $inc: { stock: -stockQuantity, reservedStock: stockQuantity } },
              { new: true, session }
            );

            if (!reservedProduct) {
              const error = new Error(`Stock for ${product.name} changed while this order was being placed. Please try again.`);
              error.statusCode = 409;
              error.code = 'STOCK_CHANGED';
              throw error;
            }
            reservedProducts.set(productId, reservedProduct);
          }
          const stockAfterReservation = reservedProducts.get(productId) || product;
          if (policy !== 'print_on_demand' && Number(stockAfterReservation.stock) <= Number(stockAfterReservation.lowStockThreshold ?? 2)) {
            lowStockProducts.set(productId, stockAfterReservation.toObject());
          }
        }

        let totalAmount = 0;
        const remainingStock = new Map([...allocationByProduct].map(([productId, allocation]) => [productId, allocation.stockQuantity]));
        const orderItems = items.map(item => {
          const product = productById.get(String(item.productId));
          const productId = String(product._id);
          const quantity = Number(item.quantity);
          const stockQuantity = Math.min(remainingStock.get(productId) || 0, quantity);
          const printQuantity = quantity - stockQuantity;
          remainingStock.set(productId, (remainingStock.get(productId) || 0) - stockQuantity);
          totalAmount += (product.price || 0) * quantity;
          return {
            productId: product._id,
            quantity,
            stockQuantity,
            printQuantity,
            productionMethod: printQuantity > 0 && ['wax', 'resin'].includes(product.printMethod) ? product.printMethod : (printQuantity > 0 ? 'undecided' : 'none'),
            fulfillmentStatus: printQuantity > 0 ? 'production' : 'stock_reserved',
            price: product.price || 0,
            weight: product.weight || 0,
            name: product.name,
            size: item.size,
            clasp: item.clasp,
            height: item.height
          };
        });

        const hasReservedStock = [...allocationByProduct.values()].some(allocation => allocation.stockQuantity > 0);
        const hasProduction = orderItems.some(item => item.printQuantity > 0);
        const createdOrders = await Order.create([{
          userId: req.user.id,
          catalogId,
          items: orderItems,
          totalAmount,
          notes,
          inventoryState: hasReservedStock ? 'reserved' : 'not_required',
          inventoryReservedAt: hasReservedStock ? new Date() : null,
          fulfillmentState: (hasReservedStock || hasProduction) ? 'in_progress' : 'clear'
        }], { session });
        order = createdOrders[0];

        const movements = [...allocationByProduct]
          .filter(([, allocation]) => allocation.stockQuantity > 0)
          .map(([productId, allocation]) => {
          const quantity = allocation.stockQuantity;
          const reservedProduct = reservedProducts.get(productId);
          return {
            productId,
            orderId: order._id,
            actorId: req.user.id,
            type: 'order_reserved',
            quantity: -quantity,
            stockBefore: reservedProduct.stock + quantity,
            stockAfter: reservedProduct.stock,
            notes: `Reserved for order #${String(order._id).slice(-6).toUpperCase()}`
          };
        });
        if (movements.length) await InventoryMovement.create(movements, { session });

        for (const orderItem of order.items) {
          const product = productById.get(String(orderItem.productId));
          if (orderItem.stockQuantity > 0) {
            const assignedTo = await findTeamAssignee('stock', session);
            const now = new Date();
            const stockCases = await WorkflowCase.create([{
              orderId: order._id,
              orderItemId: orderItem._id,
              customerId: req.user.id,
              productId: product._id,
              requestType: 'stock_pick',
              requestedName: product.name,
              quantity: orderItem.stockQuantity,
              status: 'stock_picking',
              assignedTeam: 'stock',
              assignedTo: assignedTo?._id || null,
              assignedAt: assignedTo ? now : null,
              stageQueuedAt: now,
              taskKind: 'order',
              priority: 'normal',
              targetMinutes: targetMinutesForTeam('stock'),
              requirements: `Collect ${orderItem.stockQuantity} reserved unit(s) from stock for this order.`,
              productionMethod: 'undecided',
              customerApproval: 'not_required',
              createdBy: req.user.id,
              history: [{ actorId: req.user.id, action: 'created_from_order', toStatus: 'stock_picking', note: `Stock reserved for order #${String(order._id).slice(-6).toUpperCase()}` }]
            }], { session });
            const stockCase = stockCases[0];
            orderItem.workflowCaseId = stockCase._id;
            order.workflowCaseIds.push(stockCase._id);
          }

          if (!orderItem.printQuantity) continue;
          const hasReadyModel = product.modelFileStatus === 'print_ready' && product.modelFileUrl && ['wax', 'resin'].includes(product.printMethod);
          const caseStatus = hasReadyModel ? 'ready_to_print' : 'boss_review';
          const assignedTeam = teamForStatus(caseStatus, orderItem.productionMethod);
          const assignedTo = await findTeamAssignee(assignedTeam, session);
          const now = new Date();
          const createdCases = await WorkflowCase.create([{
            orderId: order._id,
            orderItemId: orderItem._id,
            customerId: req.user.id,
            productId: product._id,
            requestType: hasReadyModel ? 'print_required' : 'model_file_missing',
            requestedName: product.name,
            quantity: orderItem.printQuantity,
            status: caseStatus,
            assignedTeam,
            assignedTo: assignedTo?._id || null,
            assignedAt: assignedTo ? now : null,
            stageQueuedAt: now,
            targetMinutes: targetMinutesForTeam(assignedTeam),
            requirements: hasReadyModel
              ? `Print ${orderItem.printQuantity} unit(s) for this order.`
              : `The order needs ${orderItem.printQuantity} unit(s), but no approved print-ready 3D file is attached to this product.`,
            productionMethod: orderItem.productionMethod,
            customerApproval: 'not_required',
            modelVersions: hasReadyModel ? [{
              version: product.modelVersion || 1,
              fileName: product.modelFileName || 'Approved model',
              fileUrl: product.modelFileUrl,
              uploadedBy: product.createdBy || req.user.id,
              isPrintReady: true
            }] : [],
            createdBy: req.user.id,
            history: [{ actorId: req.user.id, action: 'created_from_order', toStatus: caseStatus, note: `Generated for order #${String(order._id).slice(-6).toUpperCase()}` }]
          }], { session });
          const workflowCase = createdCases[0];
          orderItem.workflowCaseId = workflowCase._id;
          order.workflowCaseIds.push(workflowCase._id);
        }
        if (order.workflowCaseIds.length) await order.save({ session });
      });
    } finally {
      await session.endSession();
    }

    const assignedCases = await WorkflowCase.find({ _id: { $in: order.workflowCaseIds || [] }, assignedTo: { $ne: null } });
    await Promise.all(assignedCases.map(workflowCase => safelyNotify(() => notifyCaseAssignment(req.app, workflowCase))));
    await Promise.all([...lowStockProducts.values()].map(product => safelyNotify(() => notifyLowStock(req.app, product, String(order._id)))));
    
    // 🔔 Send push notification to user on order creation
    try {
      await sendPushToUser(
        User,
        req.user.id,
        '📦 Order Received',
        `Your order #${order._id.toString().slice(-6).toUpperCase()} has been created`,
        {
          type: 'order',
          orderId: order._id.toString(),
          status: 'pending',
          timestamp: new Date().toISOString()
        }
      );
    } catch (err) {
      console.error('⚠️  Failed to send order creation push:', err);
    }
    
    // Populate order with necessary fields
    let query = Order.findById(order._id)
      .populate('catalogId', 'name description')
      .populate('items.productId', 'name imageUrl size serialNumber weight showWeight type');
    if (mongoose.Types.ObjectId.isValid(order.userId)) {
      query = query.populate('userId', 'name email phone');
    }
    const populatedOrder = await query;

    // Ensure size is properly set in the response
    const orderWithSizes = {
      ...populatedOrder.toObject(),
      items: populatedOrder.items.map(item => ({
        ...item.toObject(),
        // Ensure size comes from the order item first, then from the product
        size: item.size || (item.productId?.size || '')
      }))
    };

    // Notify all admins about the new order
    try {
      const admins = await User.find({
        $or: [{ isAdmin: true }, { role: 'admin' }],
        isActive: { $ne: false }
      }).select('_id name email expoPushTokens');
      const io = req.app.get('io');
      const socketsByUser = req.app.get('socketsByUser');

      for (const admin of admins) {
        const title = 'New order received';
        const body = `${req.user.name || req.user.email} placed a new order (#${order._id})`;
        // persist notification for admin
        const notif = await Notification.create({
          user: admin._id,
          title,
          body,
          type: 'new_order',
          data: { orderId: order._id }
        });

        // emit to connected admin sockets if any
        if (io && socketsByUser) {
          const userSockets = socketsByUser.get(String(admin._id));
          if (userSockets) {
            for (const sid of userSockets) {
              io.to(sid).emit('notification', {
                id: notif._id,
                title: notif.title,
                body: notif.body,
                data: notif.data,
                createdAt: notif.createdAt
              });
            }
          } else {
            // helpful debug log when no connected sockets for this admin
            console.log(`No connected sockets for admin ${admin._id} — notification saved to DB`);
          }
        }

        // 🔔 Send push notification to admin
        try {
          if (admin.expoPushTokens?.length > 0) {
            await sendPushToUser(
              User,
              admin._id,
              '🆕 New Order',
              `Order #${order._id.toString().slice(-6).toUpperCase()} from ${req.user.name || req.user.email}`,
              {
                type: 'order',
                orderId: order._id.toString(),
                action: 'new_order'
              }
            );
          }
        } catch (err) {
          console.error(`⚠️  Failed to send push to admin ${admin.email}:`, err);
        }
      }
    } catch (err) {
      console.error('Error notifying admins about new order:', err);
    }

    res.status(201).json(orderWithSizes);
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(error.statusCode || 500).json({
      message: error.message || 'Server error',
      code: error.code
    });
  }
});

// GET / - List all orders (admin only)
router.get('/', operationsAuth, async (req, res) => {
  try {
    const { status, userId, catalogId, page = 1, limit = 20 } = req.query;
    
    const filters = {};
    if (status) filters.status = status;
    if (userId) filters.userId = userId;
    if (catalogId) filters.catalogId = catalogId;

    const options = { 
      page: parseInt(page), 
      limit: parseInt(limit) 
    };

    let orders = await Order.findWithFilters(filters, options);
    
    // Ensure size is properly set in the response for each order
    orders = orders.map(order => ({
      ...order.toObject(),
      items: order.items.map(item => ({
        ...item.toObject(),
        // Ensure size comes from the order item first, then from the product
        size: item.size || (item.productId?.size || '')
      }))
    }));
    
    // Get total count for pagination
    const totalCount = await Order.countDocuments(filters);
    
    res.json({
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        pages: Math.ceil(totalCount / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /my - Get user's own orders
router.get('/my', auth, async (req, res) => {
  try {
    const { status, limit } = req.query;
    
    const options = {};
    if (status) options.status = status;
    if (limit) options.limit = parseInt(limit);

    const orders = await Order.findByUser(req.user.id, options);
    res.json(orders);
  } catch (error) {
    console.error('Error fetching user orders:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /:id - Get order details
router.get('/:id', auth, async (req, res) => {
  try {
    let query = Order.findById(req.params.id)
      .populate('catalogId', 'name description')
      .populate('items.productId', 'name imageUrl price size serialNumber weight showWeight type clasp height');
    // Only populate userId when it's a valid ObjectId
    const tempOrder = await Order.findById(req.params.id).select('userId');
    if (tempOrder && mongoose.Types.ObjectId.isValid(tempOrder.userId)) {
      query = query.populate('userId', 'name email phone');
    }
    const order = await query;

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Check permissions - user can see their own orders, admin can see all
    const ownerId = (order.userId && typeof order.userId === 'object')
      ? (order.userId._id || order.userId.id || order.userId).toString()
      : (order.userId ? order.userId.toString() : '');
    if (!canManageOperations(req.user) && ownerId !== req.user.id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Ensure size is properly set in the response
    const orderWithSizes = {
      ...order.toObject(),
      items: order.items.map(item => ({
        ...item.toObject(),
        // Ensure size comes from the order item first, then from the product
        size: item.size || (item.productId?.size || '')
      }))
    };

    res.json(orderWithSizes);
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /:id/status - Advance the employee order workflow.
router.put('/:id/status', operationsAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = Object.keys(ORDER_TRANSITIONS);

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        message: 'Valid status is required',
        receivedStatus: status,
        validStatuses
      });
    }

    const order = await transitionOrder(req.params.id, status, req.user.id);

    // 🔔 Send push notification on status change
    const statusMessages = {
      pending: '⏳ Your order is being processed',
      confirmed: '✅ Your order has been confirmed',
      picking: '📋 Your order is being picked',
      packed: '📦 Your order has been packed',
      shipped: '🚚 Your order has been shipped',
      delivered: '🎉 Your order has been delivered',
      cancelled: '❌ Your order has been cancelled'
    };

    try {
      await sendPushToUser(
        User,
        order.userId,
        `Order ${status.toUpperCase()}`,
        statusMessages[status] || `Order status: ${status}`,
        {
          type: 'order',
          orderId: order._id.toString(),
          status: status,
          timestamp: new Date().toISOString()
        }
      );
      console.log(`✅ Push notification sent for order status change to ${status}`);
    } catch (err) {
      console.error('⚠️  Failed to send status update push:', err);
    }

    if (mongoose.Types.ObjectId.isValid(order.userId)) {
      await order.populate('userId', 'name email phone');
    }
    await order.populate('catalogId', 'name description');
    await order.populate('items.productId', 'name imageUrl size serialNumber weight showWeight type stock reservedStock');

    res.json(order);
  } catch (error) {
    console.error('=== STATUS UPDATE ERROR ===');
    res.status(error.statusCode || 500).json({
      message: error.message || 'Server error',
      error: error?.message,
      errorType: error?.name
    });
  }
});

// PUT /:id/cancel - Cancel order (authenticated users)
router.put('/:id/cancel', auth, async (req, res) => {
  try {
    const existingOrder = await Order.findById(req.params.id);

    if (!existingOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const ownerId = String(existingOrder.userId?._id || existingOrder.userId);
    if (!canManageOperations(req.user) && ownerId !== String(req.user.id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (!canManageOperations(req.user) && !['pending', 'confirmed'].includes(existingOrder.status)) {
      return res.status(409).json({ message: 'This order is already being prepared and can no longer be cancelled' });
    }

    const order = await transitionOrder(req.params.id, 'cancelled', req.user.id);
    if (mongoose.Types.ObjectId.isValid(order.userId)) {
      await order.populate('userId', 'name email phone');
    }
    await order.populate('catalogId', 'name description');
    await order.populate('items.productId', 'name imageUrl size serialNumber weight showWeight type stock reservedStock');

    console.log(`Order ${order._id} cancelled by user ${req.user.email}`);

    // 🔔 Send push notification on order cancel
    try {
      await sendPushToUser(
        User,
        order.userId?._id || order.userId,
        'Order Cancelled',
        'Your order has been cancelled',
        {
          type: 'order',
          orderId: order._id.toString(),
          status: 'cancelled'
        }
      );
    } catch (err) {
      console.error('⚠️  Failed to send cancel push:', err);
    }

    res.json(order);
  } catch (error) {
    console.error('Error cancelling order:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// DELETE /:id - Hard delete order (admin only)
router.delete('/:id', operationsAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    if (order.inventoryState === 'reserved') {
      return res.status(409).json({ message: 'Cancel this order before deleting it so its stock is restored' });
    }
    await order.deleteOne();
    res.json({ success: true, message: 'Order deleted successfully', order });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
