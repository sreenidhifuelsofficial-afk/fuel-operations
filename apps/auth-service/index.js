// apps/auth-service/index.js
// ---------------------------------------------------------------------------
// Auth & User Management Service — Express Router factory.
//
// Endpoints extracted from backend/index.js:
//   POST   /api/auth/register-initial  — Initial owner registration
//   GET    /api/auth/owner-exists      — Check if owner exists
//   POST   /api/auth/login             — Login
//   GET    /api/auth/me                — Current authenticated user
//   POST   /api/auth/change-password   — Change own password
//   POST   /api/users                  — Create user (OWNER/ADMIN)
//   GET    /api/users                  — List users (OWNER/ADMIN)
//   PATCH  /api/users/:id              — Update user (OWNER/ADMIN)
//   POST   /api/users/:id/password-reset  — Admin password reset
//   GET    /api/users/:id/permissions  — Get user permissions
//   PATCH  /api/users/:id/permissions  — Update user permissions
//   GET    /api/password-audit         — Password audit log
//   GET    /api/profile/me             — Get own profile
//   PUT    /api/profile                — Update own profile
//   POST   /api/profile/photo          — Upload own photo
//   GET    /api/profile/photo/me       — Get own photo
//   DELETE /api/profile/photo          — Delete own photo
//   GET    /api/profile/photo/:userId  — Get user photo (admin/self)
//   GET    /api/admin/employee-profiles — List employee profiles (admin)
//   GET    /api/admin/employee-profile/:userId — Single profile (admin)
//
// Usage (from gateway):
//   const { createAuthRouter } = require('../auth-service');
//   app.use(createAuthRouter({ pool, hashPassword, verifyPassword, signToken, requireAuth, requireRole, ownerExists }));
// ---------------------------------------------------------------------------

'use strict';

const { Router } = require('express');
const { randomUUID } = require('crypto');

// Role limits (configurable via environment)
const ROLE_LIMITS = Object.freeze({
  ADMIN: Math.max(parseInt(process.env.MAX_ADMINS || '10', 10) || 10, 0),
  OWNER: Math.max(parseInt(process.env.MAX_OWNERS || '6', 10) || 6, 0),
  EMPLOYEE: Math.max(parseInt(process.env.MAX_EMPLOYEES || '100', 10) || 100, 0),
});

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {Function} deps.hashPassword
 * @param {Function} deps.verifyPassword
 * @param {Function} deps.signToken
 * @param {Function} deps.requireAuth
 * @param {Function} deps.requireRole
 * @param {Function} deps.ownerExists
 */
