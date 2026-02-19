const express = require('express');
const router = express.Router();
const ClaspImage = require('../models/ClaspImage');
const { auth, adminAuth } = require('../middlewares/auth');

// GET / - Get all clasp images (any authenticated user)
router.get('/', auth, async (req, res) => {
  try {
    const claspImages = await ClaspImage.find({}).sort({ claspType: 1 });
    res.json(claspImages);
  } catch (error) {
    console.error('Error fetching clasp images:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /:claspType - Get clasp image by type (any authenticated user)
router.get('/:claspType', auth, async (req, res) => {
  try {
    const claspImage = await ClaspImage.findOne({ claspType: req.params.claspType });
    if (!claspImage) {
      return res.status(404).json({ message: 'Clasp image not found' });
    }
    res.json(claspImage);
  } catch (error) {
    console.error('Error fetching clasp image:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST / - Create or update a clasp image (admin only)
router.post('/', adminAuth, async (req, res) => {
  try {
    const { claspType, imageUrl, label } = req.body;

    if (!claspType || !imageUrl) {
      return res.status(400).json({ message: 'claspType and imageUrl are required' });
    }

    // Upsert - create if not exists, update if exists
    const claspImage = await ClaspImage.findOneAndUpdate(
      { claspType },
      {
        claspType,
        imageUrl,
        label: label || claspType,
        createdBy: req.user.id,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.status(201).json(claspImage);
  } catch (error) {
    console.error('Error saving clasp image:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /:claspType - Delete a clasp image (admin only)
router.delete('/:claspType', adminAuth, async (req, res) => {
  try {
    const claspImage = await ClaspImage.findOneAndDelete({ claspType: req.params.claspType });
    if (!claspImage) {
      return res.status(404).json({ message: 'Clasp image not found' });
    }
    res.json({ message: 'Clasp image deleted successfully' });
  } catch (error) {
    console.error('Error deleting clasp image:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
