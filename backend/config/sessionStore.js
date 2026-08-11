/**
 * Redis Session Store Configuration
 * Provides a properly configured Redis session store for Express
 */
const session = require('express-session');
const redis = require('redis');
const connectRedis = require('connect-redis');
const config = require('./index');

/**
 * Initialize Redis session store
 * @returns {Object} Configured Redis session store
 */
async function createSessionStore() {
  try {
    // Create a new Redis client specifically for session storage
    const redisClient = redis.createClient({
      url: config.redis.url,
      legacyMode: true  // Important for connect-redis v6.1.3 compatibility
    });

    // Set up event handlers
    redisClient.on('error', (err) => {
      console.error(`Redis session store client error: ${err.message}`);
    });

    redisClient.on('connect', () => {
      console.info('Redis session store client connected');
    });

    // Connect to Redis - must be done before creating the store
    await redisClient.connect();
    
    // Create the RedisStore with the legacy mode client
    const RedisStore = connectRedis(session);
    
    const redisStore = new RedisStore({
      client: redisClient,
      prefix: `session:${config.cache.version}:`,
      ttl: 86400 // 1 day in seconds
    });

    console.info('Redis session store initialized successfully');
    return redisStore;
  } catch (error) {
    console.error(`Failed to initialize Redis session store: ${error.message}`);
    console.warn('Falling back to in-memory session store');
    return null;
  }
}

/**
 * Configure session middleware
 * @param {Object} app - Express app instance
 * @param {string} secret - Session secret
 */
async function configureSession(app, secret) {
  try {
    // Initialize Redis store
    const store = await createSessionStore();

    // Set up trust proxy for ALB/ELB headers when in production
    if (process.env.NODE_ENV === 'production') {
      console.info('Setting up trust proxy for production environment');
      app.set('trust proxy', 1); // Trust first proxy (ALB)
    }

    // Configure session middleware with sticky session support
    const sessionConfig = {
      secret: secret,
      name: config.session.cookieName,
      resave: false,
      saveUninitialized: true, // Changed to true to ensure session is created on first visit
      rolling: true, // Force a cookie set on every response to extend the session lifetime
      proxy: process.env.NODE_ENV === 'production', // Trust the reverse proxy when in production
      // Always generate a fresh session ID. Reusing req.sessionID would defeat
      // Passport's regenerate-at-login and enable session fixation. Do not log
      // the ID (it is a bearer credential).
      genid: function(req) {
        const { v4: uuidv4 } = require('uuid');
        return uuidv4();
      },
      cookie: {
        secure: config.session.cookie.secure,
        httpOnly: true,
        maxAge: config.session.cookie.maxAge, // Use the value from config
        sameSite: config.session.cookie.sameSite || 'lax',
        path: config.session.cookie.path // Required for __Host- prefix
      }
    };
    
    console.log(`Session cookie configuration: ${JSON.stringify({
      name: sessionConfig.name,
      secure: sessionConfig.cookie.secure,
      sameSite: sessionConfig.cookie.sameSite,
      path: sessionConfig.cookie.path,
      httpOnly: sessionConfig.cookie.httpOnly
    })}`);
    

    // Add store if Redis connection successful
    if (store) {
      sessionConfig.store = store;
      console.info('Using Redis for session storage');
      console.info(`Session prefix: session:${config.cache.version}:`);
    } else {
      console.warn('Using in-memory session store. This is not suitable for production.');
    }

    // Apply session middleware
    app.use(session(sessionConfig));
    
    // Add middleware to ensure session is saved before redirects
    const originalRedirect = app.response.redirect;
    app.response.redirect = function (url) {
      const req = this.req;
      const res = this;
      if (req.session) {
        console.log(`Saving session ${req.session.id} before redirect to ${url}`);
        req.session.save((err) => {
          if (err) {
            console.error('Error saving session before redirect:', err);
          }
          originalRedirect.call(res, url);
        });
      } else {
        originalRedirect.call(res, url);
      }
    };
    
    return true;
  } catch (error) {
    console.error(`Failed to configure session: ${error.message}`);
    return false;
  }
}

module.exports = { configureSession };
