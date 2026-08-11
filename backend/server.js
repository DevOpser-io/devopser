// Main server entry point
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const ejsLayouts = require('express-ejs-layouts');
const config = require('./config');

// Log the current environment during server startup
console.log('==================================================');
console.log(`SERVER: Current NODE_ENV is set to: ${process.env.NODE_ENV || 'undefined (defaulting to development)'}`);
console.log('==================================================');

// Import database and Redis services
const { initializeDatabase } = require('./models');
const redisClient = require('./services/redisClient');
const { configureSession } = require('./config/sessionStore');

// Import route modules
const apiRoutes = require('./routes/api');
const chatRoutes = require('./routes/chat');
const authRoutes = require('./routes/auth');
const mobileAuthRoutes = require('./routes/mobileAuth');
const adminRoutes = require('./routes/admin');
const adminPanelRoutes = require('./routes/admin-panel');
const sitesRoutes = require('./routes/sites');
const previewRoutes = require('./routes/preview');
const imagesRoutes = require('./routes/images');
const leadsRoutes = require('./routes/leads');
const apiKeysRoutes = require('./routes/apiKeys');

const listEndpoints = require('express-list-endpoints');

// Initialize express app
const app = express();

// Trust proxy headers from ALB/ELB in production
if (process.env.NODE_ENV === 'production') {
  console.log('Setting trust proxy for production environment');
  app.set('trust proxy', 1); // Trust first proxy (ALB)
}

// Set up view engine for templates
app.set('views', path.join(__dirname, 'templates'));
app.set('view engine', 'ejs');

// Configure middleware
app.use(logger('dev'));
// IMPORTANT: body-parser middleware (express.json and express.urlencoded) must be added AFTER AdminJS setup
// to avoid compatibility issues with @adminjs/express
app.use(cookieParser());

