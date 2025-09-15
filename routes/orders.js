const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Catalog = require('../models/Catalog');
const Product = require('../models/Product');
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

    console.log('Creating order for user:', req.user.id, req.user.email);
    console.log('Order data:', { catalogId, items: items.length, notes });

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

      console.log('Found product:', {
        id: product._id,
        name: product.name,
        price: product.price,
        priceType: typeof product.price
      });

      // Check if product is in the catalog
      if (!catalog.products.includes(item.productId)) {
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
      console.log('Adding order item:', orderItem);
      orderItems.push(orderItem);
    }

    console.log('Final order data:', {
      totalAmount,
      orderItemsCount: orderItems.length,
      orderItems: orderItems
    });

    // Create order
    const order = new Order({
      userId: req.user.id,
      catalogId,
      items: orderItems,
      totalAmount,
      notes
    });

    await order.save();
    await order.populate('userId', 'name email');
    await order.populate('catalogId', 'name');
    await order.populate('items.productId', 'name imageUrl size');

    res.status(201).json(order);
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

    const orders = await Order.findWithFilters(filters, options);
    
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
    const order = await Order.findById(req.params.id)
      .populate('userId', 'name email')
      .populate('catalogId', 'name')
      .populate('items.productId', 'name imageUrl price size');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Check permissions - user can see their own orders, admin can see all
    if (req.user.role !== 'admin' && order.userId._id.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(order);
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

    await order.populate('userId', 'name email');
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
      .populate('userId', 'name email')
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

module.exports = router;
