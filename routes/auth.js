const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { auth, adminAuth } = require('../middlewares/auth');
const sendInviteEmail = require('../utils/emailInvite');

const router = express.Router();

// Token expiry policy: 30d in development, 7d in production.
// Can be overridden via environment variable JWT_EXPIRES_IN.
const TOKEN_EXPIRES_IN = process.env.JWT_EXPIRES_IN || (process.env.NODE_ENV === 'production' ? '7d' : '30d');

// TEMPORARY: Migration endpoint to add phone field to existing users
router.get('/migrate-phone', async (req, res) => {
  try {
    const result = await User.updateMany(
      { phone: { $exists: false } }, // Find users without phone field
      { $set: { phone: '' } }        // Set empty phone
    );

    console.log('Phone migration result:', result);
    res.json({
      message: 'Users updated with phone field',
      modifiedCount: result.modifiedCount,
      success: true
    });
  } catch (error) {
    console.error('Error migrating user phone field:', error);
    res.status(500).json({ message: 'Migration failed', success: false });
  }
});

// Register user
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').notEmpty().trim(),
  body('phone').optional().isMobilePhone()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name, phone, inviteToken } = req.body;

    // Check if user already exists
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Create new user
    user = new User({
      email,
      password,
      name,
      phone: phone || ''
    });

    await user.save();

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: TOKEN_EXPIRES_IN }
    );

    console.log('User registered successfully:', user.email);
    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        isAdmin: user.isAdmin,
        role: user.isAdmin ? 'admin' : (user.role || 'user'),
        workRole: user.workRole || 'general'
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

const loginValidators = () => [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
];

const loginHandler = ({ operationsOnly = false } = {}) => async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    if (user.isActive === false) {
      return res.status(400).json({ message: 'Account is inactive' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const role = user.isAdmin ? 'admin' : (user.role || 'user');
    if (operationsOnly && !['admin', 'employee'].includes(role)) {
      return res.status(403).json({ message: 'This account does not have operations portal access' });
    }
    if (!operationsOnly && role === 'employee') {
      return res.status(403).json({ message: 'Employee accounts can only sign in to the operations portal' });
    }

    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: TOKEN_EXPIRES_IN }
    );

    console.log(operationsOnly ? 'Operations login successful:' : 'User login successful:', user.email);
    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        isAdmin: user.isAdmin,
        role,
        workRole: user.workRole || 'general'
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Customer/mobile login. Employee credentials are deliberately rejected here.
router.post('/login', loginValidators(), loginHandler());

// Operations portal login. Only administrators and employees can use it.
router.post('/operations-login', loginValidators(), loginHandler({ operationsOnly: true }));

// Send invite (Admin only)
router.post('/invite', adminAuth, [
  body('email').isEmail().normalizeEmail(),
  body('name').notEmpty().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, name } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Send invite email
    await sendInviteEmail(email, name, req.user.name);

    res.json({ message: 'Invite sent successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  res.json({
    user: {
      id: req.user._id,
      email: req.user.email,
      name: req.user.name,
      phone: req.user.phone,
      isAdmin: req.user.isAdmin,
      role: req.user.isAdmin ? 'admin' : (req.user.role || 'user'),
      workRole: req.user.workRole || 'general'
    }
  });
});

// Change password
router.put('/change-password', auth, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Verify current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    console.log('🔐 Password changed for user:', user.email);
    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
