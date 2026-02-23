// packages/query/readPool.js
// ---------------------------------------------------------------------------
// Dedicated PostgreSQL pool for heavy read queries.
//
// Goal: isolate expensive reads from write traffic by using a separate pool
// (same DB, same schema), without changing SQL or API responses.
// ---------------------------------------------------------------------------

'use strict';

const { Pool, types } = require('pg');

// Keep type parser behavior consistent with packages/db.
try { types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val))); } catch {}
try {
  types.setTypeParser(1114, (val) => val);
  types.setTypeParser(1082, (val) => val);
} catch {}

function buildReadPool() {
  const max = Number(process.env.PG_READPOOL_MAX || 5);

  if (process.env.DATABASE_URL) {
    const needsSSL = process.env.PGSSLMODE === 'require' || /sslmode=require/i.test(process.env.DATABASE_URL);
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: needsSSL ? { rejectUnauthorized: false } : undefined,
      max,
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 30000),
      connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT || 5000),
    });
    if (!process.env.SUPPRESS_DB_LOG) {
      console.log(`[DB-READ] Connecting via DATABASE_URL (ssl=${needsSSL ? 'on' : 'off'}, max=${max})`);
    }
    return pool;
  }

  const config = {
    user: process.env.PGUSER || process.env.DB_USER || 'postgres',
    host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
    database: process.env.PGDATABASE || process.env.DB_NAME || 'crm_db',
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'root123',
    port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
    max,
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT || 5000),
  };
  if (String(process.env.PGSSLMODE || '').toLowerCase() === 'require') {
    config.ssl = { rejectUnauthorized: false };
  }
  const pool = new Pool(config);
  if (!process.env.SUPPRESS_DB_LOG) {
    console.log(`[DB-READ] Connecting to ${config.user}@${config.host}:${config.port}/${config.database} (ssl=${config.ssl ? 'on' : 'off'}, max=${max})`);
  }
  return pool;
}

const readPool = buildReadPool();

readPool.on('connect', (client) => {
  client.query(`SET statement_timeout TO ${Number(process.env.PG_STMT_TIMEOUT || 5000)};`).catch(() => {});
  client.query(`SET idle_in_transaction_session_timeout TO ${Number(process.env.PG_IDLE_TX_TIMEOUT || 10000)};`).catch(() => {});
});

module.exports = readPool;
