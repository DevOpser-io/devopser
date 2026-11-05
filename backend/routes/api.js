/**
 * API Routes
 * General API endpoints not specific to chat functionality
 */
const express = require('express');
const router = express.Router();

// Add local body-parser middleware for API routes
// This is needed because the global body-parser is added after AdminJS setup
router.use(express.json());
router.use(express.urlencoded({ extended: false }));

// Health check endpoint - available at both /api/health and /api (for backward compatibility)
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root health check for backward compatibility
router.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Information
router.get('/info', (req, res) => {
  res.json({
    name: 'Bedrock Express API',
    version: '1.0.0',
    description: 'Express.js backend for Bedrock AI Chat application',
  });
});

// Debug endpoint to check user admin status
router.get('/debug/user', (req, res) => {
  if (!req.user) {
    return res.json({ authenticated: false, message: 'Not authenticated' });
  }
  
  res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      isAdmin: req.user.isAdmin,
      emailVerified: req.user.emailVerified,
      mfaEnabled: req.user.mfaEnabled
    }
  });
});

module.exports = router;
