const express = require('express');
const router = express.Router();
const passport = require('passport');
// Passport is initialized and session is used in server.js, not here.
const db = require('../models');
const { Op } = require('sequelize');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const redisClient = require('../services/redisClient');
const qrcode = require('qrcode');
const speakeasy = require('speakeasy');
const url = require('url');

/**
 * Post-login hook for any per-user infrastructure provisioning your
 * deployment target needs (e.g. spinning up a tenant namespace, seeding
 * per-user resources, bootstrapping a cross-account role). The original
 * template fired off a managed-hosting AWS-account provisioning flow here;
 * that has been removed. See AGENTS.md for patterns on how to wire up a
 * replacement for the target you pick.
 */
function triggerAWSAccountProvisioning(user) {
  console.log(`[Auth] Post-login provisioning hook not configured for user ${user.id} — see AGENTS.md`);
}

// Ensure database is initialized before accessing models
async function ensureDatabaseInitialized() {
  if (process.env.NODE_ENV === 'production' && typeof db.initializeDatabase === 'function') {
    console.log('Ensuring database is initialized before accessing models');
    await db.initializeDatabase();
  }
  return db.User;
}

// Add local body-parser middleware for auth routes
// This is needed because the global body-parser is added after AdminJS setup
router.use(express.json());
router.use(express.urlencoded({ extended: false }));

// GET /auth/login
router.get('/login', (req, res) => {
  // Render login page with flash messages if available
  const message = req.flash('message') || req.query.message;
  const error = req.flash('error') || req.query.error;

  res.render('login', {
    error: error,
    message: message,
    googleOAuthEnabled: req.app.locals.googleOAuthEnabled || false
  });
});

// ============================================
// Magic Link Authentication Routes
// ============================================

