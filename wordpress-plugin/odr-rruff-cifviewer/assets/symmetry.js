// Space-group symmetry operators as exact 4x4 matrices: parsing "x,y,z"-style operators,
// expanding a group's generators (plus its lattice centring) into every operation, and moving
// operations to a shifted origin. Shared by the browser (AMC -> CIF, as SpaceGroupSymmetry) and
// scripts/space_group_csv.js (via require), so both build operations the same way.
//
// Fractions are [num, den] pairs, so translations such as 1/3 stay exact. Each operator is a
// 4x4 matrix: the 3x3 rotation and translation column plus a bottom row 0 0 0 1, so applying
// one operator after another is a plain matrix product ((R|t)(R|t) = (R*R | R*t + t)).
const SpaceGroupSymmetry = (() => {
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

// The same operator written for an origin moved to p (in the old coordinates), as in Bob
// Downs' "Transformations of Space Groups": {M|t} -> {M | t + Mp - p}.
function shiftOrigin(M, p) {
  return reduceToCell(M.map((row, i) => (i < 3
    ? [...row.slice(0, 3), [0, 1, 2].reduce((t, k) => fadd(t, fmul(row[k], p[k])), fadd(row[3], [-p[i][0], p[i][1]]))]
    : row)));
}

// One value of a starred line's shift, e.g. ".25", "-.125" or "-1/12", as an exact fraction.
function parseShiftValue(s) {
  const m = s.trim().match(/^([+-]?)(?:(\d+)\/(\d+)|(\d*)\.?(\d*))$/);
  if (!m || !(m[2] || m[4] || m[5])) throw new Error(`Could not read shift value "${s}"`);
  const sign = m[1] === '-' ? -1 : 1;
  if (m[2]) return frac(sign * Number(m[2]), Number(m[3]));
  const den = 10 ** m[5].length;
  return frac(sign * Number((m[4] || '0') + m[5]), den);
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
// kept per rotation part. The generators should give each rotation exactly once up to a
// centring translation, so that count must equal the product of the orders; anything else is
// reported as an error. A repeated rotation whose translation differs by a non-centring vector
// is passed to warn(), once per group.
// The lattice letter's centring vectors are then added to every operation, so the result has
// 2x the operations for A, B, C and I, 4x for F and 3x for R (hexagonal setting). Each comes
// back as { M, centring }, centring being the vector added ("0,0,0" for the generators' own).
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
  // Then the whole set again for each centring vector, added to the translation column.
  const base = [...ops.values()];
  return [[frac(0), frac(0), frac(0)], ...centringVectors(lattice, setting)].flatMap(v => base.map(M => ({
    M: reduceToCell(M.map((row, r) => (r < 3 ? [...row.slice(0, 3), fadd(row[3], v[r])] : row))),
    centring: v.map(formatFraction).join(','),
  })));
}

// Split a .txt symbol such as "*P2_1:2[0,0,.25]" into its star, name, setting and origin parts.
const SYMBOL_RE = /^(\*?)([^:\[\]]+)(?::(\d))?(?:\[([^\]]*)\])?$/;

// --- Looking groups up in the generator list ---
// `table` maps each .txt symbol to its generators as [order, operator] pairs, as in
// spacegroupdata.js. Only unstarred groups are looked up: a starred group is always built as
// its unstarred (base) group moved to the origin p, {M|t} -> {M | t + Mp - p}.

// Origin shifts and operator translations are multiples of 1/24 (halves, thirds, quarters,
// sixths, eighths, twelfths), which also lets a rounded decimal such as .333333 count as 1/3.
const STEPS = 24;

// ".25", "-.333333", "0.5" or "2/3" as an exact multiple of 1/24, or null.
function parseTwentyFourths(s) {
  const [n, d = '1'] = String(s).split('/');
  const steps = (Number(n) / Number(d)) * STEPS;
  const k = Math.round(steps);
  return Number.isFinite(steps) && Math.abs(steps - k) < 0.01 ? frac(k, STEPS) : null;
}

// An origin shift written as three values (".25 -.25 0", "0,0,2/3", "[.25,.25,0]"), or null.
function parseOriginShift(text) {
  const parts = String(text || '').replace(/[[\]]/g, '').trim().split(/[\s,]+/);
  if (parts.length !== 3) return null;
  const p = parts.map(parseTwentyFourths);
  return p.includes(null) ? null : p;
}

// One shift value the way AMC files write it: a decimal with no leading zero (.25, -.125, 0),
// rounded to six places for thirds and twelfths (.333333).
function formatShiftValue([num, den]) {
  if (num === 0) return '0';
  return String(Number((num / den).toFixed(6))).replace(/^(-?)0\./, '$1.');
}

// The settings ('' for a group with none) the table has for an unstarred group name, e.g.
// ['1', '2', '3'] for "P2_1/c" or [''] for "Pnma"; empty when the group isn't in the table.
function groupSettings(table, name) {
  if (table[name]) return [''];
  return Object.keys(table).filter(k => k.startsWith(`${name}:`)).map(k => k.slice(name.length + 1));
}

// Which of `settings` a cell with angles alpha, beta, gamma (as written) is in. A monoclinic
// group's unique axis is the one whose angle isn't 90 (":1" c, ":2" b, ":3" a); when all three
// are 90, AMCSD writes the unique one with a decimal point ("90.0") and the others as "90". An
// R group is hexagonal (":4") when gamma is 120, otherwise rhombohedral (":5").
function settingFromCell({ alpha, beta, gamma }, settings) {
  if (settings.length === 1) return settings[0];
  const off90 = angle => Math.abs(parseFloat(angle) - 90) > 1e-3;
  if (settings.includes('4') || settings.includes('5')) {
    return Math.abs(parseFloat(gamma) - 120) < 1e-3 ? '4' : '5';
  }
  const angles = { 3: String(alpha), 2: String(beta), 1: String(gamma) };
  const off = Object.keys(angles).filter(s => off90(angles[s]));
  if (off.length === 1) return off[0];
  const marked = Object.keys(angles).filter(s => angles[s].includes('.'));
  return marked.length === 1 ? marked[0] : '2';
}

// Whether the cell itself says which of `settings` it's in, rather than
// settingFromCell falling back to ":2": one angle off 90, or all three 90 with
// exactly one written with a decimal point. A CIF's operators are supposed to
// match that setting.
function cellGivesSetting({ alpha, beta, gamma }, settings) {
  if (settings.length === 1 || settings.includes('4') || settings.includes('5')) return true;
  const angles = [alpha, beta, gamma].map(String);
  const off = angles.filter(a => Math.abs(parseFloat(a) - 90) > 1e-3).length;
  return off === 1 || (off === 0 && angles.filter(a => a.includes('.')).length === 1);
}

const UNIQUE_AXIS = { 1: 'c', 2: 'b', 3: 'a' };

// The error for a cell whose setting the list doesn't have for a group, such
// as "Pb" with beta not 90: a glide along b can't lie across the unique axis b,
// so the symbol doesn't fit the cell (its operators are those of Pc).
function missingSettingMessage(name, setting, settings) {
  const axis = UNIQUE_AXIS[setting] ? ` (unique axis ${UNIQUE_AXIS[setting]})` : '';
  return `The cell puts ${name} in setting :${setting}${axis}, which the space group list doesn't have`
    + ` (it has ${settings.map(s => `:${s}`).join(', ')}); the space group symbol may not fit the cell.`;
}

const operatorCache = new Map();

// Every operation (matrices, identity first) of an unstarred group in the table.
function groupOperators(table, name, setting) {
  const symbol = setting ? `${name}:${setting}` : name;
  if (!operatorCache.has(symbol)) {
    if (!table[symbol]) throw new Error(`Space group ${symbol} is not in the space group list.`);
    const gens = table[symbol].map(([order, op]) => ({ order, M: generatorToMatrix(op) }));
    operatorCache.set(symbol, expandGenerators(gens, name[0], setting, () => {}).map(({ M }) => M));
  }
  return operatorCache.get(symbol);
}

// Operator text as CIFs write it ("1/2-x,y,0.25+z", "X, Y, Z", "+x,-y,z") in this file's
// form with translations in the cell, e.g. "1/2-x,y,1/4+z"; null if it can't be read.
function normalizeOperator(text) {
  const op = String(text).replace(/\s/g, '').toLowerCase()
    .replace(/\d*\.\d+|\d+\.\d*/g, d => formatFraction(parseTwentyFourths(d) || [NaN, 1]));
  try {
    return formatOperator(reduceToCell(generatorToMatrix(op)));
  } catch (e) {
    return null;
  }
}

// Every shift in (-1/2, 1/2] on the 1/24 grid, simplest first (fewest nonzero values, then
// smallest), built once when first needed.
let shiftCandidates = null;
function allShifts() {
  if (!shiftCandidates) {
    const ks = [0];
    for (let k = 1; k <= STEPS / 2; k++) ks.push(k, -k);
    ks.pop(); // -12/24 is the same shift as 12/24
    shiftCandidates = ks.flatMap(x => ks.flatMap(y => ks.map(z => [x, y, z])))
      .map(v => ({ v, nonzero: v.filter(Boolean).length, size: v.reduce((s, k) => s + Math.abs(k), 0) }))
      .sort((a, b) => a.nonzero - b.nonzero || a.size - b.size)
      .map(({ v }) => v.map(k => frac(k, STEPS)));
  }
  return shiftCandidates;
}

// The origin shift p that moves the operations `base` onto exactly the operators `target` (a
// Set of normalizeOperator strings), trying the shifts in `preferred` first, then every shift
// on the 1/24 grid from the simplest; null if there is none.
function findOriginShift(base, target, preferred = []) {
  if (base.length !== target.size) return null;
  const fits = p => base.every(M => target.has(formatOperator(shiftOrigin(M, p))));
  return preferred.find(fits) || allShifts().find(fits) || null;
}

// The shifts the table's starred lines give for a group, e.g. [[1/4, -1/4, 0]] for
// "*P4/ncc[.25,-.25,0]", so a match can be written the way the table writes it.
function tableShifts(table, name, setting) {
  const prefix = `*${setting ? `${name}:${setting}` : name}[`;
  return Object.keys(table).filter(k => k.startsWith(prefix)).map(k => parseOriginShift(k.slice(prefix.length - 1))).filter(Boolean);
}

return {
  frac, fadd, fmul, fmod1, formatFraction, generatorToMatrix, matMul, matPow, format3x4,
  reduceToCell, shiftOrigin, parseShiftValue, formatOperator, centringVectors, expandGenerators,
  IDENTITY, SYMBOL_RE,
  parseOriginShift, formatShiftValue, groupSettings, settingFromCell, cellGivesSetting, missingSettingMessage, groupOperators,
  normalizeOperator, findOriginShift, tableShifts,
};
})();

if (typeof module !== 'undefined') module.exports = SpaceGroupSymmetry;
