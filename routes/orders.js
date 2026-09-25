const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Catalog = require('../models/Catalog');
const Product = require('../models/Product');
const Notification = require('../models/Notification');
const InventoryMovement = require('../models/InventoryMovement');
const WorkflowCase = require('../models/WorkflowCase');
const AuditLog = require('../models/AuditLog');
const StockVariant = require('../models/StockVariant');
const User = require('../models/User');
const { auth, operationsAuth } = require('../middlewares/auth');
const { sendPushToUser } = require('../utils/pushNotification');
const { findTeamAssignee } = require('../utils/workflowAssignment');
const { teamForStatus, targetMinutesForTeam } = require('../utils/workflowRules');
const { planPrintTask, planStockTask } = require('../utils/orderWorkflowRoute');
const { notifyCaseAssignment, notifyTaskRemoved } = require('../utils/workflowNotifications');
const { catalogIncludesProduct, catalogProductIdSet } = require('../utils/catalogMembership');
const { normalizeStockSize } = require('../utils/stockReference');

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

const canViewAllOrders = (user) => Boolean(
  user?.isAdmin
  || user?.role === 'admin'
  || (user?.role === 'employee' && ['customer_service', 'boss'].includes(user?.workRole))
);

const canValidateOrders = (user) => Boolean(
  user?.isAdmin
  || user?.role === 'admin'
  || (user?.role === 'employee' && ['customer_service', 'boss'].includes(user?.workRole))
);

