const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    console.log('🔐 Auth middleware - Authorization header:', authHeader ? 'Present' : 'Missing');

    const token = authHeader?.replace('Bearer ', '');

    if (!token) {
      console.log('❌ Auth middleware - No token provided');
      return res.status(401).json({ message: 'No token, authorization denied' });
    }

    console.log('🔐 Auth middleware - Token preview:', token.substring(0, 20) + '...');

    // Handle test tokens for development
    if (token.startsWith('test-token-')) {
      if (process.env.NODE_ENV !== 'development') {
        return res.status(401).json({ message: 'Development tokens are disabled. Please sign in.' });
      }
      console.log('🧪 Auth middleware - Processing test token');
      
      // Extract email from token (format: test-token-{email} or test-token-{email}@test.com)
      let email = token.replace('test-token-', '');
      
      // If the token already contains an @, use it as is, otherwise add @test.com
      if (!email.includes('@')) {
        // If it's a simple ID (like user-001), convert to email
        if (email.includes('-')) {
          const [userType, id] = email.split('-');
          email = `${userType}@test.com`;
        } else {
          email += '@test.com';
        }
      }
      
      console.log(`🧪 Extracted email from token: ${email}`);
      
      try {
        // Find user in database by email
        const user = await User.findOne({ email });
        
        if (!user) {
          console.log(`❌ Auth middleware - No user found with email: ${email}`);
          return res.status(401).json({ message: 'Invalid test token - user not found' });
        }

        if (user.isActive === false) {
          return res.status(403).json({ message: 'Account is inactive' });
        }
        
        req.auth = { isTestToken: true, isImpersonated: false };
        req.user = {
          id: user._id.toString(),
          _id: user._id,
          userId: user._id.toString(),
          email: user.email,
          name: user.name || 'Test User',
          phone: user.phone || '',
          isAdmin: user.isAdmin || false,
          role: user.role || (user.isAdmin ? 'admin' : 'user')
        };

        console.log(`✅ Auth middleware - Test user authenticated:`, {
          email: req.user.email,
          id: req.user.id,
          _id: req.user._id,
          userId: req.user.userId,
          isAdmin: req.user.isAdmin,
          role: req.user.role,
          dbUserId: user._id.toString()
        });
        return next();
        
      } catch (error) {
        console.error('Error authenticating test user:', error);
        return res.status(500).json({ message: 'Error authenticating test user' });
      }
    }

    // Handle real JWT tokens
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.auth = decoded;
    console.log('✅ Auth middleware - Token decoded successfully, user ID:', decoded.userId);

    // Optional global invalidation: force-logout tokens issued before a cutoff
    // Set TOKEN_INVALID_BEFORE to a date/time (ISO string) or epoch seconds/ms.
    if (process.env.TOKEN_INVALID_BEFORE) {
      let cutoff = Number(process.env.TOKEN_INVALID_BEFORE);
      if (Number.isNaN(cutoff)) {
        const parsed = Date.parse(process.env.TOKEN_INVALID_BEFORE);
        cutoff = Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000); // seconds
      } else {
        // If provided in ms, convert to seconds
        if (cutoff > 1e12) cutoff = Math.floor(cutoff / 1000);
      }
      const issuedAt = decoded.iat; // seconds since epoch
      if (cutoff && issuedAt && issuedAt < cutoff) {
        console.warn('🔒 Token invalidated by TOKEN_INVALID_BEFORE cutoff. iat:', issuedAt, 'cutoff:', cutoff);
        return res.status(401).json({ message: 'Token invalidated' });
      }
    }

    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      console.log('❌ Auth middleware - User not found in database');
      return res.status(401).json({ message: 'Token is not valid' });
    }

    if (user.isActive === false) {
      return res.status(403).json({ message: 'Account is inactive' });
    }

    // Set role field for consistency with Catalog model expectations
    req.user = {
      ...user.toObject(),
      id: user._id.toString(), // Ensure id field is available
      role: user.isAdmin ? 'admin' : (user.role || 'user')
    };

    console.log('Auth middleware - user details:', {
      id: req.user.id,
      email: req.user.email,
      isAdmin: req.user.isAdmin,
      role: req.user.role
    });
    next();
  } catch (error) {
    // Return a clearer message for expired tokens so clients can handle re-auth
    if (error && error.name === 'TokenExpiredError') {
      const expiredAt = error.expiredAt ? new Date(error.expiredAt).toISOString() : 'unknown';
      const ua = req.get('User-Agent');
      const path = `${req.method} ${req.originalUrl}`;
      console.warn('🔔 TokenExpiredError in auth middleware.', { expiredAt, path, userAgent: ua });
      return res.status(401).json({ message: 'Token expired' });
    }
    console.error('Authentication error:', error);
    res.status(401).json({ message: 'Token is not valid' });
  }
};

const adminAuth = (req, res, next) => auth(req, res, () => {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ message: 'Access denied. Admin only.' });
  }

  // An impersonated session must never regain admin privileges, even if the
  // selected target account is accidentally promoted later.
  if (req.auth?.isImpersonated) {
    return res.status(403).json({ message: 'Exit customer view before using admin features.' });
  }

  return next();
});

const operationsAuth = (req, res, next) => auth(req, res, () => {
  const canManageOperations = req.user?.isAdmin || ['admin', 'employee'].includes(req.user?.role);
  if (!canManageOperations) {
    return res.status(403).json({ message: 'Operations access required.' });
  }

  if (req.auth?.isImpersonated) {
    return res.status(403).json({ message: 'Exit customer view before using operations features.' });
  }

  return next();
});

module.exports = { auth, adminAuth, operationsAuth };