// POST /auth/magic-link/request - Request a magic link code via email
router.post('/magic-link/request', [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Please enter a valid email address'
      });
    }

    const { email } = req.body;

    // Rate limiting - 1 code per email every 60 seconds
    const rateLimitKey = `magic_link_limit:${email}`;
    const lastSent = await redisClient.client.get(rateLimitKey);

    if (lastSent) {
      const timeSinceLastSent = Date.now() - parseInt(lastSent);
      if (timeSinceLastSent < 60000) {
        return res.status(429).json({
          success: false,
          error: `Please wait ${Math.ceil((60000 - timeSinceLastSent) / 1000)} seconds before requesting another code`
        });
      }
    }

    // Generate random 6-digit code
    const code = crypto.randomInt(100000, 999999).toString();
    console.log(`[Magic Link] Generated new code for ${email}`);

    // Clean up any old "used" keys for this email to prevent conflicts
    const oldUsedPattern = `magic_link_used:${email}:*`;
    const oldUsedKeys = await redisClient.client.keys(oldUsedPattern);
    if (oldUsedKeys && oldUsedKeys.length > 0) {
      console.log(`[Magic Link] Cleaning up ${oldUsedKeys.length} old used codes for ${email}`);
      await redisClient.client.del(oldUsedKeys);
    }

    // Store code in Redis with 10-minute expiry
    const codeKey = `magic_link_code:${email}`;
    await redisClient.client.setEx(codeKey, 600, code);
    console.log(`[Magic Link] Stored code in Redis at key: ${codeKey}`);

    // Set rate limit
    await redisClient.client.setEx(rateLimitKey, 60, Date.now().toString());

    // Get base URL for verification link (config-derived, never request headers)
    const baseUrl = canonicalBaseUrl();
    const verificationUrl = `${baseUrl}/auth/magic-link/auto-verify?email=${encodeURIComponent(email)}&code=${code}`;

    // Send email with code
    try {
      await sendEmail({
        to: email,
        subject: 'Your verification code',
        text: `
Your Verification Code

Click this link to sign in:
${verificationUrl}

Or enter this code manually: ${code}

This code will expire in 10 minutes.

If you didn't request this code, you can safely ignore this email.
        `.trim(),
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f4;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 0;">
        <table role="presentation" style="max-width: 600px; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background: #446df6; padding: 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Bedrock Express AI</h1>
            </td>
          </tr>

          <!-- Main content -->
          <tr>
            <td style="padding: 40px 30px;">
              <h2 style="color: #333; margin: 0 0 20px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Your Verification Code</h2>
              <p style="color: #666; font-size: 16px; line-height: 24px; margin: 0 0 30px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Click the button below to securely sign in:</p>

              <!-- CTA Button -->
              <table role="presentation" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background: #446df6;">
                    <a href="${verificationUrl}" style="display: inline-block; padding: 14px 32px; color: white; text-decoration: none; font-weight: 500; font-size: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Verify Your Email</a>
                  </td>
                </tr>
              </table>

              <!-- Divider -->
              <table role="presentation" style="width: 100%; margin: 30px 0;">
                <tr>
                  <td style="border-bottom: 1px solid #e0e0e0;"></td>
                </tr>
              </table>

              <!-- Manual code entry -->
              <p style="color: #666; font-size: 14px; text-align: center; margin: 20px 0 10px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Or enter this code manually:</p>
              <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin: 10px 0 20px 0;">
                <span style="font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #446df6; font-family: 'Courier New', monospace;">${code}</span>
              </div>

              <p style="color: #999; font-size: 14px; line-height: 20px; margin: 20px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">This code will expire in 10 minutes.</p>
              <p style="color: #999; font-size: 14px; line-height: 20px; margin: 10px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">If you didn't request this code, you can safely ignore this email.</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #f9f9f9; padding: 20px 30px; border-top: 1px solid #e0e0e0;">
              <p style="color: #999; font-size: 12px; line-height: 18px; margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center;">
                This is an automated message from Bedrock Express AI
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
        `.trim()
      });

      console.log(`Magic link code sent to ${email}`);

      return res.json({
        success: true,
        message: 'Verification code sent! Check your email.'
      });
    } catch (emailError) {
      console.error('Failed to send magic link email:', emailError);
      return res.status(500).json({
        success: false,
        error: 'Failed to send email. Please try again.'
      });
    }
  } catch (error) {
    console.error('Magic link request error:', error);
    return res.status(500).json({
      success: false,
      error: 'An error occurred. Please try again.'
    });
  }
});

// POST /auth/magic-link/verify - Verify code and login/create user
router.post('/magic-link/verify', [
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min: 6, max: 6 }).isNumeric()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email or code format'
      });
    }

    const { email, code, name } = req.body;
    console.log(`[Magic Link] Verification attempt for ${email}`);

    // Retrieve code from Redis
    const codeKey = `magic_link_code:${email}`;
    const storedCode = await redisClient.client.get(codeKey);

    if (!storedCode) {
      console.log(`[Magic Link] No stored code found for ${email} at key: ${codeKey}`);
      return res.status(401).json({
        success: false,
        error: 'Code expired or invalid. Please request a new one.'
      });
    }

    if (storedCode !== code) {
      console.log(`[Magic Link] Code mismatch for ${email}`);
      return res.status(401).json({
        success: false,
        error: 'Incorrect code. Please try again.'
      });
    }

    // Check if code has already been used
    const usedKey = `magic_link_used:${email}:${code}`;
    const wasUsed = await redisClient.client.get(usedKey);

    if (wasUsed) {
      console.log(`[Magic Link] Code for ${email} was already used`);
      return res.status(401).json({
        success: false,
        error: 'This verification code has already been used. Please request a new code.'
      });
    }

    // Mark code as used (keep for 5 minutes to prevent reuse)
    await redisClient.client.setEx(usedKey, 300, '1');
    console.log(`[Magic Link] Marked code as used for ${email}`);

    // Delete the original code now that it's marked as used
    await redisClient.client.del(codeKey);
    console.log(`[Magic Link] Deleted original code from Redis for ${email}`);

    // Find or create user
    const User = await ensureDatabaseInitialized();
    let user = await User.findOne({ where: { email } });

    if (!user) {
      // Create new user
      user = await User.create({
        email,
        name: name || email.split('@')[0],
        emailVerified: true, // Email verified via code
        lastLogin: new Date()
      });
      console.log(`New user created via magic link: ${email}`);
    } else {
      // Update existing user
      user.emailVerified = true;
      user.lastLogin = new Date();
      await user.save();
      console.log(`Existing user logged in via magic link: ${email}`);
    }

    // Magic link login is treated like OAuth - email verification is sufficient
    // MFA is optional and only enforced when user explicitly chooses to verify
    console.log(`Magic link login - User ${user.email} - logging in directly (magic link bypasses MFA like OAuth)`);

    // Log user in directly - magic link already proves email access
    req.login(user, async (err) => {
      if (err) {
        console.error('Login error:', err);
        return res.status(500).json({
          success: false,
          error: 'Authentication failed'
        });
      }

      // Set session properties - mark MFA as verified since magic link is sufficient
      req.session.mfaVerified = true;
      req.session.loginMethod = 'magic_link'; // Track login method

      // Trigger AWS account provisioning in background (non-blocking)
      triggerAWSAccountProvisioning(user);

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);

        return res.json({
          success: true,
          message: 'Sign-in successful!',
          redirect: '/'
        });
      });
    });

  } catch (error) {
    console.error('Magic link verify error:', error);
    return res.status(500).json({
      success: false,
      error: 'An error occurred. Please try again.'
    });
  }
});

// GET /auth/magic-link/auto-verify - Render a same-origin confirmation page.
// SECURITY (login CSRF): a bare top-level GET that establishes a session is
// login CSRF under SameSite=Lax. An attacker could force a victim's browser to
// follow a link and silently sign them into the attacker's account (or use the
// victim's own emailed link to pin their session). So this GET NEVER logs anyone
// in and has NO side effects on the stored code: it only renders a confirmation
// page carrying a one-time, session-bound nonce. The login is completed by the
// POST handler below, which requires that nonce and rejects cross-site requests.
router.get('/magic-link/auto-verify', async (req, res) => {
  // CRITICAL: Don't process HEAD requests - these are pre-flight checks from email clients
  // Email clients (Outlook, Gmail, etc.) send HEAD requests to verify links before the user clicks
  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  try {
    const { email, code } = req.query;

    // Validate parameters
    if (!email || !code) {
      req.flash('error', 'Invalid or missing verification link parameters.');
      return res.redirect('/auth/login');
    }

    // Normalize email
    const normalizedEmail = String(email).toLowerCase().trim();

    // If user is already logged in as the same account, just redirect to landing
    if (req.isAuthenticated() && req.user && req.user.email === normalizedEmail) {
      console.log(`User ${normalizedEmail} is already logged in, redirecting to landing`);
      return res.redirect('/');
    }

    // Validate code format
    if (typeof code !== 'string' || code.length !== 6 || !/^\d{6}$/.test(code)) {
      req.flash('error', 'Invalid verification code format.');
      return res.redirect('/auth/login');
    }

    // Bind a one-time nonce to this session. The code is neither validated nor
    // consumed here, so email-client prefetches cannot burn it.
    const nonce = crypto.randomBytes(32).toString('hex');
    req.session.magicLinkConfirm = {
      nonce,
      email: normalizedEmail,
      code,
      createdAt: Date.now()
    };

    // Persist the nonce before rendering the confirmation page.
    return req.session.save((saveErr) => {
      if (saveErr) {
        console.error('[Magic Link] Session save error before confirmation page:', saveErr);
        req.flash('error', 'An error occurred. Please try again.');
        return res.redirect('/auth/login');
      }

      const safeEmail = escapeHtml(normalizedEmail);
      const safeNonce = escapeHtml(nonce);
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="same-origin">
  <title>Confirm sign-in</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f4f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .card { max-width: 440px; margin: 60px auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); overflow: hidden; }
    .card h1 { background: #446df6; color: #fff; margin: 0; padding: 24px 30px; font-size: 20px; }
    .card .body { padding: 30px; color: #333; }
    .card p { color: #555; font-size: 15px; line-height: 22px; margin: 0 0 8px 0; }
    .card button { margin-top: 12px; padding: 14px 32px; border: 0; border-radius: 6px; background: #446df6; color: #fff; font-size: 16px; font-weight: 500; cursor: pointer; }
    .card .email { font-weight: 600; color: #333; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Confirm sign-in</h1>
    <div class="body">
      <p>Click the button below to finish signing in as <span class="email">${safeEmail}</span>.</p>
      <form method="POST" action="/auth/magic-link/auto-verify">
        <input type="hidden" name="nonce" value="${safeNonce}">
        <button type="submit">Sign in</button>
      </form>
    </div>
  </div>
</body>
</html>`);
    });

  } catch (error) {
    console.error('Magic link auto-verify error:', error);
    req.flash('error', 'An error occurred. Please try again.');
    return res.redirect('/auth/login');
  }
});

