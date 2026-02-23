// Prune public schema down to the minimal Fuel Ops + Profile/User Control tables.
//
// Safety:
// - Default is DRY RUN (prints DROP statements only)
// - Set APPLY=1 to execute.
//
// Usage:
//   node backend/scripts/prune_to_minimal.js
//   APPLY=1 node backend/scripts/prune_to_minimal.js

// Load env from backend/.env regardless of CWD
try {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {}

const pool = require('../db');

const KEEP_TABLES = new Set([
  // Users / Profile / permissions
  'users',
  'users_password_audit',
  'user_profiles',
  'user_photos',
  'user_permissions',

  // Fuel Ops
  'storage_units',
  'drivers',
  'fuel_lots',
  'dispenser_day_reading_logs',
  'truck_dispenser_trips',
  'truck_dispenser_meter_snapshots',
  'truck_odometer_day_readings',
  'fuel_internal_transfers',
  'fuel_sale_transfers',
  'testing_self_transfers',
]);

const KEEP_VIEWS = new Set([
  'user_full_profiles',
]);

function qIdent(name) {
  // Very small quoting helper for identifiers.
  return '"' + String(name).replace(/"/g, '""') + '"';
}

async function main() {
  const apply = String(process.env.APPLY || '').trim() === '1';

  const client = await pool.connect();
  try {
    const tablesRes = await client.query(
      `SELECT tablename
         FROM pg_tables
        WHERE schemaname='public'
        ORDER BY tablename`
    );

    const viewsRes = await client.query(
      `SELECT viewname
         FROM pg_views
        WHERE schemaname='public'
        ORDER BY viewname`
    );

    const dropViews = viewsRes.rows
      .map((r) => String(r.viewname))
      .filter((v) => !KEEP_VIEWS.has(v));

    const dropTables = tablesRes.rows
      .map((r) => String(r.tablename))
      .filter((t) => !KEEP_TABLES.has(t));

    const statements = [];
    for (const v of dropViews) {
      statements.push(`DROP VIEW IF EXISTS public.${qIdent(v)} CASCADE;`);
    }
    for (const t of dropTables) {
      statements.push(`DROP TABLE IF EXISTS public.${qIdent(t)} CASCADE;`);
    }

    if (!statements.length) {
      console.log('[prune] Nothing to drop. Public schema already minimal.');
      process.exit(0);
    }

    console.log('[prune] Will keep tables:', Array.from(KEEP_TABLES).sort().join(', '));
    console.log('[prune] Will drop views:', dropViews.join(', ') || '(none)');
    console.log('[prune] Will drop tables:', dropTables.join(', ') || '(none)');
    console.log('');
    console.log('-- Generated SQL');
    for (const s of statements) console.log(s);
    console.log('');

    if (!apply) {
      console.log('[prune] DRY RUN only. Set APPLY=1 to execute.');
      process.exit(0);
    }

    await client.query('BEGIN');
    for (const s of statements) {
      await client.query(s);
    }
    await client.query('COMMIT');
    console.log('[prune] Done.');
    process.exit(0);
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    console.error('[prune] Failed:', e.message || e);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main();
