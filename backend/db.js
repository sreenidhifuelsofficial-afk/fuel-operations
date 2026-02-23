// db.js - PostgreSQL connection setup (supports Neon/SSL and DATABASE_URL)
const { Pool, types } = require('pg');

// Parse NUMERIC as JS number.
// We use NUMERIC(14,3) for volume fields; float precision is acceptable here.
try {
  // 1700 = numeric
  types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));
} catch {}

// Prevent implicit timezone conversions for wall-clock values.
// 1114 = timestamp without time zone, 1082 = date
try {
  types.setTypeParser(1114, (val) => val);
  types.setTypeParser(1082, (val) => val);
} catch {}

function buildPool() {
  // Prefer a single DATABASE_URL when provided
  if (process.env.DATABASE_URL) {
    const needsSSL = process.env.PGSSLMODE === 'require' || /sslmode=require/i.test(process.env.DATABASE_URL);
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: needsSSL ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.PGPOOL_MAX || 15),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 30000),
      connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT || 5000),
    });
    // Light diagnostic
    if (!process.env.SUPPRESS_DB_LOG) {
      console.log(`[DB] Connecting via DATABASE_URL (ssl=${needsSSL ? 'on' : 'off'})`);
    }
    return pool;
  }

  // Otherwise use discrete PG* env vars (good for local dev)
  const config = {
    // Prefer standard Postgres env vars, but allow DB_* aliases for convenience
    // (common in other Node/ORM setups and easy to copy from pgAdmin).
    user: process.env.PGUSER || process.env.DB_USER || 'postgres',
    host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
    database: process.env.PGDATABASE || process.env.DB_NAME || 'crm_db',
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'root123',
    port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
    // Pool hardening
    max: Number(process.env.PGPOOL_MAX || 15),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT || 5000),
  };
  if (String(process.env.PGSSLMODE || '').toLowerCase() === 'require') {
    config.ssl = { rejectUnauthorized: false };
  }
  const pool = new Pool(config);
  if (!process.env.SUPPRESS_DB_LOG) {
    console.log(`[DB] Connecting to ${config.user}@${config.host}:${config.port}/${config.database} (ssl=${config.ssl ? 'on' : 'off'})`);
  }
  return pool;
}

const pool = buildPool();

// Startup connectivity verification with retry/backoff (non-blocking export)
pool.__ready = false;
const maxAttempts = Number(process.env.DB_CONNECT_RETRIES || 5);
const baseDelay = Number(process.env.DB_CONNECT_BASE_DELAY_MS || 500);
function delay(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function verifyConnectivity() {
  for (let attempt=1; attempt<=maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      pool.__ready = true;
      if (!process.env.SUPPRESS_DB_LOG) console.log(`[DB] Connectivity established on attempt ${attempt}`);
      return;
    } catch (e) {
      if (attempt === maxAttempts) {
        console.error('[DB] Connectivity failed after retries:', e.message);
        return; // mark as not ready; readiness endpoint will report failure
      }
      const backoff = Math.min(8000, Math.round(baseDelay * Math.pow(2, attempt-1) * (0.75 + Math.random()*0.5))); // jitter 75%-125%
      if (!process.env.SUPPRESS_DB_LOG) console.warn(`[DB] connect attempt ${attempt} failed: ${e.message}. Retrying in ${backoff}ms`);
      await delay(backoff);
    }
  }
}
verifyConnectivity().catch(()=>{});

// Apply per-connection settings
pool.on('connect', (client) => {
  // Ensure every connection speaks UTF-8 to prevent encoding mojibake
  client.query(`SET client_encoding TO 'UTF8';`).catch(()=>{});
  // 5s statement timeout; 10s idle in transaction timeout
  client.query(`SET statement_timeout TO ${Number(process.env.PG_STMT_TIMEOUT || 5000)};`).catch(()=>{});
  client.query(`SET idle_in_transaction_session_timeout TO ${Number(process.env.PG_IDLE_TX_TIMEOUT || 10000)};`).catch(()=>{});
});

module.exports = pool;
module.exports.isPoolReady = () => pool.__ready === true;