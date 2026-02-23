// apps/fuelops-service/repositories/transferRepository.js
// ---------------------------------------------------------------------------
// SQL data access for fuel sale transfers, internal transfers, and testing
// transfers.  Extracted from backend/index.js transfer routes.
// ---------------------------------------------------------------------------

'use strict';

/**
 * @param {import('pg').Pool} pool
 */
function createTransferRepository(pool) {
  return {
    // -----------------------------------------------------------------------
    // Sales
    // -----------------------------------------------------------------------
    async listSales({ unit_id, lot_id, from_date, to_date, limit = 200 }) {
      const parts = [];
      const vals = [];
      let idx = 1;
      if (unit_id) { parts.push(`from_unit_id=$${idx++}`); vals.push(unit_id); }
      if (lot_id) { parts.push(`lot_id=$${idx++}`); vals.push(lot_id); }
      if (from_date) { parts.push(`COALESCE(sale_date, performed_at::date) >= $${idx++}::date`); vals.push(from_date); }
      if (to_date) { parts.push(`COALESCE(sale_date, performed_at::date) <= $${idx++}::date`); vals.push(to_date); }
      const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
      vals.push(limit);
      const r = await pool.query(
        `SELECT * FROM public.fuel_sale_transfers ${where}
         ORDER BY COALESCE(performed_at, sale_date) DESC, id DESC
         LIMIT $${idx}`,
        vals
      );
      return r.rows;
    },

    async getSaleById(id, client) {
      const db = client || pool;
      const r = await db.query(`SELECT * FROM public.fuel_sale_transfers WHERE id=$1`, [id]);
      return r.rows[0] || null;
    },

    async getSaleByIdForUpdate(id, client) {
      const r = await client.query(`SELECT * FROM public.fuel_sale_transfers WHERE id=$1 FOR UPDATE`, [id]);
      return r.rows[0] || null;
    },

    async deleteSale(id, client) {
      const r = await client.query(`DELETE FROM public.fuel_sale_transfers WHERE id=$1 RETURNING *`, [id]);
      return r.rows[0] || null;
    },

    // -----------------------------------------------------------------------
    // Internal transfers
    // -----------------------------------------------------------------------
    async listInternalTransfers({ unit_id, from_date, to_date, limit = 200 }) {
      const parts = [];
      const vals = [];
      let idx = 1;
      if (unit_id) { parts.push(`(from_unit_id=$${idx} OR to_unit_id=$${idx})`); vals.push(unit_id); idx++; }
      if (from_date) { parts.push(`transfer_date >= $${idx++}::date`); vals.push(from_date); }
      if (to_date) { parts.push(`transfer_date <= $${idx++}::date`); vals.push(to_date); }
      const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
      vals.push(limit);
      const r = await pool.query(
        `SELECT * FROM public.fuel_internal_transfers ${where}
         ORDER BY transfer_date DESC, transfer_time DESC, id DESC
         LIMIT $${idx}`,
        vals
      );
      return r.rows;
    },

    async getInternalTransferByIdForUpdate(id, client) {
      const r = await client.query(`SELECT * FROM public.fuel_internal_transfers WHERE id=$1 FOR UPDATE`, [id]);
      return r.rows[0] || null;
    },

    async deleteInternalTransfer(id, client) {
      const r = await client.query(`DELETE FROM public.fuel_internal_transfers WHERE id=$1 RETURNING *`, [id]);
      return r.rows[0] || null;
    },

    // -----------------------------------------------------------------------
    // Testing transfers
    // -----------------------------------------------------------------------
    async getTestingTransferByIdForUpdate(id, client) {
      const r = await client.query(`SELECT * FROM public.testing_self_transfers WHERE id=$1 FOR UPDATE`, [id]);
      return r.rows[0] || null;
    },

    async deleteTestingTransfer(id, client) {
      const r = await client.query(`DELETE FROM public.testing_self_transfers WHERE id=$1 RETURNING *`, [id]);
      return r.rows[0] || null;
    },
  };
}

module.exports = { createTransferRepository };
