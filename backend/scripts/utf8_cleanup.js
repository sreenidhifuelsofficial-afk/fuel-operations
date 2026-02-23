#!/usr/bin/env node
// backend/scripts/utf8_cleanup.js
// ---------------------------------------------------------------------------
// Safe UTF-8 whitespace cleanup: replaces U+00A0 (NBSP) with normal space
// in text/label columns only. Does NOT touch timestamps or numeric fields.
// ---------------------------------------------------------------------------

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  user:     process.env.PGUSER     || process.env.DB_USER     || 'postgres',
  host:     process.env.PGHOST     || process.env.DB_HOST     || 'localhost',
  database: process.env.PGDATABASE || process.env.DB_NAME     || 'crm_db',
  password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'root123',
  port:     Number(process.env.PGPORT || process.env.DB_PORT || 5432),
});

// ---------------------------------------------------------------------------
// Columns to scan — only text/label fields, never timestamps or numerics
// ---------------------------------------------------------------------------
const TARGETS = [
  { table: 'storage_units',   columns: ['unit_code', 'vehicle_number'] },
  { table: 'drivers',         columns: ['driver_name', 'driver_code'] },
  { table: 'fuel_lots',       columns: ['lot_code_created', 'tanker_code', 'created_by'] },
  { table: 'truck_dispenser_trips', columns: ['note', 'driver_name', 'driver_code'] },
  { table: 'fuel_internal_transfers', columns: ['notes'] },
  { table: 'fuel_sale_transfers',     columns: ['to_vehicle', 'notes', 'trip'] },
];

async function run() {
  const client = await pool.connect();
  try {
    // ---- STEP 1: Identify affected rows ----------------------------------
    console.log('=== STEP 1: Scanning for NBSP (U+00A0) in text columns ===\n');
    const findings = [];

    for (const { table, columns } of TARGETS) {
      for (const col of columns) {
        try {
          const sql = `SELECT id, ${col} FROM ${table} WHERE ${col} LIKE '%' || CHR(160) || '%'`;
          const r = await client.query(sql);
          if (r.rowCount > 0) {
            console.log(`  [FOUND] ${table}.${col}: ${r.rowCount} row(s)`);
            r.rows.forEach(row => {
              console.log(`    id=${row.id}  value=${JSON.stringify(row[col])}`);
            });
            findings.push({ table, col, count: r.rowCount });
          } else {
            console.log(`  [CLEAN] ${table}.${col}`);
          }
        } catch (e) {
          // Column or table may not exist — skip gracefully
          console.log(`  [SKIP]  ${table}.${col} — ${e.message.split('\n')[0]}`);
        }
      }
    }

    if (findings.length === 0) {
      console.log('\nNo NBSP characters found in any scanned columns. Database is clean.');
      return;
    }

    // ---- STEP 2 & 3: Clean values safely ---------------------------------
    console.log('\n=== STEP 2: Cleaning NBSP → normal space ===\n');

    await client.query('BEGIN');

    for (const { table, col, count } of findings) {
      const sql = `UPDATE ${table} SET ${col} = REPLACE(${col}, CHR(160), ' ') WHERE ${col} LIKE '%' || CHR(160) || '%'`;
      const r = await client.query(sql);
      console.log(`  [UPDATED] ${table}.${col}: ${r.rowCount} row(s)`);
    }

    await client.query('COMMIT');
    console.log('\n  Transaction committed.\n');

    // ---- STEP 4: Validation ----------------------------------------------
    console.log('=== VALIDATION: Confirming no NBSP remains ===\n');

    let allClean = true;
    for (const { table, col } of findings) {
      const sql = `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${col} LIKE '%' || CHR(160) || '%'`;
      const r = await client.query(sql);
      const remaining = Number(r.rows[0].cnt);
      if (remaining > 0) {
        console.log(`  [FAIL] ${table}.${col}: ${remaining} row(s) still contain NBSP!`);
        allClean = false;
      } else {
        console.log(`  [OK]   ${table}.${col}: clean`);
      }
    }

    if (allClean) {
      console.log('\n  All cleaned columns validated — no NBSP remaining.');
    } else {
      console.log('\n  WARNING: Some columns still contain NBSP. Investigate manually.');
    }

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('\nERROR — transaction rolled back:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
