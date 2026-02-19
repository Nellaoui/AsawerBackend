const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const dns = require('dns');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const User = require('./models/User');

// Use Google DNS for SRV record resolution (fixes local DNS issues)
dns.setServers(['8.8.8.8', '8.8.4.4']);

const app = express();

// Middleware
app.use(cors({
  origin: [
    process.env.CORS_ORIGIN_LOCALHOST,
    process.env.CORS_ORIGIN_NETWORK,
    process.env.CORS_ORIGIN_WEB,
  ],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files (uploaded images)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Debug middleware to log all requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  console.log('Headers:', req.headers.authorization ? 'Authorization: ' + req.headers.authorization.substring(0, 20) + '...' : 'No Authorization');
  next();
});

// Database connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
});

// We'll create an HTTP server and attach Socket.IO so routes can use io via app.get('io')
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      process.env.CORS_ORIGIN_LOCALHOST,
      process.env.CORS_ORIGIN_NETWORK,
      process.env.CORS_ORIGIN_WEB,
    ],
    credentials: true
  }
});

// Map userId -> Set(socketId)
const socketsByUser = new Map();

// Socket middleware to authenticate using JWT or test token in handshake
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next();

    // Support test-token-... pattern used in HTTP auth middleware for local/dev
    if (token.startsWith('test-token-')) {
      let email = token.replace('test-token-', '');
      if (!email.includes('@')) {
        if (email.includes('-')) {
          const [userType, id] = email.split('-');
          email = `${userType}@test.com`;
        } else {
          email += '@test.com';
        }
      }
      const user = await User.findOne({ email });
      if (user) {
        socket.data.userId = user._id.toString();
      }
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    if (decoded && decoded.userId) {
      const user = await User.findById(decoded.userId).select('-password');
      if (user) socket.data.userId = user._id.toString();
    }
    return next();
  } catch (err) {
    console.warn('Socket auth failed:', err && err.message ? err.message : err);
    // allow connection to continue but without an authenticated user
    return next();
  }
});

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // If the socket was already authenticated during handshake, register it now
  if (socket.data && socket.data.userId) {
    const uid = String(socket.data.userId);
    if (!socketsByUser.has(uid)) socketsByUser.set(uid, new Set());
    socketsByUser.get(uid).add(socket.id);
    console.log(`Socket ${socket.id} auto-identified as user ${uid} via handshake auth`);
  }

  socket.on('identify', (userId) => {
    try {
      if (!userId) return;
      const uid = String(userId);
      if (!socketsByUser.has(uid)) socketsByUser.set(uid, new Set());
      socketsByUser.get(uid).add(socket.id);
      socket.data.userId = uid;
      console.log(`Socket ${socket.id} identified as user ${uid}`);
    } catch (e) {
      console.error('Error in identify handler', e);
    }
  });

  socket.on('disconnect', () => {
    const uid = socket.data.userId;
    if (uid && socketsByUser.has(uid)) {
      socketsByUser.get(uid).delete(socket.id);
      if (socketsByUser.get(uid).size === 0) socketsByUser.delete(uid);
    }
    console.log('Socket disconnected:', socket.id);
  });
});

// Make io and sockets map available to routes via app.get('io') / app.get('socketsByUser')
app.set('io', io);
app.set('socketsByUser', socketsByUser);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/catalogs', require('./routes/catalogs'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/users', require('./routes/users'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/wishlist', require('./routes/wishlist'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/clasp-images', require('./routes/claspImages'));
app.use('/api/size-presets', require('./routes/sizePresets'));

// Serve support page
app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'support.html'));
});

// Serve privacy policy page
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy-policy.html'));
});

// Root route for health check
app.get('/', (req, res) => {
  res.json({
    message: 'Asawer Backend API is running!',
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Local access: http://localhost:${PORT}`);
  console.log(`Network access: http://192.168.1.8:${PORT}`);
});