const quantitiesByProduct = (items) => {
  const quantities = new Map();
  for (const item of items) {
    if (item.inventoryVariantId) continue;
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
  for (const item of order.items) {
    const quantity = Number(item.stockQuantity || 0);
    if (!item.inventoryVariantId || quantity <= 0) continue;
    const variant = await StockVariant.findOneAndUpdate(
      { _id: item.inventoryVariantId, reservedQuantity: { $gte: quantity } },
      { $inc: { reservedQuantity: -quantity } },
      { new: true, session }
    );
    if (!variant) {
      const error = new Error('Reserved size inventory is inconsistent; cancellation was stopped');
      error.statusCode = 409;
      throw error;
    }
    await Product.updateMany(
      { _id: { $in: variant.productIds } },
      { $inc: { stock: quantity, reservedStock: -quantity } },
      { session }
    );
    movements.push({
      productId: item.productId,
      orderId: order._id,
      actorId,
      type: 'order_released',
      quantity,
      stockBefore: Math.max(variant.onHandQuantity - variant.reservedQuantity - quantity, 0),
      stockAfter: Math.max(variant.onHandQuantity - variant.reservedQuantity, 0),
      notes: `Size ${item.size || variant.size} released from cancelled order #${String(order._id).slice(-6).toUpperCase()}`
    });
  }
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

  for (const item of order.items) {
    const quantity = Number(item.stockQuantity || 0);
    if (!item.inventoryVariantId || quantity <= 0) continue;
    const variant = await StockVariant.findOneAndUpdate(
      {
        _id: item.inventoryVariantId,
        reservedQuantity: { $gte: quantity },
        onHandQuantity: { $gte: quantity }
      },
      { $inc: { reservedQuantity: -quantity, onHandQuantity: -quantity } },
      { new: true, session }
    );
    if (!variant) {
      const error = new Error('Reserved size inventory is inconsistent; shipment was stopped');
      error.statusCode = 409;
      throw error;
    }
    await Product.updateMany(
      { _id: { $in: variant.productIds } },
      { $inc: { reservedStock: -quantity } },
      { session }
    );
  }

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

const createFulfillmentCases = async (order, productById, actorId, session, items = order.items) => {
  const createdCases = [];
  for (const orderItem of items) {
    const product = productById.get(String(orderItem.productId));
    if (!product) {
      const error = new Error(`Product for ${orderItem.name} no longer exists`);
      error.statusCode = 409;
      throw error;
    }

    if (Number(orderItem.stockQuantity || 0) > 0) {
      const assignedTo = await findTeamAssignee('stock', session);
      const now = new Date();
      const stockPlan = planStockTask(orderItem);
      const cases = await WorkflowCase.create([{
        orderId: order._id,
        orderItemId: orderItem._id,
        customerId: order.userId,
        productId: product._id,
        requestType: 'stock_pick',
        requestedName: product.name,
        quantity: stockPlan.quantity,
        status: 'stock_picking',
        assignedTeam: 'stock',
        assignedTo: assignedTo?._id || null,
        assignedAt: assignedTo ? now : null,
        stageQueuedAt: now,
        taskKind: 'order',
        priority: 'normal',
        targetMinutes: targetMinutesForTeam('stock'),
        requirements: stockPlan.requirements,
        // Carry Customer Service's route so the Wax/Resin filters include stock
        // work, and so a unit missing from the shelf is printed on that route.
        productionMethod: ['wax', 'resin'].includes(orderItem.productionMethod) ? orderItem.productionMethod : 'undecided',
        customerApproval: 'not_required',
        createdBy: actorId,
        history: [{ actorId, action: 'created_after_validation', toStatus: 'stock_picking', note: `Customer Service approved order ${order.orderNumber || order._id}` }]
      }], { session });
      const stockCase = cases[0];
      orderItem.workflowCaseId = stockCase._id;
      order.workflowCaseIds.push(stockCase._id);
      createdCases.push(stockCase);
    }

    if (!orderItem.printQuantity) continue;
    const { status: caseStatus, assignedTeam, hasPortalModel } = planPrintTask(product, orderItem);
    const assignedTo = await findTeamAssignee(assignedTeam, session);
    const now = new Date();
    const cases = await WorkflowCase.create([{
      orderId: order._id,
      orderItemId: orderItem._id,
      customerId: order.userId,
      productId: product._id,
      requestType: 'print_required',
      requestedName: product.name,
      quantity: orderItem.printQuantity,
      status: caseStatus,
      assignedTeam,
      assignedTo: assignedTo?._id || null,
      assignedAt: assignedTo ? now : null,
      stageQueuedAt: now,
      targetMinutes: targetMinutesForTeam(assignedTeam),
      requirements: `Print ${orderItem.printQuantity} unit(s), size ${orderItem.size || '-'}, for this order using the manufacturer application. If the 3D file is unavailable, mark this task Blocked and give the reason.`,
      productionMethod: orderItem.productionMethod,
      customerApproval: 'not_required',
      modelVersions: hasPortalModel ? [{
        version: product.modelVersion || 1,
        fileName: product.modelFileName || 'Approved model',
        fileUrl: product.modelFileUrl,
        uploadedBy: product.createdBy || actorId,
        isPrintReady: true
      }] : [],
      createdBy: actorId,
      history: [{ actorId, action: 'created_after_validation', toStatus: caseStatus, note: `Customer Service approved order ${order.orderNumber || order._id}. ${Number(orderItem.stockQuantity || 0) === 0 ? 'No finished stock was reserved; stock picking was automatically skipped.' : 'Reserved stock has a separate picking task.'}` }]
    }], { session });
    const printCase = cases[0];
    orderItem.workflowCaseId = printCase._id;
    order.workflowCaseIds.push(printCase._id);
    createdCases.push(printCase);
  }
  return createdCases;
};

// POST / - Create order (authenticated users)
router.post('/', auth, validateOrderData, async (req, res) => {
  try {
    const { catalogId, items, notes } = req.body;
    const requestedSubmissionKey = String(req.get('Idempotency-Key') || req.body.submissionKey || '').trim().slice(0, 160);
    const submissionKey = requestedSubmissionKey || `server-${new mongoose.Types.ObjectId()}`;
    const existingOrder = requestedSubmissionKey
      ? await Order.findOne({ userId: req.user.id, submissionKey: requestedSubmissionKey })
      : null;
    if (existingOrder) {
      await existingOrder.populate('catalogId', 'name description');
      await existingOrder.populate('items.productId', 'name imageUrl size serialNumber weight showWeight type');
      return res.status(200).json(existingOrder);
    }
    const orderNumber = `ASW-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${new mongoose.Types.ObjectId().toString().slice(-8).toUpperCase()}`;
    const orderingUser = await User.findById(req.user.id).select('forcedProductionMethod').lean();
    const forcedProductionMethod = ['wax', 'resin'].includes(orderingUser?.forcedProductionMethod)
      ? orderingUser.forcedProductionMethod
      : null;

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

        const stockVariants = await StockVariant.find({
          productIds: { $in: uniqueProductIds }
        }).session(session);
        const variantsByProduct = new Map(uniqueProductIds.map(productId => [productId, []]));
        for (const variant of stockVariants) {
          for (const linkedProductId of variant.productIds || []) {
            const productId = String(linkedProductId);
            if (variantsByProduct.has(productId)) variantsByProduct.get(productId).push(variant);
          }
        }

        const allocationByItem = [];
        for (const [itemIndex, item] of items.entries()) {
          const productId = String(item.productId);
          const product = productById.get(productId);
          const quantity = Number(item.quantity);
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

          const productVariants = variantsByProduct.get(productId) || [];
          const sizeKey = normalizeStockSize(item.size);
          if (productVariants.length && !sizeKey) {
            const error = new Error(`Choose a size for ${product.name} so its exact stock can be checked`);
            error.statusCode = 400;
            error.code = 'SIZE_REQUIRED';
            throw error;
          }

          const sizeCandidates = productVariants.filter(variant => variant.sizeKey === sizeKey);
          // A customer-level route is authoritative for every printable item in
          // their orders. Otherwise the product classification chooses the queue.
          const preferredMethod = forcedProductionMethod
            || (['wax', 'resin'].includes(product.printMethod) ? product.printMethod : null);
          let selectedVariant = preferredMethod
            ? sizeCandidates.find(variant => variant.printMethod === preferredMethod)
            : null;
          // Once a product (or customer) has an explicit route, never borrow
          // finished stock from the opposite material. A Wax-only product with
          // no Wax stock becomes Wax print work, and the same applies to Resin.
          if (!selectedVariant && sizeCandidates.length && !preferredMethod) {
            selectedVariant = [...sizeCandidates].sort((left, right) => {
              const leftAvailable = Math.max(left.onHandQuantity - left.reservedQuantity, 0);
              const rightAvailable = Math.max(right.onHandQuantity - right.reservedQuantity, 0);
              return rightAvailable - leftAvailable || left.printMethod.localeCompare(right.printMethod);
            })[0];
          }

          // Sheet-backed products use exact reference + size + Wax/Resin stock.
          // Older manual products keep their scalar-stock fallback until linked.
          const policy = product.fulfillmentPolicy || 'stock_then_print';
          let available = selectedVariant
            ? Math.max(selectedVariant.onHandQuantity - selectedVariant.reservedQuantity, 0)
            : (productVariants.length ? 0 : (Number.isFinite(product.stock) ? product.stock : 0));
          let stockQuantity = policy === 'print_on_demand' ? 0 : Math.min(available, quantity);
          let printQuantity = quantity - stockQuantity;

          if (policy === 'stock_only' && printQuantity > 0) {
            const error = new Error(`${product.name} has only ${available} unit(s) available`);
            error.statusCode = 409;
            error.code = 'INSUFFICIENT_STOCK';
            throw error;
          }

          // Reserve atomically. If the shelf holds less than we read (another
          // order got there first), take what is left and print the rest rather
          // than refusing the whole order.
          const reserve = async (wanted) => {
            if (selectedVariant) {
              const reservedVariant = await StockVariant.findOneAndUpdate(
                {
                  _id: selectedVariant._id,
                  $expr: { $gte: [{ $subtract: ['$onHandQuantity', '$reservedQuantity'] }, wanted] }
                },
                { $inc: { reservedQuantity: wanted } },
                { new: true, session }
              );
              if (!reservedVariant) return false;
              await Product.updateMany(
                { _id: { $in: reservedVariant.productIds } },
                { $inc: { stock: -wanted, reservedStock: wanted } },
                { session }
              );
              selectedVariant.reservedQuantity = reservedVariant.reservedQuantity;
              return true;
            }
            const reservedProduct = await Product.findOneAndUpdate(
              { _id: productId, isActive: true, stock: { $gte: wanted } },
              { $inc: { stock: -wanted, reservedStock: wanted } },
              { new: true, session }
            );
            if (!reservedProduct) return false;
            // The same product can appear on several lines of one order (two
            // sizes); the next line must see the stock this line just took.
            product.stock = reservedProduct.stock;
            product.reservedStock = reservedProduct.reservedStock;
            return true;
          };

          if (stockQuantity > 0 && !(await reserve(stockQuantity))) {
            const fresh = selectedVariant
              ? await StockVariant.findById(selectedVariant._id).session(session).lean()
              : await Product.findById(productId).select('stock').session(session).lean();
            const nowAvailable = selectedVariant
              ? Math.max(Number(fresh?.onHandQuantity || 0) - Number(fresh?.reservedQuantity || 0), 0)
              : Math.max(Number(fresh?.stock || 0), 0);
            if (selectedVariant && fresh) selectedVariant.reservedQuantity = Number(fresh.reservedQuantity || 0);
            if (!selectedVariant && fresh) product.stock = Number(fresh.stock || 0);
            const retryQuantity = Math.min(nowAvailable, quantity);
            if (policy === 'stock_only' && retryQuantity < quantity) {
              const error = new Error(`${product.name} has only ${nowAvailable} unit(s) available`);
              error.statusCode = 409;
              error.code = 'INSUFFICIENT_STOCK';
              throw error;
            }
            if (retryQuantity > 0 && !(await reserve(retryQuantity))) {
              const error = new Error(`Stock for ${product.name} changed while this order was being placed. Please try again.`);
              error.statusCode = 409;
              error.code = 'STOCK_CHANGED';
              throw error;
            }
            stockQuantity = retryQuantity;
            printQuantity = quantity - retryQuantity;
            available = nowAvailable;
          }

          allocationByItem[itemIndex] = {
            stockQuantity,
            printQuantity,
            inventoryVariantId: selectedVariant?._id || null,
            productionMethod: selectedVariant?.printMethod || preferredMethod || (printQuantity > 0 ? 'undecided' : 'none'),
            stockBefore: available,
            stockAfter: available - stockQuantity
          };
        }

        let totalAmount = 0;
        const orderItems = items.map((item, itemIndex) => {
          const product = productById.get(String(item.productId));
          const quantity = Number(item.quantity);
          const allocation = allocationByItem[itemIndex];
          totalAmount += (product.price || 0) * quantity;
          return {
            productId: product._id,
            inventoryVariantId: allocation.inventoryVariantId,
            quantity,
            stockQuantity: allocation.stockQuantity,
            printQuantity: allocation.printQuantity,
            productionMethod: allocation.productionMethod,
            fulfillmentStatus: 'awaiting_validation',
            price: product.price || 0,
            weight: product.weight || 0,
            name: product.name,
            size: item.size,
            clasp: item.clasp,
            height: item.height
          };
        });

        const hasReservedStock = allocationByItem.some(allocation => allocation.stockQuantity > 0);
        const createdOrders = await Order.create([{
          orderNumber,
          submissionKey,
          userId: req.user.id,
          catalogId,
          items: orderItems,
          totalAmount,
          notes,
          inventoryState: hasReservedStock ? 'reserved' : 'not_required',
          inventoryReservedAt: hasReservedStock ? new Date() : null,
          fulfillmentState: 'blocked',
          validationStatus: 'pending'
        }], { session });
        order = createdOrders[0];

        const movements = allocationByItem
          .map((allocation, itemIndex) => ({ allocation, item: items[itemIndex] }))
          .filter(({ allocation }) => allocation.stockQuantity > 0)
          .map(({ allocation, item }) => {
          const quantity = allocation.stockQuantity;
          return {
            productId: item.productId,
            orderId: order._id,
            actorId: req.user.id,
            type: 'order_reserved',
            quantity: -quantity,
            stockBefore: allocation.stockBefore,
            stockAfter: allocation.stockAfter,
            notes: `Size ${item.size || '-'} reserved for order #${String(order._id).slice(-6).toUpperCase()}`
          };
        });
        if (movements.length) await InventoryMovement.create(movements, { session });

        const validationAssignee = await findTeamAssignee('customer_service', session);
        const now = new Date();
        const validationCases = await WorkflowCase.create([{
          orderId: order._id,
          customerId: req.user.id,
          requestType: 'order_validation',
          requestedName: `Validate order ${order.orderNumber}`,
          quantity: order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
          status: 'awaiting_validation',
          assignedTeam: 'customer_service',
          assignedTo: validationAssignee?._id || null,
          assignedAt: validationAssignee ? now : null,
          stageQueuedAt: now,
          taskKind: 'order',
          priority: 'normal',
          targetMinutes: targetMinutesForTeam('customer_service'),
          requirements: 'Confirm customer, product reference, size, quantity and Wax/Resin route before production starts.',
          productionMethod: 'undecided',
          customerApproval: 'not_required',
          createdBy: req.user.id,
          history: [{ actorId: req.user.id, action: 'order_submitted_for_validation', toStatus: 'awaiting_validation', note: `Order ${order.orderNumber} is waiting for Customer Service` }]
        }], { session });
        order.validationCaseId = validationCases[0]._id;
        order.workflowCaseIds.push(validationCases[0]._id);
        await order.save({ session });
      });
    } finally {
      await session.endSession();
    }

    const assignedCases = await WorkflowCase.find({ _id: { $in: order.workflowCaseIds || [] }, assignedTo: { $ne: null } });
    await Promise.all(assignedCases.map(workflowCase => safelyNotify(() => notifyCaseAssignment(req.app, workflowCase))));
    
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
    if (error?.code === 11000) {
      const submissionKey = String(req.get('Idempotency-Key') || req.body.submissionKey || '').trim().slice(0, 160);
      const existingOrder = submissionKey
        ? await Order.findOne({ userId: req.user.id, submissionKey })
          .populate('catalogId', 'name description')
          .populate('items.productId', 'name imageUrl size serialNumber weight showWeight type')
        : null;
      if (existingOrder) return res.status(200).json(existingOrder);
    }
    console.error('Error creating order:', error);
    res.status(error.statusCode || 500).json({
      message: error.message || 'Server error',
      code: error.code
    });
  }
});

