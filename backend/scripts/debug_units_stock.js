/*
  Debug helper (local dev): inspect lots/transfers contributing to unit stock.
  Usage:
    node scripts/debug_units_stock.js 5555 9876
*/

require('dotenv').config();
const db = require('../db');

async function main() {
  const unitCodes = process.argv.slice(2).filter(Boolean);
  if (unitCodes.length === 0) {
    console.log('Usage: node scripts/debug_units_stock.js <unit_code> [unit_code...]');
    process.exit(2);
  }

  const unitsRes = await db.query(
    'select id, unit_code from storage_units where unit_code = any($1::text[]) order by unit_code',
    [unitCodes]
  );
  const units = unitsRes.rows;
  console.log('units', units);

  const unitIds = units.map((u) => u.id);
  if (unitIds.length === 0) {
    for (const code of unitCodes) {
      const likeQ = await db.query(
        'select id, unit_code from storage_units where unit_code ILIKE $1 order by unit_code limit 25',
        [`%${code}%`]
      );
      if (likeQ.rows.length) {
        console.log(`No exact match for ${code}. Similar unit_code values:`, likeQ.rows);
      } else {
        console.log(`No exact match for ${code} and no similar unit_code values found.`);
      }
    }
    return;
  }

  const lotsRes = await db.query(
    'select id, unit_id, lot_code_created, load_type, stock_status, loaded_liters, used_liters, created_at from fuel_lots where unit_id = any($1::int[]) order by unit_id, created_at desc',
    [unitIds]
  );
  const lots = lotsRes.rows;
  const lotIds = lots.map((l) => l.id);
  console.log('lots_count', lots.length);
  console.log('lots_recent', lots.slice(0, 10));

  if (lotIds.length === 0) return;

  const remainingRes = await db.query(
    `with lots as (select * from fuel_lots where id = any($1::int[])),
      inbound as (
        select to_lot_id, sum(transfer_volume) as inbound_liters
        from fuel_internal_transfers
        where to_lot_id = any($1::int[])
          and coalesce(transfer_to_empty,false)=false
        group by to_lot_id
      ),
      outbound as (
        select from_lot_id, sum(transfer_volume) as outbound_liters
        from fuel_internal_transfers
        where from_lot_id = any($1::int[])
        group by from_lot_id
      ),
      sales as (
        select lot_id, sum(sale_volume_liters) as sold_liters
        from fuel_sale_transfers
        where lot_id = any($1::int[])
        group by lot_id
      ),
      testing as (
        select lot_id, sum(transfer_volume_liters) as test_liters
        from testing_self_transfers
        where lot_id = any($1::int[])
        group by lot_id
      )
      select
        l.unit_id,
        l.id as lot_id,
        l.lot_code_created,
        l.load_type,
        l.stock_status,
        l.loaded_liters,
        coalesce(i.inbound_liters,0) as inbound_liters,
        coalesce(o.outbound_liters,0) as outbound_liters,
        coalesce(s.sold_liters,0) as sold_liters,
        coalesce(t.test_liters,0) as test_liters,
        (l.loaded_liters + coalesce(i.inbound_liters,0) - coalesce(o.outbound_liters,0) - coalesce(s.sold_liters,0) - coalesce(t.test_liters,0)) as remaining_liters
      from lots l
      left join inbound i on i.to_lot_id=l.id
      left join outbound o on o.from_lot_id=l.id
      left join sales s on s.lot_id=l.id
      left join testing t on t.lot_id=l.id
      order by remaining_liters desc, l.created_at desc`,
    [lotIds]
  );
  console.log('remaining_top', remainingRes.rows.slice(0, 20));

  const transfersRes = await db.query(
    'select id, from_lot_id, to_lot_id, transfer_volume, transfer_to_empty, created_at from fuel_internal_transfers where (to_lot_id = any($1::int[]) or from_lot_id = any($1::int[])) order by created_at desc limit 50',
    [lotIds]
  );
  console.log('internal_transfers_recent', transfersRes.rows);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