// POST /auth/magic-link/auto-verify - Complete the login started by the GET
// confirmation page. This is the ONLY place the emailed code is consumed and the
// session established. It requires the session-bound nonce and rejects cross-site
// submissions, which together defeat login CSRF under SameSite=Lax.
router.post('/magic-link/auto-verify', async (req, res) => {
  try {
    // Reject cross-site form submissions where the browser tells us the origin.
    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite === 'cross-site') {
      console.warn('[Magic Link] Rejected cross-site auto-verify POST');
      req.flash('error', 'Sign-in request could not be verified. Please try again.');
      return res.redirect('/auth/login');
    }

    const confirm = req.session.magicLinkConfirm;
    if (!confirm || !confirm.nonce || !confirm.email || !confirm.code) {
      req.flash('error', 'Sign-in session expired. Please request a new code.');
      return res.redirect('/auth/login');
    }

    // Validate the one-time nonce in constant time, then consume it.
    const submittedNonce = typeof req.body.nonce === 'string' ? req.body.nonce : '';
    const expectedNonce = confirm.nonce;
    const nonceOk =
      submittedNonce.length === expectedNonce.length &&
      crypto.timingSafeEqual(Buffer.from(submittedNonce), Buffer.from(expectedNonce));

    // One-time use: clear regardless of the match outcome.
    delete req.session.magicLinkConfirm;

    if (!nonceOk) {
      console.warn('[Magic Link] Rejected auto-verify POST with invalid nonce');
      req.flash('error', 'Sign-in request could not be verified. Please try again.');
      return res.redirect('/auth/login');
    }

    const normalizedEmail = confirm.email;
    const code = confirm.code;

    // Retrieve code from Redis
    const codeKey = `magic_link_code:${normalizedEmail}`;
    const storedCode = await redisClient.client.get(codeKey);

    if (!storedCode) {
      req.flash('error', 'Verification code expired or invalid. Please request a new one.');
      return res.redirect('/auth/login');
    }

    if (storedCode !== code) {
      req.flash('error', 'Incorrect verification code.');
      return res.redirect('/auth/login');
    }

    // Check if code has already been used
    const usedKey = `magic_link_used:${normalizedEmail}:${code}`;
    const wasUsed = await redisClient.client.get(usedKey);

    if (wasUsed) {
      req.flash('error', 'This verification link has already been used. Please request a new code.');
      return res.redirect('/auth/login');
    }

    // Mark code as used (keep for 5 minutes to prevent reuse)
    await redisClient.client.setEx(usedKey, 300, '1');

    // Delete the original code now that it's marked as used
    await redisClient.client.del(codeKey);

    // Find or create user
    const User = await ensureDatabaseInitialized();
    let user = await User.findOne({ where: { email: normalizedEmail } });

    if (!user) {
      // Create new user
      user = await User.create({
        email: normalizedEmail,
        name: normalizedEmail.split('@')[0],
        emailVerified: true,
        lastLogin: new Date()
      });
      console.log(`New user created via magic link auto-verify: ${normalizedEmail}`);
    } else {
      // Update existing user
      user.emailVerified = true;
      user.lastLogin = new Date();
      await user.save();
      console.log(`Existing user logged in via magic link auto-verify: ${normalizedEmail}`);
    }

    // Magic link login is treated like OAuth - email verification is sufficient
    // MFA is optional and only enforced when user explicitly chooses to verify
    console.log(`Magic link auto-verify - User ${user.email} - logging in directly (magic link bypasses MFA like OAuth)`);

    // Log user in directly - magic link already proves email access
    req.login(user, async (err) => {
      if (err) {
        console.error('Login error:', err);
        req.flash('error', 'Authentication failed. Please try again.');
        return res.redirect('/auth/login');
      }

      console.log(`[MAGIC LINK] User ${user.email} logged in successfully, session ID: ${req.session.id}`);

      // Set session properties - mark MFA as verified since magic link is sufficient
      req.session.mfaVerified = true;
      req.session.loginMethod = 'magic_link'; // Track login method

      // Trigger AWS account provisioning in background (non-blocking)
      triggerAWSAccountProvisioning(user);

      // CRITICAL: Save session before redirect to ensure cookie is set
      return req.session.save((saveErr) => {
        if (saveErr) {
          console.error(`[MAGIC LINK] Session save error for ${user.email}:`, saveErr);
          req.flash('error', 'Login succeeded but session error occurred. Please try logging in again.');
          return res.redirect('/auth/login');
        }

        console.log(`[MAGIC LINK] Session saved successfully for ${user.email}, session ID: ${req.session.id}, redirecting to landing page`);
        return res.redirect('/');
      });
    });

  } catch (error) {
    console.error('Magic link auto-verify (POST) error:', error);
    req.flash('error', 'An error occurred. Please try again.');
    return res.redirect('/auth/login');
  }
});

// GET /auth/signup
router.get('/signup', (req, res) => {
  // Render signup page
  res.render('signup', {
    error: req.query.error,
    message: req.query.message,
    googleOAuthEnabled: req.app.locals.googleOAuthEnabled || false
  });
});

// Import email service for sending verification emails
const { sendEmail } = require('../services/emailService');

/**
 * Compute the canonical base URL for this deployment WITHOUT reading any
 * request headers. Trusting x-forwarded-host / host / hostname from the request
 * let an attacker inject an arbitrary host into emailed magic links, so the
 * sign-in code could be delivered to a link pointing at a host they control
 * (account takeover). We therefore derive the base URL solely from trusted
 * server configuration and fail closed in production if none is set.
 * @returns {String} - Base URL including protocol and host, no trailing slash
 */
function canonicalBaseUrl() {
  if (process.env.SITE_BASE_URL) {
    return process.env.SITE_BASE_URL.replace(/\/+$/, '');
  }
  if (process.env.CUSTOM_DOMAIN) {
    return 'https://' + process.env.CUSTOM_DOMAIN.split(',')[0].trim();
  }
  // Fail closed: never guess a host (or fall back to localhost) in production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('canonicalBaseUrl: SITE_BASE_URL or CUSTOM_DOMAIN must be set in production');
  }
  return `http://localhost:${process.env.PORT || 8000}`;
}

