#!/usr/bin/env node
// Work out the space group from its symmetry operators: which group in the space group list
// (spacegroupdata.js, built from data/SpaceGroupData.txt) has exactly these operations, and at
// what origin. The operators can be given as
//   - a CIF file: its _space_group_symop_operation_xyz / _symmetry_equiv_pos_as_xyz loop
//   - a text file (or stdin, "-") with one operator per line, either "x,y,z"-style
//     ("1/2-x,y,0.25+z") or as a matrix: the 3x4 augmented matrix (r11 r12 r13 t1 r21 ... t3)
//     on one line or as 3 lines of 4 numbers, or the 4x4 form with its 0 0 0 1 row
//   - "x,y,z"-style operators as the arguments themselves
// A directory runs every .cif in it and prints one line per file.
//
// The operators don't have to be the whole group: they are first closed under multiplication
// (translations taken into the cell), so a list of generators works too. Centring can't be
// worked out from generators, though: without a pure translation among the operators the
// lattice is taken as primitive. Pass --lattice A|B|C|I|F|R (R: hexagonal setting) to add the
// centring translations; a CIF that leaves them out gets them from its H-M symbol's letter.
// When several groups match (the list has some groups under more than one name or setting),
// the one named like the CIF's H-M symbol comes first, then those at the standard origin.
// The closed set is then compared with every unstarred group
// in the list, in every setting, at every origin shift on the 1/24 grid ({M|t} -> {M | t + Mp - p},
// see SpaceGroupSymmetry.shiftOrigin), no shift first, then the list's own starred shifts for
// that group. A shifted match is written the way AMC files write it: "*" plus the symbol, and
// the shift p as the line after the cell parameters.
//
// Usage:
//   node scripts/identify_space_group.js file.cif
//   node scripts/identify_space_group.js ops.txt
//   node scripts/identify_space_group.js "x,y,z" "-x,1/2+y,1/2-z" "-x,-y,-z"
//   node scripts/identify_space_group.js --lattice C "-x,y,1/2-z" "-x,-y,-z"
//   node scripts/identify_space_group.js path/to/cif-folder > results.tsv

const fs = require('fs');
const path = require('path');
const S = require('../symmetry');

// spacegroupdata.js declares a const for the browser; evaluate it to get the table here.
const TABLE = new Function(`${fs.readFileSync(path.join(__dirname, '..', 'spacegroupdata.js'), 'utf8')}\nreturn SPACE_GROUP_GENERATORS;`)();

// The most operations a space group can have (Fm-3m: 48 x 4 centrings).
const MAX_OPS = 192;

// --- Reading the operators ---

