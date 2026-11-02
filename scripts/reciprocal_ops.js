#!/usr/bin/env node
// Compute each space group's reciprocal space symmetry operations, which act on the indices
// (h,k,l) of lattice planes instead of on points x,y,z.
//
// A direct space operation x' = Rx + t maps the plane hx+ky+lz=n onto a plane with indices
// R^-t (h,k,l), the inverse-transpose of its 3x3 part; the translation t only changes n. Every
// operation's inverse is in the group too, so the set of inverse-transposes is the same as the
// set of plain transposes, and each R is just transposed (M^t(i,j) = M(j,i)). The k-th
// reciprocal matrix is therefore the partner of the inverse of the k-th direct one, not of the
// k-th itself; that doesn't matter for generating equivalent hkl.
//
// Operations that differ only by a translation (the centring copies of C, I, F..., or a screw axis
// and its rotation) have the same 3x3 part, so they give one reciprocal matrix. No lattice
// conditions (systematic absences of P, I, F, A, B, C) are applied.
//
// Writes data/ReciprocalSymmetryOps.csv, one row per space group, with one operation per line
// in each multi-line cell (quoted, so the CSV stays valid):
//   GroupID, SpaceGroupName,
//   SymmetryOphkls           each operation in h,k,l form, e.g. "k,-h-k,l"
//   ReciprocalSymmetryOpMs   each transposed 3x3, one row of 3 integers after another with a tab
//                            between rows (each padded so the tabs line up), as in GeneratorMs
//
// Usage: node scripts/reciprocal_ops.js [data-dir]
//   Default: data/ (reads SymmetryOps.csv and SpaceGroups.csv, written by space_group_csv.js).

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

function csvField(s) {
  s = String(s);
  return /[",\n\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// "r11 r12 r13 t1 r21 ... t3" -> 3x3 rotation part as integers.
function rotationPart(operatorM, where) {
  const v = operatorM.split(' ');
  if (v.length !== 12) throw new Error(`${where}: expected 12 values, got "${operatorM}"`);
  return [0, 4, 8].map(k => v.slice(k, k + 3).map(s => {
    if (!/^-?\d+$/.test(s)) throw new Error(`${where}: non-integer rotation entry "${s}"`);
    return Number(s);
  }));
}

const transpose = R => R[0].map((_, j) => R.map(row => row[j]));

// 3x3 -> "k,-h-k,l" style, one component per row (h' = row 1 . (h,k,l), ...).
const formatHkl = M => M.map(row => {
  let s = '';
  row.forEach((c, k) => {
    if (!c) return;
    const coef = Math.abs(c) === 1 ? '' : String(Math.abs(c));
    s += (c < 0 ? '-' : s ? '+' : '') + coef + 'hkl'[k];
  });
  return s || '0';
}).join(',');

// Same layout as the GeneratorMs field: each row padded to 15 characters, a tab between rows,
// e.g. "0 1 0          <tab>-1 -1 0        <tab>0 0 1".
const matrixRows = M => M.map(row => row.join(' ')).map((row, k) => (k < 2 ? row.padEnd(15) : row)).join('\t');

const names = new Map(readCsv('SpaceGroups.csv').map(g => [g.GroupID, g.SpaceGroupName]));
const byGroup = new Map();
for (const op of readCsv('SymmetryOps.csv')) {
  const where = `GroupID ${op.GroupID} op ${op.OpIndex}`;
  const Mt = transpose(rotationPart(op.OperatorM, where));
  const key = Mt.flat().join(' ');
  if (!byGroup.has(op.GroupID)) byGroup.set(op.GroupID, new Map());
  const ops = byGroup.get(op.GroupID);
  if (!ops.has(key)) ops.set(key, Mt);
}

const rows = [['GroupID', 'SpaceGroupName', 'SymmetryOphkls', 'ReciprocalSymmetryOpMs']];
let opCount = 0;
for (const [id, ops] of byGroup) {
  const Ms = [...ops.values()];
  opCount += Ms.length;
  rows.push([id, names.get(id) || '', Ms.map(formatHkl).join('\n'), Ms.map(matrixRows).join('\n')]);
}
const out = path.join(dataDir, 'ReciprocalSymmetryOps.csv');
fs.writeFileSync(out, rows.map(r => r.map(csvField).join(',')).join('\n') + '\n');
console.log(`${byGroup.size} space groups, ${opCount} reciprocal operations. Wrote ${path.resolve(out)}`);
