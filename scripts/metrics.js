#!/usr/bin/env node
// One row per AMCSD structure with everything the checks keep working out, for metrics.html:
// the chemistry computed from the AMC file's unit cell (formula, Z, volume, density) next to
// what AMCSD's CIF says, whether the formula is whole numbers and whether its amounts share a
// common divisor, and whether the CIF and the AMC file give the same unit cell atoms.
//
//   node scripts/metrics.js amcDir cifDir [limit] > data/metrics.json
//
// Files are paired the way check_unit_cell.js pairs them (by the "__<id>" in the name).
// Progress and a summary go to stderr.

const fs = require('fs');
const path = require('path');
const { lib, unitCellFromFile, compare } = require('./check_unit_cell');

const U = lib.UnitCell;

// A formula as element -> amount; brackets are dropped, so "(OH)2" counts once per bracket
// as written (AMCSD's _chemical_formula_sum doesn't use them).
function parseFormula(text) {
  const m = new Map();
  for (const [, el, n] of String(text).replace(/[()]/g, ' ').matchAll(/([A-Z][a-z]?)([\d.]*)/g)) {
    m.set(el, (m.get(el) || 0) + (n ? parseFloat(n) : 1));
  }
  return m;
}

const isWhole = n => Math.abs(n - Math.round(n)) < 1e-6;
function gcd(a, b) { return b ? gcd(b, a % b) : a; }

// For a formula whose amounts are all whole numbers, the largest number dividing them all
// (1 when they share none); null when some amount isn't a whole number.
function commonDivisor(amounts) {
  if (!amounts.length || !amounts.every(isWhole)) return null;
  return amounts.map(Math.round).reduce(gcd, 0) || null;
}

// How our formula compares with AMCSD's, element by element:
//  - exact: the same amounts (to AMCSD's 3 decimals);
//  - scaled: the same chemistry times a factor, i.e. a different Z (impliedZ is AMCSD's Z
//    by that factor);
//  - hOnly: everything but H and D (deuterium) in proportion, H or D not;
//  - differs: anything else.
function compareFormulas(ours, cellCounts, Z, amcsd) {
  const A = parseFormula(amcsd);
  const O = parseFormula(ours);
  const elements = [...new Set([...A.keys(), ...O.keys()])];
  if (elements.every(e => Math.abs((A.get(e) || 0) - (O.get(e) || 0)) < 0.0015)) return { match: 'exact', impliedZ: Z };
  const proportional = list => {
    if (!list.length || !list.every(e => A.get(e) > 0 && cellCounts.get(e) > 0)) return null;
    const ratio = cellCounts.get(list[0]) / A.get(list[0]);
    return list.every(e => Math.abs(cellCounts.get(e) / A.get(e) - ratio) < 0.01 * ratio) ? ratio : null;
  };
  const all = [...new Set([...A.keys(), ...cellCounts.keys()])];
  const ratio = proportional(all);
  if (ratio) return { match: 'scaled', impliedZ: Math.round(ratio * 100) / 100 };
  if (proportional(all.filter(e => e !== 'H' && e !== 'D'))) return { match: 'hOnly' };
  return { match: 'differs' };
}

const tag = (text, name) => {
  const m = text.match(new RegExp(`^${name}\\s+(?:'([^']*)'|"([^"]*)"|(\\S+))`, 'm'));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};
const num = s => (s == null ? null : parseFloat(String(s).replace(/\(\d+\)$/, '')));
const round = (v, places) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(places)));

