require('dotenv').config();

const { Pool } = require('pg');

function poolConfigFromEnv() {
  const sslDisabled = String(process.env.PGSSLMODE || '').toLowerCase() === 'disable';
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: sslDisabled ? false : { rejectUnauthorized: false },
  };
}

function getArg(name) {
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

(async () => {
  const unitCode = getArg('unit_code');
  const unitIdRaw = getArg('unit_id');
  const unitId = unitIdRaw != null ? Number(unitIdRaw) : null;

  const pool = new Pool(poolConfigFromEnv());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const unitQ = await client.query(
      `SELECT id, unit_code, unit_type FROM public.storage_units
        WHERE active=TRUE
          AND ($1::int IS NULL OR id=$1)
          AND ($2::text IS NULL OR unit_code=$2)
        ORDER BY unit_type, unit_code`,
      [Number.isFinite(unitId) ? unitId : null, unitCode || null]
    );

    if (!unitQ.rows.length) {
      await client.query('ROLLBACK');
      console.log('No matching units found. Use --unit_id <id> or --unit_code <code>.');
      return;
    }

    for (const unit of unitQ.rows) {
      const lotsQ = await client.query(
        `SELECT id, loaded_liters, lot_code_created
           FROM public.fuel_lots
          WHERE unit_id=$1
          ORDER BY created_at ASC, id ASC`,
        [unit.id]
      );

      for (const lot of lotsQ.rows) {
        const inbound = await client.query(
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
          [lot.id]
        );
        const outbound = await client.query(
          `SELECT
              (SELECT COALESCE(SUM(sale_volume_liters),0) FROM public.fuel_sale_transfers WHERE lot_id=$1) AS sale_out,
              (SELECT COALESCE(SUM(transfer_volume),0) FROM public.fuel_internal_transfers WHERE from_lot_id=$1 AND COALESCE(activity,'') <> 'TESTING') AS xfer_out,
              (SELECT COALESCE(SUM(transfer_volume_liters),0) FROM public.testing_self_transfers WHERE lot_id=$1) AS test_out`,
          [lot.id]
        );

        const inboundAdded = Number(inbound.rows[0]?.inbound_added || 0);
        const saleOut = Number(outbound.rows[0]?.sale_out || 0);
        const xferOut = Number(outbound.rows[0]?.xfer_out || 0);
        const testOut = Number(outbound.rows[0]?.test_out || 0);
        const usedOut = saleOut + xferOut + testOut;

        const loaded = Number(lot.loaded_liters || 0);
        const netRemaining = loaded + inboundAdded - usedOut;
        const stock = netRemaining <= 0 ? 'SOLD' : 'INSTOCK';

        await client.query(
          `UPDATE public.fuel_lots
              SET used_liters=$2,
                  stock_status=$3,
                  updated_at=NOW()
            WHERE id=$1`,
          [lot.id, usedOut, stock]
        );

        console.log(
          `[${unit.unit_type} ${unit.unit_code}] lot ${lot.id} ${lot.lot_code_created}: loaded=${loaded} inbound=${inboundAdded} used=${usedOut} net=${netRemaining} => ${stock}`
        );
      }
    }

    await client.query('COMMIT');
    console.log('Done.');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    console.error(e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