/**
 * Generate a full URL for the given path. Thin wrapper kept so existing call
 * sites keep working, but it NEVER trusts request headers: the host always
 * comes from canonicalBaseUrl(). The req argument is retained only for
 * signature compatibility and is intentionally ignored.
 * @param {Object} req - Express request object (unused)
 * @param {String} path - URL path (should start with /)
 * @returns {String} - Full URL including protocol and host
 */
function getFullUrl(req, path) {
  return url.resolve(canonicalBaseUrl() + '/', path);
}

/**
 * Validate an untrusted returnTo value so it can only ever redirect within this
 * origin. Accepts same-origin absolute paths only; rejects absolute URLs,
 * protocol-relative URLs ('//evil.com'), backslash bypasses ('/\\evil.com'),
 * and control characters. Returns the safe path or null.
 * @param {*} candidate - Untrusted value (typically req.query.returnTo)
 * @returns {String|null}
 */
function safeReturnTo(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return null;
  }
  // Must be a same-origin absolute path.
  if (candidate[0] !== '/') {
    return null;
  }
  // Reject protocol-relative ('//host') and backslash-based bypasses.
  if (candidate[1] === '/' || candidate[1] === '\\') {
    return null;
  }
  // Reject control characters (newlines, tabs, NUL, etc.).
  if (/[\x00-\x1f\x7f]/.test(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Minimal HTML-attribute escaper for values interpolated into the magic-link
 * confirmation page. Prevents the email/code query values from breaking out of
 * the hidden input attributes.
 * @param {*} value
 * @returns {String}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// GET /auth/mfa-setup - Display MFA setup page
router.get('/mfa-setup', async (req, res, next) => {
  try {
    const userId = req.session.mfaUserId;
    if (!userId) return res.redirect('/auth/login');
    
    // Ensure database is initialized and get User model
    const User = await ensureDatabaseInitialized();
    
    const user = await User.findByPk(userId);
    if (!user) return res.redirect('/auth/login');
    if (user.mfaEnabled) return res.redirect('/auth/mfa-verify');
    
    // Only generate the secret if it doesn't exist yet
    if (!user.mfaSecret) {
      user.generateMfaSecret();
      await user.save();
      console.log('Generated new MFA secret for setup for user id:', user.id);
    }
    const otpauthUrl = user.getMfaUri();
    console.log('Generated otpauth URL for user id:', user.id);
    
    // Generate QR code with specific options to prevent double scanning
    const qr = await qrcode.toDataURL(otpauthUrl, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      margin: 1,
      scale: 4
    });
    
    const csrfToken = req.csrfToken ? req.csrfToken() : '';
    console.log('Rendering MFA setup page');
    return res.render('mfa_setup', { qr, secret: user.mfaSecret, csrfToken });
  } catch (err) { next(err); }
});

// MFA Setup - POST (verify code)
router.post('/mfa-setup', async (req, res, next) => {
  console.log('POST /mfa-setup handler entered');
  try {
    // Support both flows: during login (mfaUserId) and from account page (authenticated user)
    let user;

    if (req.isAuthenticated()) {
      // User is setting up MFA from account page
      console.log('Setting up MFA for authenticated user:', req.user.email);
      user = req.user;
    } else if (req.session.mfaUserId) {
      // User is setting up MFA during login flow
      console.log('Setting up MFA during login flow');
      const userId = req.session.mfaUserId;
      // Ensure database is initialized and get User model
      const User = await ensureDatabaseInitialized();
      user = await User.findByPk(userId);
      if (!user) return res.redirect('/auth/login');
    } else {
      // No valid user context
      return res.redirect('/auth/login');
    }

    if (user.mfaEnabled) return res.redirect('/auth/mfa-verify');
    
    // Accept both JSON and form submissions
    console.log('Request body:', req.body);
    const verification_code = req.body.verification_code || req.body.token;
    console.log('Verification code:', verification_code);
    
    if (!verification_code) {
      console.log('No verification code provided');
      if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        const csrfToken = req.csrfToken ? req.csrfToken() : '';
        return res.status(400).json({ error: 'Please enter the code from your authenticator app.', csrfToken });
      } else {
        req.flash('error', 'Please enter the code from your authenticator app.');
        return res.redirect('/auth/mfa-setup');
      }
    }
    
    console.log('Verifying TOTP for user id:', user.id);
    const isValid = user.verifyTotp(verification_code);
    console.log('TOTP verification result:', isValid);
    
    // No more lenient verification - only accept valid TOTP codes
    
    if (!isValid) {
      console.log('Invalid verification code');
      if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        const csrfToken = req.csrfToken ? req.csrfToken() : '';
        return res.status(400).json({ error: 'Invalid code. Try again.', csrfToken });
      } else {
        req.flash('error', 'Invalid verification code. Please try again.');
        return res.redirect('/auth/mfa-setup');
      }
    }
    user.mfaEnabled = true;
    user.isMfaSetupComplete = true;
    user.hasAuthenticator = true;
    const backupCodes = await user.generateBackupCodes();
    await user.save();

    // Store backup codes in session
    req.session.mfaBackupCodes = backupCodes;
    req.session.mfaVerified = true; // Mark MFA as verified in this session

    // Only call req.login if user is not already authenticated (login flow)
    if (!req.isAuthenticated()) {
      console.log('About to call req.login in /mfa-setup for login flow');
      let loginCalled = false;
      try {
        req.login(user, function(err) {
          loginCalled = true;
          if (err) {
            console.error('req.login error in /mfa-setup:', err);
            return next(err);
          }
          console.log('MFA setup complete during login, redirecting to backup codes');
          return res.redirect('/auth/mfa-backup-codes');
        });
      } catch (err) {
        console.error('Exception thrown by req.login:', err);
        return next(err);
      }
      setTimeout(() => {
        if (!loginCalled) {
          console.error('req.login callback was not called within timeout');
          return next(new Error('Login callback timeout'));
        }
      }, 5000);
    } else {
      // User is already authenticated (account page flow)
      console.log('MFA setup complete for authenticated user, checking request type');

      // Check if this is a request from the mobile app
      if (req.body.returnToMobile) {
        console.log('Setting up from mobile app, showing backup codes first');
        req.session.returnToMobile = true; // Flag to return to mobile app after viewing backup codes
        return res.redirect('/auth/mfa-backup-codes');
      }
      // Check if this is a request from the account page
      else if (req.body.returnToAccount) {
        console.log('Setting up from account page, showing backup codes first');
        req.session.returnToAccount = true; // Flag to return to account after viewing backup codes
        return res.redirect('/auth/mfa-backup-codes');
      }
      // Check if this is an AJAX request or a form submission
      else if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        console.log('Sending JSON success response');
        return res.status(200).json({ success: true, redirect: '/auth/mfa-backup-codes' });
      } else {
        console.log('Redirecting to backup codes page');
        return res.redirect('/auth/mfa-backup-codes');
      }
    }
  } catch (err) { next(err); }
});

