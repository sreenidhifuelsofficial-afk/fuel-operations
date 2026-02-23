// apps/fuelops-service/repositories/fuelLotRepository.js
// ---------------------------------------------------------------------------
// SQL data access for fuel lots (loads, lot-code generation).
// Extracted from backend/index.js lot routes.
// ---------------------------------------------------------------------------

'use strict';

/**
 * @param {import('pg').Pool} pool
 */
function createFuelLotRepository(pool) {
  // Cached date column name (load_date vs loaded_date)
  let dateCol = null;

  async function resolveDateCol() {
    if (dateCol) return dateCol;
    try {
      const q = await pool.query(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='fuel_lots'
             AND column_name IN ('load_date','loaded_date')
           ORDER BY CASE column_name WHEN 'load_date' THEN 1 ELSE 2 END LIMIT 1`
      );
      dateCol = (q.rows[0] && q.rows[0].column_name) || 'loaded_date';
    } catch { dateCol = 'loaded_date'; }
    return dateCol;
  }

  return {
    resolveDateCol,

    /** Generate next lot code for a unit on a given date */
    async generateLotCode(unitId, date) {
      const dc = await resolveDateCol();
      const q = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM public.fuel_lots WHERE unit_id=$1 AND ${dc}=$2::date`,
        [unitId, date]
      );
      return q.rows[0]?.cnt || 0;
    },

    /** List recent lots for a unit */
    async listByUnit(unitId, limit = 50) {
      const dc = await resolveDateCol();
      const r = await pool.query(
        `SELECT id, unit_id, lot_code_created, loaded_liters, used_liters, stock_status,
                ${dc} AS load_date, created_at, load_time, seq_index, load_type,
                cumulative_testing_liters
           FROM public.fuel_lots
          WHERE unit_id=$1
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        [unitId, limit]
      );
      return r.rows;
    },

    /** Fetch a single lot by ID */
    async getById(id) {
      const r = await pool.query(`SELECT * FROM public.fuel_lots WHERE id=$1`, [id]);
      return r.rows[0] || null;
    },
  };
}

module.exports = { createFuelLotRepository };
