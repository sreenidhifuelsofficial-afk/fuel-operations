// apps/fuelops-service/index.js
// ---------------------------------------------------------------------------
// Fuel Operations Service — Express Router factory.
//
// Exports a single function that accepts shared dependencies and returns an
// Express Router mountable at /api/fuel-ops by the gateway.
//
// All 52 fuel-ops routes are organised into domain-specific controllers:
//   - storageController   → /storage-units, /vehicles              (7 routes)
//   - driverController    → /drivers                               (4 routes)
//   - transferController  → /transfers/sales, /internal, /testing  (11 routes)
//   - lotController       → /lot-code, /lots, /lots/activity …    (5 routes)
//   - tripController      → /trips, /audit                        (7 routes)
//   - dayOpsController    → /day/dispenser, /day/logs, /day/odo…  (14 routes)
//   - meterController     → /meter-snapshots, /reconcile/daily    (3 routes)
//
// stock/summary is served by reporting-service.
//
// Usage (from gateway):
//   const { createFuelOpsRouter } = require('../fuelops-service');
//   app.use('/api/fuel-ops', createFuelOpsRouter({ pool, requireAuth, requireRole }));
// ---------------------------------------------------------------------------

'use strict';

const { Router } = require('express');

/**
 * Create the Fuel Ops service router.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool          - Shared PostgreSQL pool
 * @param {Function}          deps.requireAuth   - JWT auth middleware
 * @param {Function}          deps.requireRole   - Role-based access middleware
 * @returns {import('express').Router}
 */
function createFuelOpsRouter({ pool, requireAuth, requireRole, invalidateInstockMetricsCache }) {
  const router = Router();

  // Fallback no-op if cache invalidation not provided
  const invalidateCache = typeof invalidateInstockMetricsCache === 'function'
    ? invalidateInstockMetricsCache
    : () => {};

  // Mount domain controllers (each returns a sub-Router)
  const { createStorageController } = require('./controllers/storageController');
  const { createDriverController } = require('./controllers/driverController');
  const { createTransferController } = require('./controllers/transferController');
  const { createLotController } = require('./controllers/lotController');
  const { createTripController } = require('./controllers/tripController');
  const { createDayOpsController } = require('./controllers/dayOpsController');
  const { createMeterController } = require('./controllers/meterController');

  router.use(createStorageController({ pool, requireAuth, requireRole }));
  router.use(createDriverController({ pool, requireAuth, requireRole }));
  router.use(createTransferController({ pool, requireAuth, requireRole, invalidateCache }));
  router.use(createLotController({ pool, requireAuth, requireRole, invalidateCache }));
  router.use(createTripController({ pool, requireAuth, requireRole }));
  router.use(createDayOpsController({ pool, requireAuth }));
  router.use(createMeterController({ pool, requireAuth }));

  // -----------------------------------------------------------------------
  // Register domain workers for the job queue (recompute lot status)
  // -----------------------------------------------------------------------
  try {
    let registerWorker;
    try {
      ({ registerWorker } = require('@fuel-ops/queue'));
    } catch {
      ({ registerWorker } = require('../../packages/queue'));
    }
    const { recomputeFuelLotUsedAndStatus } = require('./services/lotService');
    const { recomputeFuelLotTestingLiters } = require('./services/lotService');

    registerWorker('recomputeLot', async ({ lotId }, { client }) => {
      await recomputeFuelLotUsedAndStatus(client, lotId);
    });

    registerWorker('recomputeTestingLiters', async ({ lotId }, { client }) => {
      await recomputeFuelLotTestingLiters(client, lotId);
    });
  } catch (e) {
    console.warn('[fuelops-service] queue registration skipped:', e.message);
  }

  return router;
}

module.exports = { createFuelOpsRouter };
