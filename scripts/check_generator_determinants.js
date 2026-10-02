#!/usr/bin/env node
// Check every generator in data/Generators.csv: the determinant of its 3x3 rotation part
// (GeneratorM without the translation column) must be 1 or -1. Anything else is an error.
//
// Usage: node scripts/check_generator_determinants.js [data-dir]
//   Default: data/  (reads Generators.csv, and SpaceGroups.csv for space group names)
// Exits with code 1 if any generator fails.

const fs = require('fs');
const path = require('path');

const dataDir = process.argv[2] || path.join(__dirname, '..', 'data');

// Minimal CSV line splitter: handles quoted fields such as "x,y,z".
function splitCsv(line) {
  return [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)]
    .slice(0, -1)
    .map(([, f]) => (f.startsWith('"') ? f.slice(1, -1).replace(/""/g, '"') : f));
}

function readCsv(file) {
  const [header, ...lines] = fs.readFileSync(path.join(dataDir, file), 'utf8').trim().split(/\r?\n/);
  const cols = splitCsv(header);
  return lines.map(l => Object.fromEntries(splitCsv(l).map((v, i) => [cols[i], v])));
}

function det3([a, b, c]) {
  return a[0] * (b[1] * c[2] - b[2] * c[1])
       - a[1] * (b[0] * c[2] - b[2] * c[0])
       + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

const symbols = new Map(readCsv('SpaceGroups.csv').map(g => [g.GroupID, g.SpaceGroupName]));
const counts = {};
const bad = [];
for (const g of readCsv('Generators.csv')) {
  const m = g.GeneratorM.split(' ').map(Number);
  const d = det3([m.slice(0, 3), m.slice(4, 7), m.slice(8, 11)]);
  counts[d] = (counts[d] || 0) + 1;
  if (d !== 1 && d !== -1) {
    bad.push(`GroupID ${g.GroupID} (${symbols.get(g.GroupID)}) generator ${g.GenIndex}: '${g.Generator}' det = ${d}`);
  }
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`${total} generators checked. Determinant counts:`,
  Object.entries(counts).map(([d, n]) => `${d}: ${n}`).join(', '));
if (bad.length) {
  console.error(`\n${bad.length} generator(s) with determinant not 1 or -1:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log('All determinants are 1 or -1.');
