const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Catalog = require('../models/Catalog');
const Notification = require('../models/Notification');
const { adminAuth } = require('../middlewares/auth');
const { sendPushToUser } = require('../utils/pushNotification');

const router = express.Router();

// Get all users (Admin only)
router.get('/users', adminAuth, async (req, res) => {
  try {
    const users = await User.find({}).select('-password');
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all products (Admin only)
router.get('/products', adminAuth, async (req, res) => {
  try {
    const products = await Product.find({}).populate('createdBy', 'name');
    res.json(products);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get dashboard stats (Admin only)
router.get('/dashboard', adminAuth, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments({ isAdmin: false });
    const totalProducts = await Product.countDocuments();
    const activeProducts = await Product.countDocuments({ isActive: true });
    const totalCatalogs = await Catalog.countDocuments();
    const totalOrders = await Order.countDocuments();
    const pendingOrders = await Order.countDocuments({ status: 'pending' });
    const completedOrders = await Order.countDocuments({ status: 'delivered' });

    res.json({
      totalUsers,
      totalProducts,
      activeProducts,
      totalCatalogs,
      totalOrders,
      pendingOrders,
      completedOrders
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update user status (Admin only)
router.put('/users/:id', adminAuth, async (req, res) => {
  try {
    const { isActive } = req.body;

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.isActive = isActive;
    await user.save();

    res.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Send a notification to a specific user (Admin only)
// POST /api/admin/notify
// body: { userId, title, body, data }
router.post('/notify', adminAuth, async (req, res) => {
  try {
    const { userId, title = '', body = '', data = {} } = req.body;
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // persist notification
    const notif = await Notification.create({ user: userId, title, body, data });

    // emit via Socket.IO to connected sockets for that user
    const io = req.app.get('io');
    const socketsByUser = req.app.get('socketsByUser');
    if (io && socketsByUser) {
      const userSockets = socketsByUser.get(String(userId));
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

    // 🔔 Send push notification to user
    try {
      await sendPushToUser(User, userId, title, body, data);
    } catch (err) {
      console.error('⚠️  Failed to send push notification:', err);
      // Don't fail the request if push fails
    }

    return res.json({ success: true, notification: notif });
  } catch (error) {
    console.error('Error sending notification', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/notify-user - Send push to specific user
router.post('/notify-user', adminAuth, async (req, res) => {
  try {
    const { userId, title, body, data } = req.body;

    if (!userId || !title || !body) {
      return res.status(400).json({ message: 'userId, title, and body are required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Send push notification
    await sendPushToUser(User, userId, title, body, data || {});

    // Also save as database notification
    const notification = await Notification.create({
      user: userId,
      title,
      body,
      data: data || {},
    });

    // Emit Socket.IO notification for in-app display
    const io = req.app.get('io');
    const socketsByUser = req.app.get('socketsByUser');
    if (io && socketsByUser) {
      const userSockets = socketsByUser.get(String(userId));
      if (userSockets) {
        for (const socketId of userSockets) {
          io.to(socketId).emit('notification', {
            id: notification._id,
            title: notification.title,
            body: notification.body,
            data: notification.data,
            createdAt: notification.createdAt,
          });
        }
      }
    }

    res.json({ 
      success: true, 
      message: 'Push notification sent',
      notification 
    });
  } catch (error) {
    console.error('Error sending push notification:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/notify-all - Send push to all users or users with a role
router.post('/notify-all', adminAuth, async (req, res) => {
  try {
    const { title, body, data, role } = req.body;

    if (!title || !body) {
      return res.status(400).json({ message: 'title and body are required' });
    }

    // Find users (optionally filter by role)
    const filter = { isActive: true };
    if (role === 'admin') {
      filter.isAdmin = true;
    } else if (role === 'user') {
      filter.isAdmin = false;
    }

    const users = await User.find(filter).select('_id email');

    let sentCount = 0;
    let errorCount = 0;

    for (const user of users) {
      try {
        await sendPushToUser(User, user._id, title, body, data || {});
        sentCount++;
      } catch (err) {
        console.error(`⚠️  Failed to send push to ${user.email}:`, err);
        errorCount++;
      }
    }

    res.json({
      success: true,
      message: `Push notifications sent to ${sentCount} users`,
      sentCount,
      errorCount,
      totalAttempted: users.length
    });
  } catch (error) {
    console.error('Error sending bulk push notifications:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Impersonate a user (Admin only)
// POST /api/admin/impersonate/:userId
router.post('/impersonate/:userId', adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid target user ID' });
    }

    const targetUser = await User.findById(userId).select('-password');
    if (!targetUser) {
      return res.status(404).json({ message: 'Target user not found' });
    }

    const targetRole = targetUser.isAdmin ? 'admin' : (targetUser.role || 'user');
    if (targetRole !== 'user') {
      return res.status(400).json({ message: 'Only customer accounts can be opened as customer profiles' });
    }

    if (targetUser.isActive === false) {
      return res.status(403).json({ message: 'Inactive customer accounts cannot be opened' });
    }

    const IMPERSONATION_TOKEN_EXPIRES_IN = process.env.IMPERSONATION_TOKEN_EXPIRES_IN || '2h';
    const token = jwt.sign(
      {
        userId: targetUser._id,
        isImpersonated: true,
        originalAdminId: req.user.id || req.user._id,
        originalAdminName: req.user.name,
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: IMPERSONATION_TOKEN_EXPIRES_IN }
    );

    console.log(`👁️ Admin (${req.user.email}) is impersonating target user: (${targetUser.email})`);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      token,
      isImpersonated: true,
      user: {
        id: targetUser._id,
        email: targetUser.email,
        name: targetUser.name,
        phone: targetUser.phone,
        isAdmin: targetUser.isAdmin,
        role: 'user',
        isActive: targetUser.isActive
      },
      originalAdmin: {
        id: req.user.id || req.user._id,
        name: req.user.name,
        email: req.user.email,
      }
    });
  } catch (error) {
    console.error('Impersonation error:', error);
    res.status(500).json({ message: 'Server error during impersonation' });
  }
});

module.exports = router;
