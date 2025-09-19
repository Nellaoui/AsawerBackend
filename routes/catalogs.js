const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Catalog = require('../models/Catalog');
const Product = require('../models/Product');
const { auth } = require('../middlewares/auth');

// TEMPORARY: Update existing catalogs to be public (GET for easy testing)
router.get('/migrate-public', async (req, res) => {
  try {
    const result = await Catalog.updateMany(
      { isPublic: { $ne: true } }, // Find catalogs that are not public
      { $set: { isPublic: true } }  // Set them to public
    );

    console.log('Migration result:', result);
    res.json({
      message: 'Catalogs updated to public',
      modifiedCount: result.modifiedCount,
      success: true
    });
  } catch (error) {
    console.error('Error migrating catalogs:', error);
    res.status(500).json({ message: 'Migration failed', success: false });
  }
});

// DEBUG: Check all catalogs in database
router.get('/debug-all', async (req, res) => {
  try {
    const allCatalogs = await Catalog.find({});

    const catalogInfo = allCatalogs.map(catalog => ({
      id: catalog._id,
      name: catalog.name,
      isPublic: catalog.isPublic,
      owner: catalog.ownerId ? catalog.ownerId.email : 'No owner',
      productCount: catalog.products ? catalog.products.length : 0,
      allowedUsers: catalog.allowedUserIds ? catalog.allowedUserIds.length : 0
    }));

    res.json({
      totalCatalogs: allCatalogs.length,
      catalogs: catalogInfo
    });
  } catch (error) {
    console.error('Error fetching debug info:', error);
    res.status(500).json({ message: 'Debug failed' });
  }
});

// GET / - List user-accessible catalogs
router.get('/', auth, async (req, res) => {
  try {
    console.log('Fetching catalogs for user:', req.user.id, 'role:', req.user.role, 'email:', req.user.email);

    // Debug: Check all catalogs first
    const allCatalogs = await Catalog.find({});
    console.log('Total catalogs in database:', allCatalogs.length);
    allCatalogs.forEach(cat => {
      console.log(`Catalog: ${cat.name}, isPublic: ${cat.isPublic}, owner: ${cat.ownerId}`);
    });

    // Get catalogs based on user permissions
    let catalogs;
    if (req.user.role === 'admin') {
      // Admins can see all catalogs
      catalogs = await Catalog.find({})
        .populate('products', 'name imageUrl price')
        .sort({ createdAt: -1 });
      console.log('Admin user - showing all catalogs:', catalogs.length);
    } else {
      // Regular users can see:
      // 1. Public catalogs (isPublic: true)
      // 2. Private catalogs they have permission for (allowedUserIds includes their ID)
      // 3. Their own catalogs (ownerId equals their ID)
      const userId = req.user.id;
      const asObjectId = mongoose.Types.ObjectId.isValid(userId)
        ? new mongoose.Types.ObjectId(userId)
        : null;

      const orConditions = [
        { isPublic: true },
        { allowedUserIds: userId },
        { ownerId: userId },
      ];
      if (asObjectId) {
        orConditions.push({ allowedUserIds: asObjectId });
        orConditions.push({ ownerId: asObjectId });
      }

      catalogs = await Catalog.find({ $or: orConditions })
        .populate('products', 'name imageUrl price')
        .sort({ createdAt: -1 });

    }



  

    // Transform catalogs to include catalogId field for frontend compatibility
    const transformedCatalogs = catalogs.map(catalog => {
      const catalogObj = catalog.toObject();
      return {
        ...catalogObj,
        catalogId: catalog._id.toString(),
        // Transform products to include productId field
        products: catalogObj.products?.map(product => ({
          ...product,
          productId: product._id.toString()
        })) || []
      };
    });

    res.json(transformedCatalogs);
  } catch (error) {
    console.error('Error fetching catalogs:', error);
    res.status(500).json({ message: 'Server error fetching catalogs' });
  }
});

