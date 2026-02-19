const express = require('express');
const router = express.Router();
const SizePreset = require('../models/SizePreset');
const { auth, adminAuth } = require('../middlewares/auth');

// GET /api/size-presets — get all presets (admin + used by create/edit forms)
router.get('/', auth, async (req, res) => {
  try {
    const presets = await SizePreset.find().sort({ type: 1 });
    // Return as a map { bracelet: { sizes: [...], heights: [...] }, ... }
    const map = {};
    for (const p of presets) {
      map[p.type] = {
        availableSizes: p.availableSizes || [],
        availableHeights: p.availableHeights || [],
      };
    }
    res.json(map);
  } catch (error) {
    console.error('Error fetching size presets:', error);
    res.status(500).json({ message: 'Failed to fetch size presets' });
  }
});

// PUT /api/size-presets/:type — upsert preset for a jewelry type (admin only)
router.put('/:type', adminAuth, async (req, res) => {
  try {
    const type = req.params.type.toLowerCase();
    const allowed = ['bracelet', 'bague', 'gourmette'];
    if (!allowed.includes(type)) {
      return res.status(400).json({ message: `Invalid type. Must be one of: ${allowed.join(', ')}` });
    }

    const { availableSizes, availableHeights } = req.body;

    const preset = await SizePreset.findOneAndUpdate(
      { type },
      {
        type,
        availableSizes: Array.isArray(availableSizes) ? availableSizes : [],
        availableHeights: Array.isArray(availableHeights) ? availableHeights : [],
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json(preset);
  } catch (error) {
    console.error('Error updating size preset:', error);
    res.status(500).json({ message: 'Failed to update size preset' });
  }
});

module.exports = router;
