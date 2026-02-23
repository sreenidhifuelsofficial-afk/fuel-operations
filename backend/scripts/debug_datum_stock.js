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

(async () => {
  const pool = new Pool(poolConfigFromEnv());
  try {
    const units = await pool.query(
      "SELECT id, unit_code, capacity_liters FROM public.storage_units WHERE active=TRUE AND unit_type='DATUM' ORDER BY unit_code"
    );
    console.log('DATUM units:', units.rows);

    for (const u of units.rows) {
      const lots = await pool.query(
        'SELECT id, lot_code_created, loaded_liters, used_liters, stock_status, created_at FROM public.fuel_lots WHERE unit_id=$1 ORDER BY created_at DESC, id DESC LIMIT 10',
        [u.id]
      );

      const enriched = [];
      for (const lot of lots.rows) {
        const inbound = await pool.query(
          `SELECT COALESCE(SUM(fit.transfer_volume) FILTER (
                    WHERE NOT (
                      fit.transfer_to_empty = TRUE
                      OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
                      OR (COALESCE(fit.activity,'') = 'TESTING')
                    )
                  ),0) AS inbound_added,
                  (SELECT COUNT(*)::int FROM public.fuel_internal_transfers WHERE to_lot_id=$1) AS inbound_rows
             FROM public.fuel_internal_transfers fit
             JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
            WHERE fit.to_lot_id=$1`,
          [lot.id]
        );
        const outbound = await pool.query(
          `SELECT
              (SELECT COALESCE(SUM(sale_volume_liters),0) FROM public.fuel_sale_transfers WHERE lot_id=$1) AS sale_out,
              (SELECT COALESCE(SUM(transfer_volume),0) FROM public.fuel_internal_transfers WHERE from_lot_id=$1 AND COALESCE(activity,'') <> 'TESTING') AS xfer_out,
              (SELECT COALESCE(SUM(transfer_volume_liters),0) FROM public.testing_self_transfers WHERE lot_id=$1) AS test_out,
              (SELECT COUNT(*)::int FROM public.fuel_internal_transfers WHERE from_lot_id=$1) AS outbound_rows`,
          [lot.id]
        );
        const inboundAdded = Number(inbound.rows[0]?.inbound_added || 0);
        const saleOut = Number(outbound.rows[0]?.sale_out || 0);
        const xferOut = Number(outbound.rows[0]?.xfer_out || 0);
        const testOut = Number(outbound.rows[0]?.test_out || 0);
        const usedOut = saleOut + xferOut + testOut;
        const loaded = Number(lot.loaded_liters || 0);
        const netRemaining = loaded + inboundAdded - usedOut;
        enriched.push({
          ...lot,
          inbound_added: inboundAdded,
          inbound_rows: Number(inbound.rows[0]?.inbound_rows || 0),
          sale_out: saleOut,
          xfer_out: xferOut,
          test_out: testOut,
          outbound_rows: Number(outbound.rows[0]?.outbound_rows || 0),
          computed_used_out: usedOut,
          computed_net_remaining: netRemaining,
        });
      }

      console.log(`Lots for ${u.unit_code}:`, enriched);
    }
  } finally {
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
