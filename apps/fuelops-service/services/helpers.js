// apps/fuelops-service/services/helpers.js
// ---------------------------------------------------------------------------
// Shared domain helpers extracted from the monolith (backend/index.js).
// These functions are pure / DB-only and do NOT touch Express req/res.
// ---------------------------------------------------------------------------

'use strict';

// ---------------------------------------------------------------------------
// Math / formatting helpers
// ---------------------------------------------------------------------------

function round3(n) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1000) / 1000;
}

function parseLiters3(value) {
  if (value === undefined || value === null) return NaN;
  const s = String(value).trim();
  if (!s) return NaN;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return round3(n);
}

function isoDateOnly(s) {
  if (!s) return null;
  if (s instanceof Date) {
    if (Number.isNaN(s.getTime())) return null;
    const y = s.getFullYear();
    const m = String(s.getMonth() + 1).padStart(2, '0');
    const d = String(s.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  let m = str.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
    if (y >= 1900 && mo >= 1 && mo <= 12 && day >= 1 && day <= 31)
      return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const day = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
    if (y >= 1900 && mo >= 1 && mo <= 12 && day >= 1 && day <= 31)
      return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m) {
    const day = Number(m[1]), mo = Number(m[2]), yy = Number(m[3]);
    const y = 2000 + yy;
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31)
      return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function toSqlLocalTs(dt) {
  if (!dt) return null;
  const d = new Date(dt);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[\r\n,"]/g.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function getActor(req) {
  if (req && req.user) {
    return req.user.username || req.user.email || req.user.sub || 'user';
  }
  return 'user';
}

function isPrivileged(req) {
  const role = req && req.user ? String(req.user.role || '') : '';
  return role === 'OWNER' || role === 'ADMIN';
}

function getClientIp(req) {
  try {
    const ip = req && (req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress);
    if (!ip) return null;
    return String(Array.isArray(ip) ? ip[0] : ip).split(',')[0].trim();
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Trip helpers
// ---------------------------------------------------------------------------

function isTripClosedRow(tripRow) {
  if (!tripRow) return false;
  if (tripRow.closing_at) return true;
  if (tripRow.closing_liters != null && Number(tripRow.closing_liters) !== 0) return true;
  return false;
}

function isUnfreezeWindow(tripRow) {
  if (!tripRow) return false;
  if (!isTripClosedRow(tripRow)) return false;
  if (tripRow.is_frozen) return false;
  return !!(tripRow.frozen_at && tripRow.unfrozen_at);
}

// ---------------------------------------------------------------------------
// Date/time coercion helpers (ported from monolith)
// ---------------------------------------------------------------------------

function isValidDateTimeString(s) {
  if (!s || typeof s !== 'string') return false;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) return true;
  if (/^\d{2}-\d{2}-\d{4}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(s)) return true;
  const d = new Date(s);
  return !isNaN(d.getTime());
}

function fmtSqlTsLocal(d) {
  const x = new Date(d);
  const pad = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
}

function coerceLocalSqlTimestamp(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace('T', ' ');
  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, dd, mm, yyyy, HH='00', MM='00', SS='00'] = m;
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, yyyy, mm, dd, HH, MM, SS='00'] = m;
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
  }
  if (/Z|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return fmtSqlTsLocal(d);
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return fmtSqlTsLocal(d);
  return null;
}

module.exports = {
  round3,
  parseLiters3,
  isoDateOnly,
  toSqlLocalTs,
  csvEscape,
  getActor,
  isPrivileged,
  getClientIp,
  isTripClosedRow,
  isUnfreezeWindow,
  isValidDateTimeString,
  fmtSqlTsLocal,
  coerceLocalSqlTimestamp,
};