// MFA Backup Codes - GET
router.get('/mfa-backup-codes', async (req, res) => {
  const backupCodes = req.session.mfaBackupCodes;
  if (!backupCodes) return res.redirect('/auth/login');
  delete req.session.mfaBackupCodes;

  // Check if we should return to mobile app or account page
  let returnUrl;
  if (req.session.returnToMobile) {
    returnUrl = '/mobile-app.html';
    delete req.session.returnToMobile;
  } else if (req.session.returnToAccount) {
    returnUrl = '/account';
    delete req.session.returnToAccount;
  } else {
    returnUrl = req.session.returnTo || '/sites';
  }

  const csrfToken = req.csrfToken ? req.csrfToken() : '';
  res.render('mfa_backup_codes', {
    backupCodes,
    returnUrl,
    csrfToken,
    cspNonce: res.locals.cspNonce || '',
    layout: 'mfa_layout'
  });
});

// Send MFA Code - POST
// NOTE: This route must NOT be protected by ensureMfaVerified middleware!
// It should be accessible to users who are logged in but have not yet completed MFA verification.
router.post('/send-mfa-code', async (req, res) => {
  console.log('DEBUG /send-mfa-code: Session:', req.session);
  console.log('DEBUG /send-mfa-code: mfaUserId:', req.session.mfaUserId);
  console.log('DEBUG /send-mfa-code: AJAX:', req.xhr, '| Accept:', req.headers.accept);

  try {
    // Get user from session
    const userId = req.session.mfaUserId;
    if (!userId) {
      // Always return JSON for AJAX requests
      if (req.xhr || req.headers.accept.indexOf('json') > -1) {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please log in again.'
        });
      } else {
        // fallback for non-AJAX requests
        return res.redirect('/auth/mfa-verify');
      }
    }
    
    // Ensure database is initialized and get User model
    const User = await ensureDatabaseInitialized();
    
    const user = await User.findByPk(userId);
    if (!user || !user.mfaEnabled) {
      if (req.xhr || req.headers.accept.indexOf('json') > -1) {
        return res.status(400).json({
          success: false,
          message: 'User not found or MFA not properly configured.'
        });
      } else {
        return res.redirect('/auth/mfa-verify');
      }
    }
    
    // Rate limiting
    const rateLimitKey = `mfa_rate_limit:${user.id}`;
    const lastSent = await redisClient.client.get(rateLimitKey);
    
    if (lastSent) {
      const timeSinceLastSent = Date.now() - parseInt(lastSent);
      if (timeSinceLastSent < 120000) { // 2 minutes cooldown
        return res.status(429).json({
          success: false,
          message: `Please wait ${Math.ceil((120000 - timeSinceLastSent) / 1000)} seconds before requesting another code.`
        });
      }
    }
    
    // Generate TOTP code
    const secret = user.mfaSecret;
    if (!secret) {
      return res.status(400).json({
        success: false,
        message: 'MFA is not properly configured.'
      });
    }
    
    // Generate current TOTP code
    const totp = speakeasy.totp({
      secret: secret,
      encoding: 'base32'
    });
    
    // Send email with the code
    const { sendEmail } = require('../services/emailService');
    await sendEmail({
      to: user.email,
      subject: 'Your MFA Verification Code',
      text: `Your verification code is: ${totp}\n\nThis code will expire in 120 seconds (2 minutes).`,
      html: `<p>Your verification code is: <strong>${totp}</strong></p><p>This code will expire in 120 seconds (2 minutes).</p>`
    });
    
    // Set rate limit
    await redisClient.client.set(rateLimitKey, Date.now().toString(), {
      EX: 300 // 5 minutes expiration
    });
    
    return res.json({
      success: true,
      message: 'Verification code sent to your email.'
    });
    
  } catch (error) {
    console.error('Error sending MFA code:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send verification code. Please try again.'
    });
  }
});

// MFA Verify - GET
router.get('/mfa-verify', async (req, res, next) => {
  try {
    // Check if user is already authenticated with MFA verified
    if (req.isAuthenticated() && req.session.mfaVerified) {
      const returnUrl = req.session.returnTo || '/sites';
      delete req.session.returnTo;
      return res.redirect(returnUrl);
    }
    
    const userId = req.session.mfaUserId;
    if (!userId) return res.redirect('/auth/login');
    
    // Ensure database is initialized and get User model
    const User = await ensureDatabaseInitialized();
    
    const user = await User.findByPk(userId);
    if (!user || !user.mfaEnabled) return res.redirect('/auth/login');
    const csrfToken = req.csrfToken ? req.csrfToken() : '';
    res.render('mfa_verify', { error: null, csrfToken });
  } catch (err) { next(err); }
});

