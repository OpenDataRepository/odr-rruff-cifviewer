#!/usr/bin/env node
// Convert the space group generator file (data/SpaceGroupData.txt) into four linked CSVs:
//
//   SpaceGroups.csv    one row per space group (one per line of the .txt)
//                      GroupID, SpaceGroupName, Shift, Lattice, GenCount, OpCount
//   Generators.csv     one row per generator, linked to its group by GroupID
//                      GroupID, GenIndex, Order, Generator, GeneratorM, OrderM
//   SymmetryOps.csv    one row per symmetry operation generated from them (see expandGenerators)
//                      GroupID, OpIndex, Centring, Operator, OperatorM
//                      (Centring: the lattice vector added, "0,0,0" for the generators' own)
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
// starred line and is blank for the default origin. A starred group's generators are written
// for that origin; each is checked against its unstarred twin moved there (see shiftOrigin).
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

const {
  generatorToMatrix, matPow, format3x4, shiftOrigin, parseShiftValue,
  formatOperator, expandGenerators, SYMBOL_RE,
} = require('../symmetry');

function csvField(s) {
  s = String(s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

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
    ops = expandGenerators(parsed, lattice, setting, msg => warnings.push(`Line ${lineNo} (${symbol}): ${msg}`));
  } catch (e) {
    errors.push(`Line ${lineNo} (${symbol}): ${e.message}`);
    return;
  }
  const id = groups.length + 1;
  const twin = star ? name + (setting ? `:${setting}` : '') : '';
  groups.push({ id, lineNo, symbol, twin, origin, lattice, gens: parsed, ops, opCount: ops.length });
  parsed.forEach((g, k) => generators.push([id, k + 1, g.order, g.op, g.matrix, g.orderM]));
  ops.forEach(({ M, centring }, k) => symmetryOps.push([id, k + 1, centring, formatOperator(M), format3x4(M)]));
});

// A starred group must be its unstarred twin moved to the shifted origin. A twin not in the
// .txt yet can't be checked, so it is skipped.
const bySymbol = new Map(groups.filter(g => !g.origin).map(g => [g.symbol, g]));
groups.filter(g => g.origin && bySymbol.has(g.twin)).forEach(g => {
  let p;
  try {
    p = g.origin.split(',').map(parseShiftValue);
    if (p.length !== 3) throw new Error(`Expected 3 shift values in [${g.origin}]`);
  } catch (e) {
    errors.push(`Line ${g.lineNo} (${g.symbol}): ${e.message}`);
    return;
  }
  const own = new Set(g.ops.map(({ M }) => formatOperator(M)));
  const shifted = bySymbol.get(g.twin).ops.map(({ M }) => formatOperator(shiftOrigin(M, p)));
  const missing = shifted.find(op => !own.has(op));
  if (missing || shifted.length !== own.size) {
    errors.push(`Line ${g.lineNo} (${g.symbol}): not ${g.twin} moved to origin [${g.origin}]` +
      (missing ? ` (that would include ${missing})` : ''));
  }
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
  SymmetryOps: [['GroupID', 'OpIndex', 'Centring', 'Operator', 'OperatorM'], ...symmetryOps],
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
