#!/usr/bin/env node
/**
 * Seed an initial OWNER user directly into the DB.
 * Usage:
 *   env vars: INIT_OWNER_EMAIL, INIT_OWNER_PASSWORD, INIT_OWNER_NAME (optional)
 *   or CLI: node scripts/seed_owner.js <email> <password> [full name]
 *
 * Notes:
 * - Will no-op if an OWNER already exists.
 * - Uses the same hashing as auth endpoints.
 */
const { randomUUID } = require('crypto');
const dotenv = require('dotenv');
// Prefer backend/.env (one level up from scripts/) regardless of invocation CWD
try {
  const path = require('path');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
} catch {
  dotenv.config();
}

// Allow passing DATABASE_URL as 4th CLI arg to avoid env friction in CI/shells
if (!process.env.DATABASE_URL && process.argv[5]) {
  process.env.DATABASE_URL = process.argv[5];
}

const pool = require('../db');
const { hashPassword, ownerExists } = require('../auth');

async function main() {
  try {
  const args = process.argv.slice(2);
  const email = (process.env.INIT_OWNER_EMAIL || args[0] || '').trim().toLowerCase();
  const password = process.env.INIT_OWNER_PASSWORD || args[1] || '';
  const fullName = process.env.INIT_OWNER_NAME || args[2] || null;

    if (!email || !password) {
  console.error('Usage: INIT_OWNER_EMAIL=you@example.com INIT_OWNER_PASSWORD=secret [INIT_OWNER_NAME="Full Name"] npm run seed:owner\n   or: node scripts/seed_owner.js <email> <password> [full name] [DATABASE_URL]');
      process.exit(2);
    }

    if (await ownerExists()) {
      console.log('Owner already exists. Nothing to do.');
      process.exit(0);
    }

    const pwHash = await hashPassword(password);
    const newId = randomUUID();

    // username is NOT NULL in current schema; derive a stable-ish value from email.
    const localPart = (email.split('@')[0] || '').toLowerCase();
    const base = localPart.replace(/[^a-z0-9_]+/g, '').slice(0, 24);
    const suffix = newId.replace(/-/g, '').slice(0, 6);
    const username = `${base || 'owner'}_${suffix}`;

    const sql = `INSERT INTO public.users
      (id, email, username, full_name, role, password_hash, must_change_password)
      VALUES ($1,$2,$3,$4,'OWNER',$5,false)
      RETURNING id, email, full_name, role, created_at`;
    const r = await pool.query(sql, [newId, email, username, fullName, pwHash]);
    const user = r.rows[0];
    console.log('Seeded OWNER user:', user);
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    try { await pool.end(); } catch {}
  }
}

main();
