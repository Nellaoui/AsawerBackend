const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Catalog = require('../models/Catalog');
const Product = require('../models/Product');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { auth } = require('../middlewares/auth');

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
    if (!item.productId || !item.quantity || item.quantity < 1) {
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

    // Validate products and calculate total
    let totalAmount = 0;
    const orderItems = [];

    for (const item of items) {
      console.log('Processing item:', item);
      const product = await Product.findById(item.productId);
      if (!product) {
        console.log('Product not found:', item.productId);
        return res.status(404).json({
          message: `Product ${item.productId} not found`
        });
      }

      // Check if product is in the catalog (compare as strings to avoid ObjectId vs string mismatches)
      const productIdStr = item.productId.toString();
      const inCatalog = (catalog.products || []).some(id => id.toString() === productIdStr);
      if (!inCatalog) {
        console.log('Product not in catalog:', product.name);
        return res.status(400).json({
          message: `Product ${product.name} is not in this catalog`
        });
      }

      const itemTotal = product.price * item.quantity;
      console.log('Item calculation:', {
        price: product.price,
        quantity: item.quantity,
        itemTotal: itemTotal
      });
      totalAmount += itemTotal;

      const orderItem = {
        productId: item.productId,
        quantity: item.quantity,
        price: product.price,
        name: product.name,
        size: item.size
      };
      orderItems.push(orderItem);
    }

    // Create order
    const order = new Order({
      userId: req.user.id,
      catalogId,
      items: orderItems,
      totalAmount,
      notes
    });

    await order.save();
    
    // Populate order with necessary fields
    let query = Order.findById(order._id)
      .populate('catalogId', 'name')
      .populate('items.productId', 'name imageUrl size');
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
      const admins = await User.find({ isAdmin: true }).select('_id name email');
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
      }
    } catch (err) {
      console.error('Error notifying admins about new order:', err);
    }

    res.status(201).json(orderWithSizes);
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET / - List all orders (admin only)
router.get('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
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
      .populate('catalogId', 'name')
      .populate('items.productId', 'name imageUrl price size');
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
    if (req.user.role !== 'admin' && ownerId !== req.user.id.toString()) {
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

// PUT /:id/status - Update order status (admin only)
router.put('/:id/status', auth, async (req, res) => {
  try {
    console.log('=== STATUS UPDATE REQUEST ===');
    console.log('Request body:', req.body);
    console.log('Request body keys:', Object.keys(req.body || {}));
    console.log('Request body status property:', req.body?.status);
    console.log('Request body type:', typeof req.body);
    console.log('Request content-type:', req.headers['content-type']);

    if (req.user.role !== 'admin') {
      console.log('Access denied - user role:', req.user.role);
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { status } = req.body;
    console.log('Destructured status:', status);
    console.log('Status type:', typeof status);

    const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    console.log('Valid statuses:', validStatuses);
    console.log('Status in valid statuses:', validStatuses.includes(status));

    if (!status || !validStatuses.includes(status)) {
      console.log('Invalid status validation failed');
      return res.status(400).json({
        message: 'Valid status is required',
        receivedStatus: status,
        validStatuses
      });
    }

    console.log('Looking up order:', req.params.id);
    const order = await Order.findById(req.params.id);
    if (!order) {
      console.log('Order not found');
      return res.status(404).json({ message: 'Order not found' });
    }

    console.log('Current order status:', order.status);
    order.status = status;
    console.log('Updated order status to:', order.status);

    await order.save();
    console.log('Order saved successfully');

    await order.populate('userId', 'name email phone');
    await order.populate('catalogId', 'name');
    await order.populate('items.productId', 'name imageUrl size');

    console.log('Order populated and ready to return');
    res.json(order);
  } catch (error) {
    console.error('=== STATUS UPDATE ERROR ===');
    res.status(500).json({
      message: 'Server error',
      error: error?.message,
      errorType: error?.name
    });
  }
});

// PUT /:id/cancel - Cancel order (authenticated users)
router.put('/:id/cancel', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('userId', 'name email phone')
      .populate('catalogId', 'name')
      .populate('items.productId', 'name imageUrl size');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Check permissions - user can cancel their own orders, admin can cancel any order
    if (req.user.role !== 'admin' && order.userId._id.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Check if order can be cancelled
    if (order.status === 'delivered') {
      return res.status(400).json({ message: 'Delivered orders cannot be cancelled' });
    }

    if (order.status === 'cancelled') {
      return res.status(400).json({ message: 'Order is already cancelled' });
    }

    // Update order status to cancelled
    order.status = 'cancelled';
    order.updatedAt = new Date();
    await order.save();

    console.log(`Order ${order._id} cancelled by user ${req.user.email}`);

    res.json(order);
  } catch (error) {
    console.error('Error cancelling order:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /:id - Hard delete order (admin only)
router.delete('/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    res.json({ success: true, message: 'Order deleted successfully', order });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
