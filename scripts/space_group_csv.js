#!/usr/bin/env node
// Convert the space group generator file (data/SpaceGroupData.txt) into three linked CSVs:
//
//   SpaceGroups.csv    one row per space group (one per line of the .txt)
//                      GroupID, SpaceGroupName, Shift, Lattice, GenCount
//   Generators.csv     one row per generator, linked to its group by GroupID
//                      GroupID, GenIndex, Order, Generator, GeneratorM, OrderM
//   SpaceGroupData.csv the two joined for reading: one row per space group with its
//                      generators side by side (Gen1Order, Gen1, Gen1M, ... Gen3M)
//
// plus SpaceGroupData.xlsx, the same three tables as sheets, for opening in Excel. (Excel reads
// CSV cells starting with "-" such as "-x,y,z" as formulas and shows #NAME?; the .xlsx stores
// them as text.)
//
// GroupID numbers the groups in .txt order, so the generators of one group stay together
// however the rows are sorted or filtered. SpaceGroupName is the name exactly as written in the
// .txt (e.g. "*P2_1:2[0,0,.25]"); Shift repeats its alternate-origin shift ("0,0,.25") for a
// starred line and is blank for the default origin.
// GeneratorM is the 3x4 augmented matrix written row by row (r11 r12 r13 t1 r21 ... t3),
// 12 space-separated values. Translations stay as exact fractions (1/3 has no exact decimal).
// OrderM is the generator applied Order times (g^Order), in the same 3x4 form. It should be the
// identity up to a lattice translation (an integer or centering vector).
//
// Internally each operator is a 4x4 matrix: the 3x4 plus a bottom row 0 0 0 1, so applying one
// operator after another is a plain matrix product ((R|t)(R|t) = (R*R | R*t + t)). The bottom
// row is dropped whenever a matrix is written out.
//
// Usage: node scripts/space_group_csv.js [input.txt] [output-dir]
//   Defaults: data/SpaceGroupData.txt -> data/
//
// To add or fix space groups, edit the .txt (one group per line, same format:
// name, then "order 'x,y,z'" pairs) and rerun. Bad lines are reported with their line number.
// GroupIDs follow line order, so add new groups at the end to keep existing IDs unchanged.

const fs = require('fs');
const path = require('path');
const { writeXlsx } = require('./xlsx');

const DEFAULT_INPUT = path.join(__dirname, '..', 'data', 'SpaceGroupData.txt');
const [input = DEFAULT_INPUT, outputArg] = process.argv.slice(2);
const outDir = outputArg || path.dirname(input);
const MAX_GENS = 3;

// Setting suffixes used in the .txt (see its header notes); only checked, not written out.
const SETTINGS = { 1: 'mono-c', 2: 'mono-b', 3: 'mono-a', 4: 'hexagonal', 5: 'rhombohedral' };

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

// Exact fractions as [num, den], den > 0, in lowest terms.
function frac(num, den = 1) {
  const g = gcd(num, den) || 1;
  return den < 0 ? [-num / g, -den / g] : [num / g, den / g];
}
const fadd = ([a, b], [c, d]) => frac(a * d + c * b, b * d);
const fmul = ([a, b], [c, d]) => frac(a * c, b * d);

function formatFraction([num, den]) {
  if (num === 0) return '0';
  return den === 1 ? String(num) : `${num}/${den}`;
}

// Operator string such as "1/2-x,-y,1/2+z" -> 4x4 matrix of fractions (bottom row 0 0 0 1).
function generatorToMatrix(op) {
  const parts = op.split(',');
  if (parts.length !== 3) throw new Error(`Expected 3 components in "${op}"`);
  const rows = parts.map(p => {
    const [cx, cy, cz, num, den] = parseComponent(p.trim());
    return [frac(cx), frac(cy), frac(cz), frac(num, den)];
  });
  return [...rows, [frac(0), frac(0), frac(0), frac(1)]];
}

function matMul(A, B) {
  return A.map(row => B[0].map((_, j) => row.reduce((sum, a, k) => fadd(sum, fmul(a, B[k][j])), frac(0))));
}

function matPow(M, n) {
  let R = M;
  for (let i = 1; i < n; i++) R = matMul(R, M);
  return R;
}

// 4x4 -> the stored 3x4 form: bottom row dropped, written row by row.
function format3x4(M) {
  return M.slice(0, 3).flat().map(formatFraction).join(' ');
}

