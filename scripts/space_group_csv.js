#!/usr/bin/env node
// Convert the space group generator file (data/SpaceGroupData.txt) into four linked CSVs:
//
//   SpaceGroups.csv    one row per space group (one per line of the .txt)
//                      GroupID, SpaceGroupName, Shift, Lattice, GenCount, OpCount
//   Generators.csv     one row per generator, linked to its group by GroupID
//                      GroupID, GenIndex, Order, Generator, GeneratorM, OrderM
//   SymmetryOps.csv    one row per symmetry operation generated from them (see expandGenerators);
//                      starred alternate-origin groups are skipped for now
//                      GroupID, OpIndex, Operator, OperatorM
//   SpaceGroupData.csv the two joined for reading: one row per space group with its
//                      generators side by side (Gen1Order, Gen1, Gen1M, ... Gen3M)
//
// plus SpaceGroupData.xlsx, the same four tables as sheets, for opening in Excel. (Excel reads
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

const IDENTITY = generatorToMatrix('x,y,z');

// Translation component taken into [0, 1) exactly, e.g. -1/4 -> 3/4, 1 -> 0.
const fmod1 = ([n, d]) => frac(((n % d) + d) % d, d);

// The same operator with its translations moved back into the unit cell.
function reduceToCell(M) {
  return M.map((row, i) => (i < 3 ? [...row.slice(0, 3), fmod1(row[3])] : row));
}

// Rotation part only, as a key: operators that differ just by a translation share it.
const rotationKey = M => M.slice(0, 3).map(row => row.slice(0, 3).map(formatFraction).join(' ')).join(' ');

// 4x4 matrix -> operator string in the .txt style, e.g. "1/2-x,y,-z" or "x-y,-y,1/2+z".
function formatOperator(M) {
  return M.slice(0, 3).map(row => {
    let s = row[3][0] ? formatFraction(row[3]) : '';
    row.slice(0, 3).forEach(([c], k) => {
      if (!c) return;
      const coef = Math.abs(c) === 1 ? '' : String(Math.abs(c));
      s += (c < 0 ? '-' : s ? '+' : '') + coef + 'xyz'[k];
    });
    return s || '0';
  }).join(',');
}

// Centring translations of each lattice letter (besides 0,0,0). R is centred only in the
// hexagonal setting (:4); in the rhombohedral setting (:5) its cell is primitive.
const CENTRING = {
  P: [], A: [[0, 1, 1]], B: [[1, 0, 1]], C: [[1, 1, 0]], I: [[1, 1, 1]],
  F: [[0, 1, 1], [1, 0, 1], [1, 1, 0]],
}; // in halves
const R_HEX_CENTRING = [[[2, 3], [1, 3], [1, 3]], [[1, 3], [2, 3], [2, 3]]];
function centringVectors(lattice, setting) {
  if (lattice === 'R') return setting === '5' ? [] : R_HEX_CENTRING;
  return CENTRING[lattice].map(v => v.map(h => frac(h, 2)));
}

// All symmetry operations of a group from its generators, as in the Fortran
// Get_all_symmetry_matrices_from_generators: the identity first, then every product
// g3^i g2^j g1^k (i, j, k = 1..order) with translations moved into the cell. One operation is
// kept per rotation part, so centring translations are left out (they come from the lattice
// letter). The generators should give each rotation exactly once up to a centring translation,
// so the count must equal the product of the orders; anything else is reported as an error.
// A repeated rotation whose translation differs by a non-centring vector is passed to warn(), once per group.
function expandGenerators(gens, lattice, setting, warn) {
  const [g1, g2, g3] = [0, 1, 2].map(k => gens[k] || { order: 1, M: IDENTITY });
  const expected = g1.order * g2.order * g3.order;
  const centring = centringVectors(lattice, setting).map(v => v.map(formatFraction).join(' '));
  const ops = new Map([[rotationKey(IDENTITY), IDENTITY]]);
  let warned = false; // report only the first clash per group
  let p3 = IDENTITY;
  for (let i = 1; i <= g3.order; i++) {
    p3 = matMul(g3.M, p3);
    let p2 = IDENTITY;
    for (let j = 1; j <= g2.order; j++) {
      p2 = matMul(g2.M, p2);
      let p1 = IDENTITY;
      for (let k = 1; k <= g1.order; k++) {
        p1 = matMul(g1.M, p1);
        const op = reduceToCell(matMul(matMul(p3, p2), p1));
        const key = rotationKey(op);
        const prev = ops.get(key);
        if (!prev) {
          ops.set(key, op);
          continue;
        }
        // Same rotation again: the translations may only differ by a centring vector.
        const diff = [0, 1, 2].map(r => formatFraction(fmod1(fadd(op[r][3], [-prev[r][3][0], prev[r][3][1]])))).join(' ');
        if (diff !== '0 0 0' && !centring.includes(diff) && !warned) {
          warned = true;
          warn(`${formatOperator(op)} and ${formatOperator(prev)} differ by ${diff}, not a ${lattice}-lattice translation`);
        }
      }
    }
  }
  if (ops.size !== expected) {
    throw new Error(`generators give ${ops.size} operations, but their orders multiply to ${expected}`);
  }
  return [...ops.values()];
}

function csvField(s) {
  s = String(s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Split a .txt symbol such as "*P2_1:2[0,0,.25]" into its name, setting and origin parts.
const SYMBOL_RE = /^(\*?)([^:\[\]]+)(?::(\d))?(?:\[([^\]]*)\])?$/;

const groups = [];
const generators = [];
const symmetryOps = [];
const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/);
const errors = [];
const warnings = [];
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
  let parsed, ops = [];
  try {
    parsed = gens.map(([, order, op]) => {
      const M = generatorToMatrix(op);
      const orderM = format3x4(matPow(M, Number(order)));
      return { order: Number(order), op, M, matrix: format3x4(M), orderM };
    });
    // Starred (alternate-origin) groups aren't expanded for now; OpCount stays blank for them.
    if (!star) ops = expandGenerators(parsed, lattice, setting, msg => warnings.push(`Line ${lineNo} (${symbol}): ${msg}`));
  } catch (e) {
    errors.push(`Line ${lineNo} (${symbol}): ${e.message}`);
    return;
  }
  const id = groups.length + 1;
  groups.push({ id, symbol, origin, lattice, gens: parsed, opCount: star ? '' : ops.length });
  parsed.forEach((g, k) => generators.push([id, k + 1, g.order, g.op, g.matrix, g.orderM]));
  ops.forEach((M, k) => symmetryOps.push([id, k + 1, formatOperator(M), format3x4(M)]));
});

if (warnings.length) {
  console.warn(`Warning: ${warnings.length} group(s) whose generators imply a centring their lattice letter lacks:\n${warnings.join('\n')}\n`);
}

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

const groupCols = ['GroupID', 'SpaceGroupName', 'Shift', 'Lattice', 'GenCount', 'OpCount'];
const groupRow = g => [g.id, g.symbol, g.origin, g.lattice, g.gens.length, g.opCount];
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
  SymmetryOps: [['GroupID', 'OpIndex', 'Operator', 'OperatorM'], ...symmetryOps],
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
console.log(`${groups.length} space groups (${starred} alternate origins), ${generators.length} generators, ${symmetryOps.length} symmetry operations. Wrote:\n  ${written.join('\n  ')}`);