// POST /:id/confirm-legacy-workflow - route an order made by the older mobile
// backend without creating another set of stock or print tasks.
router.post('/:id/confirm-legacy-workflow', operationsAuth, async (req, res) => {
  if (!canValidateOrders(req.user)) {
    return res.status(403).json({ message: 'Only Customer Service or the boss can confirm an older order' });
  }
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: 'Invalid order ID' });
  }

  const routes = Array.isArray(req.body.items) ? req.body.items : [];
  const routeByItem = new Map(routes.map(item => [String(item.itemId || ''), String(item.productionMethod || '')]));
  const session = await mongoose.startSession();
  let confirmedOrder;
  const reassignedCases = [];
  const newStockCases = [];
  try {
    await session.withTransaction(async () => {
      reassignedCases.length = 0;
      newStockCases.length = 0;
      const order = await Order.findById(req.params.id).session(session);
      if (!order) {
        const error = new Error('Order not found');
        error.statusCode = 404;
        throw error;
      }
      if (order.validationCaseId || order.validatedAt) {
        const error = new Error('This order already uses the Customer Service validation workflow');
        error.statusCode = 409;
        throw error;
      }
      if (!['pending', 'confirmed'].includes(order.status)) {
        const error = new Error('Only an open order can be routed to printing');
        error.statusCode = 409;
        throw error;
      }

      const printItems = order.items.filter(item => Number(item.printQuantity || 0) > 0);
      if (!printItems.length || routes.length !== printItems.length || routeByItem.size !== printItems.length) {
        const error = new Error('Choose Wax or Resin for every printable item in this order');
        error.statusCode = 400;
        throw error;
      }
      const customer = await User.findById(order.userId).select('forcedProductionMethod').session(session);
      if (!customer) {
        const error = new Error('Confirm the customer account before routing this order');
        error.statusCode = 409;
        throw error;
      }
      const products = await Product.find({ _id: { $in: order.items.map(item => item.productId) } })
        .select('_id serialNumber').session(session);
      const productById = new Map(products.map(product => [String(product._id), product]));
      for (const item of order.items) {
        const product = productById.get(String(item.productId));
        const quantity = Number(item.quantity);
        const stockQuantity = Number(item.stockQuantity);
        const printQuantity = Number(item.printQuantity);
        if (!product || !String(product.serialNumber || '').trim()) {
          const error = new Error(`${item.name} needs a valid product reference before confirmation`);
          error.statusCode = 409;
          throw error;
        }
        if (!Number.isSafeInteger(quantity) || quantity < 1
          || !Number.isSafeInteger(stockQuantity) || stockQuantity < 0
          || !Number.isSafeInteger(printQuantity) || printQuantity < 0
          || stockQuantity + printQuantity !== quantity) {
          const error = new Error(`Review the stock and print quantities for ${product.serialNumber}`);
          error.statusCode = 409;
          throw error;
        }
      }
      const forcedMethod = ['wax', 'resin'].includes(customer.forcedProductionMethod)
        ? customer.forcedProductionMethod : null;
      const now = new Date();
      const auditRoutes = [];

      for (const item of printItems) {
        const method = routeByItem.get(String(item._id));
        if (!['wax', 'resin'].includes(method)) {
          const error = new Error(`Choose Wax or Resin for ${item.name}, size ${item.size || '-'}`);
          error.statusCode = 400;
          throw error;
        }
        if (forcedMethod && method !== forcedMethod) {
          const error = new Error(`This customer account requires ${forcedMethod} printing`);
          error.statusCode = 409;
          throw error;
        }

        const workflowCase = await WorkflowCase.findOne({
          _id: item.workflowCaseId,
          orderId: order._id,
          orderItemId: item._id
        }).session(session);
        if (!workflowCase || workflowCase.status !== 'boss_review'
          || workflowCase.requestType !== 'model_file_missing'
          || workflowCase.isBlocked) {
          const error = new Error(`The print task for ${item.name}, size ${item.size || '-'} has changed. Review it before routing.`);
          error.statusCode = 409;
          throw error;
        }

        const team = teamForStatus('ready_to_print', method);
        const assignee = await findTeamAssignee(team, session);
        if (!assignee) {
          const error = new Error(`No active ${method} printing employee is available`);
          error.statusCode = 409;
          throw error;
        }
        const previousAssignee = workflowCase.assignedTo;
        const previousStartedAt = workflowCase.startedAt;
        workflowCase.status = 'ready_to_print';
        workflowCase.requestType = 'print_required';
        workflowCase.productionMethod = method;
        workflowCase.assignedTeam = team;
        workflowCase.assignedTo = assignee._id;
        workflowCase.assignedAt = now;
        workflowCase.startedAt = null;
        workflowCase.completedAt = null;
        workflowCase.stageQueuedAt = now;
        workflowCase.targetMinutes = targetMinutesForTeam(team);
        workflowCase.requirements = `Print ${item.printQuantity} unit(s), size ${item.size || '-'}, for this order using the manufacturer application. If the 3D file is unavailable, mark this task Blocked and give the reason.`;
        workflowCase.history.push({
          actorId: req.user.id,
          action: 'legacy_order_routed',
          fromStatus: 'boss_review',
          toStatus: 'ready_to_print',
          note: `Customer Service confirmed ${method} for ${item.name}, size ${item.size || '-'}`,
          workMinutes: previousStartedAt
            ? Math.max(Math.round((now - previousStartedAt) / 60000), 0)
            : null
        });
        await workflowCase.save({ session });
        item.productionMethod = method;
        item.fulfillmentStatus = 'production';
        auditRoutes.push({ itemId: String(item._id), caseId: String(workflowCase._id), method });
        reassignedCases.push({ workflowCase, previousAssignee });
      }

      let stockAssignee = null;
      for (const item of order.items) {
        if (Number(item.stockQuantity || 0) <= 0) continue;
        const existingStockCase = await WorkflowCase.findOne({
          orderId: order._id,
          orderItemId: item._id,
          requestType: 'stock_pick'
        }).session(session);
        if (existingStockCase) continue;
        if (!stockAssignee) stockAssignee = await findTeamAssignee('stock', session);
        if (!stockAssignee) {
          const error = new Error('No active stock employee is available to verify this order');
          error.statusCode = 409;
          throw error;
        }
        const stockPlan = planStockTask(item);
        const cases = await WorkflowCase.create([{
          orderId: order._id,
          orderItemId: item._id,
          customerId: order.userId,
          productId: item.productId,
          requestType: 'stock_pick',
          requestedName: item.name,
          quantity: stockPlan.quantity,
          status: 'stock_picking',
          assignedTeam: 'stock',
          assignedTo: stockAssignee._id,
          assignedAt: now,
          stageQueuedAt: now,
          taskKind: 'order',
          targetMinutes: targetMinutesForTeam('stock'),
          requirements: stockPlan.requirements,
          productionMethod: ['wax', 'resin'].includes(item.productionMethod) ? item.productionMethod : 'undecided',
          customerApproval: 'not_required',
          createdBy: req.user.id,
          history: [{ actorId: req.user.id, action: 'legacy_stock_check_created', toStatus: 'stock_picking', note: 'Existing order confirmed without changing stock quantities' }]
        }], { session });
        order.workflowCaseIds.push(cases[0]._id);
        newStockCases.push(cases[0]);
      }

      order.validationStatus = 'approved';
      order.validatedBy = req.user.id;
      order.validatedAt = now;
      order.validationNote = String(req.body.note || 'Older order confirmed by Customer Service').slice(0, 1000);
      if (order.status === 'pending') order.status = 'confirmed';
      order.fulfillmentState = 'in_progress';
      await order.save({ session });
      await AuditLog.create([{
        category: 'workflow',
        action: 'legacy_order_confirmed',
        actorId: req.user.id,
        entityType: 'Order',
        entityId: String(order._id),
        orderId: String(order._id),
        details: { routes: auditRoutes, stockCheckTasksCreated: newStockCases.length, stockChecksAutomaticallySkipped: order.items.filter(item => Number(item.stockQuantity || 0) === 0).length, stockChanged: false }
      }], { session });
      confirmedOrder = order;
    });

    await Promise.all(reassignedCases.flatMap(({ workflowCase, previousAssignee }) => [
      previousAssignee ? safelyNotify(() => notifyTaskRemoved(req.app, previousAssignee, workflowCase)) : Promise.resolve(),
      safelyNotify(() => notifyCaseAssignment(req.app, workflowCase))
    ]));
    await Promise.all(newStockCases.map(workflowCase => safelyNotify(() => notifyCaseAssignment(req.app, workflowCase))));
    res.json(confirmedOrder);
  } catch (error) {
    console.error('Error confirming older order workflow:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to confirm older order workflow' });
  } finally {
    await session.endSession();
  }
});

