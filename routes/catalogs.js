const express = require('express');
const router = express.Router();
const { limitRelatedProducts } = require('../utils/relatedProductAccess');
const { accessSnapshot, auditAccessChange, auditCatalogChange } = require('../utils/catalogAudit');
const mongoose = require('mongoose');
const Catalog = require('../models/Catalog');
const Product = require('../models/Product');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { auth } = require('../middlewares/auth');
const Sartla = require('../utils/sartla');
const { resolveSartlaSets } = require('../utils/sartlaSets');
const { sendPushToUser } = require('../utils/pushNotification');
const { catalogNameKey, pickCatalogChoices } = require('../utils/catalogChoices');

// Fields the catalog list screen needs to draw its cards and search products.
// Screens that show or edit a whole product load the catalog through GET /:id.
const LIST_PRODUCT_FIELDS = 'name description type serialNumber imageUrl price weight showWeight isActive';

const withProductIds = products => (products || []).map(product => {
  if (!product) return null;
  if (typeof product === 'object' && product._id) {
    return { ...product, productId: product._id.toString() };
  }
  return { productId: String(product), _id: String(product) };
}).filter(Boolean);

// GET / - List user-accessible catalogs
//   ?view=names  catalogs only, with a product count (portal pickers)
//   ?view=list   products trimmed to LIST_PRODUCT_FIELDS (catalog list screen)
//   no view      every product in full, as older app versions expect
router.get('/', auth, async (req, res) => {
  try {
    const view = ['names', 'list'].includes(req.query.view) ? req.query.view : 'full';
    const isAdmin = req.user.role === 'admin';

    // Admins see every catalog. Everyone else sees public catalogs, their own,
    // and private ones that list them. Filter before populating so hidden
    // catalogs never load their products.
    let catalogs = await Catalog.find({}).sort({ createdAt: -1 });
    if (!isAdmin) {
      catalogs = catalogs.filter(catalog => catalog.hasUserAccess(req.user.id));
    }

    if (view !== 'names') {
      await Catalog.populate(catalogs, {
        path: 'products',
        // Drafts (inactive products) stay hidden from customers until they are fixed.
        ...(isAdmin ? {} : { match: { isActive: { $ne: false } } }),
        ...(view === 'list' ? { select: LIST_PRODUCT_FIELDS } : {})
      });
    }

    // Transform catalogs to include catalogId/productId fields for frontend compatibility
    const transformedCatalogs = catalogs.map(catalog => {
      const catalogObj = catalog.toObject();
      if (view === 'names') {
        const { products, ...rest } = catalogObj;
        return { ...rest, catalogId: catalog._id.toString(), productCount: (products || []).length };
      }
      return {
        ...catalogObj,
        catalogId: catalog._id.toString(),
        products: withProductIds(catalogObj.products)
      };
    });

    // Pickers list each catalogue name once, even where twins exist.
    res.json(view === 'names' ? pickCatalogChoices(transformedCatalogs) : transformedCatalogs);
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
        ...(req.user.role === 'admin' ? {} : { match: { isActive: { $ne: false } } }),
        populate: {
          path: 'relatedProducts',
          ...(req.user.role === 'admin' ? {} : { match: { isActive: { $ne: false } } })
        }
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
      // Transform products to include productId field safely
      products: catalogObj.products?.map(product => {
        if (!product) return null;
        if (typeof product === 'object' && product._id) {
          return {
            ...product,
            productId: product._id.toString()
          };
        }
        return {
          productId: String(product),
          _id: String(product)
        };
      }).filter(Boolean) || []
    };

    transformedCatalog.products = await limitRelatedProducts(transformedCatalog.products, req.user);

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

    // One catalogue per name: a second "Bagues" shows up twice in every picker.
    const nameKey = catalogNameKey(name);
    const existing = (await Catalog.find({}).select('name').lean())
      .find(catalog => catalogNameKey(catalog.name) === nameKey);
    if (existing) {
      return res.status(409).json({ message: `A catalogue called "${existing.name}" already exists`, catalog: existing });
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
        recipients = await User.find({ role: 'user', isActive: true }).select('_id name email');
      } else if (Array.isArray(catalog.allowedUserIds) && catalog.allowedUserIds.length > 0) {
        // only allowed users
        const ids = catalog.allowedUserIds.map(id => id.toString ? id.toString() : String(id));
        recipients = await User.find({ _id: { $in: ids }, role: 'user', isActive: true }).select('_id name email');
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

        // 🔔 Send push notification to user
        try {
          await sendPushToUser(
            User,
            user._id,
            '🎉 New Catalog Available',
            `"${catalog.name}" has been shared with you`,
            {
              type: 'catalog',
              catalogId: catalog._id.toString(),
              catalogName: catalog.name,
              action: 'new_catalog'
            }
          );
        } catch (err) {
          console.error(`⚠️  Failed to send push to user ${user.email}:`, err);
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
    const accessBefore = accessSnapshot(catalog);

    if (name) catalog.name = name;
    if (description !== undefined) catalog.description = description;
    if (allowedUserIds !== undefined) catalog.allowedUserIds = allowedUserIds;
    if (isPublic !== undefined) catalog.isPublic = isPublic;

    await catalog.save();
    await auditAccessChange(req, catalog, accessBefore, 'catalog_edit');
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
    await auditCatalogChange(req, 'catalog.deleted', catalog._id, {
      name: catalog.name,
      productCount: (catalog.products || []).length,
      ...accessSnapshot(catalog),
    });

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
      stock = 0,
      size,
      clasp,
      showWeight,
      height,
      relatedProducts,
      availableSizes,
      availableHeights,
      availableClasps
    } = req.body;

    // A sartla keeps a bracelet list per count; the lists are checked against real bracelets.
    let sartlaSets = [];
    if (Sartla.isSartlaType(type)) {
      const resolved = await resolveSartlaSets(req.body.sartlaSets);
      if (resolved.error) return res.status(400).json({ message: resolved.error });
      sartlaSets = resolved.sets;
    }

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
      stock: Number.isFinite(Number(stock)) && Number(stock) >= 0 ? Number(stock) : 0,
      reservedStock: 0,
      size: size || null,
      availableSizes: availableSizes || [],
      availableHeights: availableHeights || [],
      availableClasps: Array.isArray(availableClasps) ? availableClasps : [],
      sartlaSets,
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
        recipients = await User.find({ role: 'user', isActive: true }).select('_id name email');
      } else {
        const ids = (catalog.allowedUserIds || []).map(id => id && id.toString ? id.toString() : String(id));
        recipients = await User.find({ _id: { $in: ids }, role: 'user', isActive: true }).select('_id name email');
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

          // 🔔 Send push notification to user
          try {
            await sendPushToUser(
              User,
              user._id,
              '➕ New Product Added',
              `"${product.name}" was added to catalog "${catalog.name}"`,
              {
                type: 'product',
                catalogId: catalog._id.toString(),
                productId: product._id.toString(),
                productName: product.name,
                action: 'product_added'
              }
            );
          } catch (err) {
            console.error(`⚠️  Failed to send push to user ${user.email}:`, err);
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
          stock: Number.isFinite(Number(p.stock)) && Number(p.stock) >= 0 ? Number(p.stock) : 0,
          reservedStock: 0,
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

      // Notify users about the bulk product addition
      if (addedIds.length > 0) {
        try {
          const io = req.app.get('io');
          const socketsByUser = req.app.get('socketsByUser');

          let recipients = [];
          if (catalog.isPublic) {
            recipients = await User.find({ role: 'user', isActive: true }).select('_id name email');
          } else {
            const ids = (catalog.allowedUserIds || []).map(id => id && id.toString ? id.toString() : String(id));
            recipients = await User.find({ _id: { $in: ids }, role: 'user', isActive: true }).select('_id name email');
          }

          const productCount = addedIds.length;
          for (const user of recipients) {
            const title = `➕ ${productCount} Products Added`;
            const body = `${productCount} new products were added to catalog "${catalog.name}"`;
            const notif = await Notification.create({
              user: user._id,
              title,
              body,
              data: {
                type: 'product',
                catalogId: catalog._id.toString(),
                productCount,
                action: 'products_added_bulk'
              }
            });

            if (io && socketsByUser) {
              const userSockets = socketsByUser.get(String(user._id));
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
              }
            }

            try {
              await sendPushToUser(
                User,
                user._id,
                title,
                body,
                {
                  type: 'product',
                  catalogId: catalog._id.toString(),
                  productCount,
                  action: 'products_added_bulk'
                }
              );
            } catch (err) {
              console.error(`⚠️  Failed to send bulk product push to user ${user.email}:`, err);
            }
          }
        } catch (err) {
          console.error('Error notifying users about bulk product addition:', err);
        }
      }

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

    const accessBefore = accessSnapshot(catalog);

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
    await auditAccessChange(req, catalog, accessBefore, 'permissions');

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
