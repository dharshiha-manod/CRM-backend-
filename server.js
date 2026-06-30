/**
 * ====================================================
 * MANOD CRM BACKEND - MAIN SERVER
 * Node.js + Express + PostgreSQL
 * ====================================================
 */

const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const app = express();

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({
  origin:         process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials:    true,
  methods:        ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.path}`);
  next();
});

// ── DATABASE ──────────────────────────────────────────────────
const pool = require('./config/database');

// ── ROUTES ───────────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const crmRoutes  = require('./routes/crm');

app.use('/api/auth',  authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/crm',   crmRoutes);

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.status(200).json({
    message:     '✅ Backend is running!',
    timestamp:   new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// ── ROOT ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    message:  'Manod CRM Backend API',
    version:  '1.0.0',
    endpoints: {
      health: '/api/health',
      auth:   '/api/auth',
      users:  '/api/users',
      crm:    '/api/crm'
    }
  });
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path, method: req.method });
});

// ── ERROR HANDLER ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(err.status || 500).json({
    error:     err.message || 'Internal Server Error',
    timestamp: new Date().toISOString()
  });
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   🚀 MANOD CRM BACKEND STARTED               ║
╠══════════════════════════════════════════════╣
║   Server: http://localhost:${PORT}            ║
║   Environment: ${process.env.NODE_ENV || 'development'}              ║
╚══════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => {
  console.log('\n📴 Shutting down...');
  pool.end();
  process.exit(0);
});

module.exports = app;