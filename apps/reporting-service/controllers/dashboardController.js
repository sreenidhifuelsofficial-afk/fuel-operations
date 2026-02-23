// apps/reporting-service/controllers/dashboardController.js
// ---------------------------------------------------------------------------
// GET /dashboard-snapshot
//
// Returns an aggregated, cached snapshot of key dashboard data in a single
// round-trip.  In-memory cache with 5-second TTL keeps repeated loads
// near-instant without adding external dependencies.
// ---------------------------------------------------------------------------

'use strict';

const { Router } = require('express');
const { buildSnapshot } = require('../services/dashboardSnapshotService');

// Lightweight in-memory cache (TTL = 5 s)
let cachedSnapshot = null;
let cachedAt = 0;
const SNAPSHOT_TTL_MS = 5_000;

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {Function}          deps.requireAuth
 * @param {Function}          deps.getUnitInstockMetrics
 */
function createDashboardController({ pool, requireAuth, getUnitInstockMetrics }) {
  const router = Router();

  router.get('/dashboard-snapshot', requireAuth, async (_req, res) => {
    const t0 = Date.now();
    try {
      const now = Date.now();
      if (cachedSnapshot && (now - cachedAt) < SNAPSHOT_TTL_MS) {
        const duration = Date.now() - t0;
        console.log(`[dashboard-snapshot] ${duration}ms (cache-hit)`);
        return res.json(cachedSnapshot);
      }

      const snapshot = await buildSnapshot({ pool, getUnitInstockMetrics });

      // Store in cache
      cachedSnapshot = snapshot;
      cachedAt = Date.now();

      const duration = Date.now() - t0;
      console.log(`[dashboard-snapshot] ${duration}ms`);
      res.json(snapshot);
    } catch (e) {
      const duration = Date.now() - t0;
      console.error(`[dashboard-snapshot] ERROR ${duration}ms:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createDashboardController };
