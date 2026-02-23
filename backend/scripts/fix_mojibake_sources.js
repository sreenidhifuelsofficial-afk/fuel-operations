#!/usr/bin/env node
// Batch fix mojibake in frontend source files.
// These files were saved with broken encoding — UTF-8 chars were double/triple encoded.
// This script reads each file, applies deterministic text replacements, and overwrites.

'use strict';
const fs = require('fs');
const path = require('path');

// ---- Replacement map (order matters: triple-encoded first, then double) ----
const REPLACEMENTS = [
  // Triple-encoded patterns (worst corruption — fix first)
  [/Ã¢â‚¬â€/g,  '\u2014'],   // — em dash
  [/Ã¢â‚¬Â¦/g,  '\u2026'],   // … ellipsis
  [/Ã‚Â·/g,    '\u00B7'],   // · middle dot
  [/Ã¢â‚¬â„¢/g, '\u2019'],   // ' right single quote
  [/Ã¢â‚¬Å"/g,  '\u201C'],   // " left double quote
  [/Ã¢â‚¬\u009D/g, '\u201D'], // " right double quote

  // Double-encoded patterns
  [/Â·/g,     '\u00B7'],   // · middle dot
  [/â€™/g,    '\u2019'],   // ' right single quote  
  [/â€œ/g,    '\u201C'],   // " left double quote
  [/â€\u009D/g, '\u201D'], // " right double quote (control char variant)
  [/â€¦/g,    '\u2026'],   // … ellipsis
  [/â€"/g,    '\u2014'],   // — em dash
  [/â€"/g,    '\u2013'],   // – en dash
  [/â†'/g,    '\u2192'],   // → right arrow
  [/Î"/g,     '\u0394'],   // Δ Greek capital delta

  // Common special-case: â€ followed by ™ or . or end — already handled above
];

// ---- Find all .js/.jsx files under frontend/src ----
const srcDir = path.join(__dirname, '..', '..', 'frontend', 'src');

function walk(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walk(full));
    } else if (/\.(js|jsx|ts|tsx)$/i.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

const files = walk(srcDir);
let totalFixed = 0;
let filesFixed = 0;

for (const filePath of files) {
  const original = fs.readFileSync(filePath, 'utf8');
  let content = original;
  let fileReplacements = 0;

  for (const [pattern, replacement] of REPLACEMENTS) {
    const before = content;
    content = content.replace(pattern, replacement);
    // Count how many replacements were made
    const diff = (before.length - content.length);
    if (before !== content) {
      const matches = before.match(pattern);
      fileReplacements += matches ? matches.length : 1;
    }
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    const rel = path.relative(path.join(__dirname, '..'), filePath);
    console.log(`  [FIXED] ${rel} (${fileReplacements} replacements)`);
    totalFixed += fileReplacements;
    filesFixed++;
  }
}

console.log(`\nDone: ${totalFixed} mojibake sequences fixed across ${filesFixed} files.`);
if (filesFixed === 0) console.log('All files are already clean.');
