const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Catalog = require('../models/Catalog');
const Product = require('../models/Product');
const Notification = require('../models/Notification');
const User = require('../models/User');
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
      ownerId: catalog.ownerId,
      productCount: catalog.products ? catalog.products.length : 0,
      allowedUserIds: (catalog.allowedUserIds || []).map(u => u && u.toString ? u.toString() : String(u)),
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
        .populate({
          path: 'products',
          populate: { path: 'relatedProducts' }
        })
        .sort({ createdAt: -1 });
      console.log('Admin user - showing all catalogs:', catalogs.length);
    } else {
      // Regular users can see:
      // 1. Public catalogs (isPublic: true)
      // 2. Private catalogs they have permission for (allowedUserIds includes their ID)
      // 3. Their own catalogs (ownerId equals their ID)
      const userId = req.user.id;
      const userIdStr = userId.toString();
      
      console.log('🔍 Fetching catalogs for user:', {
        userId,
        userIdStr,
        userRole: req.user.role,
        userEmail: req.user.email
      });
      
      // Get all catalogs and filter in memory for more reliable ID comparison
      const allCatalogs = await Catalog.find({})
        .populate({
          path: 'products',
          populate: { path: 'relatedProducts' }
        })
        .sort({ createdAt: -1 });
      
      console.log(`📊 Total catalogs in database: ${allCatalogs.length}`);
      
      // Helper function to compare IDs safely
      const idsMatch = (id1, id2) => {
        if (!id1 || !id2) return false;
        const str1 = id1.toString ? id1.toString() : String(id1);
        const str2 = id2.toString ? id2.toString() : String(id2);
        return str1 === str2;
      };
      
      // Filter catalogs based on permissions
      catalogs = allCatalogs.filter(catalog => {
        const catalogId = catalog._id.toString();
        const isPublic = catalog.isPublic === true;
        const isOwner = catalog.ownerId && idsMatch(catalog.ownerId, userId);
        
        // Check if catalog is public
        if (isPublic) {
          console.log(`✅ [${catalogId}] Visible: Public catalog`);
          return true;
        }
        
        // Check if user is the owner
        if (isOwner) {
          console.log(`✅ [${catalogId}] Visible: User is owner`);
          return true;
        }
        
        // Check if user is in allowedUserIds
        if (catalog.allowedUserIds && catalog.allowedUserIds.length > 0) {
          const hasAccess = catalog.allowedUserIds.some(id => idsMatch(id, userId));
          
          console.log(`🔍 [${catalogId}] Checking allowedUserIds:`, {
            allowedUserIds: catalog.allowedUserIds.map(id => id.toString()),
            userHasAccess: hasAccess,
            userId: userIdStr
          });
          
          if (hasAccess) {
            console.log(`✅ [${catalogId}] Visible: User has explicit access`);
            return true;
          }
        } else {
          console.log(`🔍 [${catalogId}] No allowedUserIds set`);
        }
        
        console.log(`❌ [${catalogId}] Not visible to user`);
        return false;
      });
      
      console.log(`📊 Filtered ${catalogs.length} out of ${allCatalogs.length} catalogs for user ${userId}`);
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
      .populate({
        path: 'products',
        populate: { path: 'relatedProducts' }
      });

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
      allowedUserIds: Array.isArray(allowedUserIds) ? (function normalize(ids){
        const asStrings = Array.from(new Set(ids.filter(Boolean).map(x => x.toString())));
        const withObjectIds = [];
        asStrings.forEach(s => {
          withObjectIds.push(s);
          if (mongoose.Types.ObjectId.isValid(s)) {
            withObjectIds.push(new mongoose.Types.ObjectId(s));
          }
        });
        // Deduplicate by string value
        const uniq = [];
        const seen = new Set();
        for (const v of withObjectIds) {
          const key = v && v.toString ? v.toString() : String(v);
          if (!seen.has(key)) { seen.add(key); uniq.push(v); }
        }
        return uniq;
      })(allowedUserIds) : [],
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

    // Notify users about the new catalog
    try {
      const io = req.app.get('io');
      const socketsByUser = req.app.get('socketsByUser');

      let recipients = [];
      if (catalog.isPublic) {
        // all non-admin active users
        recipients = await User.find({ isAdmin: false, isActive: true }).select('_id name email');
      } else if (Array.isArray(catalog.allowedUserIds) && catalog.allowedUserIds.length > 0) {
        // only allowed users
        const ids = catalog.allowedUserIds.map(id => id.toString ? id.toString() : String(id));
        recipients = await User.find({ _id: { $in: ids }, isActive: true }).select('_id name email');
      }

      for (const user of recipients) {
        const title = 'New catalog available';
        const body = `Catalog "${catalog.name}" was just added.`;
        const notif = await Notification.create({ user: user._id, title, body, data: { catalogId: catalog._id } });
        if (io && socketsByUser) {
          const userSockets = socketsByUser.get(String(user._id));
          if (userSockets) {
            for (const sid of userSockets) {
              io.to(sid).emit('notification', { id: notif._id, title: notif.title, body: notif.body, data: notif.data, createdAt: notif.createdAt });
            }
          }
        }
      }
    } catch (err) {
      console.error('Error notifying users about new catalog:', err);
    }

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
      size,
      clasp,
      showWeight,
      height,
      relatedProducts,
      availableSizes,
      availableHeights
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
      weight: Number(req.body.weight) || 0,
      showWeight: showWeight || false,
      height: Number(height) || 0,
      stock: Number(stock) || 1,
      size: size || null,
      availableSizes: availableSizes || [],
      availableHeights: availableHeights || [],
      clasp: clasp || null,
      relatedProducts: relatedProducts || [],
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

    // Notify users about the new product
    try {
      const io = req.app.get('io');
      const socketsByUser = req.app.get('socketsByUser');

      // Determine recipients: users who can access this catalog
      let recipients = [];
      if (catalog.isPublic) {
        recipients = await User.find({ isAdmin: false, isActive: true }).select('_id name email');
      } else {
        const ids = (catalog.allowedUserIds || []).map(id => id && id.toString ? id.toString() : String(id));
        recipients = await User.find({ _id: { $in: ids }, isActive: true }).select('_id name email');
      }

      for (const user of recipients) {
        const title = 'New product added';
        const body = `"${product.name}" was added to catalog "${catalog.name}".`;
        const notif = await Notification.create({ user: user._id, title, body, data: { catalogId: catalog._id, productId: product._id } });
        if (io && socketsByUser) {
          const userSockets = socketsByUser.get(String(user._id));
          if (userSockets) {
            for (const sid of userSockets) {
              io.to(sid).emit('notification', { id: notif._id, title: notif.title, body: notif.body, data: notif.data, createdAt: notif.createdAt });
            }
          }
        }
      }
    } catch (err) {
      console.error('Error notifying users about new product:', err);
    }

    res.status(201).json(transformedCatalog);
  } catch (error) {
    console.error('Error adding product to catalog:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

  // POST /:id/products/bulk - Create multiple products or attach existing product IDs
  router.post('/:id/products/bulk', auth, async (req, res) => {
    try {
      const catalog = await Catalog.findById(req.params.id);
      if (!catalog) {
        return res.status(404).json({ message: 'Catalog not found' });
      }

      if (!catalog.canUserEdit(req.user.id, req.user.role)) {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const { products, productIds } = req.body;
      const Product = require('../models/Product');
      const addedIds = [];

      // Create new products if provided
      if (Array.isArray(products) && products.length > 0) {
        const docs = products.map(p => ({
          name: (p.name || '').toString().trim(),
          description: (p.description || '').toString().trim(),
          type: p.type || 'Other',
          serialNumber: (p.serialNumber || p.name || '').toString().replace(/\s+/g, '_'),
          imageUrl: p.imageUrl || p.image || 'https://via.placeholder.com/150',
          price: Number(p.price) || 0,
          size: p.size || null,
          catalogId: catalog._id,
          createdBy: req.user.id
        }));

        // Use insertMany for performance
        const created = await Product.insertMany(docs);
        created.forEach(c => addedIds.push(c._id));
      }

      // Attach existing products by id (will set their catalogId)
      if (Array.isArray(productIds) && productIds.length > 0) {
        const validIds = productIds
          .filter(id => mongoose.Types.ObjectId.isValid(id))
          .map(id => new mongoose.Types.ObjectId(id));

        if (validIds.length > 0) {
          await Product.updateMany(
            { _id: { $in: validIds } },
            { $set: { catalogId: catalog._id } }
          );
          validIds.forEach(id => addedIds.push(id));
        }
      }

      // Add collected IDs to catalog.products (dedupe)
      if (addedIds.length > 0) {
        const existing = (catalog.products || []).map(x => x.toString());
        const toAdd = [];
        for (const id of addedIds) {
          const sid = id.toString();
          if (!existing.includes(sid)) toAdd.push(id);
        }
        if (toAdd.length > 0) {
          catalog.products.push(...toAdd);
          await catalog.save();
        }
      }

      await catalog.populate('products');

      // Transform catalog to include catalogId and productId fields for frontend
      const catalogObj = catalog.toObject();
      const transformedCatalog = {
        ...catalogObj,
        catalogId: catalog._id.toString(),
        products: catalogObj.products?.map(product => ({
          ...product,
          productId: product._id.toString()
        })) || []
      };

      res.status(200).json(transformedCatalog);
    } catch (error) {
      console.error('Error bulk adding products to catalog:', error);
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

    // Check if user is admin or catalog owner
    if (req.user.role !== 'admin' && catalog.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to manage catalog permissions' });
    }

    console.log('Updating catalog permissions:', {
      catalogId: catalog._id,
      allowedUserIds,
      isPublic,
      updatedBy: req.user.email
    });

    // Update permissions with normalization (store string and ObjectId variants)
    if (allowedUserIds !== undefined) {
      console.log('🔧 Original allowedUserIds input:', allowedUserIds);
      
      // Ensure we have an array of strings
      const inputIds = Array.isArray(allowedUserIds) ? allowedUserIds : [];
      
      // Normalize each ID to string form only (no more mixed types)
      const normalizedUserIds = [];
      const seen = new Set();
      
      for (const id of inputIds) {
        if (!id) {
          console.log('⚠️ Skipping empty ID in allowedUserIds');
          continue;
        }
        
        try {
          // Convert to string form and add if not seen
          const strId = id.toString();
          if (!seen.has(strId)) {
            console.log(`➕ Adding user ID to allowed list: ${strId}`);
            seen.add(strId);
            normalizedUserIds.push(strId);
          } else {
            console.log(`ℹ️ Skipping duplicate ID: ${strId}`);
          }
        } catch (error) {
          console.error(`❌ Error processing ID ${id}:`, error);
        }
      }
      
      // Store only string IDs for consistency
      catalog.allowedUserIds = normalizedUserIds;
      console.log('📝 Final normalized allowedUserIds:', {
        count: normalizedUserIds.length,
        values: normalizedUserIds
      });
    }
    
    if (isPublic !== undefined) {
      catalog.isPublic = isPublic;
    }

    await catalog.save();

    console.log('Catalog permissions updated successfully');
    res.json({ 
      message: 'Catalog permissions updated successfully',
      catalog: {
        id: catalog._id,
        name: catalog.name,
        isPublic: catalog.isPublic,
        allowedUserIds: catalog.allowedUserIds.map(id => id.toString())
      }
    });
  } catch (error) {
    console.error('Error updating catalog permissions:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ... (rest of the code remains the same)

// PUT /:id/reorder-products - Reorder products in a catalog
router.put('/:id/reorder-products', auth, async (req, res) => {
  try {
    const catalogId = req.params.id;
    const { productIds } = req.body;

    if (!productIds || !Array.isArray(productIds)) {
      return res.status(400).json({ message: 'productIds array is required' });
    }

    const catalog = await Catalog.findById(catalogId);
    if (!catalog) {
      return res.status(404).json({ message: 'Catalog not found' });
    }

    // Only admin or owner can reorder
    if (req.user.role !== 'admin' && catalog.ownerId?.toString() !== req.user.id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Reorder the products array
    catalog.products = productIds.map(id => mongoose.Types.ObjectId(id));
    await catalog.save();

    await catalog.populate('products');

    const catalogObj = catalog.toObject();
    const transformedCatalog = {
      ...catalogObj,
      catalogId: catalog._id.toString(),
      products: catalogObj.products?.map(product => ({
        ...product,
        productId: product._id.toString()
      })) || []
    };

    res.json(transformedCatalog);
  } catch (error) {
    console.error('Error reordering products:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
