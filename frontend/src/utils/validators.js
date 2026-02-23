// Shared validation helpers

// Basic email validation: local@domain.tld (tld >= 2 chars)
export function isValidEmail(value) {
  if (!value) return false;
  const s = String(value).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(s);
}

// Indian phone number: must include +91 and 10 digits, allow spaces or dashes
// Accept forms: +911234567890, +91 1234567890, +91-1234567890
// Enforce starting digit 6-9 for mobile numbers
export function isValidIndianPhone(value) {
  if (!value) return false;
  const s = String(value).trim();
  return /^\+91[\s-]?[6-9]\d{9}$/.test(s);
}

// GSTIN format (India): 15 chars -> 2 digits state + 10 PAN (AAAAA9999A) + 1 entity (1-9 or A-Z) + Z + 1 checksum (0-9 or A-Z)
export function isValidGSTIN(value) {
  if (!value) return false;
  const s = String(value).trim().toUpperCase();
  return /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[1-9A-Z]Z[0-9A-Z]$/.test(s);
}

// Generic URL validator: must be http(s) with a hostname
export function isValidHttpUrl(value) {
  if (!value) return false;
  try {
    const u = new URL(String(value).trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

// Positive number (strictly > 0). Accepts string or number.
export function isPositiveNumber(value) {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) && n > 0;
}

// Non-negative number (>= 0)
export function isNonNegativeNumber(value) {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) && n >= 0;
}

// Relaxed Indian phone check: accepts +91… or plain 10 digits (starts 6-9), allows spaces/dashes
export function isValidIndianPhoneLoose(value) {
  if (!value) return false;
  const s = String(value).trim();
  // remove spaces/dashes for validation
  const compact = s.replace(/[\s-]+/g, '');
  if (/^\+91[6-9]\d{9}$/.test(compact)) return true;
  if (/^[6-9]\d{9}$/.test(compact)) return true;
  return false;
}

// Normalize to +91XXXXXXXXXX, stripping spaces/dashes. If already has +91, keep it; if 10 digits, prefix +91
export function normalizeIndianPhone(value) {
  if (!value) return value;
  const compact = String(value).trim().replace(/[\s-]+/g, '');
  if (/^\+91[6-9]\d{9}$/.test(compact)) return compact; // already normalized
  if (/^[6-9]\d{9}$/.test(compact)) return `+91${compact}`;
  return value; // fallback: return original if not valid
}

// Stricter Google Maps URL detection
export function isValidGoogleMapsUrl(value) {
  if (!value) return false;
  try {
    const u = new URL(String(value).trim());
    if (!(u.protocol === 'http:' || u.protocol === 'https:')) return false;
    const host = u.hostname.toLowerCase();
    const path = (u.pathname || '').toLowerCase();
    // maps.google.com and *.google.com/maps*
    if (host === 'maps.google.com') return true;
    if (host.endsWith('.google.com') && (path.startsWith('/maps') || path.startsWith('/local') || path.startsWith('/search') || path.startsWith('/maps/@'))) return true;
    // Shorteners commonly used for Maps
    if (host === 'goo.gl' && path.startsWith('/maps')) return true;
    if (host.endsWith('.app.goo.gl')) return true; // maps.app.goo.gl
    if (host === 'g.co' && path.startsWith('/kgs')) return true; // g.co/kgs short links
    return false;
  } catch {
    return false;
  }
}

// PAN (India): 5 letters, 4 digits, 1 letter
export function isValidPAN(value) {
  if (!value) return false;
  const s = String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s);
}

// Aadhaar (India): 12 digits with Verhoeff check
export function isValidAadhaar(value) {
  if (!value) return false;
  const s = String(value).replace(/\s+/g, '');
  if (!/^\d{12}$/.test(s)) return false;
  const d = [
    [0,1,2,3,4,5,6,7,8,9],
    [1,2,3,4,0,6,7,8,9,5],
    [2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],
    [4,0,1,2,3,9,5,6,7,8],
    [5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],
    [7,6,5,9,8,2,1,0,4,3],
    [8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0]
  ];
  const p = [
    [0,1,2,3,4,5,6,7,8,9],
    [1,5,7,6,2,8,3,0,9,4],
    [5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],
    [9,4,5,3,1,2,6,8,7,0],
    [4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],
    [7,0,4,6,9,1,3,2,5,8]
  ];
  let c = 0;
  const arr = s.split('').map(Number).reverse();
  for (let i = 0; i < arr.length; i++) {
    c = d[c][p[i % 8][arr[i]]];
  }
  return c === 0;
}
