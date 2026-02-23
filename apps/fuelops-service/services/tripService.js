// apps/fuelops-service/services/tripService.js
// ---------------------------------------------------------------------------
// Trip-related domain logic extracted from backend/index.js.
// ---------------------------------------------------------------------------

'use strict';

const { round3, isoDateOnly, isPrivileged, isTripClosedRow } = require('./helpers');

/**
 * Fetch a trip row for a given operation context.
 */
async function getTripRowForOp(client, truckId, opDate, tripNo) {
  if (!client) return null;
  const tId = Number(truckId);
  const tNo = tripNo != null ? Number(tripNo) : null;
  const d = isoDateOnly(opDate);
  if (!Number.isFinite(tId) || tId <= 0 || !d || !Number.isFinite(tNo) || tNo <= 0) return null;
  const q = await client.query(
    `SELECT * FROM public.truck_dispenser_trips
      WHERE truck_id=$1 AND reading_date=$2::date AND trip_no=$3
      LIMIT 1`,
    [tId, d, tNo]
  );
  return q.rows[0] || null;
}

/**
 * Get the trip-level opening/closing liters snapshot.
 */
async function getTripReadingsSnapshot(client, tripRow) {
  if (!client || !tripRow) return null;
  const truckId = Number(tripRow.truck_id);
  const tripNo = Number(tripRow.trip_no);
  const dateStr = isoDateOnly(tripRow.reading_date);
  if (!Number.isFinite(truckId) || truckId <= 0 || !Number.isFinite(tripNo) || tripNo <= 0 || !dateStr) return null;

  const openingRaw = tripRow.opening_liters != null ? Number(tripRow.opening_liters) : 0;
  const opening = Number.isFinite(openingRaw) ? openingRaw : 0;

  const salesSumQ = await client.query(
    `SELECT COALESCE(SUM(sale_volume_liters),0) AS s
       FROM public.fuel_sale_transfers
      WHERE from_unit_id=$1
        AND trip=$2
        AND (
          sale_date = $3::date
          OR (sale_date IS NULL AND performed_at::date = $3::date)
        )`,
    [truckId, tripNo, dateStr]
  );
  const transfersOutSumQ = await client.query(
    `SELECT COALESCE(SUM(transfer_volume),0) AS t
       FROM public.fuel_internal_transfers
      WHERE from_unit_id=$1
        AND trip=$2
        AND transfer_date = $3::date`,
    [truckId, tripNo, dateStr]
  );

  let testingOut = 0;
  try {
    const testingQ = await client.query(
      `SELECT COALESCE(SUM(transfer_volume_liters),0) AS t
         FROM public.testing_self_transfers
        WHERE from_unit_id=$1
          AND trip=$2
          AND (
            sale_date = $3::date
            OR (sale_date IS NULL AND performed_at::date = $3::date)
          )`,
      [truckId, tripNo, dateStr]
    );
    testingOut = Number(testingQ.rows[0]?.t || 0);
  } catch {
    testingOut = 0;
  }

  const salesOut = Number(salesSumQ.rows[0]?.s || 0);
  const transfersOut = Number(transfersOutSumQ.rows[0]?.t || 0);
  const totalOut = salesOut + transfersOut + (Number.isFinite(testingOut) ? testingOut : 0);
  const closing = round3(opening + totalOut);

  return {
    trip_opening_liters: round3(opening),
    trip_closing_liters: closing,
  };
}

/**
 * Assert that an operation is editable given the trip state.
 * Throws with HTTP-friendly status code if not editable.
 */
async function assertOpEditableByTripState(client, tripRow, req) {
  if (!tripRow) {
    if (!isPrivileged(req)) {
      const e = new Error('Locked: trip not found for this record');
      e.status = 403;
      throw e;
    }
    return;
  }
  const closed = isTripClosedRow(tripRow);
  const frozen = !!tripRow.is_frozen;

  if (!closed) return;

  if (!isPrivileged(req)) {
    const e = new Error('Locked: trip is closed');
    e.status = 403;
    throw e;
  }

  if (frozen) {
    const e = new Error('Locked: trip is frozen. Unfreeze to edit.');
    e.status = 409;
    throw e;
  }
}

module.exports = {
  getTripRowForOp,
  getTripReadingsSnapshot,
  assertOpEditableByTripState,
};
