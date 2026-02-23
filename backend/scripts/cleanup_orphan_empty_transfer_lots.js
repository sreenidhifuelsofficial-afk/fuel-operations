/*
  Local maintenance helper: clears orphan EMPTY_TRANSFER lots.

  Orphan = load_type=EMPTY_TRANSFER but has no internal transfer rows remaining
  that reference it. This can happen if internal transfers were deleted before
  the backend started reversing the seed lot's loaded_liters.

  Usage:
    node scripts/cleanup_orphan_empty_transfer_lots.js
*/

require('dotenv').config();
const db = require('../db');

async function main() {
  const orphanLots = await db.query(
    `SELECT fl.id, su.unit_code, fl.lot_code_created, fl.loaded_liters
       FROM public.fuel_lots fl
       JOIN public.storage_units su ON su.id = fl.unit_id
      WHERE fl.load_type = 'EMPTY_TRANSFER'
        AND fl.stock_status = 'INSTOCK'
        AND COALESCE(fl.loaded_liters,0) > 0
        AND NOT EXISTS (SELECT 1 FROM public.fuel_internal_transfers fit WHERE fit.to_lot_id = fl.id)
        AND NOT EXISTS (SELECT 1 FROM public.fuel_internal_transfers fit WHERE fit.from_lot_id = fl.id)
        AND NOT EXISTS (SELECT 1 FROM public.fuel_sale_transfers fst WHERE fst.lot_id = fl.id)
        AND NOT EXISTS (SELECT 1 FROM public.testing_self_transfers tst WHERE tst.lot_id = fl.id)
      ORDER BY fl.created_at DESC`
  );

  if (!orphanLots.rows.length) {
    console.log('No orphan EMPTY_TRANSFER lots found.');
    return;
  }

  console.log(`Found ${orphanLots.rows.length} orphan EMPTY_TRANSFER lot(s):`);
  for (const row of orphanLots.rows) {
    console.log(row);
  }

  await db.query('BEGIN');
  try {
    const ids = orphanLots.rows.map((r) => Number(r.id));
    await db.query(
      `DELETE FROM public.fuel_lots
        WHERE id = ANY($1::int[])`,
      [ids]
    );
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  console.log('Cleanup complete.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
