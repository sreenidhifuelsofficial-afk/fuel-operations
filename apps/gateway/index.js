// apps/gateway/index.js
// ---------------------------------------------------------------------------
// API Gateway — single entry point that mounts all service routers.
//
// This replaces the monolithic backend/index.js at deployment time.
// All endpoint paths remain EXACTLY the same so the frontend is unaffected.
//
// Architecture:
//   Gateway (this file)
//     ├── packages/middleware    → security, auth, CORS, rate limiting
//     ├── packages/db           → shared PostgreSQL pool
//     ├── packages/cache        → Redis / in-memory cache
//     ├── packages/queue        → job queue (recompute lot status)
//     ├── apps/fuelops-service  → /api/fuel-ops/* CRUD routes
//     ├── apps/reporting-service → /api/fuel-ops/stock/summary, ops/day, ops/trip
//     └── apps/auth-service     → /api/auth/*, /api/users/*, /api/password-audit
//
// The remaining routes that have NOT yet been extracted from backend/index.js
// (opportunities, reminders, meetings, employee profiles, targets, etc.) can
// continue to be served by the legacy monolith in parallel. Migrate them
// incrementally by creating new service apps and mounting here.
//
// Start:
//   node apps/gateway/index.js
//   (or via the VS Code task / npm script)
// ---------------------------------------------------------------------------

'use strict';

// Load environment variables
try {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '../../backend/.env') });
} catch {}

const express = require('express');
const os = require('os');

function getLocalIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (!net) continue;
      const family = typeof net.family === 'string' ? net.family : String(net.family);
      if (family !== 'IPv4') continue;
      if (net.internal) continue;
      if (net.address) return net.address;
    }
  }
  return 'localhost';
}

// -----------------------------------------------------------------------
// Environment variable validation (fail-fast before any I/O)
// -----------------------------------------------------------------------
{
  const required = ['DATABASE_URL', 'JWT_SECRET', 'PORT'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[gateway] FATAL — missing required env variable(s): ${missing.join(', ')}`);
    console.error('[gateway] Set them in backend/.env or export them before starting.');
    process.exit(1);
  }
}

// -----------------------------------------------------------------------
// Shared packages
// -----------------------------------------------------------------------
const pool = require('../../packages/db');
const { applyCommonMiddleware, requireAuth, requireRole, hashPassword, verifyPassword, signToken, utf8ResponseMiddleware } = require('../../packages/middleware');

// -----------------------------------------------------------------------
// Create Express app with shared middleware
// -----------------------------------------------------------------------
const app = express();
applyCommonMiddleware(app);

// UTF-8 response normalization — fixes mojibake (Â, â€™, etc.) at API layer
app.use(utf8ResponseMiddleware);

// -----------------------------------------------------------------------
// Production request logging — timestamp, method, route, status, time
// Keeps existing service-level logging intact.
// -----------------------------------------------------------------------
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${elapsed}ms`
    );
  });
  next();
});

// -----------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------
app.get('/', (req, res) => res.send('Gateway is working!'));

// DB-independent health probe (ALB / ECS / k8s liveness)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'gateway' });
});
app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------------------------------------------------------
// Mount services
// -----------------------------------------------------------------------

// Auth service — routes at /api/auth/*, /api/users/*, /api/password-audit
const { createAuthRouter } = require('../auth-service');

// ownerExists helper needs pool (re-implemented locally to avoid circular dep)
async function ownerExists() {
  const r = await pool.query("SELECT 1 FROM users WHERE role='OWNER' AND active=TRUE LIMIT 1");
  return r.rows.length > 0;
}

app.use(createAuthRouter({
  pool,
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  requireRole,
  ownerExists,
}));

// Reporting service — heavy read endpoints mounted BEFORE fuelops-service
// so the more-specific /stock/summary, /ops/day, /ops/trip match first.
const { createReportingRouter } = require('../reporting-service');
const { getUnitInstockMetrics, invalidateInstockMetricsCache, clearInstockMetricsCache } = require('../../packages/metrics/lotMetricsRepo');

app.use('/api/fuel-ops', createReportingRouter({
  pool,
  requireAuth,
  getUnitInstockMetrics,
}));

// Fuel Ops service — full parity with monolith achieved (51 routes):
//   storageController (7), driverController (4), transferController (11),
//   lotController (5), tripController (7), dayOpsController (14), meterController (3)
// stock/summary is served by reporting-service above.
const { createFuelOpsRouter } = require('../fuelops-service');
app.use('/api/fuel-ops', createFuelOpsRouter({ pool, requireAuth, requireRole, invalidateInstockMetricsCache }));

// -----------------------------------------------------------------------
// GET /api/fuel-ops/mini-stock — Lightweight aggregate stock indicator
// Returns totalRemaining, totalUsed, latestLotStatus across all active units.
// Uses cached getUnitInstockMetrics() per unit for performance.
// -----------------------------------------------------------------------
app.get('/api/fuel-ops/mini-stock', requireAuth, async (req, res) => {
  const t0 = Date.now();
  try {
    // Fetch all active storage units (TRUCK + DATUM)
    const unitsQ = await pool.query(
      `SELECT id FROM public.storage_units WHERE active = TRUE AND unit_type IN ('TRUCK','DATUM') ORDER BY id`
    );
    const unitIds = unitsQ.rows.map(r => Number(r.id));

    let totalRemaining = 0;
    let totalUsed = 0;
    let latestLotStatus = null;
    let latestCreatedAt = null;

    // Resolve metrics per-unit (cache-driven — each call checks 10s TTL cache first)
    const results = await Promise.all(
      unitIds.map(uid => getUnitInstockMetrics(pool, uid).catch(() => null))
    );

    for (const m of results) {
      if (!m) continue;
      totalRemaining += m.total_remaining_liters || 0;
      if (m.latest_lot) {
        totalUsed += m.latest_lot.outbound_used_liters || 0;
        // Track the most-recently-created lot across all units
        if (m.latest_lot.id != null) {
          // We don't have created_at in the metrics so use lot id as a proxy (auto-increment)
          if (latestCreatedAt == null || m.latest_lot.id > latestCreatedAt) {
            latestCreatedAt = m.latest_lot.id;
            latestLotStatus = m.latest_lot.remaining_liters_clamped > 0 ? 'INSTOCK' : 'SOLD';
          }
        }
      }
    }

    const elapsed = Date.now() - t0;
    console.log(`[mini-stock] ${unitIds.length} units | ${elapsed}ms | remaining=${totalRemaining} used=${totalUsed}`);

    res.json({
      totalRemaining,
      totalUsed,
      latestLotStatus,
      unitCount: unitIds.length,
      queryTimeMs: elapsed,
    });
  } catch (e) {
    const elapsed = Date.now() - t0;
    console.error(`[mini-stock] ERROR ${elapsed}ms:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------------
// 404 — unknown route (enterprise mode — no legacy proxy)
// -----------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    service: 'gateway',
  });
});

// -----------------------------------------------------------------------
// Global error handler (must be last)
// -----------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[UnhandledError]', err);
  if (res.headersSent) return;
  // In production: suppress verbose stack traces in responses
  const payload = process.env.NODE_ENV === 'production'
    ? { error: 'Internal server error' }
    : { error: err.message || 'Internal server error', stack: err.stack };
  res.status(500).json(payload);
});

// -----------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------
const port = Number(process.env.PORT || 5000);
const host = '0.0.0.0';
const server = app.listen(port, host, () => {
  console.log(`Gateway running on: http://${getLocalIPv4()}:${port}`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  server.close(() => {
    try { pool.end && pool.end(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
