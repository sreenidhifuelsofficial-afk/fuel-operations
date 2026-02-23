// apps/fuelops-service/services/lotService.js
// ---------------------------------------------------------------------------
// Domain logic for fuel lot recomputation.
// Extracted from backend/index.js recomputeFuelLotUsedAndStatus (L820)
// and recomputeFuelLotTestingLiters (L859).
// ---------------------------------------------------------------------------

'use strict';

/**
 * Recompute used_liters and stock_status for a given fuel lot.
 * Must be called inside a transaction (client = pg transaction client).
 *
 * @param {import('pg').PoolClient} client - Transaction client
 * @param {number|string} lotId - Fuel lot ID
 */
async function recomputeFuelLotUsedAndStatus(client, lotId) {
  if (!client || !lotId) return;
  const id = Number(lotId);
  if (!Number.isFinite(id) || id <= 0) return;
  const lotQ = await client.query(
    `SELECT id, loaded_liters FROM public.fuel_lots WHERE id=$1 FOR UPDATE`,
    [id]
  );
  if (!lotQ.rows.length) return;
  const lot = lotQ.rows[0];

  const inboundQ = await client.query(
    `SELECT COALESCE(SUM(fit.transfer_volume) FILTER (
            WHERE NOT (
              fit.transfer_to_empty = TRUE
              OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
              OR (COALESCE(fit.activity,'') = 'TESTING')
            )
          ),0) AS inbound_added
     FROM public.fuel_internal_transfers fit
     JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
      WHERE fit.to_lot_id=$1`,
    [id]
  );
  const inboundAdded = Number(inboundQ.rows[0]?.inbound_added || 0);

  const salesQ = await client.query(
    `SELECT COALESCE(SUM(sale_volume_liters),0) AS s FROM public.fuel_sale_transfers WHERE lot_id=$1`,
    [id]
  );
  const xfersQ = await client.query(
    `SELECT COALESCE(SUM(transfer_volume),0) AS t FROM public.fuel_internal_transfers WHERE from_lot_id=$1 AND COALESCE(activity,'') <> 'TESTING'`,
    [id]
  );
  const usedOut = Number(salesQ.rows[0]?.s || 0) + Number(xfersQ.rows[0]?.t || 0);
  const netRemaining = (Number(lot.loaded_liters || 0) + inboundAdded) - usedOut;
  const stock = netRemaining <= 0 ? 'SOLD' : 'INSTOCK';

  await client.query(
    `UPDATE public.fuel_lots
        SET used_liters=$2,
            stock_status=$3,
            updated_at=NOW()
      WHERE id=$1`,
    [id, usedOut, stock]
  );
}

/**
 * Recompute cumulative testing liters for a fuel lot.
 *
 * @param {import('pg').PoolClient} client - Transaction client
 * @param {number|string} lotId - Fuel lot ID
 */
async function recomputeFuelLotTestingLiters(client, lotId) {
  if (!client || !lotId) return;
  const id = Number(lotId);
  if (!Number.isFinite(id) || id <= 0) return;
  const q = await client.query(
    `SELECT COALESCE(SUM(transfer_volume_liters),0) AS t
       FROM public.testing_self_transfers
      WHERE lot_id=$1`,
    [id]
  );
  const t = Number(q.rows[0]?.t || 0);
  await client.query(
    `UPDATE public.fuel_lots
        SET cumulative_testing_liters=$2,
            updated_at=NOW()
      WHERE id=$1`,
    [id, t]
  );
}

/**
 * Compute cumulative inbound-added liters for a lot (excluding seeding transfers and TESTING).
 */
async function getInboundAddedLiters(client, lotId) {
  const q = await client.query(
    `SELECT COALESCE(SUM(fit.transfer_volume) FILTER (
            WHERE NOT (
              fit.transfer_to_empty = TRUE
              OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
              OR (COALESCE(fit.activity,'') = 'TESTING')
            )
          ),0) AS inbound_added
     FROM public.fuel_internal_transfers fit
     JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
      WHERE fit.to_lot_id=$1`,
    [lotId]
  );
  return Number(q.rows[0]?.inbound_added || 0);
}

/**
 * Compute cumulative outbound-used liters for a lot (sales + internal transfers, excluding TESTING).
 */
async function getOutboundUsedLiters(client, lotId) {
  const sales = await client.query(`SELECT COALESCE(SUM(sale_volume_liters),0) AS s FROM public.fuel_sale_transfers WHERE lot_id=$1`, [lotId]);
  const xfers = await client.query(`SELECT COALESCE(SUM(transfer_volume),0) AS t FROM public.fuel_internal_transfers WHERE from_lot_id=$1 AND COALESCE(activity,'') <> 'TESTING'`, [lotId]);
  return Number(sales.rows[0]?.s || 0) + Number(xfers.rows[0]?.t || 0);
}

/**
 * Recompute used_liters and stock_status from authoritative sums for a lot.
 * Client can be pool or transaction client.
 */
async function recomputeLot(client, lotId) {
  if (!lotId) return;
  const lotQ = await client.query(`SELECT * FROM public.fuel_lots WHERE id=$1 FOR UPDATE`, [lotId]);
  if (!lotQ.rows.length) return;
  const lot = lotQ.rows[0];
  const inboundAdded = await getInboundAddedLiters(client, lotId);
  const usedOut = await getOutboundUsedLiters(client, lotId);
  const netRemaining = (Number(lot.loaded_liters || 0) + inboundAdded) - usedOut;
  const stock = netRemaining <= 0 ? 'SOLD' : 'INSTOCK';
  await client.query(
    `UPDATE public.fuel_lots
        SET used_liters=$2,
            stock_status=$3,
            updated_at=NOW()
      WHERE id=$1`,
    [lotId, usedOut, stock]
  );
}

module.exports = {
  recomputeFuelLotUsedAndStatus,
  recomputeFuelLotTestingLiters,
  getInboundAddedLiters,
  getOutboundUsedLiters,
  recomputeLot,
};
