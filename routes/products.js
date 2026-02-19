const express = require('express');
const { body, validationResult } = require('express-validator');
const Product = require('../models/Product');
const User = require('../models/User');
const { auth, adminAuth } = require('../middlewares/auth');

const router = express.Router();

// TEMPORARY: Add prices to existing products
router.get('/migrate-prices', async (req, res) => {
  try {
    const result = await Product.updateMany(
      { price: { $exists: false } }, // Find products without price field
      { $set: { price: 99.99 } }     // Set default price
    );

    console.log('Price migration result:', result);
    res.json({
      message: 'Products updated with default prices',
      modifiedCount: result.modifiedCount,
      success: true
    });
  } catch (error) {
    console.error('Error migrating product prices:', error);
    res.status(500).json({ message: 'Migration failed', success: false });
  }
});

// Get all products accessible to the current user
router.get('/', auth, async (req, res) => {
  try {
    const products = await Product.find({
      $or: [
        { accessibleTo: req.user._id },
        { createdBy: req.user._id }
      ],
      isActive: true
    }).populate('createdBy', 'name');

    res.json(products);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get single product
router.get('/:id', auth, async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      $or: [
        { accessibleTo: req.user._id },
        { createdBy: req.user._id }
      ],
      isActive: true
    }).populate('createdBy', 'name');

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json(product);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create product (Admin only)
router.post('/', adminAuth, [
  body('name').notEmpty().trim(),
  body('description').notEmpty().trim(),
  body('price').isNumeric(),
  body('image').notEmpty().trim(),
  body('category').notEmpty().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, description, price, image, category, accessibleTo } = req.body;

    const product = new Product({
      name,
      description,
      price,
      image,
      category,
      createdBy: req.user._id,
      accessibleTo: accessibleTo || []
    });

    await product.save();
    res.status(201).json(product);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update product (Admin only)
router.put('/:id', adminAuth, async (req, res) => {
  try {
    const { 
      name, description, price, image, imageUrl, category, accessibleTo, isActive,
      weight, showWeight, height, type, size, clasp, serialNumber, relatedProducts, availableSizes, availableHeights 
    } = req.body;

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    if (name) product.name = name;
    if (description !== undefined) product.description = description;
    if (price !== undefined) product.price = price;
    if (image) product.image = image;
    if (imageUrl) product.imageUrl = imageUrl;
    if (category) product.category = category;
    if (accessibleTo) product.accessibleTo = accessibleTo;
    if (isActive !== undefined) product.isActive = isActive;
    if (weight !== undefined) product.weight = weight;
    if (showWeight !== undefined) product.showWeight = showWeight;
    if (height !== undefined) product.height = height;
    if (type !== undefined) product.type = type;
    if (size !== undefined) product.size = size;
    if (clasp !== undefined) product.clasp = clasp;
    if (serialNumber) product.serialNumber = serialNumber;
    if (relatedProducts !== undefined) product.relatedProducts = relatedProducts;
    if (availableSizes !== undefined) product.availableSizes = availableSizes;
    if (availableHeights !== undefined) product.availableHeights = availableHeights;

    await product.save();
    res.json(product);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete product (Admin only)
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    await Product.findByIdAndDelete(req.params.id);
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Assign products to users (Admin only)
router.post('/:id/assign', adminAuth, [
  body('userIds').isArray()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userIds } = req.body;

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Verify all users exist
    const users = await User.find({ _id: { $in: userIds } });
    if (users.length !== userIds.length) {
      return res.status(400).json({ message: 'Some users not found' });
    }

    product.accessibleTo = userIds;
    await product.save();

    res.json(product);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router; 