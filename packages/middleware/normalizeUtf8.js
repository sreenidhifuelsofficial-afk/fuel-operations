// packages/middleware/normalizeUtf8.js
// ---------------------------------------------------------------------------
// Server-side UTF-8 normalization for JSON responses.
//
// Fixes common mojibake caused by:
//   1. Windows-1252 "smart" characters stored as raw bytes then read as UTF-8
//   2. Double-encoded UTF-8 (text encoded to UTF-8 twice)
//   3. Non-breaking spaces (U+00A0 / 0xC2 0xA0) rendered as "Â " in Latin-1
//
// Applied as Express middleware — wraps res.json() so every outgoing JSON
// payload is cleaned automatically. No frontend changes required.
// ---------------------------------------------------------------------------

'use strict';

// ---- Mojibake repair map ------------------------------------------------
// When UTF-8 bytes are mis-interpreted as Windows-1252 (cp1252) they produce
// recognisable garbage sequences. This map reverses the most common ones.

const MOJIBAKE_MAP = [
  // Double-encoded NBSP  (0xC2 0xA0 read as cp1252 → "Â" + NBSP)
  [/\u00C2\u00A0/g, ' '],

  // Smart quotes & apostrophes  (UTF-8 of U+2018..U+201D read as cp1252)
  [/\u00E2\u0080\u0099/g, '\u2019'],   // '  right single quote
  [/\u00E2\u0080\u0098/g, '\u2018'],   // '  left single quote
  [/\u00E2\u0080\u009C/g, '\u201C'],   // "  left double quote
  [/\u00E2\u0080\u009D/g, '\u201D'],   // "  right double quote

  // Dashes  (U+2013, U+2014)
  [/\u00E2\u0080\u0093/g, '\u2013'],   // –  en dash
  [/\u00E2\u0080\u0094/g, '\u2014'],   // —  em dash

  // Ellipsis  (U+2026)
  [/\u00E2\u0080\u00A6/g, '\u2026'],   // …

  // Bullet  (U+2022)
  [/\u00E2\u0080\u00A2/g, '\u2022'],   // •

  // Standalone NBSP → regular space (after fixing double-encoded ones above)
  [/\u00A0/g, ' '],
];

/**
 * Recursively normalize strings inside a value.
 * Handles plain objects, arrays, and primitives.
 * Non-plain objects (Date, Buffer, etc.) are returned as-is.
 *
 * @param {*} value - any JSON-serialisable value
 * @returns {*} cleaned copy (strings changed in-place where possible)
 */
function normalizeUtf8(value) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    let s = value;
    for (const [pattern, replacement] of MOJIBAKE_MAP) {
      s = s.replace(pattern, replacement);
    }
    return s;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeUtf8);
  }

  if (typeof value === 'object') {
    // Skip non-plain objects (Date, Buffer, RegExp, etc.)
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) return value;

    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = normalizeUtf8(value[key]);
    }
    return out;
  }

  return value; // number, boolean, etc.
}

/**
 * Express middleware that wraps `res.json()` to automatically sanitise
 * all outgoing JSON payloads through `normalizeUtf8`.
 *
 * Usage:
 *   app.use(utf8ResponseMiddleware);
 *
 * Must be mounted BEFORE route handlers.
 */
function utf8ResponseMiddleware(req, res, next) {
  const _json = res.json.bind(res);
  res.json = function utf8Json(body) {
    // Ensure charset is explicit (Express usually does this, but belt-and-suspenders)
    if (!res.get('Content-Type')) {
      res.set('Content-Type', 'application/json; charset=utf-8');
    }
    return _json(normalizeUtf8(body));
  };
  next();
}

// ---------------------------------------------------------------------------
module.exports = { normalizeUtf8, utf8ResponseMiddleware };