// GET /:id - Get catalog details with products
router.get('/:id', auth, async (req, res) => {
  try {
    const catalogId = req.params.id;
    console.log('Fetching catalog with ID:', catalogId);

    if (!catalogId || catalogId === 'undefined' || catalogId === 'null') {
      return res.status(400).json({ message: 'Invalid catalog ID' });
    }

    const catalog = await Catalog.findById(catalogId)
      .populate('products');

    if (!catalog) {
      return res.status(404).json({ message: 'Catalog not found' });
    }

    // Check if user has access to this catalog
    // Admin users have access to all catalogs
    if (req.user.role !== 'admin' && !catalog.hasUserAccess(req.user.id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Transform catalog to include catalogId field for frontend compatibility
    const catalogObj = catalog.toObject();
    const transformedCatalog = {
      ...catalogObj,
      catalogId: catalog._id.toString(),
      // Transform products to include productId field
      products: catalogObj.products?.map(product => ({
        ...product,
        productId: product._id.toString()
      })) || []
    };

    res.json(transformedCatalog);
  } catch (error) {
    console.error('Error fetching catalog:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST / - Create catalog (admin only)
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { name, description, allowedUserIds, isPublic } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Catalog name is required' });
    }

    const catalog = new Catalog({
      name,
      description,
      ownerId: req.user.id,
      allowedUserIds: allowedUserIds || [],
      isPublic: isPublic !== undefined ? isPublic : true // Default to public
    });

    await catalog.save();
    // Skip populating ownerId to support test-mode string IDs

    // Transform catalog to include catalogId field for frontend compatibility
    const catalogObj = catalog.toObject();
    const transformedCatalog = {
      ...catalogObj,
      catalogId: catalog._id.toString(),
      // Transform products to include productId field
      products: catalogObj.products?.map(product => ({
        ...product,
        productId: product._id.toString()
      })) || []
    };

    res.status(201).json(transformedCatalog);
  } catch (error) {
    console.error('Error creating catalog:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /:id - Update catalog (admin/owner only)
router.put('/:id', auth, async (req, res) => {
  try {
    const catalog = await Catalog.findById(req.params.id);

    if (!catalog) {
      return res.status(404).json({ message: 'Catalog not found' });
    }

    console.log('Checking edit permissions for catalog:', {
      catalogId: catalog._id,
      catalogOwnerId: catalog.ownerId,
      userId: req.user.id,
      userRole: req.user.role,
      isAdmin: req.user.role === 'admin'
    });

    // Admin users can always edit catalogs
    if (req.user.role !== 'admin' && !catalog.canUserEdit(req.user.id, req.user.role)) {
      console.log('Edit permission denied for user:', req.user.id, 'role:', req.user.role);
      return res.status(403).json({ message: 'Permission denied' });
    }

    console.log('Edit permission granted for catalog');

    const { name, description, allowedUserIds, isPublic } = req.body;

    if (name) catalog.name = name;
    if (description !== undefined) catalog.description = description;
    if (allowedUserIds !== undefined) catalog.allowedUserIds = allowedUserIds;
    if (isPublic !== undefined) catalog.isPublic = isPublic;

    await catalog.save();
    // Skip populating ownerId to support test-mode string IDs

    res.json(catalog);
  } catch (error) {
    console.error('Error updating catalog:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /:id - Delete catalog (admin/owner only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const catalog = await Catalog.findById(req.params.id);

    if (!catalog) {
      return res.status(404).json({ message: 'Catalog not found' });
    }

    console.log('Checking delete permissions for catalog:', {
      catalogId: catalog._id,
      catalogOwnerId: catalog.ownerId,
      userId: req.user.id,
      userRole: req.user.role,
      isAdmin: req.user.role === 'admin'
    });

    // Admin users can always delete catalogs
    if (req.user.role !== 'admin' && !catalog.canUserEdit(req.user.id, req.user.role)) {
      console.log('Delete permission denied for user:', req.user.id, 'role:', req.user.role);
      return res.status(403).json({ message: 'Permission denied' });
    }

    console.log('Delete permission granted for catalog');

    // Delete all products in this catalog
    const Product = require('../models/Product');
    await Product.deleteMany({ catalogId: req.params.id });

    // Delete the catalog
    await Catalog.findByIdAndDelete(req.params.id);

    res.json({ message: 'Catalog and all its products deleted successfully' });
  } catch (error) {
    console.error('Error deleting catalog:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /:id/products - Create and add product to catalog (admin/owner only)
router.post('/:id/products', auth, async (req, res) => {
  try {
    const catalog = await Catalog.findById(req.params.id);

    if (!catalog) {
      return res.status(404).json({ message: 'Catalog not found' });
    }

    if (!catalog.canUserEdit(req.user.id, req.user.role)) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    const { 
      name, 
      description, 
      type, 
      serialNumber, 
      imageUrl, 
      price = 0, 
      stock = 1, 
      size 
    } = req.body;

    if (!name || !serialNumber) {
      return res.status(400).json({ message: 'Name and serial number are required' });
    }

    // Create new product
    const Product = require('../models/Product');
    const product = new Product({
      name: name.trim(),
      description: description?.trim() || `Type: ${type || 'Other'}, Serial: ${serialNumber.trim()}`,
      type: type || 'Other',
      serialNumber: serialNumber.trim(),
      imageUrl: imageUrl || 'https://via.placeholder.com/150',
      price: Number(price) || 0,
      stock: Number(stock) || 1,
      size: size || null,
      catalogId: catalog._id,
      createdBy: req.user.id
    });

    // Save the product
    await product.save();

    // Add product to catalog
    catalog.products.push(product._id);
    await catalog.save();

    // Return updated catalog with products populated
    await catalog.populate('products');

    // Transform catalog to include catalogId field for frontend compatibility
    const catalogObj = catalog.toObject();
    const transformedCatalog = {
      ...catalogObj,
      catalogId: catalog._id.toString(),
      // Transform products to include productId field
      products: catalogObj.products?.map(product => ({
        ...product,
        productId: product._id.toString()
      })) || []
    };

    res.status(201).json(transformedCatalog);
  } catch (error) {
    console.error('Error adding product to catalog:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /:id/products/:productId - Remove product from catalog (admin/owner only)
router.delete('/:id/products/:productId', auth, async (req, res) => {
  try {
    const catalog = await Catalog.findById(req.params.id);

    if (!catalog) {
      return res.status(404).json({ message: 'Catalog not found' });
    }

    if (!catalog.canUserEdit(req.user.id, req.user.role)) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    const { productId } = req.params;

    // Delete the product from the database
    const Product = require('../models/Product');
    await Product.findByIdAndDelete(productId);

    // Remove product from catalog
    catalog.products = catalog.products.filter(
      id => id.toString() !== productId
    );

    await catalog.save();
    await catalog.populate('products');

    // Transform catalog to include catalogId field for frontend compatibility
    const catalogObj = catalog.toObject();
    const transformedCatalog = {
      ...catalogObj,
      catalogId: catalog._id.toString(),
      // Transform products to include productId field
      products: catalogObj.products?.map(product => ({
        ...product,
        productId: product._id.toString()
      })) || []
    };

    res.json(transformedCatalog);
  } catch (error) {
    console.error('Error removing product from catalog:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /:id/permissions - Update catalog permissions (admin/owner only)
router.put('/:id/permissions', auth, async (req, res) => {
  try {
    const { allowedUserIds, isPublic } = req.body;

    const catalog = await Catalog.findById(req.params.id);

    if (!catalog) {
      return res.status(404).json({ message: 'Catalog not found' });
    }

    // Check if user is admin or owner
    if (req.user.role !== 'admin' && catalog.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to manage catalog permissions' });
    }

    console.log('Updating catalog permissions:', {
      catalogId: catalog._id,
      allowedUserIds,
      isPublic,
      updatedBy: req.user.email
    });

    // Update permissions
    if (allowedUserIds !== undefined) {
      catalog.allowedUserIds = allowedUserIds;
    }
    if (isPublic !== undefined) {
      catalog.isPublic = isPublic;
    }

    await catalog.save();

    console.log('Catalog permissions updated successfully');
    res.json({ message: 'Catalog permissions updated successfully' });
  } catch (error) {
    console.error('Error updating catalog permissions:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
