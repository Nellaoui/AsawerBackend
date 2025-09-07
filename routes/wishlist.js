const express = require('express');
const router = express.Router();
const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const { auth } = require('../middlewares/auth');

// Get user's wishlist
router.get('/', auth, async (req, res) => {
  try {
    console.log('Fetching wishlist for user:', req.user.id);
    
    const wishlistItems = await Wishlist.find({ userId: req.user.id })
      .populate({
        path: 'productId',
        populate: {
          path: 'catalogId',
          select: 'name'
        }
      })
      .sort({ createdAt: -1 });

    console.log('Found wishlist items:', wishlistItems.length);
    
    const products = wishlistItems.map(item => item.productId).filter(product => product);

    res.json(products);
  } catch (error) {
    console.error('Error fetching wishlist:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add product to wishlist
router.post('/:productId', auth, async (req, res) => {
  try {
    const { productId } = req.params;
    console.log('Adding to wishlist - productId:', productId, 'userId:', req.user.id);

    // Check if product exists
    const product = await Product.findById(productId);
    console.log('Product found:', product ? 'Yes' : 'No');
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Check if already in wishlist
    const existingItem = await Wishlist.findOne({
      userId: req.user.id,
      productId: productId
    });

    if (existingItem) {
      return res.status(400).json({ message: 'Product already in wishlist' });
    }

    // Add to wishlist
    const wishlistItem = new Wishlist({
      userId: req.user.id,
      productId: productId
    });

    await wishlistItem.save();

    res.status(201).json({ message: 'Product added to wishlist' });
  } catch (error) {
    console.error('Error adding to wishlist:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Remove product from wishlist
router.delete('/:productId', auth, async (req, res) => {
  try {
    const { productId } = req.params;

    const result = await Wishlist.findOneAndDelete({
      userId: req.user.id,
      productId: productId
    });

    if (!result) {
      return res.status(404).json({ message: 'Product not found in wishlist' });
    }

    res.json({ message: 'Product removed from wishlist' });
  } catch (error) {
    console.error('Error removing from wishlist:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Check if product is in wishlist
router.get('/check/:productId', auth, async (req, res) => {
  try {
    const { productId } = req.params;

    const wishlistItem = await Wishlist.findOne({
      userId: req.user.id,
      productId: productId
    });

    res.json({ inWishlist: !!wishlistItem });
  } catch (error) {
    console.error('Error checking wishlist:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
