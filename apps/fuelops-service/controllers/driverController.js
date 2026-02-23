// apps/fuelops-service/controllers/driverController.js
// ---------------------------------------------------------------------------
// Express Router for driver CRUD routes.
// Routes: /drivers
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
function createDriverController({ pool, requireAuth, requireRole }) {
  const router = Router();

  // GET /drivers — list (with optional ?active= filter)
  router.get('/drivers', requireAuth, async (req, res) => {
    try {
      const onlyActive = String(req.query.active || 'true').toLowerCase() !== 'false';
      const r = await pool.query(
        `SELECT id, name, phone, driver_id, active FROM public.drivers ${onlyActive ? 'WHERE active=TRUE' : ''} ORDER BY name`
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /drivers — create (OWNER/ADMIN)
  router.post('/drivers', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const { name, phone, driver_id, active } = req.body || {};
      const nm = String(name || '').trim();
      const code = String(driver_id || '').trim().toUpperCase();
      if (!nm) return res.status(400).json({ error: 'name required' });
      if (!code) return res.status(400).json({ error: 'driver_id required' });
      const r = await pool.query(`
        INSERT INTO public.drivers (name, phone, driver_id, active)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (driver_id) DO NOTHING
        RETURNING id, name, phone, driver_id, active
      `, [nm, phone || null, code, active === false ? false : true]);
      if (!r.rows.length) return res.status(409).json({ error: 'driver_id already exists' });
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /drivers/:id — update (OWNER/ADMIN)
  router.put('/drivers/:id', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const cur = await pool.query(`SELECT * FROM public.drivers WHERE id=$1`, [id]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
      const { name, phone, driver_id, active } = req.body || {};
      const nm = name !== undefined ? String(name || '').trim() : cur.rows[0].name;
      const code = driver_id !== undefined ? String(driver_id || '').trim().toUpperCase() : cur.rows[0].driver_id;
      const ph = phone !== undefined ? (phone || null) : cur.rows[0].phone;
      const act = active !== undefined ? !!active : cur.rows[0].active;
      if (!nm) return res.status(400).json({ error: 'name required' });
      if (!code) return res.status(400).json({ error: 'driver_id required' });
      if (code !== cur.rows[0].driver_id) {
        const d = await pool.query(`SELECT 1 FROM public.drivers WHERE driver_id=$1 AND id<>$2`, [code, id]);
        if (d.rowCount) return res.status(409).json({ error: 'driver_id already exists' });
      }
      const r = await pool.query(`
        UPDATE public.drivers
           SET name=$1, phone=$2, driver_id=$3, active=$4, updated_at=NOW()
         WHERE id=$5
         RETURNING id, name, phone, driver_id, active
      `, [nm, ph, code, act, id]);
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /drivers/:id — hard delete; FK fallback to soft-delete (OWNER/ADMIN)
  router.delete('/drivers/:id', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    try {
      const del = await pool.query('DELETE FROM public.drivers WHERE id=$1 RETURNING id', [id]);
      if (del.rowCount) return res.json({ ok: true, id });
      return res.status(404).json({ error: 'Not found' });
    } catch (e) {
      const msg = String(e && e.message ? e.message : '');
      const isFkViolation = (e && (e.code === '23503' || e.code === '2BP01')) || /foreign\s+key\s+constraint/i.test(msg) || /violates\s+RESTRICT\s+setting\s+of\s+foreign\s+key\s+constraint/i.test(msg);
      if (isFkViolation) {
        const upd = await pool.query(
          `UPDATE public.drivers SET active=FALSE, updated_at=NOW() WHERE id=$1
           RETURNING id, name, phone, driver_id, active`, [id]
        );
        if (!upd.rowCount) return res.status(404).json({ error: 'Not found' });
        return res.json({ ok: true, id, soft_deleted: true, driver: upd.rows[0] });
      }
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createDriverController };
