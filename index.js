const express = require('express');
const app = express();
const __path = process.cwd();
const bodyParser = require('body-parser');
const cors = require('cors'); // Add this line
const PORT = process.env.PORT || 7860;
const botdl = require('./qr').botdl;

// Import routes
let server = require('./qr');
let code = require('./pair');
let minipair = require('./minipair');
let miniqr = require('./miniqr');

// Increase the default max listeners for EventEmitter
require('events').EventEmitter.defaultMaxListeners = 500;

// ================== FIX CORS HERE ==================
// Configure CORS middleware
app.use(cors({
  origin: '*', // Allow all origins (you can restrict this to specific domains)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: false, // Set to true if you need cookies/auth headers
  maxAge: 86400 // 24 hours
}));

// Handle preflight requests globally
app.options('*', cors()); // Enable pre-flight for all routes

// OR if you want more control, handle manually:
app.use((req, res, next) => {
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});
// ===================================================

// Serve static files (CSS, JS, images, etc.)
app.use(express.static(__path + '/public')); // Serve files from the "public" directory

// Routes
app.use('/server', server);
app.use('/code', code);
app.use('/miniqr', miniqr);
app.use('/minipair', minipair);

app.use('/session/bot-download', async(req, res) => {
    await botdl(req, res);
});

app.use('/pair-code', async (req, res, next) => {
    res.sendFile(__path + '/pair.html');
});

app.use('/qr', async (req, res, next) => {
    res.sendFile(__path + '/qr.html');
});

app.use('/', async (req, res, next) => {
    res.sendFile(__path + '/public/index.html');
});

// Middleware for parsing JSON and URL-encoded data
// IMPORTANT: Place bodyParser AFTER CORS but BEFORE your routes
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    status: false, 
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    status: false, 
    message: 'Route not found' 
  });
});

// Start the server
app.listen(PORT, () => {
    console.log(`
Don't Forgot To Give Star

Server running on http://localhost:${PORT}`);
});

module.exports = app;
