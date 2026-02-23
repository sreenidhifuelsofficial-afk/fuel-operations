// apps/reporting-service/repositories/stockSummaryRepository.js
// ---------------------------------------------------------------------------
// SQL for the stock summary CTE query.
// Extracted from backend/index.js GET /api/fuel-ops/stock/summary (L1901).
// ---------------------------------------------------------------------------

'use strict';

const STOCK_SUMMARY_SQL = `
  WITH units AS (
    SELECT id, unit_code, unit_type, capacity_liters, vehicle_number
      FROM public.storage_units
     WHERE active=TRUE AND unit_type IN ('TRUCK','DATUM')
  ),
  lots AS (
    SELECT id AS lot_id, unit_id, loaded_liters, lot_code_created, created_at
      FROM public.fuel_lots
     WHERE stock_status='INSTOCK'
  ),
  latest AS (
    SELECT DISTINCT ON (unit_id) lot_id, unit_id, lot_code_created, created_at
      FROM lots
     ORDER BY unit_id, created_at DESC, lot_id DESC
  ),
  snaps AS (
    SELECT truck_id AS unit_id, reading_at, reading_liters,
           ROW_NUMBER() OVER (PARTITION BY truck_id ORDER BY reading_at DESC) AS rn
      FROM public.truck_dispenser_meter_snapshots
  ),
  inbound AS (
    SELECT fit.to_lot_id AS lot_id,
           COALESCE(SUM(fit.transfer_volume) FILTER (
             WHERE NOT (
               fit.transfer_to_empty = TRUE
               OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
               OR (COALESCE(fit.activity,'') = 'TESTING')
             )
           ),0) AS inbound_added
      FROM public.fuel_internal_transfers fit
      JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
     GROUP BY fit.to_lot_id
  ),
  sale_unit AS (
    SELECT fst.from_unit_id AS unit_id,
           COALESCE(SUM(
             CASE
               WHEN sn.reading_at IS NOT NULL THEN CASE WHEN COALESCE(fst.performed_at, fst.sale_date::timestamp) >= sn.reading_at THEN fst.sale_volume_liters ELSE 0 END
               ELSE fst.sale_volume_liters
             END
           ),0) AS sale_out_since,
           MAX(COALESCE(fst.performed_at, fst.sale_date::timestamp)) AS last_sale_at
      FROM public.fuel_sale_transfers fst
      LEFT JOIN (SELECT unit_id, reading_at FROM snaps WHERE rn=1) sn ON sn.unit_id = fst.from_unit_id
     GROUP BY fst.from_unit_id
  ),
  sales AS (
    SELECT lot_id, COALESCE(SUM(sale_volume_liters),0) AS sale_only
      FROM public.fuel_sale_transfers
     GROUP BY lot_id
  ),
  xfer_unit AS (
    SELECT fit.from_unit_id AS unit_id,
           COALESCE(SUM(
             CASE
               WHEN sn.reading_at IS NOT NULL THEN CASE WHEN (fit.transfer_date::timestamp + fit.transfer_time) >= sn.reading_at THEN fit.transfer_volume ELSE 0 END
               ELSE fit.transfer_volume
             END
           ),0) AS xfer_out_since,
           MAX(fit.transfer_date::timestamp + fit.transfer_time) AS last_xfer_at
      FROM public.fuel_internal_transfers fit
      LEFT JOIN (SELECT unit_id, reading_at FROM snaps WHERE rn=1) sn ON sn.unit_id = fit.from_unit_id
     WHERE COALESCE(fit.activity,'') <> 'TESTING'
     GROUP BY fit.from_unit_id
  ),
  testing_unit AS (
    SELECT tst.from_unit_id AS unit_id,
           COALESCE(SUM(
             CASE
               WHEN sn.reading_at IS NOT NULL THEN CASE WHEN COALESCE(tst.performed_at, tst.sale_date::timestamp) >= sn.reading_at THEN tst.transfer_volume_liters ELSE 0 END
               ELSE tst.transfer_volume_liters
             END
           ),0) AS test_out_since,
           MAX(COALESCE(tst.performed_at, tst.sale_date::timestamp)) AS last_test_at
      FROM public.testing_self_transfers tst
      LEFT JOIN (SELECT unit_id, reading_at FROM snaps WHERE rn=1) sn ON sn.unit_id = tst.from_unit_id
     GROUP BY tst.from_unit_id
  ),
  outbound_x AS (
    SELECT from_lot_id AS lot_id, COALESCE(SUM(transfer_volume),0) AS outbound_transfers
      FROM public.fuel_internal_transfers
     WHERE COALESCE(activity,'') <> 'TESTING'
     GROUP BY from_lot_id
  ),
  per_lot AS (
    SELECT l.unit_id, l.lot_id, l.lot_code_created, l.created_at,
           COALESCE((SELECT fl.loaded_liters FROM public.fuel_lots fl WHERE fl.id=l.lot_id),0) AS loaded_liters,
           GREATEST(0,
             COALESCE((SELECT fl.loaded_liters FROM public.fuel_lots fl WHERE fl.id=l.lot_id),0)
             + COALESCE(i.inbound_added,0)
             - (COALESCE(o.outbound_transfers,0) + COALESCE(s.sale_only,0))
           ) AS remaining
      FROM lots l
      LEFT JOIN inbound i ON i.lot_id = l.lot_id
      LEFT JOIN sales s ON s.lot_id = l.lot_id
      LEFT JOIN outbound_x o ON o.lot_id = l.lot_id
  ),
  agg AS (
    SELECT unit_id, COALESCE(SUM(remaining),0) AS instock_liters
      FROM per_lot
     GROUP BY unit_id
  )
  SELECT u.id, u.unit_code, u.unit_type, u.capacity_liters, u.vehicle_number,
         lt.lot_id, lt.lot_code_created,
         COALESCE(a.instock_liters,0) AS instock_liters,
         COALESCE(s.sale_only,0) AS sale_only_liters,
         COALESCE(sn.reading_liters, NULL) AS latest_snapshot_liters,
         COALESCE(to_char(sn.reading_at, 'YYYY-MM-DD"T"HH24:MI:SS'), NULL) AS latest_snapshot_at,
         COALESCE(su.sale_out_since,0) AS sale_out_since,
         COALESCE(xu.xfer_out_since,0) AS xfer_out_since,
         COALESCE(tu.test_out_since,0) AS test_out_since,
         to_char(
           GREATEST(
             COALESCE(su.last_sale_at, '1970-01-01'::timestamp),
             COALESCE(xu.last_xfer_at, '1970-01-01'::timestamp),
             COALESCE(tu.last_test_at, '1970-01-01'::timestamp)
           ),
           'YYYY-MM-DD"T"HH24:MI:SS'
         ) AS last_outbound_at,
         to_char(COALESCE(su.last_sale_at, '1970-01-01'::timestamp), 'YYYY-MM-DD"T"HH24:MI:SS') AS last_sale_at
    FROM units u
    LEFT JOIN latest lt ON lt.unit_id = u.id
    LEFT JOIN sales s ON s.lot_id = lt.lot_id
    LEFT JOIN agg a ON a.unit_id = u.id
    LEFT JOIN snaps sn ON sn.unit_id = u.id AND sn.rn = 1
    LEFT JOIN sale_unit su ON su.unit_id = u.id
    LEFT JOIN xfer_unit xu ON xu.unit_id = u.id
    LEFT JOIN testing_unit tu ON tu.unit_id = u.id
   ORDER BY u.unit_type, u.unit_code
`;

/**
 * Map a raw DB row to the API response shape.
 */
function mapStockSummaryRow(r) {
  return {
    id: r.id,
    unit_code: r.unit_code,
    unit_type: r.unit_type,
    capacity_liters: Number(r.capacity_liters || 0),
    vehicle_number: r.vehicle_number || null,
    lot_id: r.lot_id || null,
    lot_code_initial: r.lot_code_created || null,
    instock_liters: Number(r.instock_liters || 0),
    sale_only_liters: Number(r.sale_only_liters || 0),
    meter_reading_liters: (() => {
      const snap = r.latest_snapshot_liters != null ? Number(r.latest_snapshot_liters) : null;
      const outSince = Number(r.sale_out_since || 0) + Number(r.xfer_out_since || 0) + Number(r.test_out_since || 0);
      if (snap == null) return outSince;
      return snap + outSince;
    })(),
    latest_snapshot_liters: r.latest_snapshot_liters != null ? Number(r.latest_snapshot_liters) : null,
    latest_snapshot_at: r.latest_snapshot_at || null,
    last_sale_at: r.last_sale_at || null,
    last_outbound_at: r.last_outbound_at || null,
  };
}

module.exports = { STOCK_SUMMARY_SQL, mapStockSummaryRow };
