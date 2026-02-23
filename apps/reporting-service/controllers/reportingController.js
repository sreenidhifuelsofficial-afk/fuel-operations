// apps/reporting-service/controllers/reportingController.js
// ---------------------------------------------------------------------------
// Express Router for heavy read-only reporting endpoints:
//   GET /stock/summary     — Full stock summary across all units
//   GET /ops/day           — Consolidated per-day operations for a truck
//   GET /ops/trip          — Consolidated per-trip operations
//
// These are separated from the CRUD fuelops-service because they run
// expensive aggregate queries and can be independently scaled/cached.
// ---------------------------------------------------------------------------

'use strict';

const { Router } = require('express');
const { STOCK_SUMMARY_SQL, mapStockSummaryRow } = require('../repositories/stockSummaryRepository');
const { isolatedQuery } = require('../../../packages/query');

// Import shared helpers from the fuelops-service (same monorepo)
const { isoDateOnly, toSqlLocalTs } = require('../../fuelops-service/services/helpers');

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {Function} deps.requireAuth
 * @param {Function} deps.getUnitInstockMetrics  - From lotMetricsRepo
 */
function createReportingController({ pool, requireAuth, getUnitInstockMetrics }) {
  const router = Router();

  // Cached date column resolver (load_date vs loaded_date)
  let FUEL_LOTS_DATE_COL = null;
  async function resolveFuelLotsDateCol() {
    if (FUEL_LOTS_DATE_COL) return FUEL_LOTS_DATE_COL;
    try {
      const q = await pool.query(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='fuel_lots'
             AND column_name IN ('load_date','loaded_date')
           ORDER BY CASE column_name WHEN 'load_date' THEN 1 ELSE 2 END LIMIT 1`
      );
      FUEL_LOTS_DATE_COL = (q.rows[0] && q.rows[0].column_name) || 'loaded_date';
    } catch { FUEL_LOTS_DATE_COL = 'loaded_date'; }
    return FUEL_LOTS_DATE_COL;
  }

  // =========================================================================
  // GET /stock/summary
  // =========================================================================
  router.get('/stock/summary', requireAuth, async (req, res) => {
    try {
      const rows = await isolatedQuery(STOCK_SUMMARY_SQL);
      const items = rows.rows.map(mapStockSummaryRow);
      res.json({ items, generatedAt: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =========================================================================
  // GET /ops/day
  // =========================================================================
  router.get('/ops/day', requireAuth, async (req, res) => {
    try {
      const truckId = parseInt(req.query.truck_id, 10);
      const dateStrRaw = req.query.date || new Date();
      const dateStr = isoDateOnly(dateStrRaw);
      if (!Number.isFinite(truckId) || truckId <= 0)
        return res.status(400).json({ error: 'truck_id required' });
      if (!dateStr) return res.status(400).json({ error: 'invalid date' });

      // Current in-stock lot + remaining liters
      let lotInfo = null;
      let remainingLiters = null;
      if (getUnitInstockMetrics) {
        try {
          const m = await getUnitInstockMetrics(pool, truckId);
          if (m.latest_lot) {
            lotInfo = {
              id: m.latest_lot.id,
              lot_code_initial: m.latest_lot.lot_code_initial,
              loaded_liters: m.latest_lot.loaded_liters,
              used_liters: m.latest_lot.used_liters,
              inbound_adds_liters: m.latest_lot.inbound_adds_liters,
              outbound_used_liters: m.latest_lot.outbound_used_liters,
              remaining_liters: m.latest_lot.remaining_liters_clamped,
            };
            remainingLiters = m.latest_lot.remaining_liters_clamped;
          }
        } catch (e) {
          if (!process.env.SUPPRESS_DB_LOG) console.warn('[ops/day metrics warn]', e.message);
        }
      }

      // Day-filtered operations
      const salesQ = await isolatedQuery(
        `SELECT id, from_unit_id, from_unit_code, to_vehicle, sale_volume_liters, lot_code_after, driver_name, performed_at,
                TO_CHAR(performed_at, 'HH24:MI') AS performed_time, sale_date, activity
           FROM public.fuel_sale_transfers
          WHERE from_unit_id=$1 AND COALESCE(sale_date, performed_at::date) = $2::date
          ORDER BY COALESCE(performed_at, sale_date) ASC, id ASC`,
        [truckId, dateStr]
      );
      const transfersOutQ = await isolatedQuery(
        `SELECT id, from_unit_id, from_unit_code, to_unit_id, to_unit_code, transfer_volume, from_lot_code_change, to_lot_code_change, transfer_to_empty, driver_name, transfer_date, transfer_time, activity, trip
           FROM public.fuel_internal_transfers
          WHERE from_unit_id=$1 AND transfer_date = $2::date
          ORDER BY transfer_date ASC, transfer_time ASC, id ASC`,
        [truckId, dateStr]
      );
      const transfersInQ = await isolatedQuery(
        `SELECT id, from_unit_id, from_unit_code, to_unit_id, to_unit_code, transfer_volume, from_lot_code_change, to_lot_code_change, transfer_to_empty, driver_name, transfer_date, transfer_time, activity, trip
           FROM public.fuel_internal_transfers
          WHERE to_unit_id=$1 AND transfer_date = $2::date
          ORDER BY transfer_date ASC, transfer_time ASC, id ASC`,
        [truckId, dateStr]
      );
      const dateCol = await resolveFuelLotsDateCol();
      const loadsQ = await isolatedQuery(
        `SELECT id, lot_code_created AS lot_code_initial, loaded_liters, ${dateCol} AS load_date, created_at, load_time, seq_index, load_type
           FROM public.fuel_lots
          WHERE unit_id=$1 AND ${dateCol} = $2::date
          ORDER BY COALESCE(load_time, created_at) ASC, id ASC`,
        [truckId, dateStr]
      );

      let testingQ = { rows: [] };
      try {
        testingQ = await isolatedQuery(`
          SELECT id, lot_id, from_unit_id, transfer_volume_liters AS testing_volume_liters, performed_at, activity
            FROM public.testing_self_transfers
           WHERE from_unit_id=$1 AND performed_at::date = $2::date
           ORDER BY performed_at ASC, id ASC
        `, [truckId, dateStr]);
      } catch (e) {
        if (!process.env.SUPPRESS_DB_LOG) console.warn('[ops/day testing warn]', e.message);
      }

      const totals = {
        sales_liters: salesQ.rows.reduce((a, r) => a + Number(r.sale_volume_liters || 0), 0),
        transfers_out_liters: transfersOutQ.rows.reduce((a, r) => a + Number(r.transfer_volume || 0), 0),
        transfers_in_liters: transfersInQ.rows.reduce((a, r) => a + Number(r.transfer_volume || 0), 0),
        loaded_liters: loadsQ.rows.reduce((a, r) => a + Number(r.loaded_liters || 0), 0),
        testing_liters: testingQ.rows.reduce((a, r) => a + Number(r.testing_volume_liters || 0), 0),
      };

      res.json({
        truck_id: truckId,
        date: dateStr,
        lot: lotInfo,
        remaining_liters: remainingLiters,
        totals,
        sales: salesQ.rows,
        transfers_out: transfersOutQ.rows,
        transfers_in: transfersInQ.rows,
        loads: loadsQ.rows,
        testing: testingQ.rows,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =========================================================================
  // GET /ops/trip
  // =========================================================================
  router.get('/ops/trip', requireAuth, async (req, res) => {
    try {
      const truckId = parseInt(req.query.truck_id, 10);
      const dateStr = isoDateOnly(req.query.date || new Date());
      const tripNo = parseInt(req.query.trip_no, 10);
      if (!Number.isFinite(truckId) || truckId <= 0)
        return res.status(400).json({ error: 'truck_id required' });
      if (!dateStr) return res.status(400).json({ error: 'invalid date' });
      if (!Number.isFinite(tripNo) || tripNo <= 0)
        return res.status(400).json({ error: 'trip_no required' });

      const tripQ = await isolatedQuery(
        `SELECT * FROM public.truck_dispenser_trips WHERE truck_id=$1 AND reading_date=$2 AND trip_no=$3`,
        [truckId, dateStr, tripNo]
      );
      if (!tripQ.rows.length) return res.status(404).json({ error: 'trip not found' });
      const trip = tripQ.rows[0];
      const dateCol = await resolveFuelLotsDateCol();

      const nextQ = await isolatedQuery(
        `SELECT opening_at FROM public.truck_dispenser_trips
          WHERE truck_id=$1 AND reading_date=$2 AND trip_no > $3
          ORDER BY trip_no ASC LIMIT 1`,
        [truckId, dateStr, tripNo]
      );
      const defaultStart = `${dateStr} 00:00:00`;
      const defaultEnd = `${dateStr} 23:59:59`;

      // If opening not recorded, return empty ops with loads only
      if (!trip.opening_at) {
        const loadsQ = await isolatedQuery(
          `SELECT id, lot_code_created AS lot_code_initial, loaded_liters, ${dateCol} AS load_date, created_at, load_time, seq_index, load_type
             FROM public.fuel_lots
            WHERE unit_id=$1 AND ${dateCol} = $2::date
            ORDER BY COALESCE(load_time, created_at) ASC, id ASC`,
          [truckId, dateStr]
        );
        return res.json({
          truck_id: truckId,
          date: dateStr,
          trip_no: tripNo,
          trip,
          totals: {
            sales_liters: 0,
            transfers_out_liters: 0,
            transfers_in_liters: 0,
            loaded_liters: loadsQ.rows.reduce((a, r) => a + Number(r.loaded_liters || 0), 0),
            testing_liters: 0,
          },
          sales: [],
          transfers_out: [],
          transfers_in: [],
          loads: loadsQ.rows,
          testing: [],
        });
      }

      const startSQL = toSqlLocalTs(trip.opening_at) || defaultStart;
      const endSQL = trip.closing_at
        ? (toSqlLocalTs(trip.closing_at) || defaultEnd)
        : (nextQ.rows.length && nextQ.rows[0].opening_at
            ? (toSqlLocalTs(nextQ.rows[0].opening_at) || defaultEnd)
            : defaultEnd);

      const salesQ = await isolatedQuery(
        `SELECT id, from_unit_id, from_unit_code, to_vehicle, sale_volume_liters, lot_code_after, driver_name, performed_at, sale_date, activity
           FROM public.fuel_sale_transfers
          WHERE from_unit_id=$1 AND performed_at >= $2::timestamp AND performed_at < $3::timestamp
          ORDER BY COALESCE(performed_at, sale_date) ASC, id ASC`,
        [truckId, startSQL, endSQL]
      );
      const transfersOutQ = await isolatedQuery(
        `SELECT id, from_unit_id, from_unit_code, to_unit_id, to_unit_code, transfer_volume, from_lot_code_change, to_lot_code_change, transfer_to_empty, driver_name, transfer_date, transfer_time, activity, trip
           FROM public.fuel_internal_transfers
          WHERE from_unit_id=$1 AND (transfer_date::timestamp + transfer_time) >= $2::timestamp AND (transfer_date::timestamp + transfer_time) < $3::timestamp
          ORDER BY transfer_date ASC, transfer_time ASC, id ASC`,
        [truckId, startSQL, endSQL]
      );
      const transfersInQ = await isolatedQuery(
        `SELECT id, from_unit_id, from_unit_code, to_unit_id, to_unit_code, transfer_volume, from_lot_code_change, to_lot_code_change, transfer_to_empty, driver_name, transfer_date, transfer_time, activity, trip
           FROM public.fuel_internal_transfers
          WHERE to_unit_id=$1 AND (transfer_date::timestamp + transfer_time) >= $2::timestamp AND (transfer_date::timestamp + transfer_time) < $3::timestamp
          ORDER BY transfer_date ASC, transfer_time ASC, id ASC`,
        [truckId, startSQL, endSQL]
      );

      let testingQ = { rows: [] };
      try {
        testingQ = await isolatedQuery(`
          SELECT id, lot_id, from_unit_id, transfer_volume_liters AS testing_volume_liters, performed_at, activity
            FROM public.testing_self_transfers
           WHERE from_unit_id=$1 AND performed_at >= $2::timestamp AND performed_at < $3::timestamp
           ORDER BY performed_at ASC, id ASC
        `, [truckId, startSQL, endSQL]);
      } catch (e) {
        if (!process.env.SUPPRESS_DB_LOG) console.warn('[ops/trip testing warn]', e.message);
      }

      const loadsQ = await isolatedQuery(
        `SELECT id, lot_code_created AS lot_code_initial, loaded_liters, ${dateCol} AS load_date, created_at, load_time, seq_index, load_type
           FROM public.fuel_lots
          WHERE unit_id=$1 AND ${dateCol} = $2::date
          ORDER BY COALESCE(load_time, created_at) ASC, id ASC`,
        [truckId, dateStr]
      );

      // Determine current in-stock lot
      let lotInfo = null;
      let remainingLiters = null;
      if (getUnitInstockMetrics) {
        try {
          const m = await getUnitInstockMetrics(pool, truckId);
          remainingLiters = m.total_remaining_clamped_liters;
          if (m.latest_lot) {
            lotInfo = {
              id: m.latest_lot.id,
              lot_code_initial: m.latest_lot.lot_code_initial,
              loaded_liters: m.latest_lot.loaded_liters,
              used_liters: m.latest_lot.used_liters,
              inbound_adds_liters: m.latest_lot.inbound_adds_liters,
              outbound_used_liters: m.latest_lot.outbound_used_liters,
              remaining_liters: m.latest_lot.remaining_liters_clamped,
            };
          }
        } catch (e) {
          if (!process.env.SUPPRESS_DB_LOG) console.warn('[ops/trip metrics warn]', e.message);
        }
      }

      const totals = {
        sales_liters: salesQ.rows.reduce((a, r) => a + Number(r.sale_volume_liters || 0), 0),
        transfers_out_liters: transfersOutQ.rows.reduce((a, r) => a + Number(r.transfer_volume || 0), 0),
        transfers_in_liters: transfersInQ.rows.reduce((a, r) => a + Number(r.transfer_volume || 0), 0),
        loaded_liters: loadsQ.rows.reduce((a, r) => a + Number(r.loaded_liters || 0), 0),
        testing_liters: testingQ.rows.reduce((a, r) => a + Number(r.testing_volume_liters || 0), 0),
      };

      res.json({
        truck_id: truckId,
        date: dateStr,
        trip_no: tripNo,
        trip,
        totals,
        lot: lotInfo,
        remaining_liters: remainingLiters,
        sales: salesQ.rows,
        transfers_out: transfersOutQ.rows,
        transfers_in: transfersInQ.rows,
        loads: loadsQ.rows,
        testing: testingQ.rows,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createReportingController };