// MFA Verify - POST
router.post('/mfa-verify', async (req, res, next) => {
  try {
    const userId = req.session.mfaUserId;
    if (!userId) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/auth/login');
    }
    
    // Ensure database is initialized and get User model
    const User = await ensureDatabaseInitialized();
    
    const user = await User.findByPk(userId);
    if (!user || !user.mfaEnabled) {
      req.flash('error', 'User not found or MFA not enabled.');
      return res.redirect('/auth/login');
    }
    
    const { token, backupCode, method } = req.body;
    let verified = false;
    
    if (method === 'backup' && backupCode) {
      verified = await user.verifyBackupCode(backupCode);
      if (verified) await user.save();
    } else if (token) {
      verified = user.verifyTotp(token);
    }
    
    if (!verified) {
      req.flash('error', 'Invalid verification code. Please try again.');
      return res.redirect('/auth/mfa-verify');
    }
    
    // Properly establish the authenticated session with Passport
    let loginCalled = false;
    req.login(user, function(err) {
      loginCalled = true;
      if (err) {
        console.error('req.login error in /mfa-verify:', err);
        return next(err);
      }
      
      req.session.mfaVerified = true; // Mark MFA as verified in this session
      
      if (req.session.rememberMe) {
        req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
      }
      
      // Clean up temporary session data
      delete req.session.mfaUserId;
      delete req.session.rememberMe;

      // Trigger AWS account provisioning in background (non-blocking)
      triggerAWSAccountProvisioning(user);

      user.lastLogin = new Date();
      user.save().then(async () => {
        try {
          // Note: Removed automatic conversation creation for efficiency
          // Conversations are now created only when users send their first message
          
          // Redirect to the original URL if it exists, otherwise to chat
          const redirectUrl = req.session.returnTo || '/';
          delete req.session.returnTo; // Clean up
          
          // Save session before redirect to ensure all data is persisted
          console.log(`Saving session before redirect to ${redirectUrl}, session ID: ${req.session.id}`);
          console.log(`Session data: auth=${req.isAuthenticated()}, mfaVerified=${req.session.mfaVerified}`);
          
          req.session.save((err) => {
            if (err) {
              console.error('Error saving session before redirect:', err);
            }
            return res.redirect(redirectUrl);
          });
        } catch (convError) {
          console.error('Error creating initial conversation:', convError);
          // Continue with redirect even if conversation creation fails
          const redirectUrl = req.session.returnTo || '/';
          delete req.session.returnTo;
          
          // Save session before redirect to ensure all data is persisted
          console.log(`Saving session before redirect to ${redirectUrl} (fallback), session ID: ${req.session.id}`);
          
          req.session.save((err) => {
            if (err) {
              console.error('Error saving session before redirect (fallback):', err);
            }
            return res.redirect(redirectUrl);
          });
        }
      }).catch(saveErr => {
        console.error('Error saving user after MFA verify:', saveErr);
        const redirectUrl = req.session.returnTo || '/';
        
        // Save session before redirect to ensure all data is persisted
        console.log(`Saving session before redirect to ${redirectUrl} (error handler), session ID: ${req.session.id}`);
        
        req.session.save((err) => {
          if (err) {
            console.error('Error saving session before redirect (error handler):', err);
          }
          return res.redirect(redirectUrl);
        });
      });
    });
    
    // Safety timeout in case req.login callback never fires
    setTimeout(() => {
      if (!loginCalled) {
        console.error('req.login callback never called after 2 seconds in /mfa-verify!');
        if (!res.headersSent) {
          return res.status(500).json({ error: 'Internal server error: login did not complete.' });
        }
      }
    }, 2000);
  } catch (err) {
    console.error('MFA verification error:', err);
    req.flash('error', 'An error occurred during verification.');
    return res.redirect('/auth/mfa-verify');
  }
});

// POST /auth/mobile/logout - Mobile logout endpoint (always returns JSON)
router.post('/mobile/logout', async (req, res) => {
  try {
    console.log('[Mobile Logout] Request received');
    
    // Clear session if it exists
    if (req.session) {
      delete req.session.mfaVerified;
      delete req.session.conversationId;
    }
    
    // Logout using passport
    req.logout(function(err) {
      if (err) {
        console.error('[Mobile Logout] Passport logout error:', err);
        return res.status(500).json({
          success: false,
          error: 'Logout failed'
        });
      }
      
      console.log('[Mobile Logout] Logout successful');
      res.json({
        success: true,
        message: 'Logged out successfully'
      });
    });
  } catch (error) {
    console.error('[Mobile Logout] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Logout failed'
    });
  }
});

// POST /logout
router.post('/logout', (req, res) => {
  // Detect if this is a mobile API call
  const isMobileAPI = req.headers['x-api-key'] || req.headers['x-platform'];
  
  console.log('[Logout] Headers:', {
    'x-api-key': req.headers['x-api-key'],
    'x-platform': req.headers['x-platform'],
    'content-type': req.headers['content-type']
  });
  console.log('[Logout] Is mobile API?', isMobileAPI);
  
  // Clear MFA verification flag
  if (req.session) {
    delete req.session.mfaVerified;
  }
  
  // Logout using passport
  req.logout(function(err) {
    if (err) {
      console.error('[Logout] Passport logout error:', err);
      
      // Return JSON error for mobile API calls
      if (isMobileAPI) {
        console.log('[Logout] Returning JSON error for mobile');
        return res.status(500).json({
          success: false,
          error: 'Logout failed'
        });
      }
      
      console.log('[Logout] Redirecting web client to login (error case)');
      return res.redirect('/auth/login');
    }
    
    console.log('[Logout] Passport logout successful');
    
    // Return JSON success for mobile API calls
    if (isMobileAPI) {
      console.log('[Logout] Returning JSON success for mobile');
      return res.json({
        success: true,
        message: 'Logged out successfully'
      });
    }
    
    // Redirect for web clients
    console.log('[Logout] Redirecting web client to login (success case)');
    res.redirect('/auth/login');
  });
});

// GET /logout - Added to support links in the UI
router.get('/logout', (req, res) => {
  console.log('GET logout route called');
  // Clear MFA verification flag
  if (req.session) {
    delete req.session.mfaVerified;
    // Also clear any conversation data
    if (req.session.conversationId) {
      console.log(`Clearing conversation data for ID: ${req.session.conversationId}`);
      delete req.session.conversationId;
    }
  }
  // Logout using passport
  req.logout(function(err) {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/auth/login');
  });
});

// GET /account - Account settings page
// Account route moved to /account in routes/index.js

