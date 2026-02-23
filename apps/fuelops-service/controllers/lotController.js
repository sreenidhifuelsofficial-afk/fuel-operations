// apps/fuelops-service/controllers/lotController.js
// ---------------------------------------------------------------------------
// Express Router for fuel lot routes.
// Ported 1:1 from backend/index.js.
//
// Routes:
//   GET    /lot-code
//   POST   /lots
//   POST   /lots/activity
//   GET    /lots/list
//   GET    /lots/export
// ---------------------------------------------------------------------------

'use strict';

const { Router } = require('express');

function createLotController({ pool, requireAuth, requireRole, invalidateCache }) {
  const router = Router();
  const invalidate = typeof invalidateCache === 'function' ? invalidateCache : () => {};

  const { recomputeFuelLotUsedAndStatus, recomputeFuelLotTestingLiters, getInboundAddedLiters, getOutboundUsedLiters } = require('../services/lotService');
  const { insertFuelOpsAudit } = require('../services/auditService');
  const { getTripRowForOp, getTripReadingsSnapshot, assertOpEditableByTripState } = require('../services/tripService');
  const { getActor, getClientIp, isUnfreezeWindow, parseLiters3, isoDateOnly, csvEscape, round3, isTripClosedRow, isPrivileged, isValidDateTimeString, coerceLocalSqlTimestamp } = require('../services/helpers');
  const { createFuelLotRepository } = require('../repositories/fuelLotRepository');
  const lotRepo = createFuelLotRepository(pool);

  // -----------------------------------------------------------------------
  // GET /lot-code — Preview next lot code
  // -----------------------------------------------------------------------
  router.get('/lot-code', requireAuth, async (req, res) => {
    try {
      const unitId = parseInt(req.query.unit_id, 10);
      const loadDate = req.query.load_date ? new Date(String(req.query.load_date)) : new Date();
      const liters = parseLiters3(req.query.loaded_liters);
      if (!Number.isFinite(unitId) || unitId <= 0) return res.status(400).json({ error: 'unit_id required' });
      if (!(loadDate instanceof Date) || isNaN(loadDate.getTime())) return res.status(400).json({ error: 'load_date invalid' });
      if (!Number.isFinite(liters) || liters <= 0) return res.status(400).json({ error: 'loaded_liters must be > 0' });
      const dstr = `${loadDate.getFullYear()}-${String(loadDate.getMonth()+1).padStart(2,'0')}-${String(loadDate.getDate()).padStart(2,'0')}`;
      const r = await pool.query(`SELECT * FROM public.preview_next_lot_code($1::int, $2::date, $3::numeric)`, [unitId, dstr, liters]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ lot_code: r.rows[0].lot_code, seq_index: r.rows[0].seq_index });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // POST /lots — Create a fuel lot
  // -----------------------------------------------------------------------
  router.post('/lots', requireAuth, async (req, res) => {
    const actor = getActor(req);
    try {
      const { unit_id, load_date, loaded_liters, performed_time, load_time, tanker_code } = req.body || {};
      const unitId = parseInt(unit_id, 10);
      const liters = parseLiters3(loaded_liters);
      if (!Number.isFinite(unitId) || unitId <= 0) return res.status(400).json({ error: 'unit_id required' });
      if (!Number.isFinite(liters) || liters <= 0) return res.status(400).json({ error: 'loaded_liters must be > 0' });
      let d = load_date ? new Date(String(load_date)) : new Date();
      if (!(d instanceof Date) || isNaN(d.getTime())) return res.status(400).json({ error: 'load_date invalid' });
      const dstr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const su = await pool.query(`SELECT id, unit_code, capacity_liters FROM public.storage_units WHERE id=$1`, [unitId]);
      if (!su.rows.length) return res.status(400).json({ error: 'Unknown storage unit' });
      if (liters > su.rows[0].capacity_liters) return res.status(400).json({ error: `loaded_liters cannot exceed capacity ${su.rows[0].capacity_liters}` });
      const r = await pool.query(`SELECT * FROM public.create_fuel_lot($1::int, $2::date, $3::numeric)`, [unitId, dstr, liters]);
      const row = r.rows && r.rows[0];
      try { if (row && row.id) await pool.query(`UPDATE public.fuel_lots SET load_type='PURCHASE', updated_at=NOW() WHERE id=$1 AND (load_type IS NULL OR load_type <> 'PURCHASE')`, [row.id]); } catch {}
      try { if (tanker_code && row && row.id) await pool.query(`UPDATE public.fuel_lots SET tanker_code=$1 WHERE id=$2`, [String(tanker_code).trim(), row.id]); } catch {}
      try {
        let finalLoadTs = null;
        const hhmm = (load_time || performed_time || '').trim();
        if (/^\d{2}:\d{2}$/.test(hhmm)) { finalLoadTs = `${dstr} ${hhmm}:00`; }
        else if (load_time && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(load_time)) { finalLoadTs = load_time.length === 16 ? load_time+':00' : load_time; }
        if (finalLoadTs) await pool.query(`UPDATE public.fuel_lots SET load_time=$1::timestamp WHERE id=$2`, [finalLoadTs, row.id]);
      } catch {}
      try { await pool.query(`UPDATE public.fuel_lots SET created_by=$1 WHERE id=$2`, [actor, row.id]); } catch {}
      let full = row;
      try {
        const dateCol = await lotRepo.resolveDateCol();
        const q2 = await pool.query(`SELECT id, unit_id, tanker_code, ${dateCol} AS load_date, tanker_capacity, loaded_liters, seq_index, seq_letters, lot_code_created, created_at, load_time, load_time_hhmm FROM public.fuel_lots WHERE id=$1`, [row.id]);
        if (q2.rows.length) full = q2.rows[0];
      } catch {}
      // Invalidate instock metrics cache for this unit after purchase
      try { invalidate(unitId); } catch {}
      res.status(201).json({ id: full.id, unit_id: full.unit_id, tanker_code: full.tanker_code, load_date: full.load_date, tanker_capacity: full.tanker_capacity, loaded_liters: full.loaded_liters, seq_index: full.seq_index, seq_letters: full.seq_letters, lot_code: full.lot_code_created, created_at: full.created_at, load_time: full.load_time || null, created_by: actor });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // POST /lots/activity — Record transfer/sale/testing activity
  // -----------------------------------------------------------------------
  router.post('/lots/activity', requireAuth, async (req, res) => {
    const actor = getActor(req);
    try {
      const { activity, from_unit_id, to_unit_id, to_vehicle, volume_liters, driver_id, transfer_to_empty, transfer_date, sale_date, performed_time, trip } = req.body || {};
      const act = String(activity || '').toUpperCase();
      const allowed = new Set(['TANKER_TO_TANKER','TANKER_TO_DATUM','TANKER_TO_VEHICLE','DATUM_TO_VEHICLE','TESTING']);
      if (!allowed.has(act)) return res.status(400).json({ error: 'invalid activity' });
      const fromId = parseInt(from_unit_id, 10);
      if (!Number.isFinite(fromId) || fromId <= 0) return res.status(400).json({ error: 'from_unit_id required' });
      const toId = to_unit_id != null ? parseInt(to_unit_id, 10) : null;
      const vol = parseLiters3(volume_liters);
      if (!Number.isFinite(vol) || vol <= 0) return res.status(400).json({ error: 'volume_liters must be > 0' });
      let drow = null;
      if (driver_id != null) { const dr = await pool.query(`SELECT id, name, driver_id FROM public.drivers WHERE id=$1`, [parseInt(driver_id,10)]); drow = dr.rows[0] || null; }
      const lotQ = await pool.query(`SELECT * FROM public.fuel_lots WHERE unit_id=$1 AND stock_status='INSTOCK' ORDER BY created_at DESC, id DESC LIMIT 1`, [fromId]);
      if (!lotQ.rows.length) return res.status(400).json({ error: 'No in-stock lot found for source unit' });
      const lot = lotQ.rows[0];
      const lotId = lot.id;
      const addedIn = await getInboundAddedLiters(pool, lot.id);
      const usedOutBefore = await getOutboundUsedLiters(pool, lot.id);
      const remaining = Math.max(0, Number(lot.loaded_liters) + addedIn - usedOutBefore);
      if (vol > remaining && !(act === 'TANKER_TO_TANKER' || act === 'TANKER_TO_DATUM')) {
        return res.status(400).json({ error: `insufficient volume in lot; remaining ${remaining}` });
      }
      const fromUnit = await pool.query(`SELECT id, unit_code FROM public.storage_units WHERE id=$1`, [fromId]);
      if (!fromUnit.rows.length) return res.status(400).json({ error: 'Invalid from_unit_id' });
      let toUnit = { rows: [] };
      if (toId) toUnit = await pool.query(`SELECT id, unit_code, unit_type, capacity_liters FROM public.storage_units WHERE id=$1`, [toId]);

      // --- TESTING ---
      if (act === 'TESTING') {
        const dateOnly = transfer_date ? isoDateOnly(transfer_date) : (sale_date ? isoDateOnly(sale_date) : isoDateOnly(new Date()));
        let tsSql = null;
        const hhmm = (performed_time || '').trim();
        if (dateOnly && /^\d{2}:\d{2}$/.test(hhmm)) tsSql = `${dateOnly} ${hhmm}:00`;
        else if (dateOnly) tsSql = `${dateOnly} 00:00:00`;
        let actRow = null;
        let updLot = null;
        try {
          const upd = await pool.query(`UPDATE public.fuel_lots SET cumulative_testing_liters=COALESCE(cumulative_testing_liters,0)+$2, updated_at=NOW() WHERE id=$1 RETURNING *`, [lot.id, vol]);
          updLot = upd.rows[0];
        } catch (e) { updLot = lot; }
        try {
          const fromUnitCode = fromUnit.rows[0].unit_code;
          const tripVal = (Number.isFinite(parseInt(trip,10)) && parseInt(trip,10) > 0) ? parseInt(trip,10) : null;
          const tripRow = await getTripRowForOp(pool, fromId, dateOnly, tripVal);
          await assertOpEditableByTripState(pool, tripRow, req);
          await pool.query(`
            INSERT INTO public.testing_self_transfers (lot_id, activity, from_unit_id, from_unit_code, to_vehicle, transfer_volume_liters, lot_code, driver_id, driver_name, performed_by, performed_at, updated_by, sale_date, trip)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamp, NOW()), $12, COALESCE($13::date, NULL), $14) RETURNING *
          `, [lot.id, act, fromId, fromUnitCode, fromUnitCode, vol, lot.lot_code_created || null, drow ? drow.id : null, drow ? drow.name : null, actor, tsSql || null, actor, dateOnly, tripVal]);
        } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[TESTING self insert warn]', e.message); }
        try { invalidate(fromId); } catch {}
        return res.status(201).json({ testing: actRow, lot: updLot });
      }

      // --- Internal transfer ---
      const isInternal = act === 'TANKER_TO_TANKER' || act === 'TANKER_TO_DATUM';
      if (isInternal) {
        if (!toId) return res.status(400).json({ error: 'to_unit_id required for internal transfer' });
        // Enforce opening reading
        try {
          const dateOnly = transfer_date ? isoDateOnly(transfer_date) : isoDateOnly(new Date());
          const openQ = await pool.query(`SELECT opening_liters FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`, [fromId, dateOnly]);
          let hasOpening = false;
          if (openQ.rows.length && openQ.rows[0].opening_liters != null) { hasOpening = true; }
          else { try { const tq = await pool.query(`SELECT opening_at, opening_liters FROM public.truck_dispenser_trips WHERE truck_id=$1 AND reading_date=$2 AND (opening_at IS NOT NULL OR opening_liters IS NOT NULL) LIMIT 1`, [fromId, dateOnly]); if (tq.rows.length) hasOpening = true; } catch {} }
          if (!hasOpening) return res.status(400).json({ error: 'Opening reading missing for this tanker on the selected date. Please record opening before transfers.' });
        } catch {}
        let lotToQ = await pool.query(`SELECT * FROM public.fuel_lots WHERE unit_id=$1 AND stock_status='INSTOCK' ORDER BY created_at DESC, id DESC LIMIT 1`, [toId]);
        let createdNewDestLot = false;
        if (!lotToQ.rows.length) {
          const tRow = toUnit.rows[0];
          if (tRow && (tRow.unit_type === 'DATUM' || tRow.unit_type === 'TRUCK')) {
            const toUnitCap = tRow.capacity_liters;
            if (vol > toUnitCap) return res.status(400).json({ error: `destination capacity exceeded: would be ${vol}/${toUnitCap}` });
            try {
              const createDate = transfer_date ? isoDateOnly(transfer_date) : isoDateOnly(new Date());
              const created = await pool.query(`SELECT * FROM public.create_fuel_lot($1::int, $2::date, $3::numeric)`, [toId, createDate, vol]);
              if (created.rows && created.rows[0]) { lotToQ = { rows: [created.rows[0]] }; createdNewDestLot = true; }
            } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[WARN] failed to create destination lot for empty unit', e.message); }
          }
        }
        try {
          if (createdNewDestLot && lotToQ.rows[0] && lotToQ.rows[0].id) {
            await pool.query(`UPDATE public.fuel_lots SET load_type='EMPTY_TRANSFER' WHERE id=$1`, [lotToQ.rows[0].id]);
            const ref = await pool.query(`SELECT * FROM public.fuel_lots WHERE id=$1`, [lotToQ.rows[0].id]);
            if (ref.rows && ref.rows[0]) lotToQ.rows[0] = ref.rows[0];
          }
        } catch {}
        const lotTo = (lotToQ.rows && lotToQ.rows[0]) ? lotToQ.rows[0] : null;
        if (!lotTo) return res.status(400).json({ error: 'No in-stock lot found for destination unit' });
        const fromUnitCode = fromUnit.rows[0].unit_code;
        const toUnitCode = (toUnit.rows[0] || {}).unit_code;
        // Collect all source lots (FIFO)
        const sourceLotsQ = await pool.query(`SELECT * FROM public.fuel_lots WHERE unit_id=$1 AND stock_status='INSTOCK' ORDER BY created_at ASC, id ASC`, [fromId]);
        if (!sourceLotsQ.rows.length) return res.status(400).json({ error: 'No in-stock lot found for source unit' });
        const lotRemaining = [];
        let totalRemaining = 0;
        for (const L of sourceLotsQ.rows) {
          const added = await getInboundAddedLiters(pool, L.id);
          const used = await getOutboundUsedLiters(pool, L.id);
          const rem = Math.max(0, Number(L.loaded_liters) + added - used);
          lotRemaining.push({ lot: L, inbound: added, usedOut: used, remaining: rem });
          totalRemaining += rem;
        }
        if (vol > totalRemaining) return res.status(400).json({ error: `insufficient volume in lot; remaining ${totalRemaining}` });
        // Capacity guard
        const toAddedBefore = createdNewDestLot ? 0 : await getInboundAddedLiters(pool, lotTo.id);
        const toUsedOutBefore = createdNewDestLot ? 0 : await getOutboundUsedLiters(pool, lotTo.id);
        const destCap = Number((toUnit.rows[0] || {}).capacity_liters || 0);
        if (destCap > 0) {
          const toCurrentNet = createdNewDestLot ? 0 : (Number(lotTo.loaded_liters) + toAddedBefore - toUsedOutBefore);
          const toNetAfter = toCurrentNet + vol;
          if (toNetAfter > destCap) return res.status(400).json({ error: `destination capacity exceeded: would be ${toNetAfter}/${destCap}` });
        }
        const dateOnly = transfer_date ? isoDateOnly(transfer_date) : null;
        let tsSql = null;
        const hhmm = (performed_time || '').trim();
        if (dateOnly && /^\d{2}:\d{2}$/.test(hhmm)) tsSql = `${dateOnly} ${hhmm}:00`;
        const tripVal = (Number.isFinite(parseInt(trip, 10)) && parseInt(trip, 10) > 0) ? parseInt(trip, 10) : null;
        const tripRow = await getTripRowForOp(pool, fromId, dateOnly || isoDateOnly(new Date()), tripVal);
        await assertOpEditableByTripState(pool, tripRow, req);
        const shouldAudit = isUnfreezeWindow(tripRow);
        try { if (createdNewDestLot && tsSql) await pool.query(`UPDATE public.fuel_lots SET load_time=$1::timestamp WHERE id=$2`, [tsSql, lotTo.id]); } catch {}
        const prevAdjQ = await pool.query(`SELECT COALESCE(MAX(dispenser_reading_transfer_adjust),0) AS prev FROM public.fuel_internal_transfers WHERE from_unit_id=$1`, [fromId]);
        let runningAdjust = prevAdjQ.rows[0] ? Number(prevAdjQ.rows[0].prev) : 0;
        const xferRows = [];
        let remainingToTransfer = vol;
        for (const entry of lotRemaining) {
          if (remainingToTransfer <= 0) break;
          const take = Math.min(entry.remaining, remainingToTransfer);
          if (take <= 0) continue;
          const tripSnapBefore = shouldAudit ? (tripRow ? await getTripReadingsSnapshot(pool, tripRow) : null) : null;
          const fromUsedNow = await getOutboundUsedLiters(pool, entry.lot.id);
          const fromUsedAfter = fromUsedNow + take;
          const fromSuffix = `-${fromUsedAfter}` + (entry.inbound > 0 ? `+(${entry.inbound})` : '');
          const fromLotCodeAfter = `${entry.lot.lot_code_created}${fromSuffix}`;
          const toAddedAfter = createdNewDestLot ? 0 : (toAddedBefore + xferRows.reduce((a,r)=>a+r.transfer_volume,0) + take);
          const toSuffix = createdNewDestLot ? '' : (`-${toUsedOutBefore}` + (toAddedAfter > 0 ? `+(${toAddedAfter})` : ''));
          const toLotCodeAfter = `${lotTo.lot_code_created}${toSuffix}`;
          runningAdjust += take;
          const ins = await pool.query(`
            INSERT INTO public.fuel_internal_transfers (from_lot_id, to_lot_id, activity, from_unit_id, from_unit_code, to_unit_id, to_unit_code, transfer_volume, from_tanker_change, from_lot_code_change, to_tanker_change, to_lot_code_change, transfer_to_empty, driver_name, performed_by, dispenser_reading_transfer_adjust, transfer_date, transfer_time, trip)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, COALESCE($17::date, CURRENT_DATE), $18::time, $19) RETURNING *
          `, [entry.lot.id, lotTo.id, act, fromId, fromUnitCode, toId, toUnitCode, take, -take, fromLotCodeAfter, take, toLotCodeAfter, (createdNewDestLot ? true : !!transfer_to_empty), drow ? drow.name : null, actor, runningAdjust, dateOnly, (hhmm && /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : '00:00'), tripVal]);
          xferRows.push(ins.rows[0]);
          if (shouldAudit) {
            const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(pool, tripRow) : null;
            await insertFuelOpsAudit(pool, { user_id: req.user?.sub || null, username: actor, tab: 'At Depot', section: 'Sales & Transfers', action: 'CREATE', entity_type: 'INTERNAL_TRANSFER', entity_id: ins.rows[0]?.id || null, unit_id: fromId, unit_type: 'TRUCK', trip_id: tripRow?.id || null, trip_no: tripRow?.trip_no || null, op_date: dateOnly, performed_time: null, amount_liters: take, payload_old: (tripSnapBefore ? { ...tripSnapBefore } : null), payload_new: (ins.rows[0] ? (tripSnapAfter ? { ...ins.rows[0], ...tripSnapAfter } : ins.rows[0]) : (tripSnapAfter ? { ...tripSnapAfter } : null)), reason: null, request_id: req.headers['x-request-id'] || null, ip_addr: getClientIp(req) });
          }
          const fromNetRemaining = (Number(entry.lot.loaded_liters) + entry.inbound) - fromUsedAfter;
          const fromStock = fromNetRemaining <= 0 ? 'SOLD' : 'INSTOCK';
          await pool.query(`UPDATE public.fuel_lots SET used_liters=$1, stock_status=$2, updated_at=NOW() WHERE id=$3`, [fromUsedAfter, fromStock, entry.lot.id]);
          remainingToTransfer -= take;
        }
        const toAddedCum = createdNewDestLot ? 0 : await getInboundAddedLiters(pool, lotTo.id);
        const toUsedNow = await getOutboundUsedLiters(pool, lotTo.id);
        const toNetRemaining = (Number(lotTo.loaded_liters) + toAddedCum) - toUsedNow;
        const toStock = toNetRemaining <= 0 ? 'SOLD' : 'INSTOCK';
        await pool.query(`UPDATE public.fuel_lots SET used_liters=$1, stock_status=$2, updated_at=NOW() WHERE id=$3`, [toUsedNow, toStock, lotTo.id]);
        try { if (createdNewDestLot && lotTo.id) await pool.query(`UPDATE public.fuel_lots SET load_type='EMPTY_TRANSFER', updated_at=NOW() WHERE id=$1`, [lotTo.id]); } catch {}
        // Invalidate cache for both source and destination units
        try { invalidate(fromId); } catch {}
        try { invalidate(toId); } catch {}
        const last = lotRemaining.find(l => l.remaining > 0) ? lotRemaining.filter(l=>l.remaining>0).slice(-1)[0] : lotRemaining[lotRemaining.length-1];
        const lastUsedNow = await getOutboundUsedLiters(pool, last.lot.id);
        const lastSuffix = `-${lastUsedNow}` + (last.inbound>0?`+(${last.inbound})`:'');
        const lotSummary = { lot_code_initial: last.lot.lot_code_created, used_liters: lastUsedNow, loaded_liters: last.lot.loaded_liters, lot_code_by_transfer: `${last.lot.lot_code_created}${lastSuffix}` };
        return res.status(201).json({ transfers: xferRows, lot: lotSummary, total_transferred: xferRows.reduce((a,r)=>a+Number(r.transfer_volume||0),0) });
      }

      // --- Sale transfer ---
      if (!to_vehicle) return res.status(400).json({ error: 'to_vehicle required' });
      const fromUnitCode = fromUnit.rows[0].unit_code;
      const inboundAdded = await getInboundAddedLiters(pool, lot.id);
      const usedBefore = await getOutboundUsedLiters(pool, lot.id);
      const usedAfter = usedBefore + vol;
      const suffix = `-${usedAfter}`;
      const lotCodeAfter = `${lot.lot_code_created}${suffix}`;
      const baseSaleDate = sale_date ? isoDateOnly(sale_date) : null;
      let saleDateOnly = null;
      const hhmmSale = (performed_time || '').trim();
      if (baseSaleDate && /^\d{2}:\d{2}$/.test(hhmmSale)) saleDateOnly = `${baseSaleDate} ${hhmmSale}:00`;
      const tripVal = (Number.isFinite(parseInt(trip,10)) && parseInt(trip,10) > 0) ? parseInt(trip,10) : null;
      const opDate = (sale_date ? isoDateOnly(sale_date) : (saleDateOnly ? isoDateOnly(saleDateOnly) : isoDateOnly(new Date())));
      const tripRow = await getTripRowForOp(pool, fromId, opDate, tripVal);
      await assertOpEditableByTripState(pool, tripRow, req);
      const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(pool, tripRow) : null;
      const sale = await pool.query(`
        INSERT INTO public.fuel_sale_transfers (lot_id, from_unit_id, from_unit_code, to_vehicle, sale_volume_liters, lot_code_after, driver_id, driver_name, performed_by, activity, performed_at, sale_date, trip)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamp, NOW()), COALESCE($12::date, CURRENT_DATE), $13) RETURNING *
      `, [lot.id, fromId, fromUnitCode, to_vehicle, vol, lotCodeAfter, drow ? drow.id : null, drow ? drow.name : null, actor, act, saleDateOnly, sale_date ? isoDateOnly(sale_date) : null, tripVal]);
      if (isUnfreezeWindow(tripRow)) {
        const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(pool, tripRow) : null;
        await insertFuelOpsAudit(pool, { user_id: req.user?.sub || null, username: actor, tab: 'At Depot', section: 'Sales & Transfers', action: 'CREATE', entity_type: 'SALE', entity_id: sale.rows[0]?.id || null, unit_id: fromId, unit_type: 'TRUCK', driver_id: drow ? drow.id : null, trip_id: tripRow?.id || null, trip_no: tripRow?.trip_no || null, op_date: opDate, performed_time: null, amount_liters: vol, payload_old: (tripSnapBefore ? { ...tripSnapBefore } : null), payload_new: (sale.rows[0] ? (tripSnapAfter ? { ...sale.rows[0], ...tripSnapAfter } : sale.rows[0]) : (tripSnapAfter ? { ...tripSnapAfter } : null)), reason: null, request_id: req.headers['x-request-id'] || null, ip_addr: getClientIp(req) });
      }
      const netRemaining = (Number(lot.loaded_liters) + inboundAdded) - usedAfter;
      const stock = netRemaining <= 0 ? 'SOLD' : 'INSTOCK';
      const upd = await pool.query(`UPDATE public.fuel_lots SET used_liters=$1, stock_status=$2, updated_at=NOW() WHERE id=$3 RETURNING *`, [usedAfter, stock, lot.id]);
      // Invalidate cache for source unit after sale
      try { invalidate(fromId); } catch {}
      return res.status(201).json({ sale: sale.rows[0], lot: upd.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // GET /lots/list
  // -----------------------------------------------------------------------
  router.get('/lots/list', requireAuth, async (req, res) => {
    try {
      const dateCol = await lotRepo.resolveDateCol();
      const unitIdRaw = req.query.unit_id;
      const unitId = unitIdRaw != null ? parseInt(unitIdRaw, 10) : null;
      const from = req.query.from ? isoDateOnly(req.query.from) : null;
      const to = req.query.to ? isoDateOnly(req.query.to) : null;
      if (req.query.from && !from) return res.status(400).json({ error: 'from invalid' });
      if (req.query.to && !to) return res.status(400).json({ error: 'to invalid' });
      const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '50', 10) || 50));
      const loadType = (req.query.load_type || '').toString().toUpperCase();
      const unitType = (req.query.unit_type || '').toString().toUpperCase();
      const selectCols = `SELECT fl.id, fl.unit_id, fl.${dateCol}::date AS load_date, fl.loaded_liters, fl.used_liters, fl.stock_status, fl.lot_code_created AS lot_code_initial, fl.created_at::text AS created_at, fl.load_time::text AS load_time, COALESCE(fl.load_type, 'PURCHASE') AS load_type, su.unit_code, su.unit_type, CASE WHEN fl.stock_status='SOLD' THEN 0 ELSE GREATEST(0, fl.loaded_liters - fl.used_liters) END AS remaining_liters, (SELECT COALESCE(SUM(fit.transfer_volume) FILTER (WHERE COALESCE(fit.activity,'') <> 'TESTING'),0) FROM public.fuel_internal_transfers fit WHERE fit.to_lot_id = fl.id) AS transfer_volume_liters, (SELECT string_agg(DISTINCT fit.to_unit_code, ',') FROM public.fuel_internal_transfers fit WHERE fit.from_lot_id = fl.id AND fit.to_unit_code IS NOT NULL) AS transfer_to_unit_codes`;
      if (Number.isFinite(unitId) && unitId > 0) {
        const p = [unitId];
        let where = ' WHERE fl.unit_id=$1';
        if (loadType && ['PURCHASE','EMPTY_TRANSFER'].includes(loadType)) { p.push(loadType); where += ` AND COALESCE(fl.load_type, 'PURCHASE') = $${p.length}`; }
        if (from) { p.push(from); where += ` AND fl.${dateCol}::date >= $${p.length}::date`; }
        if (to) { p.push(to); where += ` AND fl.${dateCol}::date <= $${p.length}::date`; }
        const sql = `${selectCols} FROM public.fuel_lots fl JOIN public.storage_units su ON su.id = fl.unit_id ${where} ORDER BY COALESCE(fl.load_time, fl.created_at) DESC, fl.id DESC LIMIT ${limit}`;
        const r = await pool.query(sql, p);
        return res.json({ items: r.rows });
      }
      let params = [];
      let sqlBase = `FROM public.fuel_lots fl JOIN public.storage_units su ON su.id = fl.unit_id WHERE su.active=TRUE`;
      if (unitType && ['TRUCK','DATUM'].includes(unitType)) { params.push(unitType); sqlBase += ` AND su.unit_type = $${params.length}`; }
      else { sqlBase += ` AND su.unit_type IN ('TRUCK','DATUM')`; }
      if (loadType && ['PURCHASE','EMPTY_TRANSFER'].includes(loadType)) { params.push(loadType); sqlBase += ` AND COALESCE(fl.load_type, 'PURCHASE') = $${params.length}`; }
      if (from) { params.push(from); sqlBase += ` AND fl.${dateCol}::date >= $${params.length}::date`; }
      if (to) { params.push(to); sqlBase += ` AND fl.${dateCol}::date <= $${params.length}::date`; }
      const sql = `${selectCols} ${sqlBase} ORDER BY COALESCE(fl.load_time, fl.created_at) DESC, fl.id DESC LIMIT ${limit}`;
      const r = await pool.query(sql, params);
      return res.json({ items: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -----------------------------------------------------------------------
  // GET /lots/export — CSV
  // -----------------------------------------------------------------------
  router.get('/lots/export', requireAuth, async (req, res) => {
    try {
      const dateCol = await lotRepo.resolveDateCol();
      const unitId = req.query.unit_id ? parseInt(req.query.unit_id, 10) : null;
      if (req.query.unit_id && (!Number.isFinite(unitId) || unitId <= 0)) return res.status(400).send('unit_id invalid');
      const from = req.query.from ? isoDateOnly(req.query.from) : null;
      const to = req.query.to ? isoDateOnly(req.query.to) : null;
      if (req.query.from && !from) return res.status(400).send('from invalid');
      if (req.query.to && !to) return res.status(400).send('to invalid');
      const loadType = (req.query.load_type || '').toString().toUpperCase();
      const unitType = (req.query.unit_type || '').toString().toUpperCase();
      const params = []; const where = []; let idx = 1;
      where.push('su.active=TRUE');
      if (unitType && ['TRUCK','DATUM'].includes(unitType)) { where.push(`su.unit_type = $${idx++}`); params.push(unitType); }
      else { where.push("su.unit_type IN ('TRUCK','DATUM')"); }
      if (loadType && ['PURCHASE','EMPTY_TRANSFER'].includes(loadType)) { where.push(`COALESCE(fl.load_type, 'PURCHASE') = $${idx++}`); params.push(loadType); }
      if (Number.isFinite(unitId) && unitId > 0) { where.push(`fl.unit_id = $${idx++}::int`); params.push(unitId); }
      if (from) { where.push(`fl.${dateCol}::date >= $${idx++}::date`); params.push(from); }
      if (to) { where.push(`fl.${dateCol}::date <= $${idx++}::date`); params.push(to); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const q = await pool.query(`
        SELECT fl.id, fl.lot_code_created AS lot_code, su.unit_code, fl.${dateCol}::date AS load_date, fl.load_time::text AS load_time, fl.loaded_liters, fl.used_liters, CASE WHEN fl.stock_status='SOLD' THEN 0 ELSE GREATEST(0, fl.loaded_liters - fl.used_liters) END AS remaining_liters, fl.stock_status, COALESCE(fl.load_type, 'PURCHASE') AS load_type, (SELECT string_agg(DISTINCT fit.to_unit_code, ',') FROM public.fuel_internal_transfers fit WHERE fit.from_lot_id = fl.id AND fit.to_unit_code IS NOT NULL) AS transferred_to, fl.created_at::text AS created_at
          FROM public.fuel_lots fl JOIN public.storage_units su ON su.id = fl.unit_id ${whereSql} ORDER BY COALESCE(fl.load_time, fl.created_at) DESC, fl.id DESC
      `, params);
      const filename = `lots_${from || 'all'}_${to || 'all'}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      const header = ['Lot Code','Unit Code','Load Date','Load Time','Loaded (L)','Used (L)','Remaining (L)','Stock Status','Transferred To','Load Type','Created At'].join(',');
      const lines = [header];
      for (const r of q.rows) {
        lines.push([csvEscape(r.lot_code),csvEscape(r.unit_code),csvEscape(r.load_date),csvEscape(r.load_time ? String(r.load_time).slice(0,5) : ''),csvEscape(r.loaded_liters),csvEscape(r.used_liters),csvEscape(r.remaining_liters),csvEscape(r.stock_status),csvEscape(r.transferred_to),csvEscape(r.load_type),csvEscape(r.created_at)].join(','));
      }
      res.send(lines.join('\n'));
    } catch (e) { res.status(500).send(e.message || String(e)); }
  });

  return router;
}

module.exports = { createLotController };