function rowFor(id, amcFile, cifFile) {
  const row = { id, name: path.basename(amcFile).replace(/__\d+\.amc$/i, ''), amc: path.basename(amcFile), cif: path.basename(cifFile) };
  const amcText = fs.readFileSync(amcFile, 'utf8');
  const cifText = fs.readFileSync(cifFile, 'utf8');
  const cellLine = amcText.split(/\r?\n/).find(l => lib.isAmcCellLine(l));
  if (cellLine) row.sg = lib.parseAmcCellLine(cellLine).spaceGroup;

  // AMCSD's own numbers, from its CIF.
  row.amcsdFormula = tag(cifText, '_chemical_formula_sum');
  row.amcsdZ = num(tag(cifText, '_cell_formula_units_Z'));
  row.amcsdVolume = num(tag(cifText, '_cell_volume'));
  row.amcsdDensity = num(tag(cifText, '_exptl_crystal_density_diffrn'));
  if (row.amcsdFormula) {
    row.amcsdDivisor = commonDivisor([...parseFormula(row.amcsdFormula).values()]);
  }

  let fromAmc, fromCif;
  try { fromAmc = unitCellFromFile(amcFile); } catch (e) { row.error = `AMC: ${e.message}`; }
  try { fromCif = unitCellFromFile(cifFile); } catch (e) { row.error = row.error || `CIF: ${e.message}`; }

  if (fromAmc && fromCif) {
    const diff = compare(fromCif, fromAmc);
    row.cifVsAmc = diff ? diff[0] : 'same';
    if (diff) row.cifVsAmcDetail = diff[1];
  }
  if (!fromAmc || !fromAmc.length) return row;

  // Our chemistry, from the AMC file's first dataset (as AMC -> CIF writes it).
  row.datasets = fromAmc.length;
  const { atoms, cell } = fromAmc[0];
  const chem = U.chemistry(atoms, cell);
  const orders = new Map();
  for (const a of atoms) orders.set(a.site, (orders.get(a.site) || 0) + 1);
  row.orders = [...orders.values()].join(',');
  row.atoms = atoms.length;
  row.formula = chem.formula;
  row.Z = chem.Z;
  row.volume = round(chem.volume, 3);
  row.density = chem.density === null ? null : round(chem.density, 3);
  if (chem.unknown.length) row.unknown = chem.unknown.join(' ');
  const amounts = [...parseFormula(chem.formula).values()];
  row.whole = amounts.length > 0 && amounts.every(isWhole);
  row.divisor = commonDivisor(amounts);

  if (row.amcsdVolume != null) row.volumeMatch = Math.abs(row.amcsdVolume - chem.volume) < 0.0015 + 1e-4 * row.amcsdVolume;
  if (row.amcsdDensity != null && row.density != null) row.densityMatch = Math.abs(row.amcsdDensity - chem.density) < 0.0015;
  if (row.amcsdFormula) Object.assign(row, compareFormulas(chem.formula, chem.cellCounts, chem.Z, row.amcsdFormula));
  return row;
}

function main(amcDir, cifDir, limit) {
  const id = name => (name.match(/__(\d+)\.(cif|amc)$/i) || [])[1];
  const cifsById = new Map();
  for (const name of fs.readdirSync(cifDir)) {
    if (id(name)) cifsById.set(id(name), [...(cifsById.get(id(name)) || []), name]);
  }
  const cifFor = amc => {
    const names = cifsById.get(id(amc)) || [];
    return names.find(n => n.replace(/\.cif$/i, '') === amc.replace(/\.amc$/i, ''))
      || names.find(n => !/__original__/i.test(n)) || names[0];
  };
  const amcs = fs.readdirSync(amcDir).filter(n => id(n) && cifFor(n)).slice(0, limit);
  const rows = [];
  amcs.forEach((name, i) => {
    rows.push(rowFor(id(name), path.join(amcDir, name), path.join(cifDir, cifFor(name))));
    if ((i + 1) % 1000 === 0) process.stderr.write(`${i + 1} / ${amcs.length}\n`);
  });
  const out = { generated: new Date().toISOString(), amcDir, cifDir, rows };
  process.stdout.write(JSON.stringify(out));
  process.stderr.write(`${rows.length} structures\n`);
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/metrics.js amcDir cifDir [limit] > data/metrics.json');
  process.exit(1);
}
main(args[0], args[1], args[2] ? Number(args[2]) : undefined);
