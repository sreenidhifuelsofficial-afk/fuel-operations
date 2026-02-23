// packages/middleware/index.js
// ---------------------------------------------------------------------------
// Shared Express middleware extracted from the monolith.
// Every service (fuelops, reporting, auth, gateway) can import these so
// security posture is consistent across all process boundaries.
// ---------------------------------------------------------------------------

'use strict';

const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const hpp = require('hpp');

// ---------------------------------------------------------------------------
// Auth middleware (re-exported from auth module)
// ---------------------------------------------------------------------------

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('JWT_SECRET is required in production');
  }
  JWT_SECRET = 'dev_secret_change_me';
  if (!process.env.SUPPRESS_DB_LOG) {
    console.warn('[WARN] JWT_SECRET is not set; using insecure development default');
  }
}
const JWT_EXPIRES_IN = '12h';

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      email: user.email,
      username: user.username || undefined,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  const token = auth.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { sub, role, email }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function buildCorsOptions() {
  const frontendUrl = process.env.FRONTEND_URL;
  if (process.env.NODE_ENV === 'production' && frontendUrl) {
    const allowedOrigins = frontendUrl.split(',').map(u => u.trim()).filter(Boolean);
    return {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Security & performance middleware stack
// ---------------------------------------------------------------------------

/**
 * Apply common security and performance middleware to an Express app.
 * Call once during startup: `applyCommonMiddleware(app);`
 */
function applyCommonMiddleware(app, options = {}) {
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(hpp());
  app.use(compression());
  app.use(cors(buildCorsOptions()));
  app.use(morgan(options.morganFormat || 'combined'));

  const limiter = rateLimit({
    windowMs: 60_000,
    max: options.rateMax || 600,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  // Per-request timeout
  app.use((req, res, next) => {
    req.setTimeout(options.requestTimeout || 25_000, () => {});
    res.setTimeout(options.requestTimeout || 25_000, () => {});
    next();
  });

  app.use(require('express').json({ limit: options.bodyLimit || '7mb' }));
  app.use(require('express').urlencoded({ extended: true, limit: options.bodyLimit || '7mb' }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const { normalizeUtf8, utf8ResponseMiddleware } = require('./normalizeUtf8');

module.exports = {
  // Security stack
  applyCommonMiddleware,
  buildCorsOptions,

  // Auth
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  requireRole,

  // UTF-8 normalization
  normalizeUtf8,
  utf8ResponseMiddleware,
};