// Split a CIF data line into its values, keeping quoted ones ('x, y, z') whole.
function cifTokens(line) {
  return [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}

// The operator column of a CIF's symmetry loop, plus its H-M name.
function readCif(text) {
  const lines = text.split(/\r?\n/);
  // A tag's value, on its own line or the next one.
  const tag = name => {
    const at = lines.findIndex(l => l.trim().split(/\s+/)[0].toLowerCase() === name.toLowerCase());
    if (at < 0) return '';
    const value = cifTokens(lines[at].trim()).slice(1).join(' ');
    const next = (lines[at + 1] || '').trim();
    return value || (next && !/^(_|loop_|data_|#)/i.test(next) ? cifTokens(next).join(' ') : '');
  };
  const hmName = () => tag('_symmetry_space_group_name_H-M') || tag('_space_group_name_H-M_alt');
  const OP_TAGS = ['_space_group_symop_operation_xyz', '_symmetry_equiv_pos_as_xyz'];
  for (let i = 0; i < lines.length; i++) {
    // The tags may follow loop_ on its own line ("loop_ _symmetry_equiv_pos_site_id ...").
    const head = cifTokens(lines[i].trim());
    if ((head[0] || '').toLowerCase() !== 'loop_') continue;
    const tags = [];
    let tokens = head.slice(1);
    while (tokens.length && tokens[0].startsWith('_')) tags.push(tokens.shift().toLowerCase());
    let j = i + 1;
    while (!tokens.length && j < lines.length && lines[j].trim().startsWith('_')) {
      const t = cifTokens(lines[j++].trim());
      while (t.length && t[0].startsWith('_')) tags.push(t.shift().toLowerCase());
      tokens = t;
    }
    const col = tags.findIndex(t => OP_TAGS.includes(t));
    if (col < 0) continue;
    const ops = [];
    // Values may run across lines, so read them as one stream of tokens, a row per tags.length.
    for (; j < lines.length; j++) {
      const l = lines[j].trim();
      if (!l || l.startsWith('#')) continue;
      if (l.startsWith('_') || /^(loop_|data_)/i.test(l)) break;
      tokens = tokens.concat(cifTokens(l));
    }
    for (let k = 0; k + tags.length <= tokens.length; k += tags.length) ops.push(tokens[k + col]);
    return { ops, name: hmName() };
  }
  return { ops: [], name: hmName() };
}

// One matrix entry ("1", "-1", "0.5", ".333333", "2/3") as an exact fraction, or null.
function readNumber(s) {
  const [n, d = '1'] = s.split('/');
  const v = Number(n) / Number(d);
  if (!Number.isFinite(v)) return null;
  const k = Math.round(v * 24);
  return Math.abs(v * 24 - k) < 0.01 ? S.frac(k, 24) : null;
}

// Lines of a text file -> operator strings. "x,y,z"-style lines are taken as they are; runs of
// number-only lines are matrices, read 12 numbers (one 3x4) at a time with any 0 0 0 1 row of
// the 4x4 form dropped.
function readOperatorLines(text) {
  const ops = [];
  let numbers = [];
  const flush = () => {
    if (numbers.length % 12) throw new Error(`${numbers.length} matrix numbers, not a multiple of 12 (3x4 per operator)`);
    for (let k = 0; k < numbers.length; k += 12) {
      const v = numbers.slice(k, k + 12).map(readNumber);
      if (v.includes(null)) throw new Error(`Could not read matrix ${numbers.slice(k, k + 12).join(' ')}`);
      const M = [v.slice(0, 4), v.slice(4, 8), v.slice(8, 12), [S.frac(0), S.frac(0), S.frac(0), S.frac(1)]];
      ops.push(S.formatOperator(M));
    }
    numbers = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const nums = line.replace(/[[\](){};|]/g, ' ').split(/[\s,]+/).filter(Boolean);
    if (line && nums.every(n => /^[+-]?(\d+\.?\d*|\.\d+)(\/\d+)?$/.test(n))) {
      let row = nums;
      if (row.length === 16) row = row.slice(0, 12); // 4x4 on one line
      if (row.length === 4 && row.map(Number).join(' ') === '0 0 0 1') continue;
      numbers.push(...row);
      continue;
    }
    if (numbers.length) flush();
    if (!line) continue;
    // "1 x,y,z" or "1 'x, y, z'": a numbered operator, as copied out of a CIF loop.
    const op = line.replace(/^\d+\s+(?=['"]?[-+]?[\d./]*[xyz])/i, '').replace(/^['"]|['"]$/g, '');
    ops.push(op);
  }
  if (numbers.length) flush();
  return ops;
}

// --- Matching ---

const rotationKey = M => M.slice(0, 3).map(row => row.slice(0, 3).map(S.formatFraction).join(' ')).join(' ');
const sortedRotations = ops => ops.map(rotationKey).sort().join('|');

// The operators as normalized strings, closed under multiplication; throws if one can't be
// read or the set runs past any space group's size. Only the operators not already produced
// by the earlier ones are kept as generators, and the group is grown from those, so a full
// list of 192 costs a few hundred products rather than 192 x 192.
function closeOperators(opsText, lattice = '') {
  const given = new Map();
  for (const text of opsText) {
    const op = S.normalizeOperator(text);
    if (!op) throw new Error(`Could not read operator "${text}" (translations have to be multiples of 1/24, such as 1/3 or .25)`);
    given.set(op, S.reduceToCell(S.generatorToMatrix(op)));
  }
  const listed = given.size;
  for (const op of centringOperators(lattice)) given.set(S.formatOperator(op), op);
  const ops = new Map([['x,y,z', S.IDENTITY]]);
  const gens = [];
  for (const [key, G] of given) {
    if (ops.has(key)) continue;
    gens.push(G);
    // The elements so far need multiplying only by the new generator; each new element then by
    // every generator, until nothing new turns up.
    const queue = [...ops.values()].map(A => [A, [G]]);
    while (queue.length) {
      const [A, by] = queue.pop();
      for (const g of by) {
        const C = S.reduceToCell(S.matMul(A, g));
        const k = S.formatOperator(C);
        if (ops.has(k)) continue;
        ops.set(k, C);
        queue.push([C, gens]);
        if (ops.size > MAX_OPS) throw new Error(`the operators generate more than ${MAX_OPS} operations, so they don't form a space group (are the translations right?)`);
      }
    }
  }
  return { ops, listed };
}

// The centring translations of a lattice letter as operators (none for P or ''); R is taken in
// its hexagonal setting.
function centringOperators(lattice) {
  if (!lattice || lattice === 'P') return [];
  return S.centringVectors(lattice, '4').map(v => S.IDENTITY.map((row, i) => (i < 3 ? [...row.slice(0, 3), v[i]] : row)));
}

// Whether the operations include a pure translation (a centred lattice).
const hasCentring = ops => [...ops.keys()].some(k => k !== 'x,y,z' && rotationKey(ops.get(k)) === rotationKey(S.IDENTITY));

// A name reduced for comparing an H-M symbol with the list's: no setting suffix, spaces,
// underscores or (in a full symbol such as "P 1 21/c 1") lone 1s. "P 21 21 21" and "P2_12_12_1"
// both give "p212121".
function nameKey(name) {
  let n = String(name || '').replace(/:.*$/, '').replace(/^\*/, '').replace(/\((\d)\)/g, '$1').trim();
  if ((n.match(/ /g) || []).length > 1 && !/^[PR] ?-?3/.test(n)) n = n.split(' 1').join('');
  return n.replace(/[\s_]/g, '').toLowerCase();
}

// The lattice letter of an H-M symbol ("C 1 2/c 1" -> "C"), or ''.
const latticeLetter = name => (String(name || '').trim().match(/^([PABCIFR])/i) || ['', ''])[1].toUpperCase();

// Every unstarred group in the list with its setting and operations. Lines that give exactly the
// same operations (other spellings of one group, e.g. "Fm3m", "F4/m-32/m" and "Fm-3m") are
// kept as one entry, the first line's, with the others as its aliases.
let groupCache = null;
function allGroups() {
  if (!groupCache) {
    const byOps = new Map();
    for (const symbol of Object.keys(TABLE)) {
      const [, star, name, setting = ''] = symbol.match(S.SYMBOL_RE) || [];
      if (!name || star) continue;
      let base;
      try {
        base = S.groupOperators(TABLE, name, setting);
      } catch (e) {
        continue; // a line whose generators don't expand is reported by space_group_csv.js
      }
      const key = base.map(S.formatOperator).sort().join(';');
      if (byOps.has(key)) byOps.get(key).aliases.push(symbol);
      else byOps.set(key, { symbol, name, setting, base, rotations: sortedRotations(base), aliases: [] });
    }
    groupCache = [...byOps.values()];
  }
  return groupCache;
}

// --- Origin shift search ---
// Translations and shifts are all multiples of 1/24 (see symmetry.js), so the search runs on
// integers: an operation becomes its rotation key plus its translation in 24ths, and moving
// it to origin p is t + (R - I)p (mod 24), the same as SpaceGroupSymmetry.shiftOrigin.

const STEPS = 24;
const mod = n => ((n % STEPS) + STEPS) % STEPS;
const to24 = ([num, den]) => mod((num * STEPS) / den);

function intForm(M) {
  return {
    key: rotationKey(M),
    R: M.slice(0, 3).map(row => row.slice(0, 3).map(([num, den]) => num / den)),
    t: M.slice(0, 3).map(row => to24(row[3])),
  };
}

// Every shift in (-1/2, 1/2] in 24ths, simplest first (fewest nonzero values, then smallest),
// in the same order as SpaceGroupSymmetry.findOriginShift tries them.
const SHIFTS = (() => {
  const ks = [0];
  for (let k = 1; k <= STEPS / 2; k++) ks.push(k, -k);
  ks.pop(); // -12/24 is the same shift as 12/24
  return ks.flatMap(x => ks.flatMap(y => ks.map(z => [x, y, z])))
    .map(v => ({ v, nonzero: v.filter(Boolean).length, size: v.reduce((sum, k) => sum + Math.abs(k), 0) }))
    .sort((a, b) => a.nonzero - b.nonzero || a.size - b.size)
    .map(({ v }) => v);
})();

// The first shift (preferred ones first) that moves every operation of `base` onto one in
// `target` (rotation key -> Set of "t1 t2 t3" in 24ths), or null. The sizes already agree, so
// this makes the two sets equal.
function findShift(base, target, preferred) {
  const fits = p => base.every(({ key, R, t }) => {
    const moved = [0, 1, 2].map(i => mod(t[i] + R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2] - p[i]));
    return target.get(key).has(moved.join(' '));
  });
  return preferred.find(fits) || SHIFTS.find(fits) || null;
}

// Options: lattice, a centring letter to add; cifName, the CIF's own H-M symbol, whose letter
// fills in a centring the operators leave out and whose name orders the matches.
// A CIF letter that gives no match (an R group written on rhombohedral axes has no centring
// translations) is dropped again.
function identify(opsText, { lattice = '', cifName = '' } = {}) {
  const plain = closeOperators(opsText, lattice);
  const hint = latticeLetter(cifName);
  if (!lattice && !hasCentring(plain.ops) && hint && hint !== 'P') {
    try {
      const result = matchGroups(closeOperators(opsText, hint), cifName);
      if (result.matches.length) return { ...result, latticeFrom: hint };
    } catch (e) {
      // the centring makes too many operations; fall back to the operators as given
    }
  }
  // With no centring among the operators and no letter to go on, the lattice can't be told:
  // many groups have the same generators and differ only in their letter (P2/c and C2/c both
  // come from -x,-y,-z and -x,y,1/2-z). So each centred letter is tried too, and every group
  // that fits with its own letter's centring is listed alongside the primitive matches. The
  // same is done when the operators give only part of a centring (F2/d's generators give the
  // 1/2,1/2,0 translation but not the other two) and so match nothing as they are.
  const result = matchGroups(plain, cifName);
  const otherLattices = [];
  if (!lattice && !hint && (!hasCentring(plain.ops) || !result.matches.length)) {
    for (const L of ['A', 'B', 'C', 'I', 'F', 'R']) {
      try {
        const { matches } = matchGroups(closeOperators(opsText, L), cifName);
        const own = matches.filter(m => m.name[0] === L);
        if (own.length) otherLattices.push({ lattice: L, matches: own });
      } catch (e) {
        // too many operations with this centring, so it can't be this lattice
      }
    }
  }
  return { ...result, latticeFrom: lattice, otherLattices };
}

function matchGroups({ ops, listed }, cifName) {
  const centred = hasCentring(ops);
  const rotations = sortedRotations([...ops.values()]);
  const target = new Map();
  for (const M of ops.values()) {
    const { key, t } = intForm(M);
    if (!target.has(key)) target.set(key, new Set());
    target.get(key).add(t.join(' '));
  }
  const matches = [];
  for (const g of allGroups()) {
    // An origin shift changes only translations, so the rotation parts must already agree.
    if (g.base.length !== ops.size || g.rotations !== rotations) continue;
    g.ints = g.ints || g.base.map(intForm);
    const preferred = [[0, 0, 0], ...S.tableShifts(TABLE, g.name, g.setting).map(p => p.map(f => (f[0] * STEPS) / f[1]))];
    const p = findShift(g.ints, target, preferred);
    if (p) matches.push({ ...g, p: p.map(k => S.frac(k, STEPS)), shifted: p.some(Boolean) });
  }
  const wanted = nameKey(cifName);
  const named = m => Boolean(wanted) && [m.symbol, ...m.aliases].some(sym => nameKey(sym) === wanted);
  matches.forEach(m => { m.named = named(m); });
  matches.sort((a, b) => b.named - a.named || a.shifted - b.shifted);
  return { count: ops.size, listed, matches, centred, cifNamed: !wanted || matches.some(m => m.named) };
}

// How a match is written in an AMC file: the symbol (":n" setting left off, as AMC files do),
// starred when shifted, with the shift line.
function amcForm(m) {
  return m.shifted ? `*${m.name}  (shift line: ${m.p.map(S.formatShiftValue).join(' ')})` : m.name;
}

// --- Output ---

function report(label, opsText, options = {}) {
  console.log(`${label}${options.cifName ? `  (CIF says ${options.cifName})` : ''}`);
  if (!opsText.length) {
    console.log('  no symmetry operators found\n');
    return;
  }
  let result;
  try {
    result = identify(opsText, options);
  } catch (e) {
    console.log(`  ${e.message}\n`);
    return;
  }
  const { count, listed, matches, centred, latticeFrom, cifNamed, otherLattices = [] } = result;
  console.log(`  ${listed} operator(s) given, ${count} operations in the closed group${count !== listed ? ' (filled in by multiplying them)' : ''}`);
  if (latticeFrom && !options.lattice) console.log(`  ${latticeFrom} centring translations added, from the CIF's H-M symbol (its operators leave them out)`);
  else if (otherLattices.length) {
    console.log(centred
      ? "  the operators give only part of a centring, so they can't say which lattice it is; the groups"
      : "  no centring translations among the operators, so they can't say which lattice it is; the groups");
    console.log('  they fit for each lattice are below (use --lattice to pick one)');
    for (const { lattice: L, matches: ms } of otherLattices) {
      console.log(`  with ${L} centring:`);
      printMatches(ms);
    }
    console.log(`  as given${centred ? '' : ' (primitive)'}:${matches.length ? '' : ' none'}`);
    if (!matches.length) {
      console.log('');
      return;
    }
  } else if (!centred) console.log('  no centring translations among the operators, so the lattice is taken as primitive (use --lattice if it is centred)');
  if (!matches.length) {
    console.log('  no group in the space group list matches at any origin on the 1/24 grid\n');
    return;
  }
  if (!cifNamed) console.log(`  none of the matches is the CIF's ${options.cifName}${count !== listed ? ' (does the CIF list only some of its operators?)' : ''}`);
  printMatches(matches);
  console.log('');
}

function printMatches(matches) {
  for (const m of matches) {
    const shift = m.shifted ? `origin shift ${m.p.map(S.formatShiftValue).join(' ')}` : 'standard origin';
    console.log(`  ${m.symbol.padEnd(14)} ${shift.padEnd(30)} AMC: ${amcForm(m)}${m.named ? "   <- the CIF's name" : ''}`);
    if (m.aliases.length) console.log(`  ${''.padEnd(14)} same operations as ${m.aliases.join(', ')}`);
  }
}

// One tab-separated line per CIF, for running over a folder.
function reportRow(file, cif, lattice) {
  let found = '', status;
  try {
    if (!cif.ops.length) throw new Error('no symmetry operators');
    const { matches, latticeFrom } = identify(cif.ops, { lattice, cifName: cif.name });
    found = matches.map(m => `${m.shifted ? '*' : ''}${m.symbol}${m.shifted ? `[${m.p.map(S.formatShiftValue).join(',')}]` : ''}`).join(' ');
    status = !matches.length ? 'no match' : matches[0].named ? 'ok' : 'ok, not the CIF name';
    if (latticeFrom && !lattice) status += `, ${latticeFrom} centring from CIF name`;
  } catch (e) {
    status = e.message;
  }
  console.log([path.basename(file), cif.name, found, status].join('\t'));
}

function main() {
  const args = process.argv.slice(2);
  let lattice = '';
  const at = args.findIndex(a => /^--lattice(=|$)/.test(a));
  if (at >= 0) {
    const [flag] = args.splice(at, 1);
    lattice = (flag.includes('=') ? flag.split('=')[1] : args.splice(at, 1)[0] || '').toUpperCase();
    if (!/^[PABCIFR]$/.test(lattice)) {
      console.error('--lattice takes one of P, A, B, C, I, F, R');
      process.exit(1);
    }
  }
  if (!args.length) {
    console.error('Usage: node scripts/identify_space_group.js [--lattice X] <file.cif | ops.txt | folder | - | "x,y,z" ...>');
    process.exit(1);
  }
  const looseOps = [];
  for (const arg of args) {
    try {
      run(arg);
    } catch (e) {
      console.log(`${arg}\n  ${e.message}\n`);
    }
  }
  if (looseOps.length) report('operators', looseOps, { lattice });

  function run(arg) {
    if (arg === '-') {
      report('stdin', readOperatorLines(fs.readFileSync(0, 'utf8')), { lattice });
    } else if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
      console.log(['file', 'CIF H-M name', 'matches', 'status'].join('\t'));
      for (const name of fs.readdirSync(arg).filter(n => /\.cif$/i.test(n)).sort()) {
        reportRow(name, readCif(fs.readFileSync(path.join(arg, name), 'utf8')), lattice);
      }
    } else if (fs.existsSync(arg)) {
      const text = fs.readFileSync(arg, 'utf8');
      if (/\.cif$/i.test(arg) || /^\s*loop_\s*$/im.test(text)) {
        const cif = readCif(text);
        report(arg, cif.ops, { lattice, cifName: cif.name });
      } else {
        report(arg, readOperatorLines(text), { lattice });
      }
    } else {
      looseOps.push(arg);
    }
  }
}

if (require.main === module) main();

module.exports = { identify, readCif, readOperatorLines };