// Configure CORS with specific origins for security
// Supports: subdomains of DOMAIN env var, custom domains via CUSTOM_DOMAIN env var, and localhost
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc)
    if (!origin) {
      return callback(null, true);
    }

    // Check localhost (development)
    if (origin.startsWith('http://localhost') || origin.startsWith('https://localhost')) {
      return callback(null, true);
    }

    // Check subdomains of the configured DOMAIN
    const platformDomain = process.env.DOMAIN;
    if (platformDomain) {
      const domainRegex = new RegExp(`^https:\\/\\/[a-zA-Z0-9-]+\\.${platformDomain.replace(/\./g, '\\.')}$`);
      if (domainRegex.test(origin)) {
        return callback(null, true);
      }
    }

    // Check custom domain from environment variable
    // CUSTOM_DOMAIN can be a single domain or comma-separated list
    const customDomains = process.env.CUSTOM_DOMAIN ? process.env.CUSTOM_DOMAIN.split(',').map(d => d.trim()) : [];
    for (const domain of customDomains) {
      if (origin === `https://${domain}` || origin === `http://${domain}`) {
        return callback(null, true);
      }
    }

    console.warn(`CORS blocked origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,  // Allow cookies
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Platform', 'X-Client-Version', 'X-Signature', 'X-Timestamp', 'X-Device-Id', 'X-Client-Id', 'x-client-id', 'X-Mobile-Client', 'x-mobile-client', 'x-platform', 'x-device-id'],
  exposedHeaders: ['X-Session-ID', 'X-Auth-Status']
};

app.use(cors(corsOptions));

// Add middleware to generate CSP nonce for each request
app.use((req, res, next) => {
  // Generate a new random nonce value for each request
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

// Add security headers with helmet - STRICT CSP (no nonces, external files only)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      // Strict: only self and explicit external resources
      defaultSrc: ["'self'"],
      // Scripts: self only (all JS in external files)
      scriptSrc: ["'self'"],
      // Styles: self and unsafe-inline (needed for JS-set CSS custom properties)
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Images: self, data URIs, and explicit external hosts
      imgSrc: ["'self'", 'data:', 'https://placehold.co', 'https://*.cloudfront.net'],
      // Connections: self and AWS services
      connectSrc: ["'self'", 'https://*.amazonaws.com'],
      // Fonts: self only
      fontSrc: ["'self'"],
      // Block all plugins/objects
      objectSrc: ["'none'"],
      // Media: self only
      mediaSrc: ["'self'"],
      // Frames: self only
      frameSrc: ["'self'"],
      // Block inline event handlers
      'script-src-attr': ["'none'"],
      // Form submissions: self only
      formAction: ["'self'"],
      // Base URI: self only
      baseUri: ["'self'"],
      // Frame ancestors: none (prevent framing)
      frameAncestors: ["'none'"],
    },
  },
  xssFilter: true,
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: {
    maxAge: 15552000, // 180 days in seconds
    includeSubDomains: true,
    preload: true
  },
  frameguard: { action: 'deny' } // Prevent clickjacking
}));

// Middleware to restrict mobile-app.html access - only allow on org-specific ALB DNS or localhost
// The mobile app HTML is for native app development/testing only, not for production web access
app.use((req, res, next) => {
  if (req.path === '/mobile-app.html') {
    const hostname = req.hostname;

    // Allow on localhost/development
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';

    // Allow ONLY on org-specific ALB DNS (format: org-XXXXX-flask-dev.<domain>)
    // This public ALB DNS is used for testing/webhooks/development
    // Block on production domains (custom domains like myapp.<domain> or myapp.com)
    const platformDomain = process.env.DOMAIN;
    const isOrgALB = platformDomain && new RegExp(`^org-[a-zA-Z0-9]+-flask-dev\\.${platformDomain.replace(/\./g, '\\.')}$`).test(hostname);

    // Block on production domains
    if (!isLocalhost && !isOrgALB) {
      console.log(`[Security] Blocked mobile-app.html access from production domain: ${hostname}`);
      return res.status(404).send('Not Found');
    }

    console.log(`[Mobile] Serving mobile-app.html to ${hostname}`);
  }
  next();
});

// Serve static frontend files from the frontend/public directory
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

// Also serve static files from backend/public for MFA and other backend-specific assets
app.use(express.static(path.join(__dirname, 'public')));

// Serve mobile authentication page
app.get('/mobile-auth.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../mobile-auth.html'));
});

// Root health check endpoint for direct /health requests
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Index route moved to async initialization function after session is configured

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  if (req.xhr || req.path.startsWith('/api')) {
    res.status(500).json({
      success: false,
      error: 'Server Error',
      message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
  } else {
    res.status(500).render('error', {
      message: 'Server Error',
      error: process.env.NODE_ENV === 'development' ? err : {}
    });
  }
});

// Initialize database and configure session before setting up routes
(async () => {
  try {
    console.log('SERVER.JS: STARTING ASYNC IIFE');
    // Initialize database connection
    console.log('SERVER.JS: About to initialize database');
    await initializeDatabase();
    console.info('Database initialized successfully');
    console.log('SERVER.JS: Database initialized successfully (from server.js)');
    
    // Configure session with Redis store - MUST happen before routes
    console.log('SERVER.JS: About to configure session');
    const sessionConfigured = await configureSession(app, config.session.secret);

    // AdminJS has been removed - using custom admin panel instead
    if (!sessionConfigured) {
      console.error('Failed to configure session, application may not function correctly');
      process.exit(1);
    } else {
      console.info('Session middleware configured successfully');
      console.log('SERVER.JS: Session configured successfully (from server.js)');
    }
    
    // Add session debugging middleware
    app.use((req, res, next) => {
      // Check if session exists and if it contains our key identifiers
      if (!req.session) {
        // Skip warning on health check endpoint
        if (req.path !== '/api/health') {
          console.warn(`Session is undefined in request object for path: ${req.path}`);
        }
      } else {
        // Only log session info for non-health endpoints to reduce noise
        if (req.path !== '/api/health') {
          const sessionId = req.session.id || 'unknown';
          console.debug(`Request to ${req.path} using session ID: ${sessionId}`);
          
          // Add session timestamp to help with session expiration tracking
          req.session.lastAccessed = new Date().toISOString();
        }
      }
      next();
    });
    
    // Passport.js setup - initialize and configure session
    const passport = require('passport');
    const flash = require('connect-flash');
    const db = require('./models');
    const User = db.User;

    // Configure Passport Strategies
    const LocalStrategy = require('passport-local').Strategy;
    let GoogleStrategy = null;
    let googleOAuthConfigured = false;

    // Try to load Google OAuth credentials from ADDITIONAL_SECRETS
    let googleClientId, googleClientSecret;

    try {
      // Check if secretsManager exists
      const secretsPath = './services/secretsManager';
      if (require('fs').existsSync(path.join(__dirname, secretsPath + '.js'))) {
        const { getAdditionalSecrets } = require(secretsPath);

        try {
          let additionalSecrets = await getAdditionalSecrets();
          console.log('[OAuth] Additional secrets retrieved successfully');

          // Parse if string
          if (typeof additionalSecrets === 'string') {
            try {
              additionalSecrets = JSON.parse(additionalSecrets);
            } catch (parseError) {
              console.log('[OAuth] Could not parse additional secrets as JSON');
              additionalSecrets = {};
            }
          }

          // Extract Google OAuth credentials
          googleClientId = additionalSecrets?.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
          googleClientSecret = additionalSecrets?.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

          if (googleClientId && googleClientSecret) {
            console.log('[OAuth] Google OAuth credentials found in ADDITIONAL_SECRETS');
          }
        } catch (secretsError) {
          console.log('[OAuth] Could not retrieve ADDITIONAL_SECRETS:', secretsError.message);
        }
      }
    } catch (error) {
      console.log('[OAuth] secretsManager not available, checking environment variables');
    }

    // Fallback to environment variables if not in ADDITIONAL_SECRETS
    if (!googleClientId) {
      googleClientId = process.env.GOOGLE_CLIENT_ID;
      googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

      if (googleClientId && googleClientSecret) {
        console.log('[OAuth] Google OAuth credentials found in environment variables');
      }
    }

    // Configure Google OAuth if credentials are available
    if (googleClientId && googleClientSecret) {
      try {
        GoogleStrategy = require('passport-google-oauth20').Strategy;

        passport.use(new GoogleStrategy({
          clientID: googleClientId,
          clientSecret: googleClientSecret,
          callbackURL: "/auth/google/callback", // Default fallback, will be overridden dynamically
          // Use passport-oauth2's session-backed state store (instead of the
          // default NullStore, which never validates) to prevent login CSRF.
          state: true
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const googleEmail = profile.emails[0].value;
            console.log('[OAuth] Google authentication for:', googleEmail);

            // Check if user exists with this Google ID
            let user = await User.findOne({ where: { googleId: profile.id } });

            if (user) {
              console.log('[OAuth] Existing Google user found:', user.email);
              user.lastLogin = new Date();
              await user.save();
              return done(null, user);
            }

            // Check if user exists with this email
            user = await User.findOne({ where: { email: googleEmail } });

            if (user) {
              console.log('[OAuth] Linking Google account to existing user:', user.email);
              user.googleId = profile.id;
              user.emailVerified = true;
              user.lastLogin = new Date();

              if (!user.name || user.name.trim() === '') {
                user.name = profile.displayName || profile.name?.givenName || 'User';
              }

              await user.save();
              return done(null, user);
            }

            // Create new user from Google profile
            console.log('[OAuth] Creating new user from Google:', googleEmail);
            user = await User.create({
              googleId: profile.id,
              email: googleEmail,
              name: profile.displayName || profile.name?.givenName || 'User',
              emailVerified: true,
              lastLogin: new Date()
            });

            console.log('[OAuth] New Google user created successfully');
            return done(null, user);
          } catch (error) {
            console.error('[OAuth] Error in Google strategy:', error);
            return done(error, null);
          }
        }));

        googleOAuthConfigured = true;
        console.log('[OAuth] ✅ Google OAuth strategy configured successfully');
      } catch (strategyError) {
        console.log('[OAuth] Could not configure Google OAuth strategy:', strategyError.message);
        console.log('[OAuth] Google sign-in will be disabled');
      }
    } else {
      console.log('[OAuth] ⚠️  Google OAuth not configured - missing credentials');
      console.log('[OAuth] To enable Google sign-in, add to ADDITIONAL_SECRETS:');
      console.log('[OAuth]   {');
      console.log('[OAuth]     "GOOGLE_CLIENT_ID": "your-client-id.apps.googleusercontent.com",');
      console.log('[OAuth]     "GOOGLE_CLIENT_SECRET": "your-client-secret"');
      console.log('[OAuth]   }');
      console.log('[OAuth] Or set as environment variables: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    }

    // Make Google OAuth status available globally
    app.locals.googleOAuthEnabled = googleOAuthConfigured;

    app.use(passport.initialize());
    app.use(passport.session());
    app.use(flash());

    // Debug logging for authentication and MFA status.
    // Only installed outside production: the Cookie header and the raw session
    // ID are bearer credentials and must never be logged. We log a
    // non-reversible fingerprint of the session ID instead.
    if (process.env.NODE_ENV !== 'production') {
      app.use((req, res, next) => {
        const sessionId = req.session?.id;
        const sessionFingerprint = sessionId
          ? crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
          : 'none';
        console.log(`${req.method} ${req.path} | Auth: ${req.isAuthenticated ? req.isAuthenticated() : false} | MFA: ${req.session?.mfaVerified || false} | Session fingerprint: ${sessionFingerprint}`);
        next();
      });
    }

    // Global authentication check middleware
    app.use((req, res, next) => {
      // Paths that don't require authentication
      const publicPaths = [
        '/',                    // Landing page (builder interface)
        '/mobile-builder.html', // Mobile builder (same as landing)
        '/mobile-app.html',     // Legacy mobile app
        '/auth/login',
        '/auth/signup',
        '/auth/verify-email',
        '/auth/resend-verification',
        '/auth/forgot-password',
        '/auth/reset-password', // Add reset-password to public paths
        '/auth/magic-link',     // Magic link authentication
        '/auth/mfa-verify',     // MFA verification (accessed during login flow)
        '/auth/mfa-setup',      // MFA setup (accessed during login flow)
        '/auth/mfa-backup-codes', // MFA backup codes (accessed after setup)
        '/auth/send-mfa-code',  // Send MFA code via email
        '/auth/google',         // Google OAuth initiation
        '/auth/google/callback', // Google OAuth callback
        '/mobile/auth',         // Mobile app authentication endpoints
        '/static',
        '/favicon.ico',
        '/health',
        '/api', // allow API info endpoints
        '/api/health', // allow API health endpoint
        '/admin-panel',     // custom admin panel
      ];

      // Check if the current path starts with any public path
      const isPublicPath = publicPaths.some(path =>
        req.path === path || req.path.startsWith(`${path}/`)
      );

      if (isPublicPath) {
        return next();
      }

      // Check authentication for non-public paths
      if (!req.isAuthenticated || !req.isAuthenticated()) {
        // If AJAX request, return 401
        if (req.xhr || req.headers.accept === 'application/json') {
          return res.status(401).json({ error: 'Authentication required' });
        }
        // Otherwise redirect to login
        return res.redirect('/auth/login');
      }

      // MFA is OPTIONAL - users can enable it from account settings
      // Skip MFA enforcement for:
      // - OAuth logins (Google, GitHub) - trust their MFA
      // - Magic link logins - email verification is sufficient
      // - Users who haven't enabled MFA
      const loginMethod = req.session.loginMethod;
      const skipMfaEnforcement =
        loginMethod === 'oauth' ||
        loginMethod === 'magic_link' ||
        req.session.mfaVerified === true;

      // MFA is optional - only log for debugging, don't enforce
      if (req.user && req.user.mfaEnabled && !skipMfaEnforcement) {
        console.log(`[MFA] User ${req.user.email} has MFA enabled but session not verified - allowing anyway (MFA is optional)`);
      }

      next();
    });

    // Passport serialize/deserialize
    passport.serializeUser((user, done) => {
      console.log(`Serializing user ID: ${user.id} with session ID: ${user._sessionID || 'unknown'}`);
      done(null, user.id);
    });
    passport.deserializeUser(async (id, done) => {
      try {
        const user = await User.findByPk(id);
        if (!user) {
          console.log(`User with ID ${id} not found during deserialization`);
          return done(null, false);
        }
        console.log(`Deserialized user ID: ${id}`);
        return done(null, user);
      } catch (err) {
        console.error('Error deserializing user:', err);
        return done(err, null);
      }
    });

    // Make user data available in templates - AFTER session is configured
    app.use((req, res, next) => {
      res.locals.user = req.user || null;
      res.locals.title = 'Bedrock Express AI Chat';
      res.locals.sessionId = req.session ? req.session.id : 'no-session';
      next();
    });
    
    // Add a middleware to preserve conversation history in the session
    app.use((req, res, next) => {
      // Initialize conversations array if it doesn't exist
      if (!req.session.conversations) {
        req.session.conversations = [];
      }
      next();
    });
    
    // Now that session is configured, set up routes
    app.use('/api', apiRoutes);

    // Sites API Routes - for DevOpser Lite website builder
    app.use('/api/sites', sitesRoutes);

    // Images API Routes - for site image uploads (nested under sites)
    app.use('/api/sites', imagesRoutes);

    // Preview Routes - anonymous preview generation (no auth required)
    app.use('/api/preview', previewRoutes);

    // Leads API Routes - for capturing leads from deployed customer sites
    app.use('/api/leads', leadsRoutes);

    // API Keys Routes - for managing programmatic access
    app.use('/api/api-keys', apiKeysRoutes);

    // Auth Routes - for authentication functionality
    app.use('/auth', authRoutes);

    // Mobile Auth Routes - for mobile app authentication
    app.use('/mobile/auth', mobileAuthRoutes);

    // Account page route - needs to be at root level
    app.get('/account', (req, res) => {
      // Ensure user is authenticated and MFA verified
      if (!req.isAuthenticated() || !req.session.mfaVerified) {
        req.session.returnTo = '/account';
        return res.redirect('/auth/login');
      }

      // Get current user
      const user = req.user;

      // Render account settings page
      res.render('account', {
        user: user,
        title: 'Account Settings',
        error: req.flash('error'),
        message: req.flash('message'),
        csrfToken: req.csrfToken ? req.csrfToken() : ''
      });
    });

    // Delete account route
    app.post('/account/delete', async (req, res) => {
      // Ensure user is authenticated and MFA verified
      if (!req.isAuthenticated() || !req.session.mfaVerified) {
        return res.redirect('/auth/login');
      }

      const userId = req.user.id;
      console.log(`[Account] Starting account deletion for user ${userId}`);

      try {
        // Fetch the full user object
        const user = await db.User.findByPk(userId);
        if (!user) {
          req.flash('error', 'User not found');
          return res.redirect('/account');
        }

        // Step 1: Tear down any per-user deployment infrastructure here.
        // The original template shipped a Lightsail/AWS-account provisioning
        // flow that's been removed; configure your own teardown (or leave
        // empty) based on the deployment target chosen from AGENTS.md.
        if (user.awsAccountId) {
          console.log(`[Account] Skipping per-user cleanup for account ${user.awsAccountId} — not configured in this template`);
        }

        // Step 2: Deactivate all user's sites (set to draft and clear published config)
        const sites = await db.Site.findAll({ where: { userId } });
        console.log(`[Account] Deactivating ${sites.length} sites`);

        for (const site of sites) {
          await site.update({
            status: 'draft',
            deploymentStatus: 'none',
            publishedConfig: null,
            lightsailUrl: null
          });
        }

        // Step 3: Delete all leads for the user's sites
        const siteIds = sites.map(s => s.id);
        if (siteIds.length > 0) {
          const leadsDeleted = await db.Lead.destroy({ where: { siteId: siteIds } });
          console.log(`[Account] Deleted ${leadsDeleted} leads`);
        }

        // Step 4: Delete all API keys
        const apiKeysDeleted = await db.ApiKey.destroy({ where: { userId } });
        console.log(`[Account] Deleted ${apiKeysDeleted} API keys`);

        // Step 5: Anonymize the user record (keep for audit trail, remove PII)
        const deletedEmail = `deleted-${userId}-${Date.now()}@deleted.local`;
        await user.update({
          email: deletedEmail,
          name: 'Deleted User',
          googleId: null,
          profilePicture: null,
          mfaSecret: null,
          mfaEnabled: false,
          awsAccountStatus: 'closed'
        });

        console.log(`[Account] User ${userId} account deleted successfully`);

        // Step 6: Log out and destroy session
        req.logout(function(err) {
          if (err) {
            console.error('[Account] Logout error:', err);
          }
          req.session.destroy(function(err) {
            if (err) {
              console.error('[Account] Session destroy error:', err);
            }
            // Redirect to homepage with a message
            res.redirect('/?deleted=1');
          });
        });

      } catch (error) {
        console.error(`[Account] Error deleting account for user ${userId}:`, error);
        req.flash('error', 'Failed to delete account. Please try again or contact support.');
        res.redirect('/account');
      }
    });

    // Add body-parser middleware (moved from after AdminJS setup)
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    console.log('Body-parser middleware configured');
    
    // Admin Routes - for accessing admin functionality
    app.use('/admin-access', adminRoutes);
    
    // Custom Admin Panel Routes - secure replacement for AdminJS
    app.use('/admin-panel', adminPanelRoutes);
    
    // Chat Routes - specifically for chat functionality
    app.use('/', chatRoutes);

    // DevOpser Lite Routes - Sites Dashboard and Builder
    app.get('/sites', async (req, res) => {
      if (!req.isAuthenticated()) {
        return res.redirect('/auth/login');
      }
      try {
        const sites = await db.Site.findAll({
          where: { userId: req.user.id },
          order: [['created_at', 'DESC']]
        });
        res.render('sites-dashboard', {
          user: req.user,
          sites: sites.map(s => s.toPublicJSON()),
          cspNonce: res.locals.cspNonce
        });
      } catch (error) {
        console.error('[Sites] Error loading dashboard:', error);
        res.status(500).render('error', { message: 'Failed to load sites' });
      }
    });

    app.get('/sites/:id/builder', async (req, res) => {
      if (!req.isAuthenticated()) {
        return res.redirect('/auth/login');
      }
      try {
        const site = await db.Site.findOne({
          where: { id: req.params.id, userId: req.user.id }
        });
        if (!site) {
          return res.status(404).render('error', { message: 'Site not found' });
        }
        res.render('builder', {
          user: req.user,
          site: site.toPublicJSON(),
          cspNonce: res.locals.cspNonce
        });
      } catch (error) {
        console.error('[Sites] Error loading builder:', error);
        res.status(500).render('error', { message: 'Failed to load builder' });
      }
    });
    

    
    // Clear old Redis cache on startup
    await redisClient.clearOldCache();

    // Deployment-target bootstrap would go here. The original template
    // shipped a CloudFormation StackSet that pushed a trust role into
    // customer AWS accounts at startup; see AGENTS.md for guidance on
    // picking a deployment target and wiring bootstrap logic here.

    // Start the server
    const PORT = config.port || 8000;
    const HOST = config.host || 'localhost';

    // Log all registered endpoints for verification
    console.log('🚀 Endpoints:\n', listEndpoints(app));
    
    app.listen(PORT, HOST, () => {
      console.log(`Server running on http://${HOST}:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();

module.exports = app;
