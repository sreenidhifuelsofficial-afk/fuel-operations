// Shared utility functions for FuelOps tab components

export function fmtDateInput(d) {
  const pad = n => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  return `${y}-${m}-${day}`;
}

export function parseWallClockDate(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  const s = String(ts).trim();
  // Prefer treating YYYY-MM-DDTHH:mm:ss (no timezone) as local wall-clock.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const hh = Number(m[4]);
    const mm = Number(m[5]);
    const ss = Number(m[6] || '0');
    const dt = new Date(y, mo - 1, d, hh, mm, ss);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  // Treat YYYY-MM-DD as a local date.
  const md = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (md) {
    const y = Number(md[1]);
    const mo = Number(md[2]);
    const d = Number(md[3]);
    const dt = new Date(y, mo - 1, d);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  // Avoid overly-permissive Date parsing (e.g. '1' becomes 2001-01-01).
  // Only fall back when the input already looks like a date/time string.
  if (!/[\d]{2,4}[-\/][\d]{1,2}[-\/]/.test(s) && !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

export function formatTimeForInput(ts) {
  if (!ts) return '';
  try {
    if (ts instanceof Date) {
      const hh = String(ts.getHours()).padStart(2, '0');
      const mm = String(ts.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    }
    const s = String(ts).trim();
    // Fast path: extract HH:mm from common timestamp/time strings without creating a Date.
    const m = s.match(/[ T](\d{2}):(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;
    const mt = s.match(/^(\d{2}):(\d{2})/);
    if (mt) return `${mt[1]}:${mt[2]}`;
    const d = parseWallClockDate(s);
    if (!d) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch { return ''; }
}

export function fmtDateInputValue(value) {
  if (!value) return '';
  if (value instanceof Date) return fmtDateInput(value);
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

export function formatWallClockTimeDisplay(ts) {
  const hhmm = formatTimeForInput(ts);
  if (!hhmm) return '-';
  // 24-hour display (HH:mm) for all time fields.
  return hhmm;
}

export function formatWallClockDateTimeDisplay(ts) {
  if (!ts) return '-';
  const date = fmtDateInputValue(ts);
  const time = formatTimeForInput(ts);
  if (date && time) return `${formatWallClockDateDisplay(date)} ${time}`;
  if (date) return formatWallClockDateDisplay(date);
  if (time) return time;
  return String(ts);
}

export function formatWallClockDateDisplay(d) {
  const v = fmtDateInputValue(d);
  if (!v) return '-';
  const [y, m, day] = v.split('-');
  return `${day}/${m}/${y}`;
}

export function round3(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

export function parseLiters3(value) {
  if (value == null) return null;
  if (typeof value === 'number') return round3(value);
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return round3(n);
}

// Helper: robust JSON parsing with nice HTML error surface
export async function safeJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text || 'null');
  } catch {
    throw new Error(text && text.trim().startsWith('<') ? `Unexpected HTML from server (status ${response.status}). Check API server/proxy.` : (text || `HTTP ${response.status}`));
  }
}
