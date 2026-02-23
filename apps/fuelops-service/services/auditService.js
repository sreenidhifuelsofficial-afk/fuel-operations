// apps/fuelops-service/services/auditService.js
// ---------------------------------------------------------------------------
// Fuel ops audit logging, extracted from backend/index.js insertFuelOpsAudit.
// ---------------------------------------------------------------------------

'use strict';

/**
 * Insert a row into the fuel_ops_audit table.
 * Non-throwing — logs a warning on failure.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} row
 */
async function insertFuelOpsAudit(client, row) {
  try {
    if (!client) return;
    const {
      user_id, username, tab, section, action, entity_type,
      entity_id = null,
      unit_id = null, unit_type = null,
      driver_id = null,
      trip_id = null, trip_no = null,
      op_date = null,
      performed_time = null,
      amount_liters = null,
      payload_old = null, payload_new = null,
      reason = null,
      request_id = null,
      ip_addr = null,
    } = row || {};

    await client.query(
      `INSERT INTO public.fuel_ops_audit (
         user_id, username, tab, section, action, entity_type,
         unit_id, trip_id, trip_no, op_date,
         payload_old, payload_new, reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        user_id || null,
        username || null,
        String(tab || 'At Depot'),
        String(section || 'ops'),
        String(action || 'UPDATE'),
        String(entity_type || 'unknown'),
        unit_id,
        trip_id,
        trip_no,
        op_date,
        payload_old,
        payload_new,
        reason,
      ]
    );
  } catch (e) {
    if (!process.env.SUPPRESS_DB_LOG) console.warn('[fuel_ops_audit] insert warn:', e.message);
  }
}

module.exports = { insertFuelOpsAudit };
