const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:8081', 'http://192.168.0.157:8081', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());

// Serve static files (uploaded images)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Simple test route
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is working!' });
});

// Simple upload route without auth for testing
app.post('/api/upload/test', (req, res) => {
  console.log('Test upload route hit');
  res.json({ message: 'Upload route is working!' });
});

const PORT = 5001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Test server running on http://0.0.0.0:${PORT}`);
  console.log(`Local access: http://localhost:${PORT}`);
  console.log(`Network access: http://192.168.0.157:${PORT}`);
});