function createAuthRouter({ pool, hashPassword, verifyPassword, signToken, requireAuth, requireRole, ownerExists }) {
  const router = Router();

  async function assertRoleLimit(role, { excludeUserId } = {}) {
    const cap = ROLE_LIMITS[role];
    if (!cap || cap <= 0) return;
    const params = [role];
    let sql = 'SELECT COUNT(*)::int AS c FROM public.users WHERE active=TRUE AND role=$1';
    if (excludeUserId) {
      params.push(excludeUserId);
      sql += ` AND id<>$${params.length}`;
    }
    const r = await pool.query(sql, params);
    const count = (r.rows[0] && r.rows[0].c) || 0;
    if (count >= cap) {
      const label = role === 'EMPLOYEE' ? 'employee' : role.toLowerCase();
      const plural = cap === 1 ? '' : 's';
      throw new Error(`Account limit reached: max ${cap} active ${label}${plural}`);
    }
  }

  // =========================
  // Auth Endpoints
  // =========================

  // Register initial OWNER
  router.post('/api/auth/register-initial', async (req, res) => {
    try {
      const { email, password, full_name } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'email and password required' });
      if (await ownerExists()) return res.status(400).json({ error: 'Owner already exists' });
      const pwHash = await hashPassword(password);
      const newId = randomUUID();
      const uname = String(email).toLowerCase().split('@')[0];
      const r = await pool.query(
        'INSERT INTO public.users (id, email, username, full_name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, email, username, full_name, role, created_at',
        [newId, String(email).toLowerCase(), uname, full_name || null, 'OWNER', pwHash, false]
      );
      const user = r.rows[0];
      const token = signToken(user);
      res.status(201).json({ user, token });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Owner exists check
  router.get('/api/auth/owner-exists', async (req, res) => {
    try {
      const exists = await ownerExists();
      res.json({ exists });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Login
  router.post('/api/auth/login', async (req, res) => {
    try {
      const { identifier, email, password } = req.body || {};
      const idOrEmail = identifier || email;
      if (!idOrEmail || !password) return res.status(400).json({ error: 'identifier/email and password required' });
      const val = String(idOrEmail).trim();
      let r = await pool.query(
        'SELECT * FROM public.users WHERE active=TRUE AND (LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1))',
        [val]
      );
      if (r.rows.length === 0 && /\s/.test(val)) {
        const rf = await pool.query('SELECT * FROM public.users WHERE active=TRUE AND LOWER(full_name)=LOWER($1)', [val]);
        if (rf.rows.length === 1) r = rf;
      }
      if (r.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
      const user = r.rows[0];
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      await pool.query('UPDATE public.users SET last_login=NOW() WHERE id=$1', [user.id]);
      const pub = { id: user.id, email: user.email, username: user.username, phone: user.phone, full_name: user.full_name, role: user.role, must_change_password: user.must_change_password };
      const token = signToken(pub);
      res.json({ user: pub, token, requirePasswordChange: !!user.must_change_password });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Current user
  router.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT id, email, username, phone, full_name, role, must_change_password, created_at, last_login, active, joining_date, status FROM public.users WHERE id=$1',
        [req.user.sub]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json(r.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Change password
  router.post('/api/auth/change-password', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const { currentPassword, newPassword } = req.body || {};
      if (!newPassword) return res.status(400).json({ error: 'newPassword required' });
      const r = await pool.query('SELECT id, password_hash, must_change_password FROM public.users WHERE id=$1 AND active=TRUE', [userId]);
      if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
      const row = r.rows[0];
      if (!row.must_change_password) {
        if (!currentPassword) return res.status(400).json({ error: 'currentPassword required' });
        const ok = await verifyPassword(currentPassword, row.password_hash);
        if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
      }
      const hash = await hashPassword(newPassword);
      await pool.query('UPDATE public.users SET password_hash=$1, must_change_password=FALSE, last_password_change_at=NOW() WHERE id=$2', [hash, userId]);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // =========================
  // User Management Endpoints
  // =========================

  // Create user
  router.post('/api/users', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const { email, username, phone, password, role, full_name, joining_date, status } = req.body || {};
      if (!username || !password || !role) return res.status(400).json({ error: 'username, password, role required' });
      const rRole = role.toUpperCase();
      const creator = req.user;
      if (creator.role === 'OWNER') {
        if (!['OWNER', 'EMPLOYEE'].includes(rRole)) return res.status(400).json({ error: 'OWNER can create only OWNER or EMPLOYEE' });
      } else if (creator.role === 'ADMIN') {
        if (!['OWNER', 'ADMIN', 'EMPLOYEE'].includes(rRole)) return res.status(400).json({ error: 'Invalid role' });
      } else {
        return res.status(403).json({ error: 'Forbidden' });
      }
      await assertRoleLimit(rRole);
      if (email) {
        const exists = await pool.query('SELECT 1 FROM public.users WHERE email=$1', [String(email).toLowerCase()]);
        if (exists.rows.length) return res.status(409).json({ error: 'Email already in use' });
      }
      if (username) {
        const existsU = await pool.query('SELECT 1 FROM public.users WHERE LOWER(username)=LOWER($1)', [String(username)]);
        if (existsU.rows.length) return res.status(409).json({ error: 'Username already in use' });
      }
      const pwHash = await hashPassword(password);
      const newId = randomUUID();
      const ins = await pool.query(
        'INSERT INTO public.users (id, email, username, phone, full_name, role, password_hash, must_change_password, joining_date, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, email, username, phone, full_name, role, created_at, joining_date, status',
        [newId, email ? String(email).toLowerCase() : null, username || null, phone || null, full_name || null, rRole, pwHash, true, joining_date || null, status || 'ACTIVE']
      );
      res.status(201).json(ins.rows[0]);
    } catch (err) {
      console.error(err);
      const msg = String(err && err.message ? err.message : '');
      if ((err && err.code === '23505' && String(err.constraint || '').toLowerCase().includes('uniq_active_owner')) || msg.includes('uniq_active_owner')) {
        return res.status(400).json({ error: 'This database is configured to allow only one active OWNER. Run migrations to remove uniq_active_owner, or change the owner limit configuration.' });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // List users
  router.get('/api/users', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const r = await pool.query('SELECT id, email, username, phone, full_name, role, active, created_at, last_login, joining_date, status FROM public.users ORDER BY role, COALESCE(username,email)');
      res.json(r.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update user
  router.patch('/api/users/:id', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const id = req.params.id;
      let { status, joining_date, full_name, email, phone, username, role } = req.body || {};
      const current = await pool.query('SELECT id, role, active FROM public.users WHERE id=$1', [id]);
      if (!current.rows.length) return res.status(404).json({ error: 'User not found' });
      const currentRole = current.rows[0].role;
      const isActive = !!current.rows[0].active;
      const allowedStatus = new Set(['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'SUSPENDED']);
      if (status !== undefined) {
        status = String(status).toUpperCase();
        if (!allowedStatus.has(status)) return res.status(400).json({ error: 'Invalid status' });
      }
      if (joining_date !== undefined && joining_date !== null) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(joining_date)))
          return res.status(400).json({ error: 'joining_date must be YYYY-MM-DD' });
      }
      if (email !== undefined && email !== null) email = String(email).toLowerCase();
      if (username !== undefined && username !== null) username = String(username);
      if (role !== undefined && role !== null) {
        const newRole = String(role).toUpperCase();
        if (req.user.role === 'OWNER') {
          if (!['OWNER', 'EMPLOYEE'].includes(newRole))
            return res.status(400).json({ error: 'OWNER can set role only to OWNER or EMPLOYEE' });
        } else if (req.user.role === 'ADMIN') {
          if (!['OWNER', 'ADMIN', 'EMPLOYEE'].includes(newRole))
            return res.status(400).json({ error: 'Invalid role' });
        }
        role = newRole;
        if (isActive && role !== currentRole) await assertRoleLimit(role, { excludeUserId: id });
      }
      const sets = [];
      const params = [];
      const add = (sqlFragment, val) => { params.push(val); sets.push(sqlFragment.replace('$idx', `$${params.length}`)); };
      if (status !== undefined) add('status=$idx', status);
      if (joining_date !== undefined) add('joining_date=$idx', joining_date || null);
      if (full_name !== undefined) add('full_name=$idx', full_name || null);
      if (email !== undefined) {
        if (email) {
          const e = await pool.query('SELECT 1 FROM public.users WHERE email=$1 AND id<>$2', [email, id]);
          if (e.rows.length) return res.status(409).json({ error: 'Email already in use' });
        }
        add('email=$idx', email || null);
      }
      if (phone !== undefined) add('phone=$idx', phone || null);
      if (username !== undefined) {
        if (username) {
          const u = await pool.query('SELECT 1 FROM public.users WHERE LOWER(username)=LOWER($1) AND id<>$2', [username, id]);
          if (u.rows.length) return res.status(409).json({ error: 'Username already in use' });
        }
        add('username=$idx', username || null);
      }
      if (role !== undefined) add('role=$idx', role);
      if (!sets.length) return res.status(400).json({ error: 'No updatable fields provided' });
      params.push(id);
      const sql = `UPDATE public.users SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id, email, username, phone, full_name, role, active, created_at, last_login, joining_date, status`;
      const r = await pool.query(sql, params);
      if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
      res.json(r.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Password reset (OWNER/ADMIN)
  router.post('/api/users/:id/password-reset', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const id = req.params.id;
      const { newPassword } = req.body || {};
      if (!newPassword || String(newPassword).length < 6)
        return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
      const ru = await pool.query('SELECT id, role, active, email, username, full_name FROM public.users WHERE id=$1', [id]);
      if (!ru.rows.length) return res.status(404).json({ error: 'User not found' });
      const target = ru.rows[0];
      if (!target.active) return res.status(400).json({ error: 'User is inactive' });
      if (req.user.role === 'OWNER' && target.role === 'ADMIN')
        return res.status(403).json({ error: 'OWNER cannot reset ADMIN password' });
      const hash = await hashPassword(String(newPassword));
      await pool.query('UPDATE public.users SET password_hash=$1, must_change_password=FALSE, last_password_change_at=NOW() WHERE id=$2', [hash, id]);
      // Audit log
      try {
        await pool.query(
          `INSERT INTO public.users_password_audit (target_user_id, target_email, target_username, target_full_name, target_role, changed_by_user_id, changed_by, changed_by_role)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, target.email, target.username, target.full_name, target.role, req.user.sub, req.user.username || req.user.email || 'unknown', req.user.role]
        );
      } catch {}
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Password audit log
  router.get('/api/password-audit', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM public.users_password_audit ORDER BY performed_at DESC LIMIT 200');
      res.json(r.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // =========================
  // User Permissions Endpoints
  // =========================

  // Get user permissions (OWNER, ADMIN, or the user themselves)
  router.get('/api/users/:id/permissions', requireAuth, async (req, res) => {
    try {
      const id = req.params.id;
      if (!(req.user.role === 'OWNER' || req.user.role === 'ADMIN' || req.user.sub === id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const r = await pool.query('SELECT user_id, tabs, actions FROM public.user_permissions WHERE user_id=$1', [id]);
      if (!r.rows.length) return res.json({ user_id: id, tabs: {}, actions: {} });
      res.json(r.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update user permissions (OWNER or ADMIN)
  router.patch('/api/users/:id/permissions', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const id = req.params.id;
      let { tabs, actions, merge } = req.body || {};
      tabs = tabs && typeof tabs === 'object' ? tabs : {};
      actions = actions && typeof actions === 'object' ? actions : {};
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query('SELECT * FROM public.user_permissions WHERE user_id=$1 FOR UPDATE', [id]);
        if (existing.rows.length) {
          if (merge) {
            tabs = { ...existing.rows[0].tabs, ...tabs };
            actions = { ...existing.rows[0].actions, ...actions };
          }
          const upd = await client.query('UPDATE public.user_permissions SET tabs=$1, actions=$2 WHERE user_id=$3 RETURNING user_id, tabs, actions', [tabs, actions, id]);
          await client.query('COMMIT');
          return res.json(upd.rows[0]);
        } else {
          const ins = await client.query('INSERT INTO public.user_permissions (user_id, tabs, actions) VALUES ($1,$2,$3) RETURNING user_id, tabs, actions', [id, tabs, actions]);
          await client.query('COMMIT');
          return res.status(201).json(ins.rows[0]);
        }
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // =========================
  // Profile Endpoints
  // =========================

  // ---- Validators ----
  function normalizePan(pan) {
    if (!pan) return null;
    const s = String(pan).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s || null;
  }
  function isValidPan(pan) {
    const s = normalizePan(pan);
    if (!s) return false;
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s);
  }
  const verhoeffD = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0]
  ];
  const verhoeffP = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]
  ];
  function isValidAadhaar(a) {
    if (!a) return false;
    const s = String(a).replace(/\s+/g, '');
    if (!/^[0-9]{12}$/.test(s)) return false;
    let c = 0;
    const arr = s.split('').map(Number).reverse();
    for (let i = 0; i < arr.length; i++) {
      const pi = verhoeffP[i % 8][arr[i]];
      c = verhoeffD[c][pi];
    }
    return c === 0;
  }
  function last4(s) {
    const str = String(s || '');
    return str.length >= 4 ? str.slice(-4) : str;
  }
  function normalizePhone(phone) {
    if (!phone) return null;
    const digits = String(phone).replace(/\D+/g, '');
    if (/^[6-9]\d{9}$/.test(digits)) return '+91' + digits;
    if (/^91[6-9]\d{9}$/.test(digits)) return '+' + digits;
    if (/^\+91[6-9]\d{9}$/.test(String(phone))) return String(phone);
    return null;
  }

  // Ensure the user_full_profiles view exists
  async function ensureUserFullProfilesView() {
    try {
      await pool.query(`
        CREATE OR REPLACE VIEW public.user_full_profiles AS
        SELECT 
          u.id AS user_id, u.full_name, u.username, u.email, u.phone, u.role,
          u.joining_date, u.status,
          p.date_of_birth, p.gender, p.emergency_contact_name, p.emergency_contact_phone,
          p.address, p.pan, p.pan_normalized, p.aadhaar, p.aadhaar_last4, p.updated_at
        FROM public.users u
        LEFT JOIN public.user_profiles p ON p.user_id = u.id;
      `);
    } catch (e) {
      console.warn('[ensureUserFullProfilesView] warning:', e.message);
    }
  }

  // Get my profile (combines users + user_profiles)
  router.get('/api/profile/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const ur = await pool.query('SELECT id, email, username, phone, full_name, role, joining_date, status FROM public.users WHERE id=$1', [userId]);
      if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
      const pr = await pool.query('SELECT date_of_birth, gender, emergency_contact_name, emergency_contact_phone, address, pan, aadhaar, aadhaar_last4, updated_at FROM public.user_profiles WHERE user_id=$1', [userId]);
      const base = ur.rows[0];
      const prof = pr.rows[0] || null;
      res.json({ user: base, profile: prof });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  // Update my profile
  router.put('/api/profile', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const { full_name, phone, email, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, address, pan, aadhaar } = req.body || {};
      let panNorm = null;
      if (pan) { if (!isValidPan(pan)) return res.status(400).json({ error: 'Invalid PAN format' }); panNorm = normalizePan(pan); }
      if (aadhaar) { if (!isValidAadhaar(aadhaar)) return res.status(400).json({ error: 'Invalid Aadhaar number' }); }
      let phoneNorm = undefined;
      if (phone !== undefined) {
        if (phone === null || String(phone).trim() === '') phoneNorm = null;
        else {
          const n = normalizePhone(phone);
          if (!n) return res.status(400).json({ error: 'Invalid phone' });
          phoneNorm = n;
        }
      }
      if (full_name !== undefined || phone !== undefined || email !== undefined) {
        const r = await pool.query('UPDATE public.users SET full_name=COALESCE($1, full_name), phone=COALESCE($2, phone), email=COALESCE($3, email) WHERE id=$4 RETURNING id', [full_name ?? null, phoneNorm ?? null, email ? String(email).toLowerCase() : null, userId]);
        if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
      }
      const existing = await pool.query('SELECT 1 FROM public.user_profiles WHERE user_id=$1', [userId]);
      const aadhaarLast4 = aadhaar ? last4(aadhaar) : undefined;
      if (existing.rows.length) {
        const up = await pool.query(
          `UPDATE public.user_profiles SET date_of_birth=$1, gender=$2, emergency_contact_name=$3, emergency_contact_phone=$4, address=$5, pan=$6, pan_normalized=$7, aadhaar=$8, aadhaar_last4=COALESCE($9, aadhaar_last4) WHERE user_id=$10 RETURNING date_of_birth, gender, emergency_contact_name, emergency_contact_phone, address, pan, aadhaar, aadhaar_last4, updated_at`,
          [date_of_birth || null, gender || null, emergency_contact_name || null, emergency_contact_phone || null, address || null, pan || null, panNorm || null, aadhaar || null, aadhaarLast4 || null, userId]
        );
        return res.json({ ok: true, profile: up.rows[0] });
      } else {
        const ins = await pool.query(
          `INSERT INTO public.user_profiles (user_id, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, address, pan, pan_normalized, aadhaar, aadhaar_last4) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING date_of_birth, gender, emergency_contact_name, emergency_contact_phone, address, pan, aadhaar, aadhaar_last4, updated_at`,
          [userId, date_of_birth || null, gender || null, emergency_contact_name || null, emergency_contact_phone || null, address || null, pan || null, panNorm || null, aadhaar || null, aadhaarLast4 || null]
        );
        return res.json({ ok: true, profile: ins.rows[0] });
      }
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  // Upload or replace my photo
  router.post('/api/profile/photo', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const { dataUrl } = req.body || {};
      if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return res.status(400).json({ error: 'dataUrl required' });
      const m = /^data:(.*?);base64,(.*)$/.exec(dataUrl);
      if (!m) return res.status(400).json({ error: 'Invalid dataUrl' });
      const mime = m[1];
      const b64 = m[2];
      const buf = Buffer.from(b64, 'base64');
      if (!/^image\/(png|jpeg|jpg|webp)$/.test(mime)) return res.status(400).json({ error: 'Only PNG/JPEG/WEBP allowed' });
      if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Image too large' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM public.user_photos WHERE user_id=$1', [userId]);
        const ins = await client.query('INSERT INTO public.user_photos (user_id, mime_type, file_name, file_size_bytes, data) VALUES ($1,$2,$3,$4,$5) RETURNING id', [userId, mime, 'profile.' + (mime.split('/')[1] || 'png'), buf.length, buf]);
        await client.query('COMMIT');
        res.json({ ok: true, id: ins.rows[0].id });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  // Get my photo
  router.get('/api/profile/photo/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const r = await pool.query('SELECT mime_type, data FROM public.user_photos WHERE user_id=$1 LIMIT 1', [userId]);
      if (!r.rows.length) return res.status(404).end();
      res.setHeader('Content-Type', r.rows[0].mime_type);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(r.rows[0].data);
    } catch (e) {
      console.error(e);
      res.status(500).end();
    }
  });

  // Delete my photo
  router.delete('/api/profile/photo', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      await pool.query('DELETE FROM public.user_photos WHERE user_id=$1', [userId]);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  // Get a specific user's photo (Admin/Owner only, or self)
  router.get('/api/profile/photo/:userId', requireAuth, async (req, res) => {
    try {
      const targetId = req.params.userId;
      if (!(req.user.sub === targetId || req.user.role === 'OWNER' || req.user.role === 'ADMIN')) {
        return res.status(403).end();
      }
      const r = await pool.query('SELECT mime_type, data FROM public.user_photos WHERE user_id=$1 LIMIT 1', [targetId]);
      if (!r.rows.length) return res.status(404).end();
      res.setHeader('Content-Type', r.rows[0].mime_type);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(r.rows[0].data);
    } catch (e) {
      console.error(e);
      res.status(500).end();
    }
  });

  // =========================
  // Admin Employee Profile Endpoints
  // =========================

  // Read-only combined user profiles (Admin/Owner only)
  router.get('/api/admin/employee-profiles', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      await ensureUserFullProfilesView();
      let { role, q, page = 1, pageSize = 20 } = req.query || {};
      const p = Math.max(parseInt(page, 10) || 1, 1);
      const s = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
      const offset = (p - 1) * s;
      const params = [];
      const filters = [];
      if (role) {
        const allowed = ['OWNER', 'ADMIN', 'EMPLOYEE'];
        const roles = String(role).split(',').map(x => x.trim().toUpperCase()).filter(r => allowed.includes(r));
        if (roles.length) {
          const ph = roles.map((_, i) => `$${params.length + i + 1}`).join(',');
          params.push(...roles);
          filters.push(`v.role IN (${ph})`);
        }
      }
      if (q) {
        const like = `%${String(q).toLowerCase()}%`;
        params.push(like, like, like, like);
        const b = params.length;
        filters.push(`(
          LOWER(COALESCE(v.full_name,'')) LIKE $${b-3} OR
          LOWER(COALESCE(v.username,'')) LIKE $${b-2} OR
          LOWER(COALESCE(v.email,'')) LIKE $${b-1} OR
          LOWER(COALESCE(v.phone,'')) LIKE $${b}
        )`);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const order = 'ORDER BY v.role, COALESCE(v.full_name, v.username, v.email)';
      const dataSql = `SELECT v.* FROM public.user_full_profiles v ${where} ${order} LIMIT ${s} OFFSET ${offset}`;
      const countSql = `SELECT COUNT(*)::int AS total FROM public.user_full_profiles v ${where}`;
      const [r, c] = await Promise.all([
        pool.query(dataSql, params),
        pool.query(countSql, params)
      ]);
      res.json({ items: r.rows, page: p, pageSize: s, total: c.rows[0]?.total || 0 });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Single employee profile by id (Admin/Owner only)
  router.get('/api/admin/employee-profile/:userId', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      await ensureUserFullProfilesView();
      const id = req.params.userId;
      const r = await pool.query('SELECT * FROM public.user_full_profiles WHERE user_id=$1', [id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(r.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAuthRouter };
