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

return {
  frac, fadd, fmul, fmod1, formatFraction, generatorToMatrix, matMul, matPow, format3x4,
  reduceToCell, shiftOrigin, parseShiftValue, formatOperator, centringVectors, expandGenerators,
  IDENTITY, SYMBOL_RE,
};
})();

if (typeof module !== 'undefined') module.exports = SpaceGroupSymmetry;
