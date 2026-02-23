// apps/fuelops-service/controllers/meterController.js
// ---------------------------------------------------------------------------
// Express Router for meter snapshots and daily reconciliation.
// Ported 1:1 from backend/index.js.
//
// Routes:
//   POST   /meter-snapshots
//   GET    /meter-snapshots
//   GET    /reconcile/daily
// ---------------------------------------------------------------------------

'use strict';

const { Router } = require('express');

function createMeterController({ pool, requireAuth }) {
  const router = Router();

  const { getActor, round3, isoDateOnly, isValidDateTimeString, fmtSqlTsLocal, coerceLocalSqlTimestamp } = require('../services/helpers');

  // Helper to convert an arbitrary timestamp value to a local SQL string.
  function toSqlLocalTs(v) {
    if (!v) return null;
    const s = String(v);
    const coerced = coerceLocalSqlTimestamp(s);
    if (coerced) return coerced;
    return s.replace('T', ' ').slice(0, 19);
  }

  // -----------------------------------------------------------------------
  // POST /meter-snapshots
  // -----------------------------------------------------------------------
  router.post('/meter-snapshots', requireAuth, async (req, res) => {
    try {
      const { truck_id, reading_liters, reading_at, note } = req.body || {};
      const tid = parseInt(truck_id, 10);
      const val = round3(Number(reading_liters));
      if (!Number.isFinite(tid) || tid <= 0) return res.status(400).json({ error: 'truck_id required' });
      if (!Number.isFinite(val) || val < 0) return res.status(400).json({ error: 'reading_liters must be >= 0' });
      let tsSql = null;
      if (reading_at) {
        if (!isValidDateTimeString(String(reading_at))) return res.status(400).json({ error: 'reading_at invalid' });
        tsSql = coerceLocalSqlTimestamp(String(reading_at));
        if (!tsSql) return res.status(400).json({ error: 'reading_at invalid' });
      } else {
        tsSql = fmtSqlTsLocal(new Date());
      }
      const su = await pool.query(`SELECT id, unit_type FROM public.storage_units WHERE id=$1`, [tid]);
      if (!su.rows.length) return res.status(400).json({ error: 'Unknown storage unit' });
      if (!['TRUCK', 'DATUM'].includes(su.rows[0].unit_type)) return res.status(400).json({ error: 'Unsupported unit type for meter snapshot' });
      const r = await pool.query(`
        INSERT INTO public.truck_dispenser_meter_snapshots (truck_id, reading_at, reading_liters, source, note, created_by, created_by_user_id)
        VALUES ($1,$2,$3,'SNAPSHOT',$4,$5,$6)
        RETURNING id, truck_id, to_char(reading_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS reading_at, reading_liters, source, note, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
      `, [tid, tsSql, val, note || null, getActor(req), req.user?.sub || null]);
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // GET /meter-snapshots
  // -----------------------------------------------------------------------
  router.get('/meter-snapshots', requireAuth, async (req, res) => {
    try {
      const tid = parseInt(req.query.truck_id, 10);
      const fromStr = req.query.from ? String(req.query.from) : null;
      const toStr = req.query.to ? String(req.query.to) : null;
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '200', 10) || 200));
      if (!Number.isFinite(tid) || tid <= 0) return res.status(400).json({ error: 'truck_id required' });
      const params = [tid];
      let where = ' WHERE truck_id = $1';
      if (fromStr && isValidDateTimeString(fromStr)) {
        const fSql = coerceLocalSqlTimestamp(fromStr);
        if (fSql) { params.push(fSql); where += ` AND reading_at >= $${params.length}`; }
      }
      if (toStr && isValidDateTimeString(toStr)) {
        const tSql = coerceLocalSqlTimestamp(toStr);
        if (tSql) { params.push(tSql); where += ` AND reading_at <= $${params.length}`; }
      }
      const sql = `SELECT id, truck_id, to_char(reading_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS reading_at, reading_liters, source, note, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at FROM public.truck_dispenser_meter_snapshots ${where} ORDER BY reading_at DESC LIMIT ${limit}`;
      const r = await pool.query(sql, params);
      res.json({ items: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // GET /reconcile/daily
  // -----------------------------------------------------------------------
  router.get('/reconcile/daily', requireAuth, async (req, res) => {
    try {
      const truckId = parseInt(req.query.truck_id, 10);
      const dateStr = isoDateOnly(req.query.date || new Date());
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      if (!dateStr) return res.status(400).json({ error: 'date invalid' });

      let O = 0, C = 0;
      let openSQL = null, closeSQL = null;
      let meterDeltaAvailable = false;
      let Lrow = null;
      try {
        const logsQ = await pool.query(`SELECT * FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
        if (logsQ.rows.length) {
          Lrow = logsQ.rows[0];
          O = Number(Lrow.opening_liters || 0);
          C = Number(Lrow.closing_liters || 0);
          meterDeltaAvailable = (Lrow.opening_liters != null && Lrow.closing_liters != null);
          openSQL = Lrow.opening_at ? toSqlLocalTs(Lrow.opening_at) : `${dateStr} 00:00:00`;
          closeSQL = Lrow.closing_at ? toSqlLocalTs(Lrow.closing_at) : `${dateStr} 23:59:59`;
        }
      } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[reconcile logs lookup warn]', e.message); }

      const dayStart = `${dateStr} 00:00:00`;
      const dayEnd = `${dateStr} 23:59:59`;
      if (!openSQL) openSQL = dayStart;
      if (!closeSQL) closeSQL = dayEnd;

      const salesQ = await pool.query(
        `SELECT COALESCE(SUM(sale_volume_liters),0)::numeric AS s FROM public.fuel_sale_transfers WHERE from_unit_id=$1 AND performed_at >= $2::timestamp AND performed_at <= $3::timestamp`,
        [truckId, openSQL, closeSQL]
      );
      const S = Number(salesQ.rows[0]?.s || 0);

      const toutQ = await pool.query(
        `SELECT COALESCE(SUM(transfer_volume),0)::numeric AS t FROM public.fuel_internal_transfers WHERE from_unit_id=$1 AND COALESCE(activity,'') <> 'TESTING' AND (transfer_date::timestamp + transfer_time) >= $2::timestamp AND (transfer_date::timestamp + transfer_time) <= $3::timestamp`,
        [truckId, openSQL, closeSQL]
      );
      const tinQ = await pool.query(
        `SELECT COALESCE(SUM(transfer_volume),0)::numeric AS t FROM public.fuel_internal_transfers WHERE to_unit_id=$1 AND COALESCE(activity,'') <> 'TESTING' AND (transfer_date::timestamp + transfer_time) >= $2::timestamp AND (transfer_date::timestamp + transfer_time) <= $3::timestamp`,
        [truckId, openSQL, closeSQL]
      );
      const T_out = Number(toutQ.rows[0]?.t || 0);
      const T_in = Number(tinQ.rows[0]?.t || 0);

      const testingTransfersQ = await pool.query(
        `SELECT COALESCE((SELECT SUM(transfer_volume_liters) FROM public.testing_self_transfers WHERE from_unit_id=$1 AND performed_at >= $2::timestamp AND performed_at <= $3::timestamp),0) AS t`,
        [truckId, openSQL, closeSQL]
      );
      const T_test = (Lrow ? Number(Lrow.testing_used_liters || 0) : 0) + Number(testingTransfersQ.rows[0]?.t || 0);

      const deltaM = meterDeltaAvailable ? Number((C - O).toFixed(3)) : null;
      const deltaE = Number((S + T_out + T_test).toFixed(3));
      const delta = (deltaM == null) ? null : Number((deltaM - deltaE).toFixed(3));

      let note = null;
      if (delta == null) note = 'Meter delta unavailable (no day reading or insufficient snapshots)';
      else if (delta > 0) note = `Meter reading is more by ${Math.abs(delta)} than transfers and sales`;
      else if (delta < 0) note = `Meter reading is less by ${Math.abs(delta)} than transfers and sales`;
      else note = 'Meter matches transfers and sales';

      res.json({
        truck_id: truckId, date: dateStr, opening: O, opening_at: openSQL, closing: C, closing_at: closeSQL, sales: S, transfers_out: T_out, transfers_in: T_in, testing_used_liters: T_test, delta_meter: deltaM, delta_expected: deltaE, delta_difference: delta, note
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createMeterController };
