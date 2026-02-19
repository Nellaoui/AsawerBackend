const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const User = require('../models/User');
const { auth } = require('../middlewares/auth');

// GET /api/notifications - Get all notifications for the authenticated user
router.get('/', auth, async (req, res) => {
  try {
    const notifications = await Notification.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/notifications/unread - Get unread count
router.get('/unread', auth, async (req, res) => {
  try {
    const count = await Notification.countDocuments({ 
      user: req.user.id, 
      read: false 
    });
    
    res.json({ count });
  } catch (error) {
    console.error('Error counting unread notifications:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/notifications/:id/read - Mark notification as read
router.put('/:id/read', auth, async (req, res) => {
  try {
    const notification = await Notification.findOne({ 
      _id: req.params.id, 
      user: req.user.id 
    });
    
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }
    
    notification.read = true;
    await notification.save();
    
    res.json(notification);
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/notifications/read-all - Mark all notifications as read
router.put('/read-all', auth, async (req, res) => {
  try {
    await Notification.updateMany(
      { user: req.user.id, read: false },
      { $set: { read: true } }
    );
    
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/notifications/:id - Delete a notification
router.delete('/:id', auth, async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({ 
      _id: req.params.id, 
      user: req.user.id 
    });
    
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }
    
    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/notifications/push-token - Register push token
router.post('/push-token', auth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: 'Push token is required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add token if not already present
    if (!user.expoPushTokens) {
      user.expoPushTokens = [];
    }
    if (!user.expoPushTokens.includes(token)) {
      user.expoPushTokens.push(token);
      await user.save();
    }

    res.json({ success: true, message: 'Push token registered' });
  } catch (error) {
    console.error('Error registering push token:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/notifications/push-token - Unregister push token
router.delete('/push-token', auth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: 'Push token is required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.expoPushTokens) {
      user.expoPushTokens = user.expoPushTokens.filter(t => t !== token);
      await user.save();
    }

    res.json({ success: true, message: 'Push token unregistered' });
  } catch (error) {
    console.error('Error unregistering push token:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
