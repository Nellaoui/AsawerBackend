const express = require('express');
const User = require('../models/User');
const { auth } = require('../middlewares/auth');

const router = express.Router();

// GET /users - Get all users (admin only)
router.get('/', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
    }

    const users = await User.find({}, '-password'); // Exclude password field
    
    const transformedUsers = users.map(user => ({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      isAdmin: user.isAdmin,
      role: user.isAdmin ? 'admin' : 'user',
      isActive: user.isActive !== false, // Default to true if not set
      createdAt: user.createdAt || new Date().toISOString()
    }));

    res.json(transformedUsers);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'Server error fetching users' });
  }
});

// POST /users - Create new user (admin only)
router.post('/', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
    }

    const { name, email, password, role } = req.body;

    // Validate required fields
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Create new user (password will be hashed automatically by User model)
    const newUser = new User({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: password, // Don't hash here - let the User model handle it
      isAdmin: role === 'admin',
      isActive: true,
      createdAt: new Date()
    });

    await newUser.save();

    // Return user without password
    const userResponse = {
      id: newUser._id.toString(),
      name: newUser.name,
      email: newUser.email,
      isAdmin: newUser.isAdmin,
      role: newUser.isAdmin ? 'admin' : 'user',
      isActive: newUser.isActive,
      createdAt: newUser.createdAt
    };

    console.log('User created successfully:', {
      email: userResponse.email,
      name: userResponse.name,
      role: userResponse.role,
      isActive: userResponse.isActive
    });
    res.status(201).json(userResponse);
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ message: 'Server error creating user' });
  }
});

// PUT /users/:id - Update user (admin only)
router.put('/:id', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
    }

    const { name, email, role, isActive } = req.body;
    const userId = req.params.id;

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if email is being changed and if it already exists
    if (email && email.toLowerCase() !== user.email) {
      const existingUser = await User.findOne({ 
        email: email.toLowerCase(),
        _id: { $ne: userId }
      });
      if (existingUser) {
        return res.status(400).json({ message: 'User with this email already exists' });
      }
    }

    // Update user fields
    if (name) user.name = name.trim();
    if (email) user.email = email.toLowerCase().trim();
    if (role !== undefined) user.isAdmin = role === 'admin';
    if (isActive !== undefined) user.isActive = isActive;

    await user.save();

    // Return updated user without password
    const userResponse = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      isAdmin: user.isAdmin,
      role: user.isAdmin ? 'admin' : 'user',
      isActive: user.isActive,
      createdAt: user.createdAt
    };

    console.log('User updated successfully:', userResponse.email);
    res.json(userResponse);
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ message: 'Server error updating user' });
  }
});

// DELETE /users/:id - Delete user (admin only)
router.delete('/:id', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
    }

    const userId = req.params.id;

    // Prevent admin from deleting themselves
    if (userId === req.user.id) {
      return res.status(400).json({ message: 'Cannot delete your own account' });
    }

    // Find and delete user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    await User.findByIdAndDelete(userId);

    console.log('User deleted successfully:', user.email);
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: 'Server error deleting user' });
  }
});

// PATCH /users/:id/status - Toggle user active status (admin only)
router.patch('/:id/status', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
    }

    const userId = req.params.id;

    // Prevent admin from deactivating themselves
    if (userId === req.user.id) {
      return res.status(400).json({ message: 'Cannot change your own account status' });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Toggle active status
    user.isActive = !user.isActive;
    await user.save();

    // Return updated user without password
    const userResponse = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      isAdmin: user.isAdmin,
      role: user.isAdmin ? 'admin' : 'user',
      isActive: user.isActive,
      createdAt: user.createdAt
    };

    console.log('User status updated:', userResponse.email, 'Active:', userResponse.isActive);
    res.json(userResponse);
  } catch (error) {
    console.error('Error updating user status:', error);
    res.status(500).json({ message: 'Server error updating user status' });
  }
});

// PUT /:id/profile - Update user profile (user can update their own profile, admin can update any)
router.put('/:id/profile', auth, async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    const userId = req.params.id;

    // Check if user is updating their own profile or is admin
    console.log('🔐 Profile update authorization check:', {
      reqUserId: req.user.id,
      reqUserRole: req.user.role,
      reqUserIsAdmin: req.user.isAdmin,
      requestedUserId: userId,
      idsMatch: req.user.id === userId,
      isAdmin: req.user.role === 'admin' || req.user.isAdmin === true,
      tokenPreview: req.header('Authorization')?.replace('Bearer ', '').substring(0, 20) + '...'
    });

    if (req.user.id !== userId && req.user.role !== 'admin' && req.user.isAdmin !== true) {
      console.error('❌ Profile update authorization failed - IDs do not match');
      return res.status(403).json({ message: 'Not authorized to update this profile' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    console.log('Updating user profile:', {
      userId,
      currentEmail: user.email,
      currentPhone: user.phone,
      newData: { name, email, phone },
      updatedBy: req.user.email
    });

    // Check if email is being changed and if it's already taken
    if (email && email.toLowerCase() !== user.email.toLowerCase()) {
      const existingUser = await User.findOne({
        email: email.toLowerCase(),
        _id: { $ne: userId }
      });

      if (existingUser) {
        return res.status(400).json({ message: 'Email is already in use' });
      }
    }

    // Update user fields
    if (name !== undefined) user.name = name.trim();
    if (email !== undefined) user.email = email.toLowerCase().trim();
    if (phone !== undefined) user.phone = phone.trim();

    console.log('Saving user with updated fields:', {
      name: user.name,
      email: user.email,
      phone: user.phone
    });

    await user.save();

    console.log('User saved successfully, new phone:', user.phone);

    // Return updated user without password
    const userResponse = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone,
      isAdmin: user.isAdmin,
      role: user.isAdmin ? 'admin' : 'user',
      isActive: user.isActive,
      createdAt: user.createdAt
    };

    console.log('User profile updated successfully:', userResponse.email);
    res.json(userResponse);
  } catch (error) {
    console.error('Error updating user profile:', error);
    res.status(500).json({ message: 'Server error updating profile' });
  }
});

module.exports = router;
