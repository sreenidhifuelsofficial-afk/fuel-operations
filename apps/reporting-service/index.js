// apps/reporting-service/index.js
// ---------------------------------------------------------------------------
// Reporting Service — heavy read-only endpoints.
//
// Endpoints:
//   GET /stock/summary   — Full stock summary across all units
//   GET /ops/day         — Consolidated per-day operations for a truck
//   GET /ops/trip        — Consolidated per-trip operations
//
// Usage (from gateway):
//   const { createReportingRouter } = require('../reporting-service');
//   app.use('/api/fuel-ops', createReportingRouter({ pool, requireAuth, getUnitInstockMetrics }));
// ---------------------------------------------------------------------------

'use strict';

const { Router } = require('express');

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {Function}          deps.requireAuth
 * @param {Function}          deps.getUnitInstockMetrics
 * @returns {import('express').Router}
 */
function createReportingRouter({ pool, requireAuth, getUnitInstockMetrics }) {
  const router = Router();

  const { createReportingController } = require('./controllers/reportingController');
  router.use(createReportingController({ pool, requireAuth, getUnitInstockMetrics }));

  const { createDashboardController } = require('./controllers/dashboardController');
  router.use(createDashboardController({ pool, requireAuth, getUnitInstockMetrics }));

  return router;
}

module.exports = { createReportingRouter };