// POST /remove-authenticator - Remove MFA authenticator
router.post('/remove-authenticator', async (req, res) => {
  // Ensure user is authenticated and MFA verified
  if (!req.isAuthenticated() || !req.session.mfaVerified) {
    req.session.returnTo = '/account';
    return res.redirect('/auth/login');
  }

  try {
    const user = req.user;

    // Remove MFA configuration
    user.mfaSecret = null;
    user.hasAuthenticator = false;
    user.mfaEnabled = false;
    user.isMfaSetupComplete = false;

    // Save changes
    await user.save();

    // Flash success message
    req.flash('message', 'Authenticator app has been removed successfully.');

    // Redirect back to account page
    res.redirect('/account');
  } catch (err) {
    console.error('Error removing authenticator:', err);
    req.flash('error', 'An error occurred while removing the authenticator app.');
    res.redirect('/account');
  }
});

// GET /setup-authenticator - Setup MFA authenticator
router.get('/setup-authenticator', async (req, res) => {
  // Ensure user is authenticated
  if (!req.isAuthenticated()) {
    req.session.returnTo = '/auth/setup-authenticator';
    return res.redirect('/auth/login');
  }

  try {
    const user = req.user;

    // Generate MFA secret if not already set
    if (!user.mfaSecret) {
      user.generateMfaSecret();
      await user.save();
    }

    // Generate QR code
    const otpAuthUrl = user.getMfaUri('Bedrock Express AI');
    const qrCodeDataUrl = await qrcode.toDataURL(otpAuthUrl);

    // Check if this is from mobile app
    const returnToMobile = req.query.returnToMobile === 'true';

    // Render MFA setup page
    res.render('mfa_setup', {
      user: user,
      qr: qrCodeDataUrl,
      secret: user.mfaSecret,
      error: req.flash('error'),
      message: req.flash('message'),
      returnToAccount: !returnToMobile, // Return to account unless from mobile
      returnToMobile: returnToMobile, // Flag for mobile app return
      csrfToken: req.csrfToken ? req.csrfToken() : '',
      layout: 'mfa_layout'
    });
  } catch (err) {
    console.error('Error setting up authenticator:', err);
    req.flash('error', 'An error occurred while setting up the authenticator app.');
    res.redirect('/account');
  }
});

// Google OAuth Routes
// Only register if Google OAuth is configured
router.get('/google', (req, res, next) => {
  // Check if Google OAuth is configured
  if (!req.app.locals.googleOAuthEnabled) {
    console.log('[OAuth] Google sign-in attempted but not configured');
    req.flash('error', 'Google sign-in is not available. Please use email/password login.');
    return res.redirect('/auth/login');
  }

  // Store return URL if provided (same-origin paths only, to prevent an
  // attacker-controlled returnTo from turning login into an open redirect)
  const safeReturn = safeReturnTo(req.query.returnTo);
  if (safeReturn) {
    req.session.returnTo = safeReturn;
  }

  // Detect mobile flag
  const isMobile = req.query.mobile === 'true';

  // Store mobile flag in session as backup (though this may be lost)
  if (isMobile) {
    req.session.mobileAuth = true;
    console.log('[OAuth] Mobile flag set in session:', req.session.id);
  }

  // NOTE: We intentionally do NOT build a custom `state` string here.
  // passport-oauth2 only runs its CSRF state store when `state: true` is set on
  // the strategy (done in server.js) AND no explicit state string is passed. A
  // custom state string is used verbatim and SKIPS the store, defeating the
  // login-CSRF protection. The mobile flag is carried via the session and the
  // callback query (?mobile=true) instead.

  // Dynamically generate callback URL with mobile flag if present
  let dynamicCallbackURL = getFullUrl(req, '/auth/google/callback');
  if (isMobile) {
    dynamicCallbackURL += '?mobile=true';
  }
  console.log('[OAuth] Using dynamic callback URL:', dynamicCallbackURL);

  // Save session before redirecting to Google
  req.session.save((err) => {
    if (err) {
      console.error('[OAuth] Error saving session before redirect:', err);
    }
    console.log('[OAuth] Session saved before redirect, mobile flag:', req.session.mobileAuth);

    // Initiate Google OAuth flow. passport generates and verifies its own state.
    passport.authenticate('google', {
      scope: ['profile', 'email'],
      callbackURL: dynamicCallbackURL
    })(req, res, next);
  });
});

