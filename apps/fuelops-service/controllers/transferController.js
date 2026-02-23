// apps/fuelops-service/controllers/transferController.js
// ---------------------------------------------------------------------------
// Express Router for ALL transfer routes (sales, internal, testing).
// Ported 1:1 from backend/index.js for full monolith parity.
//
// Routes:
//   DELETE /transfers/sales/:id
//   PATCH  /transfers/sales/:id
//   GET    /transfers/sales/list
//   GET    /transfers/sales/export
//   DELETE /transfers/internal/:id
//   PATCH  /transfers/internal/:id
//   PUT    /transfers/internal/:id/full
//   GET    /transfers/internal/list
//   GET    /transfers/internal/export
//   DELETE /transfers/testing/:id
//   PATCH  /transfers/testing/:id
// ---------------------------------------------------------------------------

'use strict';

const { Router } = require('express');

function createTransferController({ pool, requireAuth, requireRole, invalidateCache }) {
  const router = Router();
  const invalidate = typeof invalidateCache === 'function' ? invalidateCache : () => {};

  const { recomputeFuelLotUsedAndStatus, recomputeFuelLotTestingLiters, getInboundAddedLiters, getOutboundUsedLiters, recomputeLot } = require('../services/lotService');
  const { insertFuelOpsAudit } = require('../services/auditService');
  const { getTripRowForOp, getTripReadingsSnapshot, assertOpEditableByTripState } = require('../services/tripService');
  const { getActor, getClientIp, isUnfreezeWindow, parseLiters3, isoDateOnly, csvEscape, round3 } = require('../services/helpers');
  const { resolveDateCol } = require('../repositories/fuelLotRepository');

  // -----------------------------------------------------------------------
  // DELETE /transfers/sales/:id
  // -----------------------------------------------------------------------
  router.delete('/transfers/sales/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const existingQ = await client.query(`SELECT * FROM public.fuel_sale_transfers WHERE id=$1 FOR UPDATE`, [id]);
      if (!existingQ.rows.length) return res.status(404).json({ error: 'not found' });
      const existing = existingQ.rows[0];
      const opDate = existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : null);
      const tripRow = await getTripRowForOp(client, existing.from_unit_id, opDate, existing.trip);
      await assertOpEditableByTripState(client, tripRow, req);
      const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
      const del = await client.query(`DELETE FROM public.fuel_sale_transfers WHERE id=$1 RETURNING *`, [id]);
      const deleted = del.rows[0];
      await recomputeFuelLotUsedAndStatus(client, deleted.lot_id);
      if (isUnfreezeWindow(tripRow)) {
        const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
        await insertFuelOpsAudit(client, {
          user_id: req.user?.sub || null, username: getActor(req),
          tab: 'At Depot', section: 'Sales & Transfers', action: 'DELETE', entity_type: 'SALE',
          entity_id: id, unit_id: existing.from_unit_id || null, unit_type: 'TRUCK',
          driver_id: existing.driver_id || null,
          trip_id: tripRow?.id || null, trip_no: tripRow?.trip_no || null, op_date: opDate,
          performed_time: null, amount_liters: existing.sale_volume_liters || null,
          payload_old: (tripSnapBefore ? { ...existing, ...tripSnapBefore } : existing),
          payload_new: (tripSnapAfter ? { ...tripSnapAfter } : {}),
          reason: null, request_id: req.headers['x-request-id'] || null, ip_addr: getClientIp(req),
        });
      }
      await client.query('COMMIT');
      try { invalidate(existing.from_unit_id); } catch {}
      res.json({ deleted: true, row: deleted });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(e.status || 500).json({ error: e.message });
    } finally { client.release(); }
  });

  // -----------------------------------------------------------------------
  // PATCH /transfers/sales/:id
  // -----------------------------------------------------------------------
  router.patch('/transfers/sales/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const { sale_volume_liters, to_vehicle, sale_date, performed_time } = req.body || {};
      const existingQ = await client.query(`SELECT * FROM public.fuel_sale_transfers WHERE id=$1 FOR UPDATE`, [id]);
      if (!existingQ.rows.length) return res.status(404).json({ error: 'not found' });
      const existing = existingQ.rows[0];
      const oldOpDate = existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : null);
      const tripRow = await getTripRowForOp(client, existing.from_unit_id, oldOpDate, existing.trip);
      await assertOpEditableByTripState(client, tripRow, req);
      const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
      const parts = []; const vals = []; let idx = 1;
      if (sale_volume_liters != null) {
        const v = parseLiters3(sale_volume_liters);
        if (!Number.isFinite(v)) return res.status(400).json({ error: 'invalid sale_volume_liters' });
        parts.push(`sale_volume_liters=$${idx++}`); vals.push(v);
      }
      if (to_vehicle != null) { parts.push(`to_vehicle=$${idx++}`); vals.push(String(to_vehicle)); }
      if (sale_date != null) { parts.push(`sale_date=$${idx++}`); vals.push(isoDateOnly(sale_date)); }
      if (performed_time != null) {
        const hhmm = String(performed_time).trim();
        if (/^\d{2}:\d{2}$/.test(hhmm)) {
          const baseDate = sale_date ? isoDateOnly(sale_date)
            : (existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : isoDateOnly(new Date())));
          if (baseDate) { parts.push(`performed_at=$${idx++}`); vals.push(`${baseDate} ${hhmm}:00`); }
        }
      }
      if (!parts.length) return res.status(400).json({ error: 'no fields to update' });
      parts.push(`updated_at=NOW()`);
      vals.push(id);
      const q = await client.query(`UPDATE public.fuel_sale_transfers SET ${parts.join(', ')} WHERE id=$${idx} RETURNING *`, vals);
      if (!q.rows.length) return res.status(404).json({ error: 'not found' });
      await recomputeFuelLotUsedAndStatus(client, existing.lot_id);
      if (isUnfreezeWindow(tripRow)) {
        const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
        await insertFuelOpsAudit(client, {
          user_id: req.user?.sub || null, username: getActor(req),
          tab: 'At Depot', section: 'Sales & Transfers', action: 'UPDATE', entity_type: 'SALE',
          entity_id: id, unit_id: existing.from_unit_id || null, unit_type: 'TRUCK',
          driver_id: existing.driver_id || null,
          trip_id: tripRow?.id || null, trip_no: tripRow?.trip_no || null, op_date: oldOpDate,
          performed_time: null,
          amount_liters: (q.rows[0]?.sale_volume_liters != null ? q.rows[0].sale_volume_liters : existing.sale_volume_liters) || null,
          payload_old: (tripSnapBefore ? { ...existing, ...tripSnapBefore } : existing),
          payload_new: (q.rows[0] ? (tripSnapAfter ? { ...q.rows[0], ...tripSnapAfter } : q.rows[0]) : (tripSnapAfter ? { ...tripSnapAfter } : null)),
          reason: null, request_id: req.headers['x-request-id'] || null, ip_addr: getClientIp(req),
        });
      }
      await client.query('COMMIT');
      try { invalidate(existing.from_unit_id); } catch {}
      res.json(q.rows[0]);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(e.status || 500).json({ error: e.message });
    } finally { client.release(); }
  });

  // -----------------------------------------------------------------------
  // GET /transfers/sales/list
  // -----------------------------------------------------------------------
  router.get('/transfers/sales/list', requireAuth, async (req, res) => {
    try {
      const from = req.query.from ? isoDateOnly(req.query.from) : null;
      const to = req.query.to ? isoDateOnly(req.query.to) : null;
      const unitId = req.query.unit_id ? parseInt(req.query.unit_id, 10) : null;
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '100', 10) || 100));
      const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
      if (req.query.unit_id && (!Number.isFinite(unitId) || unitId <= 0)) return res.status(400).json({ error: 'unit_id invalid' });
      const params = []; let idx = 1; const where = [];
      if (from) { where.push(`date_key >= $${idx++}::date`); params.push(from); }
      if (to) { where.push(`date_key <= $${idx++}::date`); params.push(to); }
      if (Number.isFinite(unitId) && unitId > 0) { where.push(`from_unit_id = $${idx++}::int`); params.push(unitId); }
      params.push(limit); const limitIdx = idx++;
      params.push(offset); const offsetIdx = idx++;
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const r = await pool.query(`
        WITH t AS (
          SELECT fst.id, fst.from_unit_id, fst.from_unit_code, fst.to_vehicle,
                 fst.performed_at, COALESCE(fst.sale_date, (fst.performed_at::date)) AS sale_date,
                 fst.sale_volume_liters, fst.lot_code_after, fst.driver_name, fst.performed_by, fst.activity, fst.trip,
                 COALESCE(fst.sale_date, (fst.performed_at::date)) AS date_key
            FROM public.fuel_sale_transfers fst
          UNION ALL
          SELECT tst.id, tst.from_unit_id,
                 COALESCE(su.unit_code, tst.from_unit_code, '') AS from_unit_code,
                 tst.to_vehicle, tst.performed_at,
                 COALESCE(tst.sale_date, (tst.performed_at::date)) AS sale_date,
                 tst.transfer_volume_liters AS sale_volume_liters,
                 tst.lot_code AS lot_code_after, tst.driver_name, tst.performed_by, tst.activity, tst.trip::int AS trip,
                 COALESCE(tst.sale_date, (tst.performed_at::date)) AS date_key
            FROM public.testing_self_transfers tst
            LEFT JOIN public.storage_units su ON su.id = tst.from_unit_id
          UNION ALL
          SELECT fl.id, fl.unit_id AS from_unit_id,
                 COALESCE(fl.tanker_code, su.unit_code, '') AS from_unit_code,
                 NULL::text AS to_vehicle,
                 COALESCE(fl.load_time, fl.created_at) AS performed_at,
                 fl.load_date AS sale_date,
                 fl.loaded_liters AS sale_volume_liters,
                 fl.lot_code_created AS lot_code_after,
                 NULL::text AS driver_name, NULL::text AS performed_by, 'LOADED'::text AS activity, NULL::int AS trip,
                 fl.load_date AS date_key
            FROM public.fuel_lots fl
            JOIN public.storage_units su ON su.id = fl.unit_id
        )
        SELECT id, from_unit_code, to_vehicle, performed_at::text AS performed_at,
               sale_date::text AS sale_date, sale_volume_liters, lot_code_after, driver_name, performed_by, activity, trip
          FROM t ${whereSql}
         ORDER BY date_key DESC, performed_at DESC NULLS LAST, id DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `, params);
      res.json({ items: r.rows, limit, offset });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // GET /transfers/sales/export
  // -----------------------------------------------------------------------
  router.get('/transfers/sales/export', requireAuth, async (req, res) => {
    try {
      const from = req.query.from ? isoDateOnly(req.query.from) : null;
      const to = req.query.to ? isoDateOnly(req.query.to) : null;
      const unitId = req.query.unit_id ? parseInt(req.query.unit_id, 10) : null;
      if (req.query.unit_id && (!Number.isFinite(unitId) || unitId <= 0)) return res.status(400).send('unit_id invalid');
      const params = []; let idx = 1; const where = [];
      if (from) { where.push(`date_key >= $${idx++}::date`); params.push(from); }
      if (to) { where.push(`date_key <= $${idx++}::date`); params.push(to); }
      if (Number.isFinite(unitId) && unitId > 0) { where.push(`from_unit_id = $${idx++}::int`); params.push(unitId); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const q = await pool.query(`
        WITH t AS (
          SELECT fst.id, fst.from_unit_id, fst.from_unit_code, fst.to_vehicle,
                 fst.sale_volume_liters, fst.lot_code_after, fst.driver_name, fst.performed_by, fst.activity, fst.trip,
                 COALESCE(fst.sale_date, (fst.performed_at::date)) AS sale_date, fst.performed_at,
                 COALESCE(fst.sale_date, (fst.performed_at::date)) AS date_key
            FROM public.fuel_sale_transfers fst
          UNION ALL
          SELECT tst.id, tst.from_unit_id,
                 COALESCE(su.unit_code, tst.from_unit_code, '') AS from_unit_code, tst.to_vehicle,
                 tst.transfer_volume_liters AS sale_volume_liters, tst.lot_code AS lot_code_after,
                 tst.driver_name, tst.performed_by, tst.activity, tst.trip::int AS trip,
                 COALESCE(tst.sale_date, (tst.performed_at::date)) AS sale_date, tst.performed_at,
                 COALESCE(tst.sale_date, (tst.performed_at::date)) AS date_key
            FROM public.testing_self_transfers tst
            LEFT JOIN public.storage_units su ON su.id = tst.from_unit_id
          UNION ALL
          SELECT fl.id, fl.unit_id AS from_unit_id,
                 COALESCE(fl.tanker_code, su.unit_code, '') AS from_unit_code, NULL::text AS to_vehicle,
                 fl.loaded_liters AS sale_volume_liters, fl.lot_code_created AS lot_code_after,
                 NULL::text AS driver_name, NULL::text AS performed_by, 'LOADED'::text AS activity, NULL::int AS trip,
                 fl.load_date AS sale_date, COALESCE(fl.load_time, fl.created_at) AS performed_at,
                 fl.load_date AS date_key
            FROM public.fuel_lots fl
            JOIN public.storage_units su ON su.id = fl.unit_id
        )
        SELECT id, from_unit_code, to_vehicle, sale_volume_liters, lot_code_after,
               driver_name, performed_by, activity, trip, sale_date::text AS sale_date, performed_at::text AS performed_at
          FROM t ${whereSql}
         ORDER BY date_key DESC, performed_at DESC NULLS LAST, id DESC
      `, params);
      const filename = `sales_${from || 'all'}_${to || 'all'}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      const header = ['Date','From Unit Code','To Vehicle','Sale Volume (L)','Lot Code After','Driver Name','Performed By','Trip','Performed At','Activity'].join(',');
      const lines = [header];
      for (const r of q.rows) {
        lines.push([csvEscape(r.sale_date),csvEscape(r.from_unit_code),csvEscape(r.to_vehicle),csvEscape(r.sale_volume_liters),csvEscape(r.lot_code_after),csvEscape(r.driver_name),csvEscape(r.performed_by),csvEscape(r.trip),csvEscape(r.performed_at),csvEscape(r.activity)].join(','));
      }
      res.send(lines.join('\n'));
    } catch (e) { res.status(500).send(e.message || String(e)); }
  });

  // -----------------------------------------------------------------------
  // DELETE /transfers/internal/:id  (with EMPTY_TRANSFER undo logic)
  // -----------------------------------------------------------------------
  router.delete('/transfers/internal/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      await client.query('BEGIN');
      const existingQ = await client.query(`SELECT * FROM public.fuel_internal_transfers WHERE id=$1 FOR UPDATE`, [id]);
      if (!existingQ.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
      const existing = existingQ.rows[0];
      const opDate = existing.transfer_date ? isoDateOnly(existing.transfer_date) : null;
      const tripRow = await getTripRowForOp(client, existing.from_unit_id, opDate, existing.trip);
      await assertOpEditableByTripState(client, tripRow, req);
      const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
      const del = await client.query(`DELETE FROM public.fuel_internal_transfers WHERE id=$1 RETURNING *`, [id]);
      const deleted = del.rows[0];
      const fromLotId = deleted.from_lot_id != null ? Number(deleted.from_lot_id) : null;
      const toLotId = deleted.to_lot_id != null ? Number(deleted.to_lot_id) : null;
      const vol = deleted.transfer_volume != null ? Number(deleted.transfer_volume) : null;
      // EMPTY_TRANSFER undo: if this transfer seeded the destination lot, undo the seeding
      let toLotDeleted = false;
      if (toLotId && vol != null) {
        const toLotQ = await client.query(`SELECT id, load_type, lot_code_created FROM public.fuel_lots WHERE id=$1 FOR UPDATE`, [toLotId]);
        const toLot = toLotQ.rows[0];
        const seededByFlag = deleted.transfer_to_empty === true;
        const seededByCode = toLot && String(toLot.load_type || '') === 'EMPTY_TRANSFER' && String(deleted.to_lot_code_change || '') === String(toLot.lot_code_created || '');
        if (seededByFlag || seededByCode) {
          const refQ = await client.query(`
            SELECT
              (SELECT COUNT(*)::int FROM public.fuel_internal_transfers WHERE to_lot_id=$1 OR from_lot_id=$1) AS xfers,
              (SELECT COUNT(*)::int FROM public.fuel_sale_transfers WHERE lot_id=$1) AS sales,
              (SELECT COUNT(*)::int FROM public.testing_self_transfers WHERE lot_id=$1) AS testing
          `, [toLotId]);
          const refs = refQ.rows[0] || { xfers: 0, sales: 0, testing: 0 };
          const hasRefs = Number(refs.xfers || 0) > 0 || Number(refs.sales || 0) > 0 || Number(refs.testing || 0) > 0;
          if (hasRefs) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'cannot delete transfer: destination lot has dependent records', details: { toLotId, refs } });
          }
          await client.query(`DELETE FROM public.fuel_lots WHERE id=$1`, [toLotId]);
          toLotDeleted = true;
        }
      }
      await recomputeLot(client, fromLotId);
      if (!toLotDeleted) await recomputeLot(client, toLotId);
      if (isUnfreezeWindow(tripRow)) {
        const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
        await insertFuelOpsAudit(client, {
          user_id: req.user?.sub || null, username: getActor(req),
          tab: 'At Depot', section: 'Sales & Transfers', action: 'DELETE', entity_type: 'INTERNAL_TRANSFER',
          entity_id: id, unit_id: existing.from_unit_id || null, unit_type: 'TRUCK',
          trip_id: tripRow?.id || null, trip_no: tripRow?.trip_no || null, op_date: opDate,
          performed_time: null, amount_liters: existing.transfer_volume || null,
          payload_old: (tripSnapBefore ? { ...existing, ...tripSnapBefore } : existing),
          payload_new: (tripSnapAfter ? { ...tripSnapAfter } : {}),
          reason: null, request_id: req.headers['x-request-id'] || null, ip_addr: getClientIp(req),
        });
      }
      await client.query('COMMIT');
      try { invalidate(existing.from_unit_id); } catch {}
      try { if (existing.to_unit_id) invalidate(existing.to_unit_id); } catch {}
      res.json({ deleted: true, row: deleted });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(e.status || 500).json({ error: e.message });
    } finally { client.release(); }
  });

  // -----------------------------------------------------------------------
  // PATCH /transfers/internal/:id
  // -----------------------------------------------------------------------
  router.patch('/transfers/internal/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const { transfer_volume_liters, transfer_volume, performed_time, transfer_date } = req.body || {};
      await client.query('BEGIN');
      const existingQ = await client.query(`SELECT * FROM public.fuel_internal_transfers WHERE id=$1 FOR UPDATE`, [id]);
      if (!existingQ.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
      const existing = existingQ.rows[0];
      const opDate = existing.transfer_date ? isoDateOnly(existing.transfer_date) : null;
      const tripRow = await getTripRowForOp(client, existing.from_unit_id, opDate, existing.trip);
      await assertOpEditableByTripState(client, tripRow, req);
      const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
      const oldVol = Number(existing.transfer_volume || 0);
      let newVol = oldVol;
      const volInput = transfer_volume != null ? transfer_volume : transfer_volume_liters;
      if (volInput != null) {
        const v = parseLiters3(volInput);
        if (!Number.isFinite(v) || v <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'invalid transfer_volume_liters' }); }
        newVol = v;
      }
      if (newVol !== oldVol) {
        const fromUnitId = Number(existing.from_unit_id || 0);
        const toUnitId = Number(existing.to_unit_id || 0);
        if (!Number.isFinite(fromUnitId) || fromUnitId <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'invalid from_unit_id on existing transfer' }); }
        if (!Number.isFinite(toUnitId) || toUnitId <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'invalid to_unit_id on existing transfer' }); }
        const unitIds = [fromUnitId, toUnitId];
        const stockQ = await client.query(`
          WITH units AS (SELECT id, capacity_liters FROM public.storage_units WHERE id = ANY($1::int[])),
          lots AS (SELECT id AS lot_id, unit_id FROM public.fuel_lots WHERE stock_status='INSTOCK' AND unit_id = ANY($1::int[])),
          inbound AS (
            SELECT fit.to_lot_id AS lot_id,
                   COALESCE(SUM(fit.transfer_volume) FILTER (WHERE NOT (fit.transfer_to_empty = TRUE OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters) OR (COALESCE(fit.activity,'') = 'TESTING'))),0) AS inbound_added
              FROM public.fuel_internal_transfers fit
              JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id WHERE fl.unit_id = ANY($1::int[]) GROUP BY fit.to_lot_id),
          sales AS (SELECT lot_id, COALESCE(SUM(sale_volume_liters),0) AS sale_only FROM public.fuel_sale_transfers WHERE from_unit_id = ANY($1::int[]) GROUP BY lot_id),
          outbound_x AS (SELECT from_lot_id AS lot_id, COALESCE(SUM(transfer_volume),0) AS outbound_transfers FROM public.fuel_internal_transfers WHERE from_unit_id = ANY($1::int[]) AND COALESCE(activity,'') <> 'TESTING' GROUP BY from_lot_id),
          per_lot AS (
            SELECT l.unit_id, GREATEST(0, COALESCE((SELECT fl.loaded_liters FROM public.fuel_lots fl WHERE fl.id=l.lot_id),0) + COALESCE(i.inbound_added,0) - (COALESCE(o.outbound_transfers,0) + COALESCE(s.sale_only,0))) AS remaining
              FROM lots l LEFT JOIN inbound i ON i.lot_id = l.lot_id LEFT JOIN sales s ON s.lot_id = l.lot_id LEFT JOIN outbound_x o ON o.lot_id = l.lot_id),
          agg AS (SELECT unit_id, COALESCE(SUM(remaining),0) AS instock_liters FROM per_lot GROUP BY unit_id)
          SELECT u.id AS unit_id, COALESCE(u.capacity_liters,0) AS capacity_liters, COALESCE(a.instock_liters,0) AS instock_liters
            FROM units u LEFT JOIN agg a ON a.unit_id = u.id
        `, [unitIds]);
        const byUnit = new Map(stockQ.rows.map(r => [Number(r.unit_id), { instock: Number(r.instock_liters || 0), capacity: Number(r.capacity_liters || 0) }]));
        const fromNow = byUnit.get(fromUnitId) || { instock: 0, capacity: 0 };
        const toNow = byUnit.get(toUnitId) || { instock: 0, capacity: 0 };
        const delta = round3(newVol - oldVol);
        const fromAfter = round3(fromNow.instock - delta);
        const toAfter = round3(toNow.instock + delta);
        if (fromAfter < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Insufficient stock in source unit for this edit (available ${fromNow.instock} L, would become ${fromAfter} L).` }); }
        if (toNow.capacity > 0 && toAfter > toNow.capacity) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Destination capacity exceeded by this edit (capacity ${toNow.capacity} L, would become ${toAfter} L).` }); }
        if (toAfter < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Destination stock would become negative' }); }
      }
      const parts = []; const vals = []; let idx = 1;
      if (volInput != null) { parts.push(`transfer_volume=$${idx++}`); vals.push(newVol); }
      if (transfer_date != null) {
        const dOnly = isoDateOnly(transfer_date);
        if (!dOnly) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'invalid transfer_date' }); }
        parts.push(`transfer_date=$${idx++}`); vals.push(dOnly);
      }
      if (performed_time != null) {
        const hhmm = String(performed_time).trim();
        if (/^\d{2}:\d{2}$/.test(hhmm)) { parts.push(`transfer_time=$${idx++}`); vals.push(`${hhmm}:00`); }
        else if (hhmm) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'invalid performed_time' }); }
      }
      if (!parts.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'no fields to update' }); }
      parts.push(`updated_at=NOW()`);
      vals.push(id);
      const q = await client.query(`UPDATE public.fuel_internal_transfers SET ${parts.join(', ')} WHERE id=$${idx} RETURNING *`, vals);
      await recomputeLot(client, existing.from_lot_id);
      await recomputeLot(client, existing.to_lot_id);
      if (isUnfreezeWindow(tripRow)) {
        const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
        await insertFuelOpsAudit(client, {
          user_id: req.user?.sub || null, username: getActor(req),
          tab: 'At Depot', section: 'Sales & Transfers', action: 'UPDATE', entity_type: 'INTERNAL_TRANSFER',
          entity_id: id, unit_id: existing.from_unit_id || null, unit_type: 'TRUCK',
          trip_id: tripRow?.id || null, trip_no: tripRow?.trip_no || null, op_date: opDate,
          performed_time: null, amount_liters: q.rows[0]?.transfer_volume || null,
          payload_old: (tripSnapBefore ? { ...existing, ...tripSnapBefore } : existing),
          payload_new: (q.rows[0] ? (tripSnapAfter ? { ...q.rows[0], ...tripSnapAfter } : q.rows[0]) : (tripSnapAfter ? { ...tripSnapAfter } : null)),
          reason: null, request_id: req.headers['x-request-id'] || null, ip_addr: getClientIp(req),
        });
      }
      await client.query('COMMIT');
      try { invalidate(existing.from_unit_id); } catch {}
      try { if (existing.to_unit_id) invalidate(existing.to_unit_id); } catch {}
      if (!q.rows.length) return res.status(404).json({ error: 'not found' });
      res.json(q.rows[0]);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(e.status || 500).json({ error: e.message });
    } finally { client.release(); }
  });

  // -----------------------------------------------------------------------
  // PUT /transfers/internal/:id/full
  // -----------------------------------------------------------------------
  router.put('/transfers/internal/:id/full', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const { activity, from_unit_id, to_unit_id, volume_liters, driver_id, transfer_date, performed_time } = req.body || {};
      const act = String(activity || '').toUpperCase();
      if (!new Set(['TANKER_TO_TANKER','TANKER_TO_DATUM']).has(act)) return res.status(400).json({ error: 'invalid activity' });
      const fromId = parseInt(from_unit_id, 10);
      const toId = parseInt(to_unit_id, 10);
      const vol = parseLiters3(volume_liters);
      if (!Number.isFinite(fromId) || fromId <= 0) return res.status(400).json({ error: 'from_unit_id required' });
      if (!Number.isFinite(toId) || toId <= 0) return res.status(400).json({ error: 'to_unit_id required' });
      if (!Number.isFinite(vol) || vol <= 0) return res.status(400).json({ error: 'volume_liters must be > 0' });
      await client.query('BEGIN');
      const existingQ = await client.query(`SELECT * FROM public.fuel_internal_transfers WHERE id=$1 FOR UPDATE`, [id]);
      if (!existingQ.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
      const existing = existingQ.rows[0];
      const existingOpDate = existing.transfer_date ? isoDateOnly(existing.transfer_date) : null;
      const tripRow = await getTripRowForOp(client, existing.from_unit_id, existingOpDate, existing.trip);
      await assertOpEditableByTripState(client, tripRow, req);
      const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
      let drow = null;
      if (driver_id != null) {
        const dr = await client.query(`SELECT id, name, driver_id FROM public.drivers WHERE id=$1`, [parseInt(driver_id,10)]);
        drow = dr.rows[0] || null;
      }
      const dateOnly = transfer_date ? isoDateOnly(transfer_date) : (existing.transfer_date ? isoDateOnly(existing.transfer_date) : isoDateOnly(new Date()));
      const hhmm = (performed_time || '').trim();
      const tsSql = (/^\d{2}:\d{2}$/.test(hhmm) && dateOnly) ? `${dateOnly} ${hhmm}:00` : (dateOnly ? `${dateOnly} 00:00:00` : null);
      const fromUnit = await client.query(`SELECT id, unit_code, unit_type, capacity_liters FROM public.storage_units WHERE id=$1`, [fromId]);
      const toUnit = await client.query(`SELECT id, unit_code, unit_type, capacity_liters FROM public.storage_units WHERE id=$1`, [toId]);
      if (!fromUnit.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'invalid from_unit_id' }); }
      if (!toUnit.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'invalid to_unit_id' }); }
      const fromCode = fromUnit.rows[0].unit_code;
      const toCode = toUnit.rows[0].unit_code;
      const lotFromQ = await client.query(`SELECT * FROM public.fuel_lots WHERE unit_id=$1 AND stock_status='INSTOCK' ORDER BY created_at DESC, id DESC LIMIT 1`, [fromId]);
      if (!lotFromQ.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No in-stock lot for source unit' }); }
      const lotFrom = lotFromQ.rows[0];
      let lotToQ = await client.query(`SELECT * FROM public.fuel_lots WHERE unit_id=$1 AND stock_status='INSTOCK' ORDER BY created_at DESC, id DESC LIMIT 1`, [toId]);
      let createdNewDestLot = false;
      if (!lotToQ.rows.length) {
        const tRow = toUnit.rows[0];
        if (tRow && (tRow.unit_type === 'DATUM' || tRow.unit_type === 'TRUCK')) {
          const cap = Number(tRow.capacity_liters || 0);
          if (cap > 0 && vol > cap) { await client.query('ROLLBACK'); return res.status(400).json({ error: `destination capacity exceeded: would be ${vol}/${cap}` }); }
          const dateCol = await resolveDateCol(pool);
          const created = await client.query(`
            WITH seq AS (SELECT COALESCE(MAX(seq_index),0)+1 AS next FROM public.fuel_lots WHERE unit_id=$1 AND ${dateCol} = CURRENT_DATE)
            INSERT INTO public.fuel_lots (unit_id, tanker_code, tanker_capacity, ${dateCol}, seq_index, seq_letters,
              loaded_liters, lot_code_created, stock_status, used_liters, updated_at, load_type)
            SELECT $1, $2, $3, CURRENT_DATE, s.next, public.seq_index_to_letters(s.next),
                   $4, public.gen_lot_code($2, CURRENT_DATE, s.next, $4), 'INSTOCK', 0, NOW(), 'EMPTY_TRANSFER'
              FROM seq s RETURNING *
          `, [toId, toCode, toUnit.rows[0].capacity_liters, vol]);
          lotToQ = created; createdNewDestLot = true;
        }
      }
      if (!lotToQ.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No in-stock lot for destination unit' }); }
      const lotTo = lotToQ.rows[0];
      const destCap = Number(toUnit.rows[0].capacity_liters || 0);
      if (destCap > 0) {
        const toAddedBefore = createdNewDestLot ? 0 : await getInboundAddedLiters(client, lotTo.id);
        const toUsedBefore = createdNewDestLot ? 0 : await getOutboundUsedLiters(client, lotTo.id);
        const toCurrentNet = createdNewDestLot ? 0 : (Number(lotTo.loaded_liters) + toAddedBefore - toUsedBefore);
        const toNetAfter = toCurrentNet + vol;
        if (toNetAfter > destCap) { await client.query('ROLLBACK'); return res.status(400).json({ error: `destination capacity exceeded: would be ${toNetAfter}/${destCap}` }); }
      }
      const upd1 = await client.query(`
        UPDATE public.fuel_internal_transfers
           SET from_lot_id=$2, to_lot_id=$3, from_unit_id=$4, to_unit_id=$5,
               from_unit_code=$6, to_unit_code=$7, transfer_volume=$8, activity=$9, driver_name=$10,
               transfer_time=COALESCE($11::time, transfer_time), transfer_date=COALESCE($12::date, transfer_date), updated_at=NOW()
         WHERE id=$1 RETURNING *
      `, [id, lotFrom.id, lotTo.id, fromId, toId, fromCode, toCode, vol, act, drow ? drow.name : null, (tsSql ? hhmm : null), dateOnly]);
      if (!upd1.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found after update' }); }
      const fromAddedCum = await getInboundAddedLiters(client, lotFrom.id);
      const fromUsedNow = await getOutboundUsedLiters(client, lotFrom.id);
      const fromSuffix = `-${fromUsedNow}` + (fromAddedCum > 0 ? `+(${fromAddedCum})` : '');
      const fromLotCodeAfter = `${lotFrom.lot_code_created}${fromSuffix}`;
      const toAddedAfter = createdNewDestLot ? 0 : await getInboundAddedLiters(client, lotTo.id);
      const toUsedOut = createdNewDestLot ? 0 : await getOutboundUsedLiters(client, lotTo.id);
      const toSuffix = createdNewDestLot ? '' : (`-${toUsedOut}` + (toAddedAfter > 0 ? `+(${toAddedAfter})` : ''));
      const toLotCodeAfter = `${lotTo.lot_code_created}${toSuffix}`;
      await client.query(`UPDATE public.fuel_internal_transfers SET from_lot_code_change=$2, to_lot_code_change=$3 WHERE id=$1`, [id, fromLotCodeAfter, toLotCodeAfter]);
      try {
        if (tsSql) {
          const shouldStampLoadTime = createdNewDestLot || (lotTo && String(lotTo.load_type).toUpperCase() === 'EMPTY_TRANSFER');
          if (shouldStampLoadTime) await client.query(`UPDATE public.fuel_lots SET load_time=$1::timestamp WHERE id=$2`, [tsSql, lotTo.id]);
        }
      } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[warn] full update set load_time failed', e.message); }
      await recomputeFuelLotUsedAndStatus(client, lotFrom.id);
      await recomputeFuelLotUsedAndStatus(client, lotTo.id);
      if (isUnfreezeWindow(tripRow)) {
        const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
        await insertFuelOpsAudit(client, {
          user_id: req.user?.sub || null, username: getActor(req),
          tab: 'At Depot', section: 'Sales & Transfers', action: 'UPDATE', entity_type: 'INTERNAL_TRANSFER',
          entity_id: id, unit_id: existing.from_unit_id || null, unit_type: 'TRUCK',
          trip_id: tripRow?.id || null, trip_no: tripRow?.trip_no || null, op_date: dateOnly,
          performed_time: null, amount_liters: vol,
          payload_old: (tripSnapBefore ? { ...existing, ...tripSnapBefore } : existing),
          payload_new: (upd1.rows[0] ? (tripSnapAfter ? { ...upd1.rows[0], ...tripSnapAfter } : upd1.rows[0]) : (tripSnapAfter ? { ...tripSnapAfter } : null)),
          reason: null, request_id: req.headers['x-request-id'] || null, ip_addr: getClientIp(req),
        });
      }
      await client.query('COMMIT');
      try { invalidate(fromId); } catch {}
      try { invalidate(toId); } catch {}
      const finalQ = await pool.query(`SELECT * FROM public.fuel_internal_transfers WHERE id=$1`, [id]);
      res.json(finalQ.rows[0]);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(500).json({ error: e.message });
    } finally { client.release(); }
  });

  // -----------------------------------------------------------------------
  // GET /transfers/internal/list
  // -----------------------------------------------------------------------
  router.get('/transfers/internal/list', requireAuth, async (req, res) => {
    try {
      const from = req.query.from ? isoDateOnly(req.query.from) : null;
      const to = req.query.to ? isoDateOnly(req.query.to) : null;
      if (req.query.from && !from) return res.status(400).json({ error: 'from invalid' });
      if (req.query.to && !to) return res.status(400).json({ error: 'to invalid' });
      const activity = (req.query.activity || '').toString().toUpperCase();
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '100', 10) || 100));
      const params = []; const where = []; let idx = 1;
      if (from) { where.push(`transfer_date >= $${idx++}::date`); params.push(from); }
      if (to) { where.push(`transfer_date <= $${idx++}::date`); params.push(to); }
      if (activity && activity !== 'ALL') { where.push(`UPPER(COALESCE(activity,'')) = $${idx++}`); params.push(activity); }
      params.push(limit); const limitIdx = idx++;
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const r = await pool.query(`
        SELECT id, from_unit_code, to_unit_code, transfer_date::text AS transfer_date, transfer_time::text AS transfer_time,
               transfer_volume, from_lot_code_change, to_lot_code_change, transfer_to_empty, driver_name, performed_by, activity, created_at::text AS created_at
          FROM public.fuel_internal_transfers ${whereSql}
         ORDER BY transfer_date DESC, COALESCE(transfer_time, '00:00'::time) DESC, id DESC
         LIMIT $${limitIdx}
      `, params);
      res.json({ items: r.rows, limit });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // GET /transfers/internal/export
  // -----------------------------------------------------------------------
  router.get('/transfers/internal/export', requireAuth, async (req, res) => {
    try {
      const from = req.query.from ? isoDateOnly(req.query.from) : null;
      const to = req.query.to ? isoDateOnly(req.query.to) : null;
      if (req.query.from && !from) return res.status(400).send('from invalid');
      if (req.query.to && !to) return res.status(400).send('to invalid');
      const activity = (req.query.activity || '').toString().toUpperCase();
      const params = []; const where = []; let idx = 1;
      if (from) { where.push(`transfer_date >= $${idx++}::date`); params.push(from); }
      if (to) { where.push(`transfer_date <= $${idx++}::date`); params.push(to); }
      if (activity && activity !== 'ALL') { where.push(`UPPER(COALESCE(activity,'')) = $${idx++}`); params.push(activity); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const q = await pool.query(`
        SELECT id, transfer_date::text AS transfer_date, transfer_time::text AS transfer_time,
               from_unit_code, to_unit_code, transfer_volume, from_lot_code_change, to_lot_code_change,
               transfer_to_empty, driver_name, performed_by, activity
          FROM public.fuel_internal_transfers ${whereSql}
         ORDER BY transfer_date DESC, COALESCE(transfer_time, '00:00'::time) DESC, id DESC
      `, params);
      const filename = `internal_transfers_${from || 'all'}_${to || 'all'}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      const header = ['Date','Time','From Unit Code','To Unit Code','Transfer Volume (L)','From Lot Code Change','To Lot Code Change','Transfer To Empty','Driver Name','Performed By','Activity'].join(',');
      const lines = [header];
      for (const r of q.rows) {
        lines.push([csvEscape(r.transfer_date),csvEscape(r.transfer_time ? String(r.transfer_time).slice(0,5) : ''),csvEscape(r.from_unit_code),csvEscape(r.to_unit_code),csvEscape(r.transfer_volume),csvEscape(r.from_lot_code_change),csvEscape(r.to_lot_code_change),csvEscape(r.transfer_to_empty ? 'Yes' : 'No'),csvEscape(r.driver_name),csvEscape(r.performed_by),csvEscape(r.activity)].join(','));
      }
      res.send(lines.join('\n'));
    } catch (e) { res.status(500).send(e.message || String(e)); }
  });

  // -----------------------------------------------------------------------
  // PATCH /transfers/testing/:id
  // -----------------------------------------------------------------------
  router.patch('/transfers/testing/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const { transfer_volume_liters, transfer_volume, performed_time, sale_date } = req.body || {};
      const existingQ = await client.query(`SELECT * FROM public.testing_self_transfers WHERE id=$1 FOR UPDATE`, [id]);
      if (!existingQ.rows.length) return res.status(404).json({ error: 'not found' });
      const existing = existingQ.rows[0];
      const opDate = existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : null);
      const tripRow = await getTripRowForOp(client, existing.from_unit_id, opDate, existing.trip);
      await assertOpEditableByTripState(client, tripRow, req);
      const parts = []; const vals = []; let idx = 1;
      if (transfer_volume != null) {
        const v = parseLiters3(transfer_volume);
        if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'invalid transfer_volume_liters' });
        parts.push(`transfer_volume_liters=$${idx++}`); vals.push(v);
      } else if (transfer_volume_liters != null) {
        const v = parseLiters3(transfer_volume_liters);
        if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'invalid transfer_volume_liters' });
        parts.push(`transfer_volume_liters=$${idx++}`); vals.push(v);
      }
      if (performed_time != null) {
        const hhmm = String(performed_time).trim();
        if (/^\d{2}:\d{2}$/.test(hhmm)) {
          const baseDate = sale_date ? isoDateOnly(sale_date) : (existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : isoDateOnly(new Date())));
          if (baseDate) { parts.push(`performed_at=$${idx++}`); vals.push(`${baseDate} ${hhmm}:00`); }
        }
      }
      if (sale_date != null && performed_time == null) {
        const baseDate = isoDateOnly(sale_date);
        if (baseDate) {
          const timePart = existing.performed_at ? String(existing.performed_at).slice(11,19) : '00:00:00';
          parts.push(`performed_at=$${idx++}`); vals.push(`${baseDate} ${timePart}`);
          parts.push(`sale_date=$${idx++}`); vals.push(baseDate);
        }
      }
      if (!parts.length) return res.status(400).json({ error: 'no fields to update' });
      parts.push(`updated_at=NOW()`);
      vals.push(id);
      const q = await client.query(`UPDATE public.testing_self_transfers SET ${parts.join(', ')} WHERE id=$${idx} RETURNING *`, vals);
      if (!q.rows.length) return res.status(404).json({ error: 'not found' });
      await recomputeFuelLotTestingLiters(client, existing.lot_id);
      await client.query('COMMIT');
      try { invalidate(existing.from_unit_id); } catch {}
      res.json(q.rows[0]);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(e.status || 500).json({ error: e.message });
    } finally { client.release(); }
  });

  // -----------------------------------------------------------------------
  // DELETE /transfers/testing/:id
  // -----------------------------------------------------------------------
  router.delete('/transfers/testing/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const existingQ = await client.query(`SELECT * FROM public.testing_self_transfers WHERE id=$1 FOR UPDATE`, [id]);
      if (!existingQ.rows.length) return res.status(404).json({ error: 'not found' });
      const existing = existingQ.rows[0];
      const opDate = existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : null);
      const tripRow = await getTripRowForOp(client, existing.from_unit_id, opDate, existing.trip);
      await assertOpEditableByTripState(client, tripRow, req);
      const del = await client.query(`DELETE FROM public.testing_self_transfers WHERE id=$1 RETURNING *`, [id]);
      const deleted = del.rows[0];
      await recomputeFuelLotTestingLiters(client, existing.lot_id);
      await client.query('COMMIT');
      try { invalidate(existing.from_unit_id); } catch {}
      res.json({ deleted: true, row: deleted });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(e.status || 500).json({ error: e.message });
    } finally { client.release(); }
  });

  return router;
}

module.exports = { createTransferController };
