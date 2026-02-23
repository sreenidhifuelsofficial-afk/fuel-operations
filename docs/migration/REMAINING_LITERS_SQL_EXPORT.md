---

## FILE EXPORT — DO NOT EDIT

=== FILE: C:\Users\splog\OneDrive\Documents\fuel-ops-website\backend\fuelOps\lotMetricsRepo.js ===

```code
// backend/fuelOps/lotMetricsRepo.js
// Centralized queries for computing in-stock remaining liters without N+1 loops.

const { createCache } = require('../utils/cache');

// In-memory cache for unit instock metrics (TTL = 10 seconds)
const instockMetricsCache = createCache(10_000);

/**
 * Returns aggregate remaining liters across all in-stock lots for a unit, plus the latest lot's metrics.
 *
 * Domain rules (aligned with stock summary & ops/day):
 * - Inbound additions exclude:
 *   - transfer_to_empty
 *   - seed/identity transfers that exactly mirror the original lot code + full loaded liters
 *   - TESTING activity
 * - Outbound transfers exclude TESTING (sales are always outbound).
 *
 * Performance: Results are cached in memory for 10 seconds (TTL).
 * Call invalidateInstockMetricsCache(unitId) after writes that affect a unit's stock.
 */
async function getUnitInstockMetrics(db, unitId) {
  const id = Number.parseInt(unitId, 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error('unitId must be a positive integer');

  // Check cache first
  const cached = instockMetricsCache.get(id);
  if (cached !== undefined) {
    return cached;
  }

  // Execute query normally (existing logic unchanged below)
  const q = await db.query(
    `$([Environment]::NewLine)    WITH unit AS (
      SELECT id, capacity_liters
        FROM public.storage_units
       WHERE id = $1
    ),
    instock_lots AS (
      SELECT fl.id AS lot_id, fl.unit_id, fl.loaded_liters, fl.lot_code_created, fl.created_at, fl.used_liters
        FROM public.fuel_lots fl
       WHERE fl.unit_id = $1 AND fl.stock_status = 'INSTOCK'
    ),
    inbound AS (
      SELECT fit.to_lot_id AS lot_id,
             COALESCE(
               SUM(fit.transfer_volume) FILTER (
                 WHERE NOT (
                   fit.transfer_to_empty = TRUE
                   OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
                   OR (COALESCE(fit.activity,'') = 'TESTING')
                 )
               ),
               0
             ) AS inbound_added
        FROM public.fuel_internal_transfers fit
        JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
       WHERE fit.to_lot_id IN (SELECT lot_id FROM instock_lots)
       GROUP BY fit.to_lot_id
    ),
    sales AS (
      SELECT fst.lot_id,
             COALESCE(SUM(fst.sale_volume_liters), 0) AS outbound_sales
        FROM public.fuel_sale_transfers fst
       WHERE fst.lot_id IN (SELECT lot_id FROM instock_lots)
       GROUP BY fst.lot_id
    ),
    xfers AS (
      SELECT fit.from_lot_id AS lot_id,
             COALESCE(
               SUM(fit.transfer_volume) FILTER (WHERE COALESCE(fit.activity,'') <> 'TESTING'),
               0
             ) AS outbound_xfers
        FROM public.fuel_internal_transfers fit
       WHERE fit.from_lot_id IN (SELECT lot_id FROM instock_lots)
       GROUP BY fit.from_lot_id
    ),
    per_lot AS (
      SELECT l.lot_id,
             l.unit_id,
             l.loaded_liters,
             l.lot_code_created,
             l.created_at,
             l.used_liters,
             COALESCE(i.inbound_added, 0) AS inbound_added,
             COALESCE(s.outbound_sales, 0) AS outbound_sales,
             COALESCE(x.outbound_xfers, 0) AS outbound_xfers,
             GREATEST(
               0,
               COALESCE(l.loaded_liters, 0)
               + COALESCE(i.inbound_added, 0)
               - (COALESCE(s.outbound_sales, 0) + COALESCE(x.outbound_xfers, 0))
             ) AS remaining_liters
        FROM instock_lots l
        LEFT JOIN inbound i ON i.lot_id = l.lot_id
        LEFT JOIN sales s ON s.lot_id = l.lot_id
        LEFT JOIN xfers x ON x.lot_id = l.lot_id
    ),
    agg AS (
      SELECT COALESCE(SUM(remaining_liters), 0) AS total_remaining_liters
        FROM per_lot
    )
    SELECT u.capacity_liters,
           a.total_remaining_liters,
           latest.lot_id,
           latest.lot_code_created,
           latest.loaded_liters,
           latest.used_liters,
           latest.inbound_added,
           latest.outbound_sales,
           latest.outbound_xfers,
           latest.remaining_liters
      FROM agg a
      LEFT JOIN unit u ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
          FROM per_lot
         ORDER BY created_at DESC, lot_id DESC
         LIMIT 1
      ) latest ON TRUE
    `,
    [id]
  );

  const row = q.rows && q.rows[0] ? q.rows[0] : null;
  const capacityLiters = row && row.capacity_liters != null ? Number(row.capacity_liters) : 0;
  const totalRemainingLiters = row && row.total_remaining_liters != null ? Number(row.total_remaining_liters) : 0;

  const totalRemainingClampedLiters =
    capacityLiters > 0 && Number.isFinite(totalRemainingLiters)
      ? Math.min(totalRemainingLiters, capacityLiters)
      : totalRemainingLiters;

  const hasLatest = row && row.lot_id != null;
  const latestLot = hasLatest
    ? {
        id: Number(row.lot_id),
        lot_code_initial: row.lot_code_created || null,
        loaded_liters: row.loaded_liters != null ? Number(row.loaded_liters) : 0,
        used_liters: row.used_liters != null ? Number(row.used_liters) : 0,
        inbound_adds_liters: row.inbound_added != null ? Number(row.inbound_added) : 0,
        outbound_sales_liters: row.outbound_sales != null ? Number(row.outbound_sales) : 0,
        outbound_transfers_liters: row.outbound_xfers != null ? Number(row.outbound_xfers) : 0,
        outbound_used_liters:
          (row.outbound_sales != null ? Number(row.outbound_sales) : 0) +
          (row.outbound_xfers != null ? Number(row.outbound_xfers) : 0),
        remaining_liters: row.remaining_liters != null ? Number(row.remaining_liters) : 0,
      }
    : null;

  // Clamp latest remaining to capacity as well (mirrors older UI behavior)
  const latestRemainingClampedLiters =
    latestLot && capacityLiters > 0 && Number.isFinite(latestLot.remaining_liters)
      ? Math.min(latestLot.remaining_liters, capacityLiters)
      : latestLot
        ? latestLot.remaining_liters
        : null;

  const result = {
    unit_id: id,
    capacity_liters: capacityLiters,
    total_remaining_liters: totalRemainingLiters,
    total_remaining_clamped_liters: totalRemainingClampedLiters,
    latest_lot: latestLot
      ? {
          ...latestLot,
          remaining_liters_clamped: latestRemainingClampedLiters,
        }
      : null,
  };

  // Store in cache before returning
  instockMetricsCache.set(id, result);

  return result;
}

/**
 * Invalidate cached metrics for a specific unit.
 * Call this after any write operation that affects fuel lots, transfers, or sales for a unit.
 * @param {number|string} unitId
 */
function invalidateInstockMetricsCache(unitId) {
  const id = Number.parseInt(unitId, 10);
  if (Number.isFinite(id)) {
    instockMetricsCache.invalidate(id);
  }
}

/**
 * Clear the entire instock metrics cache.
 * Useful for bulk operations or administrative resets.
 */
function clearInstockMetricsCache() {
  instockMetricsCache.clear();
}

module.exports = {
  getUnitInstockMetrics,
  invalidateInstockMetricsCache,
  clearInstockMetricsCache,
};

`$([Environment]::NewLine)---



