// apps/reporting-service/services/dashboardSnapshotService.js
// ---------------------------------------------------------------------------
// Aggregates multiple lightweight reads into a single dashboard snapshot.
//
// Data sources (all read-only, no SQL modifications):
//   1. Mini-stock metrics  — cached getUnitInstockMetrics per active unit
//   2. Today's day-logs    — summary count + latest entry
//   3. Latest trips        — most recent 5 trip records
//   4. Meter snapshots     — summary (latest snapshot per truck)
//   5. Audit alerts        — latest 5 fuel-ops audit entries
//
// Heavy DB reads go through isolatedQuery (dedicated read pool + timeout).
// The service itself is stateless; caching is applied at the controller level.
// ---------------------------------------------------------------------------

'use strict';

const { isolatedQuery } = require('../../../packages/query');

/**
 * Build the full dashboard snapshot object.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool              - Shared write pool (used for unit list only)
 * @param {Function}          deps.getUnitInstockMetrics - lotMetricsRepo function
 * @returns {Promise<object>}
 */
async function buildSnapshot({ pool, getUnitInstockMetrics }) {
  // Resolve today's date in local server time (YYYY-MM-DD)
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  // --- 1. Mini-stock (reuses cached per-unit metrics) ----------------------
  const unitsQ = await pool.query(
    `SELECT id FROM public.storage_units WHERE active = TRUE AND unit_type IN ('TRUCK','DATUM') ORDER BY id`
  );
  const unitIds = unitsQ.rows.map(r => Number(r.id));

  let totalRemaining = 0;
  let totalUsed = 0;
  let latestLotStatus = null;
  let latestLotId = null;

  const metricResults = await Promise.all(
    unitIds.map(uid => getUnitInstockMetrics(pool, uid).catch(() => null))
  );
  for (const m of metricResults) {
    if (!m) continue;
    totalRemaining += m.total_remaining_liters || 0;
    if (m.latest_lot) {
      totalUsed += m.latest_lot.outbound_used_liters || 0;
      if (latestLotId == null || m.latest_lot.id > latestLotId) {
        latestLotId = m.latest_lot.id;
        latestLotStatus = m.latest_lot.remaining_liters_clamped > 0 ? 'INSTOCK' : 'SOLD';
      }
    }
  }

  const miniStock = { totalRemaining, totalUsed, latestLotStatus, unitCount: unitIds.length };

  // --- Parallel heavy reads (2–5) via isolatedQuery -----------------------
  const [dayLogsQ, tripsQ, meterQ, auditQ] = await Promise.all([
    // 2. Today's day-logs summary
    isolatedQuery(
      `SELECT truck_id, reading_date, opening_liters, closing_liters
         FROM public.dispenser_day_reading_logs
        WHERE reading_date = $1::date
        ORDER BY truck_id`,
      [todayStr]
    ),

    // 3. Latest 5 trips across all trucks
    isolatedQuery(
      `SELECT id, truck_id, reading_date, trip_no, opening_liters, closing_liters, opening_at, closing_at, is_frozen
         FROM public.truck_dispenser_trips
        ORDER BY reading_date DESC, trip_no DESC, id DESC
        LIMIT 5`,
      []
    ),

    // 4. Meter snapshots — latest per truck
    isolatedQuery(
      `SELECT DISTINCT ON (truck_id) truck_id, reading_at, reading_liters, source
         FROM public.truck_dispenser_meter_snapshots
        ORDER BY truck_id, reading_at DESC`,
      []
    ),

    // 5. Audit alerts — latest 5
    isolatedQuery(
      `SELECT id, created_at, username AS performed_by, tab, section, action, entity_type, unit_id, op_date
         FROM public.fuel_ops_audit
        ORDER BY created_at DESC
        LIMIT 5`,
      []
    ),
  ]);

  // --- Shape responses -----------------------------------------------------
  const dayLogsSummary = {
    date: todayStr,
    count: dayLogsQ.rows.length,
    entries: dayLogsQ.rows,
  };

  const latestTrips = tripsQ.rows;

  const meterSummary = meterQ.rows.map(r => ({
    truck_id: r.truck_id,
    reading_at: r.reading_at,
    reading_liters: r.reading_liters != null ? Number(r.reading_liters) : null,
    source: r.source || null,
  }));

  const auditAlerts = auditQ.rows;

  return {
    miniStock,
    dayLogs: dayLogsSummary,
    latestTrips,
    meterSnapshots: meterSummary,
    auditAlerts,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildSnapshot };
