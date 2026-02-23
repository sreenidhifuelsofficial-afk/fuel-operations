// Schema runner: executes schema.sql (idempotent)
const fs = require('fs');
const path = require('path');

// Load environment variables from backend/.env regardless of process CWD
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {}

async function run() {
  // Allow passing DATABASE_URL as CLI arg to avoid shell env issues on Windows
  const conn = process.argv[2];
  if (conn && !process.env.DATABASE_URL) {
    process.env.DATABASE_URL = conn;
  }

  const pool = require('./db');
  const client = await pool.connect();
  try {
    const schemaFile = (process.env.SCHEMA_FILE || 'schema.sql').trim();
    const schemaPath = path.join(__dirname, schemaFile);
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query('COMMIT');
    console.log(`[migrate] Applied ${schemaFile}`);
    console.log('[migrate] Done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate] Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

run();
