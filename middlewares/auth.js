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
      console.log('🧪 Auth middleware - Processing test token');
      
      const testUsers = {
        'test-token-admin-001': {
          userId: 'admin-001',
          email: 'admin@test.com',
          name: 'Test Admin',
          isAdmin: true,
          role: 'admin'
        },
        'test-token-admin-002': {
          userId: 'admin-002',
          email: 'admin@asawer.com',
          name: 'Asawer Admin',
          isAdmin: true,
          role: 'admin'
        },
        'test-token-user-001': {
          userId: 'user-001',
          email: 'user@test.com',
          name: 'Test User',
          isAdmin: false,
          role: 'user'
        }
      };

      const testUser = testUsers[token];
      if (testUser) {
        req.user = {
          ...testUser,
          id: testUser.userId,
          _id: testUser.userId
        };
        console.log('✅ Auth middleware - Test user authenticated:', req.user.email);
        return next();
      } else {
        console.log('❌ Auth middleware - Invalid test token');
        return res.status(401).json({ message: 'Invalid test token' });
      }
    }

    // Handle real JWT tokens
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
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

    // Set role field for consistency with Catalog model expectations
    req.user = {
      ...user.toObject(),
      id: user._id.toString(), // Ensure id field is available
      role: user.isAdmin ? 'admin' : 'user'
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

const adminAuth = async (req, res, next) => {
  try {
    await auth(req, res, () => {});
    
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied. Admin only.' });
    }
    
    next();
  } catch (error) {
    res.status(401).json({ message: 'Authentication failed' });
  }
};

module.exports = { auth, adminAuth }; 