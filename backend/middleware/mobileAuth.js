/**
 * Mobile API Authentication Middleware
 *
 * Provides secure authentication for mobile app API requests using:
 * 1. API Key authentication for app identification
 * 2. Session-based auth for user-specific requests
 * 3. Request signature validation to prevent tampering
 */

const crypto = require('crypto');
const { getAdditionalSecrets } = require('../services/secretsManager');

// Cache for mobile API secrets
let mobileSecrets = null;
let secretsLastFetched = null;
const SECRETS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Get mobile API secrets from AWS Secrets Manager with caching
 */
async function getMobileSecrets() {
  const now = Date.now();

  if (!mobileSecrets || !secretsLastFetched || (now - secretsLastFetched > SECRETS_CACHE_TTL)) {
    try {
      const secrets = await getAdditionalSecrets();
      mobileSecrets = {
        apiKey: secrets.MOBILE_API_KEY || process.env.MOBILE_API_KEY || generateDefaultApiKey(),
        signingSecret: secrets.MOBILE_SIGNING_SECRET || process.env.MOBILE_SIGNING_SECRET || generateDefaultSigningSecret()
      };
      secretsLastFetched = now;
      console.log('[Mobile Auth] Mobile API secrets loaded/refreshed');
    } catch (error) {
      console.error('[Mobile Auth] Failed to load mobile secrets from AWS:', error);
      // Fall back to environment variables or defaults
      if (!mobileSecrets) {
        mobileSecrets = {
          apiKey: process.env.MOBILE_API_KEY || generateDefaultApiKey(),
          signingSecret: process.env.MOBILE_SIGNING_SECRET || generateDefaultSigningSecret()
        };
      }
    }
  }

  return mobileSecrets;
}

/**
 * Generate a default API key (for development only)
 *
 * Fails closed in production: never fall back to a hardcoded/guessable key.
 * In non-production, generate a random per-process value so the fallback can
 * never be a shipped literal that an attacker could know in advance.
 */
function generateDefaultApiKey() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('MOBILE_API_KEY is not configured; refusing to use a default API key in production');
  }
  const key = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️  Using generated per-process API key for mobile (development only)');
  console.warn('⚠️  Set MOBILE_API_KEY in AWS Secrets Manager for production!');
  return key;
}

/**
 * Generate a default signing secret (for development only)
 *
 * Fails closed in production: never fall back to a per-process secret that
 * would silently pass signature validation without an operator-set value.
 */
function generateDefaultSigningSecret() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('MOBILE_SIGNING_SECRET is not configured; refusing to use a default signing secret in production');
  }
  const secret = crypto.randomBytes(64).toString('hex');
  console.warn('⚠️  Using generated per-process signing secret for mobile (development only)');
  console.warn('⚠️  Set MOBILE_SIGNING_SECRET in AWS Secrets Manager for production!');
  return secret;
}

/**
 * Constant-time string comparison to avoid leaking the API key via timing.
 * Returns false immediately on a length mismatch (which is not secret), and
 * otherwise compares the full buffers so the timing does not depend on the
 * position of the first differing byte.
 */
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validate request signature to prevent tampering
 */
function validateSignature(req, signingSecret) {
  const signature = req.headers['x-signature'];
  const timestamp = req.headers['x-timestamp'];

  if (!signature || !timestamp) {
    return false;
  }

  // Check timestamp is within 5 minutes
  const requestTime = parseInt(timestamp);
  const now = Date.now();
  if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
    console.warn('[Mobile Auth] Request timestamp too old or in future');
    return false;
  }

  // Recreate signature
  const method = req.method;
  const path = req.originalUrl || req.url;
  const body = JSON.stringify(req.body || {});
  const message = `${method}:${path}:${timestamp}:${body}`;

  const expectedSignature = crypto
    .createHmac('sha256', signingSecret)
    .update(message)
    .digest('hex');

  return signature === expectedSignature;
}

/**
 * Mobile API authentication middleware
 *
 * Usage:
 *   app.use('/api/mobile', mobileAuth());  // Require mobile auth for all mobile routes
 *   app.use('/api', mobileAuth({ optional: true })); // Allow but don't require mobile auth
 */
function mobileAuth(options = {}) {
  const {
    optional = false,        // If true, allows requests without mobile auth
    requireUser = false,     // If true, also requires user session
    validateSignature: validateSig = false  // If true, validates request signature
  } = options;

  return async (req, res, next) => {
    try {
      // API key can come from header or query parameter (for EventSource)
      const apiKey = req.headers['x-api-key'] || req.query.apiKey;
      const clientVersion = req.headers['x-client-version'] || req.query.clientVersion;
      const platform = req.headers['x-platform'] || req.query.platform; // ios, android, web

      // Skip mobile auth for health checks
      if (req.path === '/health' || req.path === '/api/health') {
        return next();
      }

      // Check if this is a mobile request
      const isMobileRequest = apiKey || platform === 'ios' || platform === 'android' ||
                             req.headers['user-agent']?.includes('Capacitor');

      if (!isMobileRequest && optional) {
        // Not a mobile request and mobile auth is optional
        return next();
      }

      if (!apiKey) {
        if (optional) {
          return next();
        }
        return res.status(401).json({
          error: 'API key required',
          code: 'MISSING_API_KEY'
        });
      }

      // Get and validate API key
      const secrets = await getMobileSecrets();

      if (!timingSafeEqualStr(apiKey, secrets.apiKey)) {
        console.warn(`[Mobile Auth] Invalid API key attempt: ${apiKey.substring(0, 8)}...`);
        return res.status(401).json({
          error: 'Invalid API key',
          code: 'INVALID_API_KEY'
        });
      }

      // Validate signature if required
      if (validateSig && !validateSignature(req, secrets.signingSecret)) {
        console.warn('[Mobile Auth] Invalid request signature');
        return res.status(401).json({
          error: 'Invalid request signature',
          code: 'INVALID_SIGNATURE'
        });
      }

      // Check user session if required
      if (requireUser && !req.user) {
        return res.status(401).json({
          error: 'User authentication required',
          code: 'USER_AUTH_REQUIRED'
        });
      }

      // Add mobile context to request
      req.isMobileClient = true;
      req.clientPlatform = platform;
      req.clientVersion = clientVersion;

      // Log mobile request for monitoring
      console.log(`[Mobile Auth] Mobile API request: ${req.method} ${req.path} [${platform} v${clientVersion}]`);

      next();
    } catch (error) {
      console.error('[Mobile Auth] Mobile auth middleware error:', error);
      if (optional) {
        // Don't block request if mobile auth is optional
        return next();
      }
      res.status(500).json({
        error: 'Authentication error',
        code: 'AUTH_ERROR'
      });
    }
  };
}

/**
 * Helper middleware to require mobile-only access
 */
function mobileOnly() {
  return mobileAuth({ optional: false });
}

/**
 * Helper middleware to require mobile auth with user session
 */
function mobileWithUser() {
  return mobileAuth({ optional: false, requireUser: true });
}

module.exports = {
  mobileAuth,
  mobileOnly,
  mobileWithUser,
  getMobileSecrets
};