router.get('/google/callback', async (req, res, next) => {
  // Check if Google OAuth is configured
  if (!req.app.locals.googleOAuthEnabled) {
    console.log('[OAuth] Google callback accessed but OAuth not configured');
    req.flash('error', 'Google sign-in is not available.');
    return res.redirect('/auth/login');
  }

  // Detect mobile flag from the callback query, callback URL, and session.
  // The `state` parameter is owned and verified by passport-oauth2 and no
  // longer carries any application data, so we do NOT decode it here.

  // 1. Check query parameter
  const isMobileFromQuery = req.query.mobile === 'true';
  console.log('[OAuth] Query parameter mobile flag:', isMobileFromQuery);

  // 2. Check session (may be lost across the OAuth round trip)
  const isMobileFromSession = req.session.mobileAuth === true;
  console.log('[OAuth] Session mobile flag:', isMobileFromSession);

  // 3. Check callback URL itself
  const callbackURL = req.originalUrl || req.url;
  const isMobileFromURL = callbackURL.includes('mobile=true');
  console.log('[OAuth] Callback URL contains mobile=true:', isMobileFromURL);

  // Determine final mobile auth flag (priority: query > URL > session)
  const isMobileAuth = isMobileFromQuery || isMobileFromURL || isMobileFromSession;
  console.log('[OAuth] Final mobile auth decision:', isMobileAuth);

  // Dynamically generate the callback URL to match what was used during authorization
  let dynamicCallbackURL = getFullUrl(req, '/auth/google/callback');
  if (isMobileFromQuery || isMobileFromURL) {
    dynamicCallbackURL += '?mobile=true';
  }
  console.log('[OAuth] Callback using dynamic URL:', dynamicCallbackURL);

  passport.authenticate('google', {
    callbackURL: dynamicCallbackURL
  }, (err, user, info) => {
    if (err) {
      console.error('[OAuth] Google authentication error:', err);
      req.flash('error', 'Authentication failed. Please try again.');
      return res.redirect('/auth/login');
    }

    if (!user) {
      console.log('[OAuth] Google authentication failed - no user returned');
      req.flash('error', 'Authentication failed. Please try again.');
      return res.redirect('/auth/login');
    }

    // Log the user in
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('[OAuth] Login error after Google auth:', loginErr);
        req.flash('error', 'Login failed. Please try again.');
        return res.redirect('/auth/login');
      }

      console.log('[OAuth] Google login successful for:', user.email);
      console.log('[OAuth] Is mobile auth?', isMobileAuth);

      // OAuth users skip MFA (trust Google's MFA)
      req.session.mfaVerified = true;
      req.session.loginMethod = 'oauth'; // Track OAuth login

      // Trigger AWS account provisioning in background (non-blocking)
      triggerAWSAccountProvisioning(user);

      // Clean up session mobile flag if it exists
      if (req.session.mobileAuth) {
        delete req.session.mobileAuth;
      }

      // Handle mobile OAuth flow with session token exchange
      if (isMobileAuth) {
        // Generate a one-time session token for mobile app (no MFA required)
        const oauthSessionToken = crypto.randomBytes(32).toString('hex');

        const sessionData = {
          userId: user.id,
          email: user.email,
          platform: 'mobile_oauth',
          isOAuth: true,
          timestamp: Date.now()
        };

        // Store session token in Redis with 5 minute expiration
        redisClient.client.setEx(
          `oauth_mobile_session:${oauthSessionToken}`,
          300, // 5 minutes
          JSON.stringify(sessionData)
        ).then(() => {
          console.log('[Mobile OAuth] Session token created for user:', user.email);

          // Redirect to mobile auth page with session token
          const host = req.get('host') || '';
          let mobileRedirectURL;
          
          if (host.includes('localhost')) {
            // Local development
            mobileRedirectURL = '/mobile/auth';
          } else {
            // Production/staging - use full URL
            mobileRedirectURL = getFullUrl(req, '/mobile/auth');
          }
          
          const returnUrl = `${mobileRedirectURL}?success=true&session=${oauthSessionToken}`;
          console.log(`[Mobile OAuth] Redirecting to: ${returnUrl}`);
          res.redirect(returnUrl);
        }).catch((redisError) => {
          console.error('[Mobile OAuth] Redis error storing session token:', redisError);
          const host = req.get('host') || '';
          const errorUrl = host.includes('localhost') ? '/mobile/auth?error=oauth_failed' : getFullUrl(req, '/mobile/auth?error=oauth_failed');
          res.redirect(errorUrl);
        });

        return;
      }

      // Regular web OAuth flow
      const returnTo = req.session.returnTo || '/sites';
      delete req.session.returnTo;

      // Save session before redirect
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('[OAuth] Session save error:', saveErr);
        }
        res.redirect(returnTo);
      });
    });
  })(req, res, next);
});

// Google OAuth status endpoint (for mobile apps)
router.get('/google/status', (req, res) => {
  res.json({
    enabled: req.app.locals.googleOAuthEnabled || false,
    configured: !!req.app.locals.googleOAuthEnabled
  });
});

// POST /auth/mobile/oauth-exchange - Exchange OAuth session token for session cookie
router.post('/mobile/oauth-exchange',
  [
    body('sessionToken').notEmpty()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const { sessionToken } = req.body;

      console.log(`[Mobile OAuth] Exchange requested for session token: ${sessionToken.substring(0, 8)}...`);

      // Retrieve session data from Redis
      const sessionKey = `oauth_mobile_session:${sessionToken}`;
      let sessionDataStr;

      try {
        sessionDataStr = await redisClient.client.get(sessionKey);
      } catch (redisError) {
        console.error('[Mobile OAuth] Redis error during exchange:', redisError.message);
        return res.status(503).json({
          success: false,
          error: 'OAuth service temporarily unavailable. Please try again.'
        });
      }

      if (!sessionDataStr) {
        console.log('[Mobile OAuth] Session token not found or expired');
        return res.status(401).json({
          success: false,
          error: 'Invalid or expired session token'
        });
      }

      // Parse session data
      const sessionData = JSON.parse(sessionDataStr);
      console.log('[Mobile OAuth] Session data retrieved for user:', sessionData.userId);

      // Delete the one-time session token
      try {
        await redisClient.client.del(sessionKey);
      } catch (redisError) {
        console.error('[Mobile OAuth] Error deleting session token:', redisError.message);
      }

      // Get user from database
      const User = await ensureDatabaseInitialized();
      const user = await User.findByPk(sessionData.userId);

      if (!user) {
        console.error('[Mobile OAuth] User not found:', sessionData.userId);
        return res.status(401).json({
          success: false,
          error: 'User not found'
        });
      }

      // Log the user in by creating a session
      req.logIn(user, (loginErr) => {
        if (loginErr) {
          console.error('[Mobile OAuth] Login error:', loginErr);
          return res.status(500).json({
            success: false,
            error: 'Login failed'
          });
        }

        // Mark MFA as verified for OAuth users
        req.session.mfaVerified = true;

        // Save session and return success
        req.session.save((saveErr) => {
          if (saveErr) {
            console.error('[Mobile OAuth] Session save error:', saveErr);
            return res.status(500).json({
              success: false,
              error: 'Session creation failed'
            });
          }

          console.log('[Mobile OAuth] Session created successfully for user:', user.email);

          res.json({
            success: true,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              emailVerified: user.emailVerified
            }
          });
        });
      });

    } catch (error) {
      console.error('[Mobile OAuth] Exchange error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  }
);

// Authentication status endpoint for mobile app
router.get('/status', (req, res) => {
  const isAuthenticated = req.isAuthenticated();
  // Only skip MFA for OAuth logins, not for users who have Google linked but logged in with password
  // For backward compatibility: if loginMethod is not set, treat as OAuth if user has googleId (legacy sessions)
  const isOAuthLogin = req.session.loginMethod === 'oauth' ||
                      (!req.session.loginMethod && req.user && req.user.googleId && req.user.googleId.trim() !== '');
  const mfaRequired = isAuthenticated && req.user && req.user.mfaEnabled && !req.session.mfaVerified && !isOAuthLogin;

  res.json({
    authenticated: isAuthenticated,
    mfaRequired: mfaRequired,
    mfaEnabled: req.user ? req.user.mfaEnabled : false,
    user: req.user ? {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      mfaEnabled: req.user.mfaEnabled,
      createdAt: req.user.createdAt
    } : null
  });
});

module.exports = router;
