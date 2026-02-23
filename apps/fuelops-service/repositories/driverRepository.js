// apps/fuelops-service/repositories/driverRepository.js
// ---------------------------------------------------------------------------
// SQL data access for drivers.
// Extracted from backend/index.js driver routes.
// ---------------------------------------------------------------------------

'use strict';

/**
 * @param {import('pg').Pool} pool
 */
function createDriverRepository(pool) {
  return {
    /** List all active drivers */
    async listAll() {
      const r = await pool.query(
        `SELECT id, driver_name, phone, active, vehicle_number
           FROM public.drivers
          WHERE active=TRUE
          ORDER BY driver_name`
      );
      return r.rows;
    },

    /** Create a new driver */
    async create({ driver_name, phone, vehicle_number }) {
      const r = await pool.query(
        `INSERT INTO public.drivers (driver_name, phone, active, vehicle_number)
         VALUES ($1,$2,TRUE,$3)
         RETURNING *`,
        [driver_name, phone || null, vehicle_number || null]
      );
      return r.rows[0];
    },

    /** Update a driver */
    async update(id, { driver_name, phone, active, vehicle_number }) {
      const parts = [];
      const vals = [];
      let idx = 1;
      if (driver_name !== undefined) { parts.push(`driver_name=$${idx++}`); vals.push(driver_name); }
      if (phone !== undefined) { parts.push(`phone=$${idx++}`); vals.push(phone); }
      if (active !== undefined) { parts.push(`active=$${idx++}`); vals.push(active); }
      if (vehicle_number !== undefined) { parts.push(`vehicle_number=$${idx++}`); vals.push(vehicle_number); }
      if (!parts.length) return null;
      vals.push(id);
      const r = await pool.query(
        `UPDATE public.drivers SET ${parts.join(',')} WHERE id=$${idx} RETURNING *`,
        vals
      );
      return r.rows[0] || null;
    },

    /** Soft-delete (deactivate) a driver */
    async deactivate(id) {
      const r = await pool.query(
        `UPDATE public.drivers SET active=FALSE WHERE id=$1 RETURNING *`,
        [id]
      );
      return r.rows[0] || null;
    },
  };
}

module.exports = { createDriverRepository };
