// apps/fuelops-service/controllers/tripController.js
// ---------------------------------------------------------------------------
// Express Router for truck dispenser trip routes.
// Ported 1:1 from backend/index.js.
//
// Routes:
//   GET    /trips
//   POST   /trips
//   PATCH  /trips/:id
//   POST   /trips/:id/unfreeze
//   POST   /trips/:id/update-end-trip
//   DELETE /trips/:id
//   GET    /audit
// ---------------------------------------------------------------------------

'use strict';

const { Router } = require('express');
const { isolatedQuery } = require('../../../packages/query');

function createTripController({ pool, requireAuth, requireRole }) {
  const router = Router();

  const { insertFuelOpsAudit } = require('../services/auditService');
  const { getTripReadingsSnapshot } = require('../services/tripService');
  const { getActor, getClientIp, isTripClosedRow, isPrivileged, isUnfreezeWindow, parseLiters3, round3, isoDateOnly, coerceLocalSqlTimestamp, isValidDateTimeString } = require('../services/helpers');

  // -----------------------------------------------------------------------
  // GET /trips
  // -----------------------------------------------------------------------
  router.get('/trips', requireAuth, async (req, res) => {
    try {
      const truckId = parseInt(req.query.truck_id, 10);
      const dateStr = isoDateOnly(req.query.date || new Date());
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      if (!dateStr) return res.status(400).json({ error: 'date invalid' });
      const r = await pool.query(
        `SELECT id, truck_id, reading_date, trip_no, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code
                , is_frozen, frozen_at, frozen_by, frozen_reason, unfrozen_at, unfrozen_by, unfrozen_reason
           FROM public.truck_dispenser_trips
          WHERE truck_id=$1 AND reading_date=$2
          ORDER BY trip_no ASC`,
        [truckId, dateStr]
      );
      res.json({ items: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // POST /trips
  // -----------------------------------------------------------------------
  router.post('/trips', requireAuth, async (req, res) => {
    try {
      const { truck_id, date, opening_liters, opening_at, note, driver_name, driver_code } = req.body || {};
      const truckId = parseInt(truck_id, 10);
      const dateStr = isoDateOnly(date || new Date());
      if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
      if (!dateStr) return res.status(400).json({ error: 'date invalid' });
      const nextQ = await pool.query(
        `SELECT COALESCE(MAX(trip_no),0)+1 AS next FROM public.truck_dispenser_trips WHERE truck_id=$1 AND reading_date=$2`,
        [truckId, dateStr]
      );
      const nextNo = Number(nextQ.rows[0]?.next || 1);
      let openingTsSql = null;
      if (opening_at && isValidDateTimeString(String(opening_at))) {
        openingTsSql = coerceLocalSqlTimestamp(String(opening_at)) || String(opening_at).replace('T', ' ').slice(0, 19);
      }
      const r = await pool.query(
        `INSERT INTO public.truck_dispenser_trips (truck_id, reading_date, trip_no, opening_liters, opening_at, note, driver_name, driver_code, created_by, created_by_user_id)
         VALUES ($1,$2,$3,COALESCE($4,0),$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [truckId, dateStr, nextNo, (opening_liters != null ? parseLiters3(opening_liters) : null), openingTsSql, note || null, driver_name || null, driver_code || null, getActor(req), req.user?.sub || null]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // PATCH /trips/:id
  // -----------------------------------------------------------------------
  router.patch('/trips/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const existingQ = await client.query(`SELECT * FROM public.truck_dispenser_trips WHERE id=$1 FOR UPDATE`, [id]);
      if (!existingQ.rows.length) return res.status(404).json({ error: 'not found' });
      const existing = existingQ.rows[0];
      const { opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code } = req.body || {};
      const parts = [];
      const vals = [];
      let idx = 1;
      if (opening_liters != null) { parts.push(`opening_liters=$${idx++}`); vals.push(parseLiters3(opening_liters)); }
      if (closing_liters != null) { parts.push(`closing_liters=$${idx++}`); vals.push(parseLiters3(closing_liters)); }
      if (opening_at) { parts.push(`opening_at=$${idx++}`); vals.push(coerceLocalSqlTimestamp(String(opening_at)) || String(opening_at).replace('T', ' ').slice(0, 19)); }
      if (closing_at) { parts.push(`closing_at=$${idx++}`); vals.push(coerceLocalSqlTimestamp(String(closing_at)) || String(closing_at).replace('T', ' ').slice(0, 19)); }
      if (note !== undefined) { parts.push(`note=$${idx++}`); vals.push(note || null); }
      if (driver_name !== undefined) { parts.push(`driver_name=$${idx++}`); vals.push(driver_name || null); }
      if (driver_code !== undefined) { parts.push(`driver_code=$${idx++}`); vals.push(driver_code || null); }
      if (!parts.length) return res.status(400).json({ error: 'no fields to update' });
      if (isTripClosedRow(existing) && !isPrivileged(req)) return res.status(403).json({ error: 'Locked: trip is closed' });
      if (existing.is_frozen) return res.status(409).json({ error: 'Locked: trip is frozen. Unfreeze to edit.' });
      const willClose = (closing_at || closing_liters != null);
      const wasClosed = isTripClosedRow(existing);
      if (willClose && !wasClosed) {
        parts.push(`is_frozen=TRUE`);
        parts.push(`frozen_at=COALESCE(frozen_at, NOW())`);
        parts.push(`frozen_by=$${idx++}`); vals.push(getActor(req));
        parts.push(`frozen_by_user_id=$${idx++}`); vals.push(req.user?.sub || null);
        parts.push(`frozen_reason=COALESCE(frozen_reason,'Trip closed')`);
      }
      parts.push(`updated_at=NOW()`);
      vals.push(id);
      const r = await client.query(`UPDATE public.truck_dispenser_trips SET ${parts.join(', ')} WHERE id=$${idx} RETURNING *`, vals);
      const didEditOpening = (opening_liters != null) || Boolean(opening_at);
      const didEditClosing = (closing_liters != null) || Boolean(closing_at);
      const updatedTrip = r.rows[0] || null;
      if (isUnfreezeWindow(existing) && (didEditOpening || didEditClosing)) {
        const baseAudit = {
          user_id: req.user?.sub || null,
          username: getActor(req),
          tab: 'At Depot',
          action: 'UPDATE',
          entity_type: 'TRIP',
          entity_id: id,
          unit_id: updatedTrip?.truck_id || existing.truck_id || null,
          unit_type: 'TRUCK',
          trip_id: id,
          trip_no: updatedTrip?.trip_no || existing.trip_no || null,
          op_date: updatedTrip?.reading_date || existing.reading_date || null,
          performed_time: null,
          reason: null,
          request_id: req.headers['x-request-id'] || null,
          ip_addr: getClientIp(req),
        };
        if (didEditOpening) {
          await insertFuelOpsAudit(client, { ...baseAudit, section: 'Opening Reading', payload_old: { opening_liters: existing.opening_liters ?? null, opening_at: existing.opening_at ?? null }, payload_new: { opening_liters: updatedTrip?.opening_liters ?? null, opening_at: updatedTrip?.opening_at ?? null } });
        }
        if (didEditClosing) {
          await insertFuelOpsAudit(client, { ...baseAudit, section: 'Closing Reading', payload_old: { closing_liters: existing.closing_liters ?? null, closing_at: existing.closing_at ?? null }, payload_new: { closing_liters: updatedTrip?.closing_liters ?? null, closing_at: updatedTrip?.closing_at ?? null } });
        }
      }
      await client.query('COMMIT');
      res.json(r.rows[0]);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(e.status || 500).json({ error: e.message });
    } finally { client.release(); }
  });

  // -----------------------------------------------------------------------
  // POST /trips/:id/unfreeze
  // -----------------------------------------------------------------------
  router.post('/trips/:id/unfreeze', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      if (!isPrivileged(req)) return res.status(403).json({ error: 'Forbidden' });
      await client.query('BEGIN');
      const id = parseInt(req.params.id, 10);
      const reason = (req.body && req.body.reason) ? String(req.body.reason) : null;
      const q = await client.query(`SELECT * FROM public.truck_dispenser_trips WHERE id=$1 FOR UPDATE`, [id]);
      if (!q.rows.length) return res.status(404).json({ error: 'not found' });
      const oldRow = q.rows[0];
      const r = await client.query(
        `UPDATE public.truck_dispenser_trips
            SET is_frozen=FALSE, unfrozen_at=NOW(), unfrozen_by=$2, unfrozen_by_user_id=$3, unfrozen_reason=COALESCE($4, unfrozen_reason, 'Manual unfreeze'), updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [id, getActor(req), req.user?.sub || null, reason]
      );
      await insertFuelOpsAudit(client, {
        user_id: req.user?.sub || null, username: getActor(req), tab: 'At Depot', section: 'Freeze', action: 'UNFREEZE', entity_type: 'TRIP', entity_id: id, unit_id: r.rows[0]?.truck_id || null, unit_type: 'TRUCK', trip_id: id, trip_no: r.rows[0]?.trip_no || null, op_date: r.rows[0]?.reading_date || null, performed_time: null, payload_old: oldRow, payload_new: r.rows[0] || null, reason, request_id: req.headers['x-request-id'] || null, ip_addr: getClientIp(req),
      });
      await client.query('COMMIT');
      res.json(r.rows[0]);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(500).json({ error: e.message });
    } finally { client.release(); }
  });

  // -----------------------------------------------------------------------
  // POST /trips/:id/update-end-trip — Recalculate + re-freeze (OWNER/ADMIN)
  // -----------------------------------------------------------------------
  router.post('/trips/:id/update-end-trip', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const reason = (req.body && req.body.reason) ? String(req.body.reason) : null;
      const q = await client.query(`SELECT * FROM public.truck_dispenser_trips WHERE id=$1 FOR UPDATE`, [id]);
      if (!q.rows.length) return res.status(404).json({ error: 'not found' });
      const oldRow = q.rows[0];
      if (!isTripClosedRow(oldRow)) return res.status(400).json({ error: 'Trip is not closed yet' });
      if (oldRow.is_frozen) return res.status(409).json({ error: 'Locked: trip is frozen. Unfreeze to update end trip.' });

      const truckId = Number(oldRow.truck_id);
      const tripNo = Number(oldRow.trip_no);
      const dateStr = isoDateOnly(oldRow.reading_date);
      const opening = Number(oldRow.opening_liters || 0);

      async function getTripOutSums(truckId, tripNo, dateStr) {
        const salesSumQ = await client.query(
          `SELECT COALESCE(SUM(sale_volume_liters),0) AS s, MAX(performed_at) AS max_ts FROM public.fuel_sale_transfers WHERE from_unit_id=$1 AND trip=$2 AND (sale_date = $3::date OR (sale_date IS NULL AND performed_at::date = $3::date))`,
          [truckId, tripNo, dateStr]
        );
        const transfersOutSumQ = await client.query(
          `SELECT COALESCE(SUM(transfer_volume),0) AS t, MAX(transfer_date::timestamp + transfer_time) AS max_ts FROM public.fuel_internal_transfers WHERE from_unit_id=$1 AND trip=$2 AND transfer_date = $3::date`,
          [truckId, tripNo, dateStr]
        );
        let testingSumQ = { rows: [{ t: 0, max_ts: null }] };
        try {
          testingSumQ = await client.query(
            `SELECT COALESCE(SUM(transfer_volume_liters),0) AS t, MAX(performed_at) AS max_ts FROM public.testing_self_transfers WHERE from_unit_id=$1 AND trip=$2 AND (sale_date = $3::date OR (sale_date IS NULL AND performed_at::date = $3::date))`,
            [truckId, tripNo, dateStr]
          );
        } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[update-end-trip testing warn]', e.message); }
        const salesOut = Number(salesSumQ.rows[0]?.s || 0);
        const transfersOut = Number(transfersOutSumQ.rows[0]?.t || 0);
        const testingOut = Number(testingSumQ.rows[0]?.t || 0);
        const latestCandidates = [];
        if (salesSumQ.rows[0]?.max_ts) latestCandidates.push(salesSumQ.rows[0].max_ts);
        if (transfersOutSumQ.rows[0]?.max_ts) latestCandidates.push(transfersOutSumQ.rows[0].max_ts);
        if (testingSumQ.rows[0]?.max_ts) latestCandidates.push(testingSumQ.rows[0].max_ts);
        let latestTs = null;
        if (latestCandidates.length) {
          latestTs = latestCandidates[0];
          for (const t of latestCandidates) { try { if (t && latestTs && new Date(t).getTime() > new Date(latestTs).getTime()) latestTs = t; } catch {} }
        }
        return { salesOut, transfersOut, testingOut, latestTs, totalOut: salesOut + transfersOut + testingOut };
      }

      const sums = await getTripOutSums(truckId, tripNo, dateStr);
      const newClosing = round3(opening + sums.totalOut);
      const tsCandidates = [];
      if (oldRow.closing_at) tsCandidates.push(oldRow.closing_at);
      if (sums.latestTs) tsCandidates.push(sums.latestTs);
      let newClosingAt = oldRow.closing_at || null;
      if (tsCandidates.length) {
        let latest = tsCandidates[0];
        for (const t of tsCandidates) { try { if (t && latest && new Date(t).getTime() > new Date(latest).getTime()) latest = t; } catch {} }
        newClosingAt = latest || newClosingAt;
      }
      const upd = await client.query(
        `UPDATE public.truck_dispenser_trips
            SET closing_liters=$2, closing_at=COALESCE($3, closing_at), is_frozen=TRUE, frozen_at=NOW(), frozen_by=$4, frozen_by_user_id=$5, frozen_reason=COALESCE($6,'Update End Trip'), updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [id, newClosing, newClosingAt ? coerceLocalSqlTimestamp(String(newClosingAt)) || String(newClosingAt).replace('T', ' ').slice(0, 19) : null, getActor(req), req.user?.sub || null, reason]
      );

      // Cascade forward
      let prevClosing = Number(upd.rows[0]?.closing_liters || newClosing || 0);
      const laterTripsQ = await client.query(
        `SELECT * FROM public.truck_dispenser_trips WHERE truck_id=$1 AND (reading_date > $2::date OR (reading_date = $2::date AND trip_no > $3)) ORDER BY reading_date ASC, trip_no ASC FOR UPDATE`,
        [truckId, dateStr, tripNo]
      );
      const cascaded = [];
      for (const t of laterTripsQ.rows) {
        const tDate = isoDateOnly(t.reading_date);
        const tNo = Number(t.trip_no);
        const openingSaved = !!(t.opening_at || (t.opening_liters != null && Number(t.opening_liters) !== 0));
        const oldOpening = t.opening_liters != null ? Number(t.opening_liters) : null;
        const oldClosing = t.closing_liters != null ? Number(t.closing_liters) : null;
        let newOpening = oldOpening;
        if (openingSaved) newOpening = round3(prevClosing);
        let newClose = oldClosing;
        const closed = isTripClosedRow(t);
        if (closed && openingSaved) {
          const sums2 = await getTripOutSums(truckId, tNo, tDate);
          newClose = round3(Number(newOpening || 0) + Number(sums2.totalOut || 0));
        }
        const openingChanged = openingSaved && (newOpening != null) && (oldOpening == null || round3(oldOpening) !== round3(newOpening));
        const closingChanged = closed && openingSaved && (newClose != null) && (oldClosing == null || round3(oldClosing) !== round3(newClose));
        if (openingChanged || closingChanged) {
          const updParts = []; const updVals = []; let ui = 1;
          if (openingChanged) { updParts.push(`opening_liters=$${ui++}`); updVals.push(newOpening); }
          if (closingChanged) { updParts.push(`closing_liters=$${ui++}`); updVals.push(newClose); }
          updParts.push(`updated_at=NOW()`); updVals.push(t.id);
          const updatedTripQ = await client.query(`UPDATE public.truck_dispenser_trips SET ${updParts.join(', ')} WHERE id=$${ui} RETURNING *`, updVals);
          cascaded.push({ id: t.id, reading_date: tDate, trip_no: tNo, opening_old: oldOpening, opening_new: openingChanged ? newOpening : oldOpening, closing_old: oldClosing, closing_new: closingChanged ? newClose : oldClosing });
          const updatedTrip = updatedTripQ.rows[0] || t;
          if (isTripClosedRow(updatedTrip) && updatedTrip.closing_liters != null) { prevClosing = Number(updatedTrip.closing_liters); } else { break; }
        } else {
          if (isTripClosedRow(t) && t.closing_liters != null) { prevClosing = Number(t.closing_liters); } else { break; }
        }
      }
      await client.query('COMMIT');
      res.json({
        trip: upd.rows[0],
        computed: { opening_liters: opening, sales_out_liters: round3(sums.salesOut), transfers_out_liters: round3(sums.transfersOut), testing_out_liters: round3(sums.testingOut), closing_liters: newClosing },
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(e.status || 500).json({ error: e.message });
    } finally { client.release(); }
  });

  // -----------------------------------------------------------------------
  // GET /audit — Fuel ops audit (OWNER/ADMIN only)
  // -----------------------------------------------------------------------
  router.get('/audit', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const unitId = req.query.unit_id != null && req.query.unit_id !== '' ? parseInt(req.query.unit_id, 10) : null;
      const tab = req.query.tab ? String(req.query.tab) : null;
      const section = req.query.section ? String(req.query.section) : null;
      const action = req.query.action ? String(req.query.action) : null;
      const entityType = req.query.entity_type ? String(req.query.entity_type) : null;
      const opFrom = req.query.op_from ? isoDateOnly(req.query.op_from) : null;
      const opTo = req.query.op_to ? isoDateOnly(req.query.op_to) : null;
      const includePayload = String(req.query.include_payload || 'true').toLowerCase() === 'true';
      const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000);
      const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
      const where = []; const vals = []; let idx = 1;
      const allowedSections = ['Freeze', 'Opening Reading', 'Closing Reading', 'Sales & Transfers'];
      where.push(`a.section = ANY($${idx++}::text[])`); vals.push(allowedSections);
      if (Number.isFinite(unitId) && unitId > 0) { where.push(`a.unit_id=$${idx++}`); vals.push(unitId); }
      if (tab) { where.push(`a.tab=$${idx++}`); vals.push(tab); }
      if (section) { where.push(`a.section=$${idx++}`); vals.push(section); }
      if (action) { where.push(`a.action=$${idx++}`); vals.push(action); }
      if (entityType) { where.push(`a.entity_type=$${idx++}`); vals.push(entityType); }
      if (opFrom) { where.push(`a.op_date >= $${idx++}::date`); vals.push(opFrom); }
      if (opTo) { where.push(`a.op_date <= $${idx++}::date`); vals.push(opTo); }
      const payloadCols = includePayload ? ', a.payload_old, a.payload_new' : '';
      vals.push(limit); vals.push(offset);
      const sql = `SELECT a.id, a.created_at, a.user_id, a.username AS performed_by, a.tab, a.section, a.action, a.entity_type, a.unit_id, su.unit_code AS unit_code, a.trip_id, a.trip_no, a.op_date, a.reason ${payloadCols} FROM public.fuel_ops_audit a LEFT JOIN public.storage_units su ON su.id = a.unit_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
      const r = await isolatedQuery(sql, vals);
      res.json({ items: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // DELETE /trips/:id — Only last trip of day
  // -----------------------------------------------------------------------
  router.delete('/trips/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const q = await client.query(`SELECT * FROM public.truck_dispenser_trips WHERE id=$1 FOR UPDATE`, [id]);
      if (!q.rows.length) return res.status(404).json({ error: 'not found' });
      const row = q.rows[0];
      if (isTripClosedRow(row) && !isPrivileged(req)) return res.status(403).json({ error: 'Locked: trip is closed' });
      if (row.is_frozen) return res.status(409).json({ error: 'Locked: trip is frozen. Unfreeze to delete.' });
      const m = await client.query(`SELECT MAX(trip_no) AS max_no FROM public.truck_dispenser_trips WHERE truck_id=$1 AND reading_date=$2`, [row.truck_id, row.reading_date]);
      const maxNo = Number(m.rows[0]?.max_no || 0);
      if (row.trip_no !== maxNo) return res.status(400).json({ error: 'only the last trip for the day can be deleted' });
      await client.query(`DELETE FROM public.truck_dispenser_trips WHERE id=$1`, [id]);
      await client.query('COMMIT');
      res.json({ ok: true, deleted_id: id });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(e.status || 500).json({ error: e.message });
    } finally { client.release(); }
  });

  return router;
}

module.exports = { createTripController };
