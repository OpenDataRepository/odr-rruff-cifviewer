// Every atom in the unit cell from the asymmetric unit: each listed atom is moved by every
// symmetry operation of its space group, taken into the cell ([0, 1) on each axis), and
// copies that land on one already found for that atom are dropped. Shared by the browser
// (CIF and AMC input, as UnitCell) and scripts/check_unit_cell.js (via require).
//
// The operations come from the space group list (SpaceGroupSymmetry.groupOperators, moved to
// the origin p for a starred group), whichever file the atoms were read from, so a CIF and
// the AMC file of the same structure give the same operations in the same order.
const UnitCell = (() => {
// --- When two copies of an atom are the same position ---
// An atom on a special position is written rounded (.3333 for 1/3), so its copies come out
// slightly apart, and some files give one a little off (Zeolite-L's O2 at .1593 .3196 for
// x, 2x). But an atom can also really sit just off a special position, split over several
// copies close together, each partly filled (Brucite's H at .3371 .6742, beside the 3-fold
// axis at 1/3 2/3, with occupancy 1/3). So:
//  - copies within the rounding of the atom's coordinates are always one position;
//  - copies closer than NEAR (in Å) are one position too, unless keeping them apart leaves
//    the site no more than full: the occupancy of every atom listed at those coordinates,
//    times the number of copies that close together, is at most 1.
const NEAR = 0.05;

// The most a coordinate can be off from what it stands for, judging by its decimals: half
// its last decimal place (.3371 -> .00005). The number is all there is to go on (a CIF's
// "0.20000" and an AMC file's ".2" are both 0.2, and must give the same answer), so a value
// with one or two decimals is taken as exact, as are multiples of 1/8 (.125) and fractions
// read from an AMC file ("1/3", which comes out with every decimal).
function roundingError(v) {
  const s = String(Math.abs(v));
  if (s.includes('e')) return 0; // so close to 0 that it is 0
  const places = (s.split('.')[1] || '').length;
  if (places <= 2 || places >= 12 || (places === 3 && Math.abs(v * 8 - Math.round(v * 8)) < 1e-9)) return 0;
  return 0.5 * 10 ** -places;
}

// Whether fractional positions p and q are within tolerance[i] on each axis i, counting
// whole-cell shifts (.99999 and 0 are .00001 apart).
function withinRounding(p, q, tolerance) {
  return p.every((v, i) => { const d = Math.abs(v - q[i]); return Math.min(d, 1 - d) <= tolerance[i] + 1e-9; });
}

// The most two copies of an atom, made by operations with rotation parts R and S, can differ
// from the rounding e of its coordinates alone: (R - S).e on each axis, the rounding being
// at most e on each axis. Copies differing only by a translation must match exactly.
function copyTolerance(R, S, e) {
  return R.map((row, i) => row.reduce((sum, r, k) => sum + Math.abs(r - S[i][k]) * e[k], 0));
}

// Metric tensor G of a cell (angles in degrees): the squared length of a fractional vector
// d is d.G.d.
function metricTensor({ a, b, c, alpha, beta, gamma }) {
  const cos = deg => Math.cos((deg * Math.PI) / 180);
  return [
    [a * a, a * b * cos(gamma), a * c * cos(beta)],
    [a * b * cos(gamma), b * b, b * c * cos(alpha)],
    [a * c * cos(beta), b * c * cos(alpha), c * c],
  ];
}

// Distance (Å) between fractional positions p and q, counting whole-cell shifts.
function cellDistance(G, p, q) {
  const d = p.map((v, i) => { const x = v - q[i]; return x - Math.round(x); });
  return Math.sqrt(d.reduce((sum, di, i) => sum + di * d.reduce((s, dj, j) => s + G[i][j] * dj, 0), 0));
}

// v taken into [0, 1); a value a rounding error short of 1 counts as 0.
function wrap(v) {
  const w = v - Math.floor(v);
  return w > 1 - 1e-9 ? 0 : w;
}

// A symmetry operation (4x4 exact-fraction matrix from symmetry.js) applied to a fractional
// position, as plain numbers.
function applyOperation(M, p) {
  return M.slice(0, 3).map(row => row.slice(0, 3).reduce((s, [n, d], k) => s + (n / d) * p[k], row[3][0] / row[3][1]));
}

// An occupancy as a number, a missing or unreadable one being full.
const occupancy = atom => (Number.isFinite(atom.occ) ? atom.occ : 1);

// --- How many decimals to show ---
// Each coordinate is shown with the decimals it was written with, less any trailing zeros:
// a CIF pads its values ("0.09300") and an AMC file may or may not keep a zero (".0930",
// ".875" and ".8750" both occur), so trailing zeros are the one thing the two files can't
// agree on. A fraction ("1/2", "1/3") gets as many decimals as it needs, five for one that
// repeats (1/3 -> .33333).
function fractionPlaces([num, den]) {
  for (let places = 0; places <= 3; places++) if ((num * 10 ** places) % den === 0) return places;
  return 5;
}

// Decimals a coordinate as written has, trailing zeros dropped: ".9075" 4, "0.09300" 3,
// "0" 0, "1/4" 2, "1/3" 5. A refinement uncertainty ("0.4135(3)") is ignored.
function writtenPlaces(text) {
  const s = String(text).trim().replace(/\(\d+\)$/, '');
  const f = s.match(/^[+-]?(\d+)\/(\d+)$/);
  if (f) return fractionPlaces([Number(f[1]), Number(f[2])]);
  return (s.split('.')[1] || '').replace(/0+$/, '').length;
}

// Decimals to show for a copy's coordinates: on each axis, the most of the atom's own
// coordinates that go into it (both x and y for x-y) and of the operation's translation.
function copyPlaces(M, places) {
  return M.slice(0, 3).map(row => Math.max(
    fractionPlaces(row[3]),
    ...row.slice(0, 3).map(([n], k) => (n ? places[k] : 0)),
  ));
}

// cell: { a, b, c, alpha, beta, gamma } as numbers; ops: the group's operations, identity
// first; atoms: [{ label, x, y, z, occ, places }] as numbers (occ may be undefined; places,
// the decimals each coordinate was written with, may be left out for 5). Returns one entry
// per position in the cell, { label, x, y, z, occ, places, site }, site being the index of
// the atom it came from, in the order of the atoms and then of the operations. Throws when
// an atom has a coordinate that isn't a number.
function expandAtoms(cell, ops, atoms) {
  const G = metricTensor(cell);
  atoms.forEach(atom => {
    const bad = ['x', 'y', 'z'].find(axis => !Number.isFinite(atom[axis]));
    if (bad) throw new Error(`Atom ${atom.label} has no readable ${bad} coordinate.`);
  });
  // Each atom's coordinates, a value that is a multiple of 1/24 as far as its decimals go
  // (.33333, .1667) taken as exactly that. The rounding stays with a snapped value too: one
  // coordinate can snap while a coordinate tied to it doesn't (.458 to 11/24 but .916 not
  // to 22/24, for x, 2x), and the copies then only meet within that rounding.
  const placed = atoms.map(atom => [atom.x, atom.y, atom.z].reduce((acc, v) => {
    const e = roundingError(v), k = Math.round(v * 24);
    const snapped = Math.abs(v - k / 24) <= e + 1e-12;
    acc.pos.push(snapped ? k / 24 : v);
    acc.e.push(e);
    return acc;
  }, { pos: [], e: [] }));
  const rotation = M => M.slice(0, 3).map(row => row.slice(0, 3).map(([n, d]) => n / d));
  return atoms.flatMap((atom, site) => {
    const { pos, e } = placed[site];
    const places = atom.places || [5, 5, 5];
    const copies = []; // [position, rotation part of the operation that made it, decimals]
    for (const M of ops) {
      const p = applyOperation(M, pos).map(wrap), R = rotation(M);
      if (!copies.some(([q, S]) => withinRounding(p, q, copyTolerance(R, S, e)))) copies.push([p, R, copyPlaces(M, places)]);
    }
    // How full the site is: this atom and any other listed at the same coordinates (a site
    // shared by several elements), and the most copies that lie close together.
    const siteOccupancy = atoms
      .filter((other, j) => withinRounding(placed[j].pos, pos, placed[j].e.map((r, k) => r + e[k])))
      .reduce((sum, other) => sum + occupancy(other), 0);
    const positions = copies.map(([p]) => p);
    const cluster = Math.max(...positions.map(p => positions.filter(q => cellDistance(G, p, q) < NEAR).length));
    const split = cluster > 1 && siteOccupancy * cluster <= 1.02;
    const kept = split ? copies : copies.filter(([p], i) => !positions.slice(0, i).some(q => cellDistance(G, p, q) < NEAR));
    return kept.map(([[x, y, z], , copyDecimals]) => ({ label: atom.label, x, y, z, occ: atom.occ, places: copyDecimals, site }));
  });
}

// A coordinate to `places` decimals, wrapped again so one that rounds up to 1 reads 0.
function formatCoordinate(v, places = 5) {
  const s = v.toFixed(places);
  return Number(s) >= 1 ? (0).toFixed(places) : s;
}

// The expanded atoms as a fixed-width table: label, x, y, z (each to its own decimals), occ
// (blank when it isn't a number), the numbers and their headers right-aligned.
function formatTable(expanded) {
  const rows = expanded.map(a => [
    a.label,
    ...[a.x, a.y, a.z].map((v, k) => formatCoordinate(v, a.places ? a.places[k] : 5)),
    Number.isFinite(a.occ) ? String(Number(a.occ.toFixed(5))) : '',
  ]);
  const headers = ['atom', 'x', 'y', 'z', 'occ'];
  const widths = headers.map((h, col) => Math.max(h.length, ...rows.map(r => r[col].length)));
  const line = cells => cells.map((c, col) => (col ? c.padStart(widths[col]) : c.padEnd(widths[col]))).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

// --- Chemistry, Z, volume and density ---

// Standard atomic weights (g/mol); D is deuterium, which AMCSD keeps apart from H.
const ATOMIC_MASS = {
  H: 1.008, D: 2.014, He: 4.0026, Li: 6.94, Be: 9.0122, B: 10.81, C: 12.011, N: 14.007,
  O: 15.999, F: 18.998, Ne: 20.180, Na: 22.990, Mg: 24.305, Al: 26.982, Si: 28.085,
  P: 30.974, S: 32.06, Cl: 35.45, Ar: 39.948, K: 39.098, Ca: 40.078, Sc: 44.956, Ti: 47.867,
  V: 50.942, Cr: 51.996, Mn: 54.938, Fe: 55.845, Co: 58.933, Ni: 58.693, Cu: 63.546,
  Zn: 65.38, Ga: 69.723, Ge: 72.630, As: 74.922, Se: 78.971, Br: 79.904, Kr: 83.798,
  Rb: 85.468, Sr: 87.62, Y: 88.906, Zr: 91.224, Nb: 92.906, Mo: 95.95, Tc: 98, Ru: 101.07,
  Rh: 102.91, Pd: 106.42, Ag: 107.87, Cd: 112.41, In: 114.82, Sn: 118.71, Sb: 121.76,
  Te: 127.60, I: 126.90, Xe: 131.29, Cs: 132.91, Ba: 137.33, La: 138.91, Ce: 140.12,
  Pr: 140.91, Nd: 144.24, Pm: 145, Sm: 150.36, Eu: 151.96, Gd: 157.25, Tb: 158.93,
  Dy: 162.50, Ho: 164.93, Er: 167.26, Tm: 168.93, Yb: 173.05, Lu: 174.97, Hf: 178.49,
  Ta: 180.95, W: 183.84, Re: 186.21, Os: 190.23, Ir: 192.22, Pt: 195.08, Au: 196.97,
  Hg: 200.59, Tl: 204.38, Pb: 207.2, Bi: 208.98, Po: 209, At: 210, Rn: 222, Fr: 223,
  Ra: 226, Ac: 227, Th: 232.04, Pa: 231.04, U: 238.03, Np: 237, Pu: 244, Am: 243, Cm: 247,
};

// Avogadro's number times 1e-24 (cm3 per A3): density = mass (g/mol) / (V (A3) * this).
const AVOGADRO_A3_CM3 = 0.602214076;

// The element an atom label stands for: its leading symbol ("Mg1" Mg, "FeM1" Fe, "OH3" and
// "O-H" O, "KK1" K, "Ti4+M" Ti); null when the label starts with no element symbol.
function elementOf(label) {
  const m = String(label).match(/^([A-Z])([a-z]?)/);
  if (!m) return null;
  if (m[2] && ATOMIC_MASS[m[1] + m[2]]) return m[1] + m[2];
  return ATOMIC_MASS[m[1]] ? m[1] : null;
}

// What one atom with this label adds to the chemistry, as [element, count] pairs. X-ray
// refinements often don't locate H (it has one electron), so AMCSD's labels say where it is:
//  - "Wat" is a whole water molecule, H2O;
//  - "OH" ("OH3", "O-H1", "OHw") is a hydroxyl, O and its H;
//  - "Oh" ("Oh2") is an O whose H is listed in the dataset itself, so just O;
//  - anything else is its element.
function atomsOf(label) {
  if (/^Wat/i.test(label)) return [['O', 1], ['H', 2]];
  if (/^O-?H/.test(label)) return [['O', 1], ['H', 1]];
  const element = elementOf(label);
  return element ? [[element, 1]] : [];
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

// A formula amount the way AMCSD writes it: up to three decimals, no leading zero, and
// nothing for 1 ("Mg.91", "Si1.97", "O6", "Ca").
function formatAmount(n) {
  const s = String(Number(n.toFixed(3)));
  return s === '1' ? '' : s.replace(/^0\./, '.');
}

// The chemistry of a unit cell from its expanded atoms (as expandAtoms gives them) and cell:
//  - cellCounts: each element's atoms in the cell, adding up occupancies (with the H atoms
//    AMCSD counts that weren't located, see atomsOf), in the order the elements first appear
//    in the atom list;
//  - Z: how many formula units the cell holds. Each crystallographic site (one listed atom
//    and all its copies) has an order, its number of positions in the cell; Z is the largest
//    number that divides every order (the smallest order, when the others are multiples of it,
//    as in Diopside's 4, 4, 8, 8, 8, 8 -> 4);
//  - formula: cellCounts / Z, as AMCSD writes _chemical_formula_sum ("Mg.91 Fe.1 ... O6"),
//    leaving out trace elements that round to 0;
//  - volume (A3): the square root of the metric tensor's determinant;
//  - density (g/cm3): the cell's mass over its volume.
// Labels with no element (`unknown`) are left out of the formula, and then no density is
// given (it would be too low).
function chemistry(expanded, cell) {
  const cellCounts = new Map();
  const unknown = new Set();
  const orders = new Map();
  for (const atom of expanded) {
    orders.set(atom.site, (orders.get(atom.site) || 0) + 1);
    const parts = atomsOf(atom.label);
    if (!parts.length) { unknown.add(atom.label); continue; }
    const occ = Number.isFinite(atom.occ) ? atom.occ : 1;
    for (const [element, count] of parts) cellCounts.set(element, (cellCounts.get(element) || 0) + count * occ);
  }
  const Z = [...orders.values()].reduce(gcd, 0) || 1;
  const formula = [...cellCounts].filter(([, n]) => formatAmount(n / Z) !== '0').map(([el, n]) => el + formatAmount(n / Z)).join(' ');
  const G = metricTensor(cell);
  const [[a, b, c], [d, e, f], [g, h, i]] = G;
  const volume = Math.sqrt(a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g));
  const mass = [...cellCounts].reduce((sum, [el, n]) => sum + ATOMIC_MASS[el] * n, 0);
  const density = unknown.size ? null : mass / (volume * AVOGADRO_A3_CM3);
  return { cellCounts, Z, formula, volume, density, unknown: [...unknown] };
}

// The chemistry as CIF lines, in the order AMCSD writes them, with Z under the formula:
// [formula and Z lines, volume and density lines] - the first pair goes before the cell
// lengths, the second after the cell angles.
function chemistryCifLines(chem) {
  const top = [`_chemical_formula_sum '${chem.formula}'`, `_cell_formula_units_Z ${chem.Z}`];
  const bottom = [`_cell_volume ${chem.volume.toFixed(3)}`];
  if (chem.density !== null) bottom.push(`_exptl_crystal_density_diffrn ${chem.density.toFixed(3)}`);
  return [top, bottom];
}

return { NEAR, ATOMIC_MASS, chemistryCifLines, roundingError, writtenPlaces, expandAtoms, formatCoordinate, formatTable, elementOf, atomsOf, chemistry };
})();

if (typeof module !== 'undefined') module.exports = UnitCell;
