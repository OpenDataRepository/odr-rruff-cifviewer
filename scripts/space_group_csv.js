#!/usr/bin/env node
// Convert the space group generator file (data/SpaceGroupData.txt) into a CSV with one row per generator:
//   SpaceGroup, Lattice, Order, Generator, GeneratorM
// GeneratorM is the 3x4 augmented matrix written row by row (r11 r12 r13 t1 r21 ... t3),
// 12 space-separated values. Translations stay as exact fractions (1/3 has no exact decimal).
//
// Usage: node scripts/space_group_csv.js [input.txt] [output.csv]
//   Defaults: data/SpaceGroupData.txt -> data/SpaceGroupData.csv
//
// To add or fix space groups, edit the .txt (one group per line, same format:
// name, then "order 'x,y,z'" pairs) and rerun. Bad lines are reported with their line number.

const fs = require('fs');
const path = require('path');

const DEFAULT_INPUT = path.join(__dirname, '..', 'data', 'SpaceGroupData.txt');
const [input = DEFAULT_INPUT, outputArg] = process.argv.slice(2);
const output = outputArg || input.replace(/\.[^.]+$/, '') + '.csv';

const AXES = { x: 0, y: 1, z: 2 };

function gcd(a, b) { return b ? gcd(b, a % b) : Math.abs(a); }

// Parse one component such as "1/2-x", "x-y", "-1/2+x", "+z" into [cx, cy, cz, [num, den]].
function parseComponent(expr) {
  const row = [0, 0, 0];
  let num = 0, den = 1;
  const re = /([+-]*)\s*(\d+\/\d+|\d+|[xyz])/g;
  let consumed = '', m;
  while ((m = re.exec(expr)) !== null) {
    consumed += m[0];
    const sign = (m[1].match(/-/g) || []).length % 2 ? -1 : 1;
    const term = m[2];
    if (term in AXES) {
      row[AXES[term]] += sign;
    } else {
      const [n, d = '1'] = term.split('/');
      const tn = sign * Number(n), td = Number(d);
      num = num * td + tn * den;
      den *= td;
    }
  }
  if (consumed.replace(/\s/g, '') !== expr.replace(/\s/g, '')) {
    throw new Error(`Could not parse component "${expr}"`);
  }
  const g = gcd(num, den) || 1;
  return [...row, num / g, den / g];
}

function formatFraction(num, den) {
  if (num === 0) return '0';
  return den === 1 ? String(num) : `${num}/${den}`;
}

function generatorToMatrix(op) {
  const parts = op.split(',');
  if (parts.length !== 3) throw new Error(`Expected 3 components in "${op}"`);
  return parts.flatMap(p => {
    const [cx, cy, cz, num, den] = parseComponent(p.trim());
    return [cx, cy, cz, formatFraction(num, den)];
  }).join(' ');
}

function csvField(s) {
  s = String(s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const rows = [['SpaceGroup', 'Lattice', 'Order', 'Generator', 'GeneratorM']];
const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/);
const errors = [];
const seen = new Map();
let groups = 0;
let skipped = 0;
lines.forEach((line, i) => {
  if (!line.trim() || /^(Date|Note):/.test(line)) return;
  const lineNo = i + 1;
  const name = line.trim().split(/\s+/)[0];
  // Alternate-origin entries (e.g. *Pban[.25,.25,0]) are skipped for now.
  if (name.startsWith('*')) {
    skipped++;
    return;
  }
  const lattice = name[0];
  if (!/^[PABCIFR]$/.test(lattice)) {
    errors.push(`Line ${lineNo} (${name}): unknown lattice "${lattice}"`);
    return;
  }
  const rest = line.slice(line.indexOf(name) + name.length);
  const gens = [...rest.matchAll(/(\d+)\s+'([^']*)'/g)];
  if (!gens.length) {
    errors.push(`Line ${lineNo} (${name}): no generators found`);
    return;
  }
  if (rest.replace(/(\d+)\s+'([^']*)'/g, '').trim()) {
    errors.push(`Line ${lineNo} (${name}): unexpected text "${rest.replace(/(\d+)\s+'([^']*)'/g, '').trim()}"`);
    return;
  }
  if (seen.has(name)) {
    console.warn(`Warning: ${name} on line ${lineNo} duplicates line ${seen.get(name)}`);
  } else {
    seen.set(name, lineNo);
  }
  try {
    const parsed = gens.map(([, order, op]) => [name, lattice, order, op, generatorToMatrix(op)]);
    rows.push(...parsed);
    groups++;
  } catch (e) {
    errors.push(`Line ${lineNo} (${name}): ${e.message}`);
  }
});

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} bad line(s); CSV not written.`);
  process.exit(1);
}

fs.writeFileSync(output, rows.map(r => r.map(csvField).join(',')).join('\n') + '\n');
console.log(`Wrote ${rows.length - 1} generator rows (${groups} space groups, ${skipped} starred skipped) to ${path.resolve(output)}`);