// POST /:id/validate - Customer Service approves an order before work starts.
router.post('/:id/validate', operationsAuth, async (req, res) => {
  if (!canValidateOrders(req.user)) {
    return res.status(403).json({ message: 'Only Customer Service or the boss can validate an order' });
  }

  const session = await mongoose.startSession();
  let approvedOrder;
  let fulfillmentCases = [];
  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(req.params.id).session(session);
      if (!order) {
        const error = new Error('Order not found');
        error.statusCode = 404;
        throw error;
      }
      if (order.validationStatus !== 'pending') {
        const error = new Error(order.validationStatus === 'approved' ? 'This order is already validated' : 'This order cannot be validated');
        error.statusCode = 409;
        throw error;
      }

      const validationCase = await WorkflowCase.findById(order.validationCaseId).session(session);
      if (!validationCase || validationCase.status !== 'awaiting_validation') {
        const error = new Error('The Customer Service validation task is missing or already closed');
        error.statusCode = 409;
        throw error;
      }
      const manager = req.user?.isAdmin || req.user?.role === 'admin' || req.user?.workRole === 'boss';
      if (!manager && String(validationCase.assignedTo || '') !== String(req.user.id)) {
        const error = new Error('This validation is assigned to another Customer Service employee');
        error.statusCode = 403;
        throw error;
      }
      const customer = mongoose.Types.ObjectId.isValid(String(order.userId))
        ? await User.findById(order.userId).select('forcedProductionMethod').session(session).lean()
        : null;
      if (!customer) {
        const error = new Error('Confirm the customer account before approving this order');
        error.statusCode = 409;
        throw error;
      }

      const productIds = [...new Set(order.items.map(item => String(item.productId)))];
      const products = await Product.find({ _id: { $in: productIds } }).session(session);
      const productById = new Map(products.map(product => [String(product._id), product]));
      const submittedRoutes = new Map((Array.isArray(req.body.items) ? req.body.items : [])
        .map(item => [String(item.itemId || ''), String(item.productionMethod || '')]));

      // Customer Service may confirm references one at a time. Only items still
      // waiting are confirmed; `itemIds` narrows that to the ones sent.
      const waitingItems = order.items.filter(item => item.fulfillmentStatus === 'awaiting_validation');
      const pendingItems = waitingItems.length ? waitingItems : order.items;
      const requestedIds = Array.isArray(req.body.itemIds) ? new Set(req.body.itemIds.map(String)) : null;
      const confirmItems = requestedIds ? pendingItems.filter(item => requestedIds.has(String(item._id))) : pendingItems;
      if (!confirmItems.length) {
        const error = new Error('These items are already confirmed');
        error.statusCode = 409;
        throw error;
      }

      for (const item of confirmItems) {
        const product = productById.get(String(item.productId));
        if (!product || !String(product.serialNumber || '').trim()) {
          const error = new Error(`${item.name} needs a valid product reference before approval`);
          error.statusCode = 409;
          throw error;
        }
        if (!Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) < 1) {
          const error = new Error(`${product.name} needs a valid quantity`);
          error.statusCode = 409;
          throw error;
        }
        if (item.printQuantity > 0) {
          const forcedMethod = ['wax', 'resin'].includes(customer.forcedProductionMethod)
            ? customer.forcedProductionMethod
            : null;
          const chosenMethod = forcedMethod || submittedRoutes.get(String(item._id)) || item.productionMethod;
          if (!['wax', 'resin'].includes(chosenMethod)) {
            const error = new Error(`Choose Wax or Resin for ${product.serialNumber}, size ${item.size || '-'}`);
            error.statusCode = 409;
            throw error;
          }
          item.productionMethod = chosenMethod;
        } else {
          // Stock-only lines: the route is optional and only used if the stock
          // team cannot find the units and sends them to printing.
          const forcedMethod = ['wax', 'resin'].includes(customer.forcedProductionMethod)
            ? customer.forcedProductionMethod
            : null;
          const chosenMethod = forcedMethod || submittedRoutes.get(String(item._id));
          if (['wax', 'resin'].includes(chosenMethod)) item.productionMethod = chosenMethod;
        }
        item.fulfillmentStatus = item.printQuantity > 0 ? 'production' : 'stock_reserved';
      }

      fulfillmentCases = await createFulfillmentCases(order, productById, req.user.id, session, confirmItems);
      const now = new Date();
      if (!validationCase.startedAt) validationCase.startedAt = now;
      const stillWaiting = order.items.filter(item => item.fulfillmentStatus === 'awaiting_validation');
      if (stillWaiting.length) {
        // Part of the order is confirmed: its items move on now, the rest stay
        // with Customer Service on the same validation task.
        validationCase.history.push({
          actorId: req.user.id,
          action: 'items_validated',
          fromStatus: 'awaiting_validation',
          toStatus: 'awaiting_validation',
          note: `Confirmed ${confirmItems.map(item => `${productById.get(String(item.productId))?.serialNumber || item.name} size ${item.size || '-'}`).join(', ')}. ${stillWaiting.length} item(s) still to confirm.`
        });
        await validationCase.save({ session });
        order.fulfillmentState = 'in_progress';
        await order.save({ session });
        approvedOrder = order;
        return;
      }
      validationCase.status = 'completed';
      validationCase.completedAt = now;
      validationCase.history.push({
        actorId: req.user.id,
        action: 'order_validated',
        fromStatus: 'awaiting_validation',
        toStatus: 'completed',
        note: String(req.body.note || 'Customer, references, sizes, quantities and production routes confirmed').slice(0, 1000),
        workMinutes: validationCase.startedAt ? Math.max(Math.round((now - validationCase.startedAt) / 60000), 0) : null
      });
      await validationCase.save({ session });

      order.validationStatus = 'approved';
      order.validatedBy = req.user.id;
      order.validatedAt = now;
      order.validationNote = String(req.body.note || '').slice(0, 1000);
      order.status = 'confirmed';
      order.fulfillmentState = fulfillmentCases.length ? 'in_progress' : 'ready';
      await order.save({ session });
      approvedOrder = order;
    });

    await Promise.all(fulfillmentCases
      .filter(workflowCase => workflowCase.assignedTo)
      .map(workflowCase => safelyNotify(() => notifyCaseAssignment(req.app, workflowCase))));
    if (approvedOrder.validationStatus === 'approved') await sendPushToUser(
      User,
      approvedOrder.userId,
      '✅ Order confirmed',
      `Order ${approvedOrder.orderNumber || approvedOrder._id} passed Customer Service validation`,
      { type: 'order', orderId: String(approvedOrder._id), status: 'confirmed' }
    ).catch(error => console.error('Order validation push failed:', error));

    await approvedOrder.populate('items.productId', 'name imageUrl size serialNumber weight showWeight type');
    res.json(approvedOrder);
  } catch (error) {
    console.error('Error validating order:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to validate order' });
  } finally {
    await session.endSession();
  }
});

// GET / - List all orders (admin only)
router.get('/', operationsAuth, async (req, res) => {
  try {
    if (!canViewAllOrders(req.user)) {
      return res.status(403).json({ message: 'Only Customer Service, the boss, or an administrator can view full order history' });
    }
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
