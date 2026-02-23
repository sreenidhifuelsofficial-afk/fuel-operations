// Demo data seeding for Fuel Ops Website (Standalone)
// Load environment variables from backend/.env regardless of process CWD
try {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {}

const pool = require('./db');
const { hashPassword } = require('./auth');
const { randomUUID } = require('crypto');

async function seed() {
  // Minimal seed for Fuel Ops + Profile/User Control
  const ownerEmail = process.env.SEED_OWNER_EMAIL || 'owner@local.test';
  const ownerUsername = process.env.SEED_OWNER_USERNAME || 'owner';
  const ownerPassword = process.env.SEED_OWNER_PASSWORD || 'Owner@123';
  const ownerName = process.env.SEED_OWNER_NAME || 'Owner';

  const adminEmail = (process.env.SEED_ADMIN_EMAIL || process.env.INIT_ADMIN_EMAIL || '').trim().toLowerCase();
  const adminUsername = (process.env.SEED_ADMIN_USERNAME || '').trim();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || process.env.INIT_ADMIN_PASSWORD || '';
  const adminName = process.env.SEED_ADMIN_NAME || process.env.INIT_ADMIN_NAME || 'Admin';

  const existing = await pool.query(
    `SELECT id FROM public.users WHERE email=$1 OR username=$2 LIMIT 1`,
    [ownerEmail, ownerUsername]
  );
  let ownerId;
  if (existing.rows.length) {
    ownerId = existing.rows[0].id;
  } else {
    ownerId = randomUUID();
    const passwordHash = await hashPassword(ownerPassword);
    await pool.query(
      `INSERT INTO public.users (id, email, username, full_name, role, password_hash, active, must_change_password)
       VALUES ($1,$2,$3,$4,'OWNER',$5,TRUE,FALSE)
      `,
      [ownerId, ownerEmail, ownerUsername, ownerName, passwordHash]
    );
  }

  // Default permissions row (owners/admins bypass gating but endpoints expect it sometimes)
  await pool.query(
    `INSERT INTO public.user_permissions (user_id, tabs, actions)
     VALUES ($1, '{}'::jsonb, '{}'::jsonb)
     ON CONFLICT (user_id) DO NOTHING`,
    [ownerId]
  );

  // Optional: seed an ADMIN user when explicitly configured
  if (adminEmail && adminPassword) {
    const existingAdmin = await pool.query(`SELECT id FROM public.users WHERE email=$1 LIMIT 1`, [adminEmail]);
    if (!existingAdmin.rows.length) {
      const adminId = randomUUID();
      const adminHash = await hashPassword(adminPassword);
      const localPart = (adminEmail.split('@')[0] || '').toLowerCase();
      const base = (adminUsername || localPart).replace(/[^a-z0-9_]+/g, '').slice(0, 24);
      const suffix = adminId.replace(/-/g, '').slice(0, 6);
      const uname = `${base || 'admin'}_${suffix}`;
      await pool.query(
        `INSERT INTO public.users (id, email, username, full_name, role, password_hash, active, must_change_password)
         VALUES ($1,$2,$3,$4,'ADMIN',$5,TRUE,FALSE)`,
        [adminId, adminEmail, uname, adminName || null, adminHash]
      );
      await pool.query(
        `INSERT INTO public.user_permissions (user_id, tabs, actions)
         VALUES ($1, '{}'::jsonb, '{}'::jsonb)
         ON CONFLICT (user_id) DO NOTHING`,
        [adminId]
      );
      console.log(`[seed] Admin login: ${adminEmail} / ${adminPassword}`);
    }
  }

  // Seed a few storage units and a driver for quick UI testing
  await pool.query(
    `INSERT INTO public.storage_units (unit_type, unit_code, capacity_liters, vehicle_number, active)
     VALUES
      ('TRUCK','TRUCK-01', 5000, 'TRUCK-01', TRUE),
      ('DATUM','DATUM-01', 30000, NULL, TRUE),
      ('DISPENSER','DISP-01', 1000, NULL, TRUE)
     ON CONFLICT (unit_code) DO NOTHING`,
    []
  );

  await pool.query(
    `INSERT INTO public.drivers (name, phone, driver_id, active)
     VALUES ('Default Driver', NULL, 'DRV-01', TRUE)
     ON CONFLICT (driver_id) DO NOTHING`,
    []
  );

  console.log('[seed] Data seeded.');
  console.log(`[seed] Owner login: ${ownerEmail} / ${ownerPassword}`);
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
