#!/usr/bin/env node
// Every atom in the unit cell, from a CIF or an AMC file (unitCellFromCif / unitCellFromAmc,
// with unitcell.js), and a check that the CIF and the AMC file of the same structure give
// the same atoms.
//
//   node scripts/check_unit_cell.js file.cif            print the unit cell's atoms
//   node scripts/check_unit_cell.js file.amc
//   node scripts/check_unit_cell.js file.cif file.amc   compare the two
//   node scripts/check_unit_cell.js amcDir cifDir [limit] > mismatches.tsv
//
// With two folders, each AMC file is paired with the CIF whose name ends in the same
// "__<id>" (as AMCSD downloads are named), and every pair that differs is printed as one
// tab-separated line: id, what differs, details. A summary goes to stderr.
// Two positions count as the same when every coordinate is within COORD_TOLERANCE, allowing
// for the precision lost writing a CIF value into an AMC file.

const fs = require('fs');
const path = require('path');

const COORD_TOLERANCE = 0.002;

// The browser scripts declare globals; load them into one function scope with the DOM
// stubbed out, as the page would.
const ROOT = path.join(__dirname, '..');
const stub = `
var document = { getElementById: () => ({ addEventListener(){}, value:'', textContent:'', style:{} }) };
var window = { location: { search: '' }, addEventListener(){} };
var navigator = { clipboard: { writeText: () => Promise.resolve() } };
`;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const lib = new Function(`${stub}
${read('spacegroups.js')}
${read('symmetry.js')}
${read('spacegroupdata.js')}
${read('unitcell.js')}
${read('app.js').replace(/^function setupDropZone[\s\S]*?^}\r?\n/m, 'function setupDropZone() {}\n')}
${read('amc2cif.js')}
return { parseCIF, unitCellFromCif, unitCellFromAmc, isAmcCellLine, parseAmcCellLine, UnitCell };`)();

function unitCellFromFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return /\.cif$/i.test(file) ? lib.unitCellFromCif(lib.parseCIF(text)) : lib.unitCellFromAmc(text);
}

const sameCoord = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d) < COORD_TOLERANCE; };

// What differs between two unit cells (as unitCell* return them), or null when nothing does.
function compare(fromCif, fromAmc) {
  if (fromCif.length !== fromAmc.length) return ['datasetCount', `${fromCif.length} vs ${fromAmc.length}`];
  for (let i = 0; i < fromCif.length; i++) {
    const [c, a] = [fromCif[i].atoms, fromAmc[i].atoms];
    const where = fromCif.length > 1 ? `dataset ${i + 1}: ` : '';
    if (c.length !== a.length) {
      // Which source atoms have a different number of positions.
      const count = atoms => atoms.reduce((m, x) => m.set(x.site, (m.get(x.site) || 0) + 1), new Map());
      const [cc, ac] = [count(c), count(a)];
      const sites = [...new Set([...cc.keys(), ...ac.keys()])].filter(s => cc.get(s) !== ac.get(s));
      const label = s => (c.find(x => x.site === s) || a.find(x => x.site === s)).label;
      return ['atomCount', `${where}${c.length} vs ${a.length}; ${sites.slice(0, 5).map(s => `${label(s)} ${cc.get(s) || 0} vs ${ac.get(s) || 0}`).join(', ')}`];
    }
    const k = c.findIndex((x, k) => !['x', 'y', 'z'].every(ax => sameCoord(x[ax], a[k][ax])));
    if (k !== -1) {
      const fmt = x => ['x', 'y', 'z'].map(ax => lib.UnitCell.formatCoordinate(x[ax])).join(' ');
      return ['position', `${where}${c[k].label}: ${fmt(c[k])} vs ${fmt(a[k])}`];
    }
  }
  for (let i = 0; i < fromCif.length; i++) {
    const occ = x => (Number.isFinite(x.occ) ? x.occ : 1);
    const k = fromCif[i].atoms.findIndex((x, k) => Math.abs(occ(x) - occ(fromAmc[i].atoms[k])) > 0.001);
    if (k !== -1) return ['occupancy', `${fromCif[i].atoms[k].label}: ${fromCif[i].atoms[k].occ} vs ${fromAmc[i].atoms[k].occ}`];
  }
  // Same positions, but not to the last printed digit (one file wrote a value with more
  // decimals than the other).
  for (let i = 0; i < fromCif.length; i++) {
    const fmt = x => ['x', 'y', 'z'].map(ax => lib.UnitCell.formatCoordinate(x[ax])).join(' ');
    const k = fromCif[i].atoms.findIndex((x, k) => fmt(x) !== fmt(fromAmc[i].atoms[k]));
    if (k !== -1) return ['lastDigit', `${fromCif[i].atoms[k].label}: ${fmt(fromCif[i].atoms[k])} vs ${fmt(fromAmc[i].atoms[k])}`];
  }
  // Same atoms, but the tables don't print the same (a value written with more decimals in
  // one file than the other).
  for (let i = 0; i < fromCif.length; i++) {
    const [a, b] = [fromCif[i], fromAmc[i]].map(d => lib.UnitCell.formatTable(d.atoms.map(x => ({ ...x, label: '-' })))
      .split('\n').slice(1).map(l => l.trim().split(/\s+/).join(' ')));
    const k = a.findIndex((l, k) => l !== b[k]);
    if (k !== -1) return ['printed', `${fromCif[i].atoms[k].label}: "${a[k]}" vs "${b[k]}"`];
  }
  // Same positions, but the two files write some labels differently ("O-H3" vs "OH3").
  for (let i = 0; i < fromCif.length; i++) {
    const k = fromCif[i].atoms.findIndex((x, k) => x.label !== fromAmc[i].atoms[k].label);
    if (k !== -1) return ['labelOnly', `${fromCif[i].atoms[k].label} vs ${fromAmc[i].atoms[k].label}`];
  }
  return null;
}