function csvField(s) {
  s = String(s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Split a .txt symbol such as "*P2_1:2[0,0,.25]" into its name, setting and origin parts.
const SYMBOL_RE = /^(\*?)([^:\[\]]+)(?::(\d))?(?:\[([^\]]*)\])?$/;

const groups = [];
const generators = [];
const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/);
const errors = [];
const seen = new Map();
lines.forEach((line, i) => {
  if (!line.trim() || /^(Date|Note):/.test(line)) return;
  const lineNo = i + 1;
  const symbol = line.trim().split(/\s+/)[0];
  const parts = symbol.match(SYMBOL_RE);
  if (!parts) {
    errors.push(`Line ${lineNo} (${symbol}): could not split into name, setting and origin`);
    return;
  }
  const [, star, name, setting = '', origin = ''] = parts;
  if (star && !origin) {
    errors.push(`Line ${lineNo} (${symbol}): starred entry has no [origin] shift`);
    return;
  }
  if (setting && !(setting in SETTINGS)) {
    errors.push(`Line ${lineNo} (${symbol}): unknown setting ":${setting}"`);
    return;
  }
  const lattice = name[0];
  if (!/^[PABCIFR]$/.test(lattice)) {
    errors.push(`Line ${lineNo} (${symbol}): unknown lattice "${lattice}"`);
    return;
  }
  if (seen.has(symbol)) {
    errors.push(`Line ${lineNo} (${symbol}): duplicates line ${seen.get(symbol)}`);
    return;
  }
  seen.set(symbol, lineNo);
  const rest = line.slice(line.indexOf(symbol) + symbol.length);
  const gens = [...rest.matchAll(/(\d+)\s+'([^']*)'/g)];
  if (!gens.length) {
    errors.push(`Line ${lineNo} (${symbol}): no generators found`);
    return;
  }
  if (gens.length > MAX_GENS) {
    errors.push(`Line ${lineNo} (${symbol}): ${gens.length} generators, at most ${MAX_GENS} expected`);
    return;
  }
  if (rest.replace(/(\d+)\s+'([^']*)'/g, '').trim()) {
    errors.push(`Line ${lineNo} (${symbol}): unexpected text "${rest.replace(/(\d+)\s+'([^']*)'/g, '').trim()}"`);
    return;
  }
  let parsed;
  try {
    parsed = gens.map(([, order, op]) => {
      const M = generatorToMatrix(op);
      const orderM = format3x4(matPow(M, Number(order)));
      return { order: Number(order), op, matrix: format3x4(M), orderM };
    });
  } catch (e) {
    errors.push(`Line ${lineNo} (${symbol}): ${e.message}`);
    return;
  }
  const id = groups.length + 1;
  groups.push({ id, symbol, origin, lattice, gens: parsed });
  parsed.forEach((g, k) => generators.push([id, k + 1, g.order, g.op, g.matrix, g.orderM]));
});

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} bad line(s); nothing written.`);
  process.exit(1);
}

function writeCsv(file, rows) {
  const out = path.join(outDir, file);
  fs.writeFileSync(out, rows.map(r => r.map(csvField).join(',')).join('\n') + '\n');
  return path.resolve(out);
}

const groupCols = ['GroupID', 'SpaceGroupName', 'Shift', 'Lattice', 'GenCount'];
const groupRow = g => [g.id, g.symbol, g.origin, g.lattice, g.gens.length];
const genCols = Array.from({ length: MAX_GENS }, (_, k) =>
  [`Gen${k + 1}Order`, `Gen${k + 1}`, `Gen${k + 1}M`]).flat();

const tables = {
  SpaceGroupData: [
    [...groupCols, ...genCols],
    ...groups.map(g => [
      ...groupRow(g),
      ...Array.from({ length: MAX_GENS }, (_, k) => g.gens[k] ? [g.gens[k].order, g.gens[k].op, g.gens[k].matrix] : ['', '', '']).flat(),
    ]),
  ],
  SpaceGroups: [groupCols, ...groups.map(groupRow)],
  Generators: [['GroupID', 'GenIndex', 'Order', 'Generator', 'GeneratorM', 'OrderM'], ...generators],
};

const written = Object.entries(tables).map(([name, rows]) => writeCsv(`${name}.csv`, rows));
const xlsxFile = path.join(outDir, 'SpaceGroupData.xlsx');
try {
  writeXlsx(xlsxFile, Object.entries(tables).map(([name, rows]) => ({ name, rows })));
} catch (e) {
  if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
  console.error(`CSVs written, but ${path.resolve(xlsxFile)} is locked (open in Excel?). Close it and rerun.`);
  process.exit(1);
}
written.push(path.resolve(xlsxFile));
const starred = groups.filter(g => g.origin).length;
console.log(`${groups.length} space groups (${starred} alternate origins), ${generators.length} generators. Wrote:\n  ${written.join('\n  ')}`);
