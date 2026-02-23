// apps/fuelops-service/controllers/storageController.js
// ---------------------------------------------------------------------------
// Express Router for storage unit & dispenser & vehicle routes.
// Routes: /storage-units, /vehicles, /dispensers
// Ported 1:1 from backend/index.js for full monolith parity.
// ---------------------------------------------------------------------------

'use strict';

const { Router } = require('express');

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {Function} deps.requireAuth
 * @param {Function} deps.requireRole
 */
function createStorageController({ pool, requireAuth, requireRole }) {
  const router = Router();

  // GET /storage-units — list (optionally by type / active flag)
  router.get('/storage-units', requireAuth, async (req, res) => {
    try {
      const type = (req.query.type || '').toString().toUpperCase();
      const onlyActive = String(req.query.active || 'true').toLowerCase() !== 'false';
      const params = [];
      let sql = `SELECT id, unit_type, unit_code, capacity_liters, active
                   FROM public.storage_units`;
      const where = [];
      if (type && ['TRUCK','DATUM','DISPENSER'].includes(type)) {
        params.push(type);
        where.push(`unit_type = $${params.length}`);
      }
      if (onlyActive) {
        where.push('active = TRUE');
      }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY unit_type, unit_code';
      const r = await pool.query(sql, params);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /storage-units — Create (OWNER/ADMIN)
  router.post('/storage-units', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const { unit_code, capacity_liters, unit_type, vehicle_number } = req.body || {};
      const rawType = String(unit_type || 'TRUCK').toUpperCase();
      const type = rawType === 'STORAGE' ? 'DATUM' : rawType;
      if (!['TRUCK','DATUM','DISPENSER'].includes(type))
        return res.status(400).json({ error: 'unit_type invalid' });
      const code = (unit_code || '').toString().trim();
      const cap = parseInt(capacity_liters, 10);
      if (!code) return res.status(400).json({ error: 'unit_code required' });
      if (!Number.isFinite(cap) || cap <= 0)
        return res.status(400).json({ error: 'capacity_liters must be > 0' });
      const r = await pool.query(
        `INSERT INTO public.storage_units (unit_type, unit_code, capacity_liters, active, vehicle_number)
         VALUES ($1,$2,$3,TRUE,$4)
         ON CONFLICT (unit_code) DO NOTHING
         RETURNING id, unit_type, unit_code, capacity_liters, active, vehicle_number`,
        [type, code, cap, vehicle_number || null]
      );
      if (!r.rows.length) return res.status(409).json({ error: 'unit_code already exists' });
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /storage-units/:id — Update (OWNER/ADMIN)
  router.put('/storage-units/:id', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const cur = await pool.query(`SELECT * FROM public.storage_units WHERE id=$1`, [id]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
      const { unit_code, capacity_liters, vehicle_number, active } = req.body || {};
      const code = unit_code !== undefined ? String(unit_code || '').trim() : cur.rows[0].unit_code;
      const cap = capacity_liters !== undefined ? parseInt(capacity_liters,10) : cur.rows[0].capacity_liters;
      const veh = vehicle_number !== undefined ? (vehicle_number || null) : cur.rows[0].vehicle_number;
      const act = active !== undefined ? !!active : cur.rows[0].active;
      if (!code) return res.status(400).json({ error: 'unit_code required' });
      if (!Number.isFinite(cap) || cap <= 0) return res.status(400).json({ error: 'capacity_liters must be > 0' });
      if (code !== cur.rows[0].unit_code) {
        const exists = await pool.query(`SELECT 1 FROM public.storage_units WHERE unit_code=$1 AND id<>$2`, [code, id]);
        if (exists.rowCount) return res.status(409).json({ error: 'unit_code already exists' });
      }
      const r = await pool.query(`
        UPDATE public.storage_units
           SET unit_code=$1, capacity_liters=$2, vehicle_number=$3, active=$4, updated_at=NOW()
         WHERE id=$5
         RETURNING id, unit_type, unit_code, capacity_liters, active, vehicle_number
      `, [code, cap, veh, act, id]);
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /storage-units/:id — hard delete; FK fallback to soft-delete (OWNER/ADMIN)
  router.delete('/storage-units/:id', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    try {
      const del = await pool.query('DELETE FROM public.storage_units WHERE id=$1 RETURNING id', [id]);
      if (del.rowCount) return res.json({ ok: true, id });
      return res.status(404).json({ error: 'Not found' });
    } catch (e) {
      const msg = String(e && e.message ? e.message : '');
      const isFkViolation = (e && (e.code === '23503' || e.code === '2BP01')) || /foreign\s+key\s+constraint/i.test(msg) || /violates\s+RESTRICT\s+setting\s+of\s+foreign\s+key\s+constraint/i.test(msg);
      if (isFkViolation) {
        const upd = await pool.query(
          `UPDATE public.storage_units SET active=FALSE, updated_at=NOW() WHERE id=$1
           RETURNING id, unit_type, unit_code, capacity_liters, active, vehicle_number`, [id]
        );
        if (!upd.rowCount) return res.status(404).json({ error: 'Not found' });
        return res.json({ ok: true, id, soft_deleted: true, unit: upd.rows[0] });
      }
      return res.status(500).json({ error: e.message });
    }
  });

  // DELETE /vehicles/:id — same hard-delete-first logic (OWNER/ADMIN)
  router.delete('/vehicles/:id', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    try {
      const del = await pool.query('DELETE FROM public.storage_units WHERE id=$1 RETURNING id', [id]);
      if (del.rowCount) return res.json({ ok: true, id });
      return res.status(404).json({ error: 'Not found' });
    } catch (e) {
      const msg = String(e && e.message ? e.message : '');
      const isFkViolation = (e && (e.code === '23503' || e.code === '2BP01')) || /foreign\s+key\s+constraint/i.test(msg) || /violates\s+RESTRICT\s+setting\s+of\s+foreign\s+key\s+constraint/i.test(msg);
      if (isFkViolation) {
        const upd = await pool.query(
          `UPDATE public.storage_units SET active=FALSE, updated_at=NOW() WHERE id=$1
           RETURNING id, unit_type, unit_code, capacity_liters, active, vehicle_number`, [id]
        );
        if (!upd.rowCount) return res.status(404).json({ error: 'Not found' });
        return res.json({ ok: true, id, soft_deleted: true, unit: upd.rows[0] });
      }
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /dispensers — List active dispensers
  router.get('/dispensers', requireAuth, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, unit_type, unit_code, capacity_liters, active
           FROM public.storage_units
          WHERE unit_type='DISPENSER' AND active=TRUE
          ORDER BY unit_code`
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /vehicles — List vehicles by type
  router.get('/vehicles', requireAuth, async (req, res) => {
    try {
      const type = (req.query.type || '').toString().toUpperCase();
      if (!['TRUCK','DATUM'].includes(type))
        return res.status(400).json({ error: 'type must be TRUCK or DATUM' });
      const r = await pool.query(
        `SELECT id, unit_type, unit_code, vehicle_number, capacity_liters, active
           FROM public.storage_units
          WHERE unit_type=$1 AND active=TRUE
          ORDER BY unit_code`, [type]
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createStorageController };
