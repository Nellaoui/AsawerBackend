const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { auth, adminAuth } = require('../middlewares/auth');
const { isTabletAccount } = require('../utils/customerTablet');
const sendInviteEmail = require('../utils/emailInvite');
const { MESSAGES, decidePhoneSignIn, deviceFromBody, canApprovePhoneChanges } = require('../utils/customerPhones');
const { getRequireApp, recordPhoneRequest } = require('../utils/customerPhoneService');

const router = express.Router();

// Token expiry policy: 30d in development, 7d in production.
// Can be overridden via environment variable JWT_EXPIRES_IN.
const TOKEN_EXPIRES_IN = process.env.JWT_EXPIRES_IN || (process.env.NODE_ENV === 'production' ? '7d' : '30d');

// A customer's token names the phone it was issued to, so it stops working on
// that phone once the account is moved to another one.
const signToken = (userId, deviceId) => jwt.sign(
  { userId, ...(deviceId ? { did: deviceId } : {}) },
  process.env.JWT_SECRET,
  { expiresIn: TOKEN_EXPIRES_IN }
);

const refusedSignIns = {
  new_phone: { code: 'PHONE_NOT_ALLOWED', message: MESSAGES.newPhone },
  needs_app: { code: 'APP_UPDATE_REQUIRED', message: MESSAGES.needsApp },
  web: { code: 'PHONE_APP_REQUIRED', message: MESSAGES.webBlocked }
};

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

    // A new customer account belongs to the phone it was created on.
    const device = deviceFromBody(req.body);
    const phoneCheck = decidePhoneSignIn({ user: { role: 'user' }, device, requireApp: await getRequireApp() });
    if (refusedSignIns[phoneCheck]) {
      return res.status(403).json(refusedSignIns[phoneCheck]);
    }

    // Create new user
    user = new User({
      email,
      password,
      name,
      phone: phone || '',
      ...(phoneCheck === 'link' ? {
        boundDeviceId: device.deviceId,
        boundDeviceName: device.deviceName,
        boundDeviceAt: new Date()
      } : {})
    });

    await user.save();

    // Generate JWT token
    const token = signToken(user._id, phoneCheck === 'link' ? device.deviceId : undefined);

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
      return res.status(400).json({ message: 'This account is paused. Please contact the shop.' });
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

    const tablet = isTabletAccount(user);
    if (operationsOnly && tablet) {
      return res.status(403).json({ message: 'The shop tablet account cannot use the operations portal' });
    }

    // Customers in the app are tied to one phone. The portal never is.
    let tokenDevice;
    if (!operationsOnly) {
      const device = deviceFromBody(req.body);
      const phoneCheck = decidePhoneSignIn({ user, device, requireApp: await getRequireApp() });
      if (phoneCheck === 'new_phone') {
        await recordPhoneRequest(req.app, user, device)
          .catch(error => console.error('❌ Could not record phone change request:', error));
      }
      if (refusedSignIns[phoneCheck]) {
        console.log(`📱 Customer sign-in refused (${phoneCheck}):`, user.email);
        return res.status(403).json(refusedSignIns[phoneCheck]);
      }
      if (phoneCheck === 'link') {
        await User.updateOne(
          { _id: user._id },
          { $set: { boundDeviceId: device.deviceId, boundDeviceName: device.deviceName, boundDeviceAt: new Date() } }
        );
      }
      if (phoneCheck === 'link' || phoneCheck === 'same') tokenDevice = device.deviceId;
    }

    const token = signToken(user._id, tokenDevice);

    console.log(operationsOnly ? 'Operations login successful:' : 'User login successful:', user.email);
    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        // The shop tablet account never acts as an admin in the app.
        isAdmin: tablet ? false : user.isAdmin,
        role: tablet ? 'user' : role,
        workRole: user.workRole || 'general',
        isTabletAccount: tablet,
        canApprovePhoneChanges: canApprovePhoneChanges(user)
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
  // Sliding session: every time the app opens it gets a fresh token, so people
  // who use the app regularly are never asked to sign in again. Test and
  // impersonation tokens are left as they are.
  const renewable = req.auth?.userId && !req.auth.isTestToken && !req.auth.isImpersonated;

  // Customers who signed in before phones were remembered: the updated app
  // names its phone here, so their session is tied to it without a new sign-in.
  let did = req.auth?.did;
  if (renewable && !did) {
    const device = deviceFromBody({ deviceId: req.header('X-Device-Id'), deviceName: req.header('X-Device-Name'), platform: req.header('X-Device-Platform') });
    const phoneCheck = device.deviceId ? decidePhoneSignIn({ user: req.user, device }) : 'allow';
    if (phoneCheck === 'new_phone') {
      await recordPhoneRequest(req.app, req.user, device)
        .catch(error => console.error('❌ Could not record phone change request:', error));
      return res.status(401).json(refusedSignIns.new_phone);
    }
    if (phoneCheck === 'link') {
      await User.updateOne(
        { _id: req.user._id },
        { $set: { boundDeviceId: device.deviceId, boundDeviceName: device.deviceName, boundDeviceAt: new Date() } }
      );
    }
    if (phoneCheck === 'link' || phoneCheck === 'same') did = device.deviceId;
  }
  const token = renewable ? signToken(req.auth.userId, did) : undefined;
  res.json({
    ...(token ? { token } : {}),
    user: {
      id: req.user._id,
      email: req.user.email,
      name: req.user.name,
      phone: req.user.phone,
      isAdmin: req.user.isAdmin,
      role: req.user.isAdmin ? 'admin' : (req.user.role || 'user'),
      workRole: req.user.workRole || 'general',
      isTabletAccount: req.user.isTabletAccount === true,
      canApprovePhoneChanges: canApprovePhoneChanges(req.user)
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
