// Simple test to verify ngrok connection
const express = require('express');
const cors = require('cors');

const app = express();

// Enable CORS for ngrok
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());

// Test route
app.get('/', (req, res) => {
  res.json({ 
    message: 'Backend is working!', 
    timestamp: new Date().toISOString(),
    headers: req.headers
  });
});

app.get('/api', (req, res) => {
  res.json({ 
    message: 'API is working!', 
    timestamp: new Date().toISOString()
  });
});

app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'API test endpoint working!', 
    timestamp: new Date().toISOString()
  });
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Test server running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`Ngrok should forward to this port`);
});