function printUnitCell(file) {
  unitCellFromFile(file).forEach(({ atoms }, i, all) => {
    if (all.length > 1) console.log(`Dataset ${i + 1}`);
    console.log(lib.UnitCell.formatTable(atoms));
    console.log(`${atoms.length} atoms\n`);
  });
}

function comparePair(cifFile, amcFile) {
  const diff = compare(unitCellFromFile(cifFile), unitCellFromFile(amcFile));
  console.log(diff ? `${diff[0]}: ${diff[1]}` : 'Same atoms from both files.');
}

function compareFolders(amcDir, cifDir, limit) {
  const id = name => (name.match(/__(\d+)\.(cif|amc)$/i) || [])[1];
  const cifsById = new Map();
  for (const name of fs.readdirSync(cifDir)) {
    if (id(name)) cifsById.set(id(name), [...(cifsById.get(id(name)) || []), name]);
  }
  // Some ids have more than one file ("CaCoP2O7__0012303" and "Ca Co O7 P2__0012303"):
  // the CIF named like the AMC file, else AMCSD's own rather than the authors'
  // "__original__" one.
  const cifFor = amc => {
    const names = cifsById.get(id(amc)) || [];
    return names.find(n => n.replace(/\.cif$/i, '') === amc.replace(/\.amc$/i, ''))
      || names.find(n => !/__original__/i.test(n)) || names[0];
  };
  const counts = { compared: 0, same: 0 };
  const tally = key => { counts[key] = (counts[key] || 0) + 1; };
  const amcs = fs.readdirSync(amcDir).filter(n => id(n) && cifFor(n)).slice(0, limit);
  console.log(['id', 'difference', 'details'].join('\t'));
  for (const name of amcs) {
    counts.compared++;
    let fromAmc, fromCif;
    try { fromAmc = unitCellFromFile(path.join(amcDir, name)); } catch (e) { tally('amcError'); console.log([id(name), 'amcError', e.message].join('\t')); continue; }
    try { fromCif = unitCellFromFile(path.join(cifDir, cifFor(name))); } catch (e) { tally('cifError'); console.log([id(name), 'cifError', e.message].join('\t')); continue; }
    const diff = compare(fromCif, fromAmc);
    if (!diff) { counts.same++; continue; }
    tally(diff[0]);
    console.log([id(name), ...diff].join('\t'));
  }
  console.error(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('\n'));
}

// scripts/metrics.js reuses the loaded scripts and the comparison.
module.exports = { lib, unitCellFromFile, compare };
if (require.main !== module) return;

const args = process.argv.slice(2);
if (args.length === 1) printUnitCell(args[0]);
else if (args.length >= 2 && fs.statSync(args[0]).isDirectory()) compareFolders(args[0], args[1], args[2] ? Number(args[2]) : undefined);
else if (args.length === 2) comparePair(...(/\.cif$/i.test(args[0]) ? args : [args[1], args[0]]));
else console.error('Usage: node scripts/check_unit_cell.js file.cif|file.amc [other] | amcDir cifDir [limit]');
