// apps/fuelops-service/repositories/storageUnitRepository.js
// ---------------------------------------------------------------------------
// SQL data access for storage units (trucks, datums, dispensers).
// Extracted from backend/index.js storage unit & vehicle routes.
// ---------------------------------------------------------------------------

'use strict';

/**
 * @param {import('pg').Pool} pool
 */
function createStorageUnitRepository(pool) {
  return {
    /** List all active storage units */
    async listAll() {
      const r = await pool.query(
        `SELECT id, unit_type, unit_code, capacity_liters, active, vehicle_number
           FROM public.storage_units
          WHERE active=TRUE
          ORDER BY unit_type, unit_code`
      );
      return r.rows;
    },

    /** List active units by type (TRUCK / DATUM) */
    async listByType(type) {
      const r = await pool.query(
        `SELECT id, unit_type, unit_code, vehicle_number, capacity_liters, active
           FROM public.storage_units
          WHERE unit_type=$1 AND active=TRUE
          ORDER BY unit_code`,
        [type]
      );
      return r.rows;
    },

    /** List active dispensers */
    async listDispensers() {
      const r = await pool.query(
        `SELECT id, unit_type, unit_code, capacity_liters, active, vehicle_number
           FROM public.storage_units
          WHERE active=TRUE AND unit_type='DISPENSER'
          ORDER BY unit_code`
      );
      return r.rows;
    },

    /** Create a storage unit (upsert on unit_code) */
    async create({ unit_type, unit_code, capacity_liters, vehicle_number }) {
      const r = await pool.query(
        `INSERT INTO public.storage_units (unit_type, unit_code, capacity_liters, active, vehicle_number)
         VALUES ($1,$2,$3,TRUE,$4)
         ON CONFLICT (unit_code) DO NOTHING
         RETURNING id, unit_type, unit_code, capacity_liters, active, vehicle_number`,
        [unit_type, unit_code, capacity_liters, vehicle_number || null]
      );
      return r.rows[0] || null;
    },

    /** Update a storage unit */
    async update(id, fields) {
      const parts = [];
      const vals = [];
      let idx = 1;
      for (const [key, value] of Object.entries(fields)) {
        parts.push(`${key}=$${idx++}`);
        vals.push(value);
      }
      if (!parts.length) return null;
      vals.push(id);
      const r = await pool.query(
        `UPDATE public.storage_units SET ${parts.join(',')} WHERE id=$${idx} RETURNING *`,
        vals
      );
      return r.rows[0] || null;
    },

    /** Soft-delete (deactivate) a storage unit */
    async deactivate(id) {
      const r = await pool.query(
        `UPDATE public.storage_units SET active=FALSE WHERE id=$1 RETURNING *`,
        [id]
      );
      return r.rows[0] || null;
    },
  };
}

module.exports = { createStorageUnitRepository };
