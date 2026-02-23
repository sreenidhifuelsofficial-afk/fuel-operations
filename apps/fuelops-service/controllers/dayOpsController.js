// apps/fuelops-service/controllers/dayOpsController.js
// ---------------------------------------------------------------------------
// Express Router for daily dispenser, logs, and odometer routes.
// Ported 1:1 from backend/index.js.
//
// Routes:
//   GET    /opening-suggestion/odometer
//   GET    /day/dispenser
//   POST   /day/dispenser
//   PATCH  /day/dispenser
//   GET    /day/logs
//   GET    /day/logs/list
//   POST   /day/logs
//   PATCH  /day/logs/:id
//   DELETE /day/logs/:id
//   GET    /day/odometer
//   POST   /day/odometer
//   PATCH  /day/odometer
//   GET    /day/odometer/list
//   DELETE /day/odometer
// ---------------------------------------------------------------------------

'use strict';

const { Router } = require('express');

function createDayOpsController({ pool, requireAuth }) {
  const router = Router();

  const { getActor, isoDateOnly, parseLiters3, coerceLocalSqlTimestamp, isValidDateTimeString } = require('../services/helpers');

  // -----------------------------------------------------------------------
  // GET /opening-suggestion/odometer
  // -----------------------------------------------------------------------
  router.get('/opening-suggestion/odometer', requireAuth, async (req, res) => {
    try {
      const truckId = parseInt(req.query.truck_id, 10);
      const dateStr = isoDateOnly(req.query.date || new Date());
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      const r = await pool.query(
        `SELECT closing_km, reading_date FROM public.truck_odometer_day_readings WHERE truck_id=$1 AND reading_date < $2::date ORDER BY reading_date DESC LIMIT 1`,
        [truckId, dateStr]
      );
      if (r.rows.length) return res.json({ opening: r.rows[0].closing_km, source: 'yesterday', date: r.rows[0].reading_date });
      res.json({ opening: null, source: 'first' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // GET /day/dispenser
  // -----------------------------------------------------------------------
  router.get('/day/dispenser', requireAuth, async (req, res) => {
    try {
      const truckId = parseInt(req.query.truck_id, 10);
      const dateStr = isoDateOnly(req.query.date || new Date());
      const r = await pool.query(`SELECT * FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
      res.json(r.rows[0] || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // POST /day/dispenser — create + meter snapshots
  // -----------------------------------------------------------------------
  router.post('/day/dispenser', requireAuth, async (req, res) => {
    try {
      const { truck_id, date, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code } = req.body || {};
      const truckId = parseInt(truck_id, 10);
      const dateStr = isoDateOnly(date || new Date());
      const open = Number(opening_liters);
      const close = (closing_liters == null) ? null : Number(closing_liters);
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      if (!Number.isFinite(open) || open < 0) return res.status(400).json({ error: 'opening_liters invalid' });
      if (close != null && (!Number.isFinite(close) || close < open)) return res.status(400).json({ error: 'closing_liters must be >= opening' });
      const exists = await pool.query(`SELECT 1 FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
      if (exists.rowCount > 0) {
        const [y, m, d] = dateStr.split('-');
        return res.status(409).json({ error: `readings are submitted for ${d}/${m}/${y}. to edit go to edit button.` });
      }
      const openingSql = (opening_at && isValidDateTimeString(String(opening_at)))
        ? (coerceLocalSqlTimestamp(String(opening_at)) || String(opening_at).replace('T', ' ').slice(0, 19))
        : `${dateStr} 00:00:00`;
      const closingSql = (close != null && closing_at && isValidDateTimeString(String(closing_at)))
        ? (coerceLocalSqlTimestamp(String(closing_at)) || String(closing_at).replace('T', ' ').slice(0, 19))
        : null;
      const su = await pool.query(`SELECT unit_code FROM public.storage_units WHERE id=$1`, [truckId]);
      const truckCode = su.rows.length ? su.rows[0].unit_code : null;
      const r = await pool.query(
        `INSERT INTO public.dispenser_day_reading_logs (truck_id, truck_code, reading_date, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code, created_by, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [truckId, truckCode, dateStr, open, close, openingSql, closingSql, note || null, driver_name || null, driver_code || null, getActor(req), req.user?.sub || null]
      );
      try {
        await pool.query(`INSERT INTO public.truck_dispenser_meter_snapshots (truck_id, reading_at, reading_liters, source, note, created_by, created_by_user_id) VALUES ($1,$2,$3,'OPENING',$4,$5,$6)`, [truckId, openingSql, open, 'Opening snapshot', getActor(req), req.user?.sub || null]);
        if (closingSql) await pool.query(`INSERT INTO public.truck_dispenser_meter_snapshots (truck_id, reading_at, reading_liters, source, note, created_by, created_by_user_id) VALUES ($1,$2,$3,'CLOSING',$4,$5,$6)`, [truckId, closingSql, close, 'Closing snapshot', getActor(req), req.user?.sub || null]);
      } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[snapshots insert warn]', e.message); }
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // PATCH /day/dispenser — edit with adjustment snapshots
  // -----------------------------------------------------------------------
  router.patch('/day/dispenser', requireAuth, async (req, res) => {
    try {
      const { truck_id, date, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code } = req.body || {};
      const truckId = parseInt(truck_id, 10);
      const dateStr = isoDateOnly(date || new Date());
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      const existingQ = await pool.query(`SELECT * FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
      if (!existingQ.rows.length) return res.status(404).json({ error: 'day reading not found' });
      const existing = existingQ.rows[0];
      const open = opening_liters != null ? Number(opening_liters) : Number(existing.opening_liters);
      const close = closing_liters != null ? Number(closing_liters) : Number(existing.closing_liters);
      if (!Number.isFinite(open) || open < 0) return res.status(400).json({ error: 'opening_liters invalid' });
      if (close != null && (!Number.isFinite(close) || close < open)) return res.status(400).json({ error: 'closing_liters must be >= opening' });
      const resolvedOpeningAt = opening_at != null ? String(opening_at) : (existing.opening_at ? String(existing.opening_at) : `${dateStr} 00:00:00`);
      const resolvedClosingAt = closing_at != null ? String(closing_at) : (existing.closing_at ? String(existing.closing_at) : null);
      const openingSql = coerceLocalSqlTimestamp(resolvedOpeningAt) || resolvedOpeningAt.replace('T', ' ').slice(0, 19);
      const closingSql = resolvedClosingAt ? (coerceLocalSqlTimestamp(resolvedClosingAt) || resolvedClosingAt.replace('T', ' ').slice(0, 19)) : null;
      const parts = []; const vals = []; let idx = 1;
      parts.push(`opening_liters=$${idx++}`); vals.push(open);
      parts.push(`closing_liters=$${idx++}`); vals.push(close != null ? close : null);
      parts.push(`opening_at=$${idx++}`); vals.push(openingSql);
      parts.push(`closing_at=$${idx++}`); vals.push(closingSql);
      parts.push(`note=$${idx++}`); vals.push(note != null ? note : existing.note);
      parts.push(`driver_name=$${idx++}`); vals.push(driver_name != null ? driver_name : existing.driver_name);
      parts.push(`driver_code=$${idx++}`); vals.push(driver_code != null ? driver_code : existing.driver_code);
      parts.push(`updated_at=NOW()`);
      vals.push(truckId); vals.push(dateStr);
      const upd = await pool.query(`UPDATE public.dispenser_day_reading_logs SET ${parts.join(', ')} WHERE truck_id=$${idx++} AND reading_date=$${idx} RETURNING *`, vals);
      if (!upd.rows.length) return res.status(404).json({ error: 'not found' });
      try {
        const changedOpening = open !== Number(existing.opening_liters);
        const changedClosing = (close != null && close !== Number(existing.closing_liters));
        if (changedOpening) await pool.query(`INSERT INTO public.truck_dispenser_meter_snapshots (truck_id, reading_at, reading_liters, source, note, created_by, created_by_user_id) VALUES ($1,$2,$3,'OPENING_EDIT',$4,$5,$6)`, [truckId, openingSql, open, 'Edited opening liters', getActor(req), req.user?.sub || null]);
        if (changedClosing) await pool.query(`INSERT INTO public.truck_dispenser_meter_snapshots (truck_id, reading_at, reading_liters, source, note, created_by, created_by_user_id) VALUES ($1,$2,$3,'CLOSING_EDIT',$4,$5,$6)`, [truckId, closingSql, close, 'Edited closing liters', getActor(req), req.user?.sub || null]);
      } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[edit snapshots warn]', e.message); }
      res.json(upd.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // GET /day/logs
  // -----------------------------------------------------------------------
  router.get('/day/logs', requireAuth, async (req, res) => {
    try {
      const truckId = parseInt(req.query.truck_id, 10);
      const dateStr = isoDateOnly(req.query.date || new Date());
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      if (!dateStr) return res.status(400).json({ error: 'invalid date' });
      const r = await pool.query(
        `SELECT id, truck_id, reading_date, opening_liters, closing_liters, opening_at::text AS opening_at, closing_at::text AS closing_at, note, driver_name, driver_code, created_by, created_by_user_id, created_at::text AS created_at, updated_at::text AS updated_at FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`,
        [truckId, dateStr]
      );
      res.json(r.rows[0] || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // GET /day/logs/list
  // -----------------------------------------------------------------------
  router.get('/day/logs/list', requireAuth, async (req, res) => {
    try {
      const truckId = parseInt(req.query.truck_id, 10);
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      const limitRaw = (req.query.limit != null && req.query.limit !== '') ? parseInt(req.query.limit, 10) : null;
      const limit = (Number.isFinite(limitRaw) && limitRaw > 0) ? Math.min(limitRaw, 1000) : null;
      const sql = `SELECT id, truck_id, reading_date, opening_liters, closing_liters, opening_at::text AS opening_at, closing_at::text AS closing_at, note, driver_name, driver_code, created_by, created_by_user_id, created_at::text AS created_at, updated_at::text AS updated_at FROM public.dispenser_day_reading_logs WHERE truck_id=$1 ORDER BY reading_date DESC${limit ? ' LIMIT $2' : ''}`;
      const r = await pool.query(sql, limit ? [truckId, limit] : [truckId]);
      res.json({ items: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // POST /day/logs
  // -----------------------------------------------------------------------
  router.post('/day/logs', requireAuth, async (req, res) => {
    try {
      const { truck_id, date, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code } = req.body || {};
      const truckId = parseInt(truck_id, 10);
      const dateStr = isoDateOnly(date || new Date());
      const open = Number(opening_liters);
      const close = (closing_liters == null) ? null : Number(closing_liters);
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      if (!Number.isFinite(open) || open < 0) return res.status(400).json({ error: 'opening_liters invalid' });
      if (close != null && (!Number.isFinite(close) || close < open)) return res.status(400).json({ error: 'closing_liters must be >= opening' });
      const exists = await pool.query(`SELECT 1 FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
      if (exists.rowCount > 0) return res.status(409).json({ error: 'readings already submitted for this date' });
      let truckCode = null;
      try { const su = await pool.query(`SELECT unit_code FROM public.storage_units WHERE id=$1`, [truckId]); truckCode = su.rows.length ? su.rows[0].unit_code : null; } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[day/logs truck_code lookup warn]', e.message); }
      let openingSql = null;
      let closingSql = null;
      if (opening_at) openingSql = coerceLocalSqlTimestamp(String(opening_at));
      if (!openingSql) openingSql = `${dateStr} 00:00:00`;
      if (closing_at) closingSql = coerceLocalSqlTimestamp(String(closing_at));
      const r = await pool.query(
        `INSERT INTO public.dispenser_day_reading_logs (truck_id, truck_code, reading_date, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code, created_by, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id, truck_id, reading_date, opening_liters, closing_liters, opening_at::text AS opening_at, closing_at::text AS closing_at, note, driver_name, driver_code, created_by, created_by_user_id, created_at::text AS created_at, updated_at::text AS updated_at`,
        [truckId, truckCode, dateStr, open, close, openingSql, closingSql, note || null, driver_name || null, driver_code || null, getActor(req), req.user?.sub || null]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // PATCH /day/logs/:id
  // -----------------------------------------------------------------------
  router.patch('/day/logs/:id', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const { opening_liters, closing_liters, opening_at, closing_at, note } = req.body || {};
      const oldQ = await pool.query(
        `SELECT id, truck_id, reading_date, opening_liters, closing_liters, opening_at::text AS opening_at, closing_at::text AS closing_at, note, driver_name, driver_code, created_by, created_by_user_id, created_at::text AS created_at, updated_at::text AS updated_at FROM public.dispenser_day_reading_logs WHERE id=$1`, [id]
      );
      if (!oldQ.rows.length) return res.status(404).json({ error: 'not found' });
      const parts = []; const vals = []; let idx = 1;
      if (opening_liters != null) { const v = parseLiters3(opening_liters); if (!Number.isFinite(v)) return res.status(400).json({ error: 'invalid opening_liters' }); parts.push(`opening_liters=$${idx++}`); vals.push(v); }
      if (closing_liters != null) { const v = parseLiters3(closing_liters); if (!Number.isFinite(v)) return res.status(400).json({ error: 'invalid closing_liters' }); parts.push(`closing_liters=$${idx++}`); vals.push(v); }
      if (opening_at) { const c = coerceLocalSqlTimestamp(String(opening_at)); parts.push(`opening_at=$${idx++}`); vals.push(c || String(opening_at).replace('T', ' ').slice(0, 19)); }
      if (closing_at) { const c = coerceLocalSqlTimestamp(String(closing_at)); parts.push(`closing_at=$${idx++}`); vals.push(c || String(closing_at).replace('T', ' ').slice(0, 19)); }
      if (note !== undefined) { parts.push(`note=$${idx++}`); vals.push(note || null); }
      if (!parts.length) return res.status(400).json({ error: 'no fields to update' });
      parts.push(`updated_at=NOW()`);
      vals.push(id);
      const r = await pool.query(
        `UPDATE public.dispenser_day_reading_logs SET ${parts.join(', ')} WHERE id=$${idx} RETURNING id, truck_id, reading_date, opening_liters, closing_liters, opening_at::text AS opening_at, closing_at::text AS closing_at, note, driver_name, driver_code, created_by, created_by_user_id, created_at::text AS created_at, updated_at::text AS updated_at`,
        vals
      );
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // DELETE /day/logs/:id
  // -----------------------------------------------------------------------
  router.delete('/day/logs/:id', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const del = await pool.query(
        `DELETE FROM public.dispenser_day_reading_logs WHERE id=$1 RETURNING id, truck_id, reading_date, opening_liters, closing_liters, opening_at::text AS opening_at, closing_at::text AS closing_at, note, driver_name, driver_code, created_by, created_by_user_id, created_at::text AS created_at, updated_at::text AS updated_at`,
        [id]
      );
      if (!del.rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, deleted_id: del.rows[0].id, truck_id: del.rows[0].truck_id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // GET /day/odometer
  // -----------------------------------------------------------------------
  router.get('/day/odometer', requireAuth, async (req, res) => {
    try {
      const truckId = parseInt(req.query.truck_id, 10);
      const dateStr = isoDateOnly(req.query.date || new Date());
      const r = await pool.query(`SELECT * FROM public.truck_odometer_day_readings WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
      res.json(r.rows[0] || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // POST /day/odometer
  // -----------------------------------------------------------------------
  router.post('/day/odometer', requireAuth, async (req, res) => {
    try {
      const { truck_id, date, opening_km, closing_km, note, driver_name, driver_code, opening_time, closing_time, opening_at, closing_at } = req.body || {};
      const truckId = parseInt(truck_id, 10);
      const dateStr = isoDateOnly(date || new Date());
      const open = Number(opening_km);
      const close = Number(closing_km);
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      if (!Number.isFinite(open) || open < 0) return res.status(400).json({ error: 'opening_km invalid' });
      if (!Number.isFinite(close) || close < open) return res.status(400).json({ error: 'closing_km must be >= opening' });
      const exists = await pool.query(`SELECT 1 FROM public.truck_odometer_day_readings WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
      if (exists.rowCount > 0) {
        const [y, m, d] = dateStr.split('-');
        return res.status(409).json({ error: `readings are submitted for ${d}/${m}/${y}. to edit go to edit button.` });
      }
      function buildTs(hhmm, overrideTs) {
        try {
          if (overrideTs) return new Date(overrideTs);
          const t = (hhmm || '').toString().trim();
          if (!t) return null;
          const [hh, mm] = t.split(':');
          if (hh == null || mm == null) return null;
          return new Date(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);
        } catch { return null; }
      }
      const openingAtTs = buildTs(opening_time, opening_at);
      const closingAtTs = buildTs(closing_time, closing_at);
      const r = await pool.query(
        `INSERT INTO public.truck_odometer_day_readings (truck_id, reading_date, opening_km, closing_km, note, driver_name, driver_code, opening_at, closing_at, created_by, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [truckId, dateStr, open, close, note || null, driver_name || null, driver_code || null, openingAtTs, closingAtTs, getActor(req), req.user?.sub || null]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // PATCH /day/odometer
  // -----------------------------------------------------------------------
  router.patch('/day/odometer', requireAuth, async (req, res) => {
    try {
      const { truck_id, date, opening_km, closing_km, note, driver_name, driver_code, opening_time, closing_time, opening_at, closing_at } = req.body || {};
      const truckId = parseInt(truck_id, 10);
      const dateStr = isoDateOnly(date || new Date());
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      const existingQ = await pool.query(`SELECT * FROM public.truck_odometer_day_readings WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
      if (!existingQ.rows.length) return res.status(404).json({ error: 'day reading not found' });
      const existing = existingQ.rows[0];
      const open = opening_km != null ? Number(opening_km) : Number(existing.opening_km);
      const close = closing_km != null ? Number(closing_km) : Number(existing.closing_km);
      if (!Number.isFinite(open) || open < 0) return res.status(400).json({ error: 'opening_km invalid' });
      if (!Number.isFinite(close) || close < open) return res.status(400).json({ error: 'closing_km must be >= opening' });
      function buildTs(hhmm, overrideTs, fallback) {
        try {
          if (overrideTs != null) return new Date(overrideTs);
          const t = (hhmm || '').toString().trim();
          if (!t) return fallback;
          const [hh, mm] = t.split(':');
          if (hh == null || mm == null) return fallback;
          return new Date(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);
        } catch { return fallback; }
      }
      const openingAtTs = buildTs(opening_time, opening_at, existing.opening_at || null);
      const closingAtTs = buildTs(closing_time, closing_at, existing.closing_at || null);
      const upd = await pool.query(
        `UPDATE public.truck_odometer_day_readings SET opening_km=$3, closing_km=$4, note=$5, driver_name=$6, driver_code=$7, opening_at=$8, closing_at=$9, updated_at=NOW() WHERE truck_id=$1 AND reading_date=$2 RETURNING *`,
        [truckId, dateStr, open, close, note != null ? note : existing.note, driver_name != null ? driver_name : existing.driver_name, driver_code != null ? driver_code : existing.driver_code, openingAtTs, closingAtTs]
      );
      res.json(upd.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // GET /day/odometer/list
  // -----------------------------------------------------------------------
  router.get('/day/odometer/list', requireAuth, async (req, res) => {
    try {
      const truckId = parseInt(req.query.truck_id, 10);
      const limit = Math.max(1, Math.min(365, parseInt(req.query.limit || '90', 10) || 90));
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      const r = await pool.query(
        `SELECT id, truck_id, reading_date, opening_km, closing_km, opening_at, closing_at, note, driver_name, driver_code, created_at, updated_at FROM public.truck_odometer_day_readings WHERE truck_id=$1 ORDER BY reading_date DESC LIMIT $2`,
        [truckId, limit]
      );
      res.json({ items: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // DELETE /day/odometer
  // -----------------------------------------------------------------------
  router.delete('/day/odometer', requireAuth, async (req, res) => {
    try {
      const idRaw = req.query.id;
      if (idRaw) {
        const id = parseInt(idRaw, 10);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
        const del = await pool.query(`DELETE FROM public.truck_odometer_day_readings WHERE id=$1 RETURNING id`, [id]);
        if (!del.rows.length) return res.status(404).json({ error: 'not found' });
        return res.json({ ok: true, deleted_id: id });
      }
      const truckId = parseInt(req.query.truck_id, 10);
      const dateStr = isoDateOnly(req.query.date || new Date());
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      const del = await pool.query(`DELETE FROM public.truck_odometer_day_readings WHERE truck_id=$1 AND reading_date=$2 RETURNING id`, [truckId, dateStr]);
      if (!del.rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, deleted_id: del.rows[0].id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createDayOpsController };
