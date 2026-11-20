// Paper table -> AMC. Journals print atom tables in many layouts, often with
// values scaled by a power of ten and the uncertainty in parentheses: under
// "Atomic coordinates (x 10^4)", "3375(1)" is x = .3375; under "U(eq)
// (A^2 x 10^3)", "8(1)" is Uiso = .008; under "beta(ij) x 10^4", "255(14)" is
// .0255.
//
// The pasted text is read line by line:
//  - A header row names the columns, in the paper's order: x y z (or x/a y/b
//    z/c), the isotropic term (U(eq), Ueq, Uiso, Beq, Biso, iso), the six
//    anisotropic terms (U11 ... U23, U(1,1), B11, beta11, or just 11 ... 23)
//    and an occupancy (occ, sof). One table can mix row layouts (some atoms
//    with U(i,j), some with only an isotropic term, some with an occupancy):
//    the header names every column, and the number of values on a row says
//    which of them the row has.
//  - A row is an atom label followed by numbers.
//  - Any other line just before a block of rows is that dataset's title (e.g.
//    "Phl1a"), so one table can hold several datasets, each written out as
//    its own AMC dataset.
//  - A second header without x y z (a separate U(i,j) table, as in many
//    papers) adds its values to the atoms of the same labels, in the dataset
//    of the same title (or the same position, when untitled).
//
// A coordinate printed without an uncertainty is a special position, fixed by
// symmetry, so it is written as its exact value: "2500" is .25 (not .2500),
// "5000" is .5, "1250" is .125, and in a hexagonal or rhombohedral cell (a a c
// 90 90 120, or a a a alpha alpha alpha) "3333" and "6667" are 1/3 and 2/3.
// Only coordinates are snapped: an isotropic term without an uncertainty is
// just missing its error, and U(i,j) fixed by symmetry are printed as "0" or as
// equal values, which scaling already gets right.

// A printed value: optional sign, digits with an optional point, and an
// optional uncertainty in parentheses ("3375(1)", "-2363(1)", "0", "2.30(8)").
const PAPER_VALUE_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:\((\d+)\))?$/;

// PDF text uses typographic minus signs and dashes (made plain hyphens by
// normalizeMinusSigns), sometimes puts a space
// before an uncertainty ("31 (3)"), and scanned papers can read a decimal
// point as a comma ("0,1724(2)"). A footnote mark after a value ("0.028
// (8)*", where * marks a Uiso among Ueq) is dropped, and so is one standing
// on its own ("0.080 *", a value fixed in the refinement).
function paperTableTokens(line) {
  return normalizeMinusSigns(line)
    .replace(/(\d)\s+(\(\d+\))/g, '$1$2')
    .trim()
    .split(/\s+/)
    .filter(t => t && !/^[*†‡§]+$/.test(t))
    .map(t => t.replace(/^([+-]?[\d.,]*\d(?:\(\d+\))?)[*†‡§]+$/, '$1'))
    .map(t => (/^[+-]?\d+,\d+(\(\d+\))?$/.test(t) ? t.replace(',', '.') : t));
}

// A special position printed as a fraction ("1/4", "3/4", "1/3"): exact, so
// never scaled; `exact` holds it in AMC form (".25", ".75", "1/3").
const PAPER_FRACTION_RE = /^([+-]?)(\d)\/(\d{1,2})$/;

function exactFraction(sign, numerator, denominator) {
  const value = numerator / denominator;
  if (value === 0) return '0';
  if (denominator % 3 === 0 && Math.round(value * 3) === value * 3 && value < 1) return `${sign}${value * 3}/3`;
  const text = Number.isInteger(value * 8) ? String(value) : value.toFixed(5);
  return sign + text.replace(/^0\./, '.');
}

function parsePaperValue(token) {
  const f = token.match(PAPER_FRACTION_RE);
  if (f && Number(f[3]) > 0 && Number(f[2]) < Number(f[3])) {
    return { sign: f[1] === '-' ? '-' : '', intPart: '', fracPart: '', su: null, exact: exactFraction(f[1] === '-' ? '-' : '', Number(f[2]), Number(f[3])) };
  }
  const m = token.match(PAPER_VALUE_RE);
  if (!m || !/\d/.test((m[2] || '') + (m[3] || ''))) return null;
  return { sign: m[1] === '-' ? '-' : '', intPart: m[2] || '', fracPart: m[3] || '', su: m[4] || null };
}

const isPaperValue = token => parsePaperValue(token) !== null;

// The value divided by 10^power, done on the digits so nothing is lost to
// floating point, in AMC form: no leading zero, all printed digits kept
// ("3375", 4 -> ".3375"; "782", 4 -> ".0782"; "8", 3 -> ".008"), "0" for zero.
function scalePaperValue({ sign, intPart, fracPart, exact }, power) {
  if (exact !== undefined) return exact;
  let digits = intPart + fracPart;
  if (/^0*$/.test(digits)) return '0';
  let point = intPart.length - power;
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits = digits.padEnd(point, '0');
  const whole = digits.slice(0, point).replace(/^0+/, '');
  const frac = digits.slice(point);
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}

const PAPER_THIRDS = { '1': '1/3', '2': '2/3', '-1': '-1/3', '-2': '-2/3' };

// The exact value a coordinate printed without an uncertainty stands for: a
// multiple of 1/8 (0, .125, .25, .375, .5, ...) printed exactly, or in a
// hexagonal or rhombohedral cell 1/3 or 2/3 rounded to the digits shown (at
// least three, so "0.3" is not taken for 1/3). { looksLikeThird } when it is
// 1/3 or 2/3 but thirds aren't allowed, null when it is neither, which keeps
// the value as printed.
function specialPositionValue(value, power, decimalsShown, allowThirds) {
  const places = power + decimalsShown;
  const eighth = Math.round(value * 8) / 8;
  if (Math.abs(value - eighth) < 1e-9) {
    if (eighth === 0) return '0';
    return String(eighth).replace(/^(-?)0\./, '$1.');
  }
  const thirds = Math.round(value * 3);
  if (places >= 3 && Math.abs(value - thirds / 3) <= 0.5 * Math.pow(10, -places) * (1 + 1e-9)) {
    if (!allowThirds) return { looksLikeThird: true };
    if (PAPER_THIRDS[thirds]) return PAPER_THIRDS[thirds];
    return (thirds / 3).toFixed(5).replace(/^(-?)0\./, '$1.');
  }
  return null;
}

// --- Header ---

const AMC_ANISO_ORDER = ['11', '22', '33', '12', '13', '23'];

// One header word as a column, or null for a word that isn't one ("Atom",
// "Site"). Stars and dots marking footnotes ("Beq.", "beta11*") are dropped.
function paperColumn(word) {
  const w = word.replace(/[*.]+$/, '');
  const axis = w.match(/^([xyz])(\/[abc])?$/i);
  if (axis) return { kind: axis[1].toLowerCase() };
  // One column for both kinds ("Uiso*/Ueq", "Ueq/Uiso", "Beq/Biso").
  if (w.includes('/')) {
    const parts = w.split('/').map(part => paperColumn(part.replace(/[*.]+/g, '')));
    return parts.every(p => p && p.kind === 'iso') ? parts[0] : null;
  }
  if (/^([UB]\s*\(?\s*(eq|iso)\s*\)?|iso|[UB])$/i.test(w)) return { kind: 'iso', convention: /^b/i.test(w) ? 'B' : 'U' };
  const term = w.match(/^(U|B|β|beta)?\s*\(?\s*([123])\s*,?\s*([123])\s*\)?$/i);
  if (term) return { kind: 'aniso', ij: [term[2], term[3]].sort().join(''), convention: term[1] && !/^u$/i.test(term[1]) ? 'B' : 'U' };
  if (/^(occ|occupancy|sof|s\.o\.f)$/i.test(w)) return { kind: 'occ' };
  return null;
}

// The columns a header line names, or null when it isn't a header: a header
// names x, y and z, or all six anisotropic terms (a separate U(i,j) table).
// A scanned header's column name read loosely: footnote marks and stray
// quotes dropped ("623*," is 23), and a term whose β or U was misread
// ("~11", "fl22", "633") still taken as that term, a β unless it reads U.
function scannedColumn(word) {
  const w = word.replace(/["'`*,.;:]+$/, '');
  const column = paperColumn(w);
  if (column) return column;
  const term = w.match(/^(.{0,2}?)([123])([123])$/);
  if (term && term[2] <= term[3]) return { kind: 'aniso', ij: term[2] + term[3], convention: /^u/i.test(term[1]) ? 'U' : 'B' };
  return null;
}

const LABEL_COLUMN_RE = /^(atom|atoms|site|sites|label|name)$/i;

function readPaperHeader(tokens) {
  if (tokens.length && LABEL_COLUMN_RE.test(tokens[0])) tokens = tokens.slice(1);
  // A scan often misreads the italic x, y and z ("ae y eZ B", "rda yfo z/c"):
  // when the three words before the other columns aren't all read as x, y
  // and z but one of them is, and the rest read as columns, they are taken
  // as x y z.
  const axes = tokens.slice(0, 3).map(scannedColumn);
  const isAxis = (c, k) => c && c.kind === k;
  const scanned = tokens.length >= 3 && !['x', 'y', 'z'].every((k, i) => isAxis(axes[i], k))
    && ['x', 'y', 'z'].some((k, i) => isAxis(axes[i], k) || /^[xyz]/i.test(tokens[i]))
    && tokens.slice(0, 3).every(t => t.length <= 4) && tokens.slice(3).every(scannedColumn);
  if (scanned) tokens = ['x', 'y', 'z', ...tokens.slice(3)];
  const columns = tokens.map(scannedColumn).filter(Boolean);
  const kinds = new Set(columns.map(c => c.kind));
  const hasXyz = ['x', 'y', 'z'].every(k => kinds.has(k));
  const terms = new Set(columns.filter(c => c.kind === 'aniso').map(c => c.ij));
  if (!hasXyz && terms.size !== 6) return null;
  // Half a set of U(i,j) can't be told apart from a row of numbers, so it is left out.
  const usable = terms.size === 6 ? columns : columns.filter(c => c.kind !== 'aniso');
  return { columns: usable, hasXyz };
}

// Without a header, every column a row could have; rowColumns keeps the ones
// that match its number of values (4: x y z iso, 10: x y z iso and U(i,j)).
const DEFAULT_PAPER_COLUMNS = [
  ...['x', 'y', 'z', 'iso'].map(kind => ({ kind, convention: 'U' })),
  ...AMC_ANISO_ORDER.map(ij => ({ kind: 'aniso', ij, convention: 'U' })),
  { kind: 'occ' },
];

// Which of the header's columns a row of these values has. x, y and z are
// always there; of the optional groups (the isotropic term, the six U(i,j),
// the occupancy) the row keeps a set whose size matches. When more than one
// does (x y z U(i,j) and one more value: the isotropic term or the
// occupancy?), the values decide: an occupancy is a decimal no more than 1
// ("0.75(3)"), and a scaled isotropic or anisotropic term is a whole number
// ("9(1)"), so the reading that fits the most values wins. Failing
// that, U(i,j) are kept over the isotropic term over the occupancy (a full
// occupancy is the value most often left blank). Null when no set matches.
const PAPER_GROUP_WEIGHT = { aniso: 4, iso: 2, occ: 1 };

function rowColumns(columns, values, powers) {
  const groups = Object.keys(PAPER_GROUP_WEIGHT).filter(g => columns.some(c => c.kind === g));
  // An unscaled U is a decimal under .1 ("0.0085(2)"), which no occupancy is
  // as small as (.02 at least), so it reads as the isotropic term.
  const smallDecimal = token => parsePaperValue(token).fracPart !== '' && Math.abs(parseFloat(token)) < 0.1;
  const looksLike = {
    occ: token => { const v = parsePaperValue(token); const n = parseFloat(token); return v.fracPart !== '' && n <= 1 && n >= 0.02; },
    iso: token => powers.isoPower === 0 || parsePaperValue(token).fracPart === '' || smallDecimal(token),
    aniso: token => powers.anisoPower === 0 || parsePaperValue(token).fracPart === '' || smallDecimal(token),
  };
  let best = null;
  for (let mask = 0; mask < 1 << groups.length; mask++) {
    const kept = groups.filter((_, i) => mask & (1 << i));
    const candidate = columns.filter(c => !PAPER_GROUP_WEIGHT[c.kind] || kept.includes(c.kind));
    if (candidate.length !== values.length) continue;
    const fits = candidate.filter((c, i) => looksLike[c.kind] && looksLike[c.kind](values[i])).length;
    const weight = kept.reduce((n, g) => n + PAPER_GROUP_WEIGHT[g], 0);
    if (!best || fits > best.fits || (fits === best.fits && weight > best.weight)) best = { candidate, fits, weight };
  }
  return best && best.candidate;
}

// --- Reading the tables ---

const cleanTitle = line => line.trim().replace(/[*\s]+$/, '');

// An atom row: a label, then two or more numbers. Papers often print more
// than a bare label in the label column - a footnote mark ("T1*"), the
// Wyckoff position ("M1 (4c)"), or two species sharing a site ("F, OH") -
// and scans add stray letters ("K ae"). The label is the first word without
// its footnote mark or comma; a Wyckoff position after it is dropped, and
// anything else dropped is returned in `dropped` so it can be pointed out.
// Null for a line that isn't an atom row.
const isPaperSpecies = w => w === 'OH' || w === 'H2O'
  || (/^[A-Z][a-z]?$/.test(w) && UnitCell.elementOf(w) === w && Object.prototype.hasOwnProperty.call(USUAL_CHARGE, w));

// An occupancy column's text ("Y0.84Yb0.16", "F0.5(OH)0.5", "Si", "OH") as
// [{ species, occ }], occ null where none is printed; null when it isn't one.
function paperComposition(text) {
  const parts = [];
  const re = /\(?(OH|H2O|[A-Z][a-z]?)\)?(\d*\.\d+|\d+)?/gy;
  let m;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (!isPaperSpecies(m[1])) return null;
    parts.push({ species: m[1], occ: m[2] || null });
  }
  return parts.length && re.lastIndex === text.length ? parts : null;
}

function paperAtomRow(tokens) {
  const first = tokens.findIndex(isPaperValue);
  if (first < 1 || tokens.length - first < 2 || !tokens.slice(first).every(isPaperValue)) return null;
  const label = tokens[0].replace(/[*,]+$/, '');
  if (!label) return null;
  // A footnote mark on the label ("Cu2*") is kept to match a footnote that
  // gives its occupancy ("* = 0.965(10) Cu").
  const mark = (tokens[0].match(/\*+$/) || [''])[0];
  const values = tokens.slice(first);
  const extra = tokens.slice(1, first).filter(t => !/^\(?\d+[a-z]\)?$/.test(t) && !/^[*†‡§]+$/.test(t));
  // "F, OH" or "F,OH": a site the paper says two species share.
  const words = [...new Set([tokens[0], ...extra].join(' ').split(/[\s,/]+/).filter(Boolean))];
  if (words.length > 1 && words.every(isPaperSpecies)) return { label, mark, values, dropped: [], shared: words };
  // An occupancy column: "Y0.84Yb0.16" is the site's contents; "O" beside O1
  // (or "Si" beside Si) only repeats the label; "OH" beside O5 says what is on it.
  const composition = extra.length === 1 ? paperComposition(extra[0]) : null;
  if (composition) {
    const element = UnitCell.elementOf(label);
    if (composition.every(p => p.occ !== null) && !(composition.length === 1 && Math.abs(parseFloat(composition[0].occ) - 1) < 1e-9 && composition[0].species === element)) {
      return { label, mark, values, dropped: [], contents: composition };
    }
    if (composition.length === 1 && composition[0].occ === null) {
      const species = composition[0].species;
      if (species === element || species === label) return { label, mark, values, dropped: [] };
      if (element) return { label, mark, values, dropped: [], contents: [{ species, occ: '1' }] };
    }
  }
  return { label, mark, values, dropped: extra };
}
const sameTitle = (a, b) => a.toLowerCase() === b.toLowerCase();

// Every dataset in the pasted text, as [{ title, atoms: [{ label, values: {
// x, y, z, iso, occ, aniso: { ij: token } } }], isoConvention, anisoConvention }],
// plus notes worth telling the user.
function readPaperTables(text, powers, columnsText = '') {
  const datasets = [];
  const notes = [];
  // Columns the user typed replace any header in the paste.
  const typed = columnsText.trim() ? readPaperHeader(paperTableTokens(columnsText)) : null;
  if (columnsText.trim() && !typed) notes.push(`Couldn't read the columns "${columnsText.trim()}"; they need x y z (e.g. x y z Beq B11 B22 B33 B12 B13 B23).`);
  let header = typed;
  let current = null;
  let pendingTitle = '';
  let supplementGroup = -1;
  let warnedNoHeader = false;

  const datasetFor = title => {
    if (header.hasXyz) {
      const dataset = { title, atoms: [], isoConvention: null, anisoConvention: null };
      datasets.push(dataset);
      return dataset;
    }
    supplementGroup++;
    const found = title
      ? datasets.find(d => sameTitle(d.title, title))
      : datasets[supplementGroup] || (datasets.length === 1 ? datasets[0] : null);
    if (!found) notes.push(`No dataset${title ? ` titled ${title}` : ''} for the U(i,j) rows${title ? '' : ` in block ${supplementGroup + 1}`}; they were left out.`);
    return found || { skip: true };
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const tokens = paperTableTokens(line);
    if (!tokens.length) continue;

    // A scan reads the label O2 as "02": a leading-zero number followed by a
    // full row of values is taken as an oxygen.
    if (/^0\d{1,2}$/.test(tokens[0]) && tokens.length >= 4 && tokens.slice(1).every(isPaperValue)) {
      notes.push(`"${tokens[0]}" was read as the label O${tokens[0].slice(1)}.`);
      tokens[0] = `O${tokens[0].slice(1)}`;
    }

    const row = paperAtomRow(tokens);
    if (row) {
      if (!header) {
        header = { columns: DEFAULT_PAPER_COLUMNS, hasXyz: true };
        if (!warnedNoHeader) notes.push('No header row found, so the columns were worked out from the number of values (x y z, then the isotropic value, the six anisotropic terms, the occupancy); type them under Columns if that is wrong.');
        warnedNoHeader = true;
      }
      // The same label again under coordinates starts the next dataset (a
      // second table pasted below the first without its own header).
      if (current && !current.skip && header.hasXyz && current.atoms.some(a => a.label === row.label && a.values.x !== undefined)) {
        notes.push(`${row.label} appears again, so a new dataset was started there.`);
        current = null;
      }
      if (!current) {
        current = datasetFor(pendingTitle);
        if (header.columns === DEFAULT_PAPER_COLUMNS) current.guessedColumns = true;
      }
      pendingTitle = '';
      if (current.skip) continue;
      const { label, values, dropped } = row;
      if (dropped.length) notes.push(`"${tokens.slice(0, tokens.length - values.length).join(' ')}" was read as the label ${label}.`);
      const columns = rowColumns(header.columns, values, powers);
      if (!columns) {
        notes.push(`${label}${current.title ? ` (${current.title})` : ''} has ${values.length} values, which doesn't fit the header's columns; it was left out.`);
        continue;
      }
      let atom = current.atoms.find(a => a.label === label);
      if (!header.hasXyz && !atom) {
        notes.push(`${label}${current.title ? ` (${current.title})` : ''} has U(i,j) but no coordinates; it was left out.`);
        continue;
      }
      if (!atom) {
        atom = {
          label,
          values: { aniso: {} },
          ...(row.mark ? { mark: row.mark } : {}),
          ...(row.shared ? { shared: row.shared } : {}),
          ...(row.contents ? { contents: row.contents } : {}),
        };
        current.atoms.push(atom);
      }
      columns.forEach((column, i) => {
        if (column.kind === 'aniso') {
          atom.values.aniso[column.ij] = values[i];
          current.anisoConvention = current.anisoConvention || column.convention;
        } else {
          atom.values[column.kind] = values[i];
          if (column.kind === 'iso') current.isoConvention = current.isoConvention || column.convention;
        }
      });
      continue;
    }

    const newHeader = readPaperHeader(tokens);
    if (newHeader) {
      if (!typed) header = newHeader;
      current = null;
      pendingTitle = '';
      supplementGroup = -1;
      continue;
    }

    // A header row too garbled to read ("Atom ...") isn't a dataset title;
    // the columns are worked out from the rows (or typed under Columns).
    if (LABEL_COLUMN_RE.test(tokens[0]) && tokens.length >= 4) {
      if (!typed) notes.push(`Couldn't read the header "${line.trim()}"; type it under Columns if the values come out in the wrong places.`);
      current = null;
      pendingTitle = '';
      continue;
    }

    // A row whose label reads as a number (a scan's "01" for O1) can't be told
    // from a row of values, so it is pointed out rather than guessed at.
    if (header && tokens.length >= 4 && tokens.every(isPaperValue)) {
      notes.push(`"${line.trim()}" starts with a number, not an atom label; it was left out.`);
      continue;
    }

    // A footnote giving the occupancy of marked atoms ("Occupancies: * =
    // 0.965(10) Cu; ** = 0.989(4) Pb"): each mark's value goes to the atom
    // of the last dataset whose label carried that mark.
    const lastDataset = datasets[datasets.length - 1];
    const footnotes = [...line.matchAll(/(\*+|†|‡)\s*[=:]\s*(\d*\.\d+)(?:\(\d+\))?/g)];
    if (footnotes.length && lastDataset) {
      for (const [, mark, occ] of footnotes) {
        const atom = lastDataset.atoms.find(a => a.mark === mark);
        if (atom && atom.values.occ === undefined && parseFloat(occ) <= 1) {
          atom.values.occ = occ;
          notes.push(`${atom.label} has occupancy ${occ}, from the footnote.`);
        }
      }
      continue;
    }

    // A caption, a footnote, or a dataset title: whichever line comes last
    // before a block of rows titles it.
    current = null;
    pendingTitle = cleanTitle(line);
  }

  // Without a header, U or B is told from the isotropic values: a U is a few
  // hundredths of Å², so printed values (with decimal points) of .5 or more
  // are B, and the anisotropic terms beside them β.
  for (const dataset of datasets.filter(d => d.guessedColumns)) {
    const iso = dataset.atoms.map(a => a.values.iso).filter(t => t !== undefined && parsePaperValue(t).fracPart !== '');
    if (iso.length && iso.filter(t => parseFloat(t) >= 0.5).length * 2 > iso.length) {
      dataset.isoConvention = 'B';
      if (dataset.anisoConvention) dataset.anisoConvention = 'B';
      notes.push(`The isotropic values${dataset.title ? ` of ${dataset.title}` : ''} are too large for U, so they were read as B${dataset.anisoConvention ? ' and the anisotropic terms as β' : ''}.`);
    }
  }

  return { datasets, notes };
}

// --- Cell parameters ---

// "Phl1a 5.306(1) 9.195(3) 10.272(3) 90 100.01(2) 90 C2/m" - an optional
// title, six numbers (or a b c beta, for a monoclinic cell), then the space
// group in AMC form. A line holding only a space group gives every dataset
// that space group. Returns { byTitle: [{ title, cell }], shared, spaceGroup }.
function readCellLines(text) {
  const result = { byTitle: [], shared: null, spaceGroup: '', notes: [] };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const tokens = paperTableTokens(line);
    if (!tokens.length) continue;
    const first = tokens.findIndex(isPaperValue);
    if (first === -1) {
      if (tokens.length === 1) result.spaceGroup = tokens[0];
      else result.notes.push(`Couldn't read the cell line "${line.trim()}".`);
      continue;
    }
    let last = first;
    while (last < tokens.length && isPaperValue(tokens[last])) last++;
    const numbers = tokens.slice(first, last).map(t => t.replace(/\(\d+\)$/, ''));
    const title = cleanTitle(tokens.slice(0, first).join(' '));
    const spaceGroup = tokens.slice(last).join('').replace(/\*+$/, '');
    let values;
    if (numbers.length === 6) values = numbers;
    else if (numbers.length === 4) values = [numbers[0], numbers[1], numbers[2], '90', numbers[3], '90'];
    else {
      result.notes.push(`The cell line "${line.trim()}" needs six numbers (a b c alpha beta gamma) or four (a b c beta).`);
      continue;
    }
    const [a, b, c, alpha, beta, gamma] = values;
    const cell = { a, b, c, alpha, beta, gamma, spaceGroup };
    if (title) result.byTitle.push({ title, cell });
    else result.shared = cell;
  }
  return result;
}

// a a c 90 90 120, or a a a alpha alpha alpha: where 1/3 and 2/3 can be special positions.
function isHexagonalOrRhombohedral(cell) {
  const [a, b, c, alpha, beta, gamma] = ['a', 'b', 'c', 'alpha', 'beta', 'gamma'].map(k => parseFloat(cell[k]));
  const near = (p, q, tol) => Math.abs(p - q) <= tol;
  const sameLength = (p, q) => near(p, q, 1e-3 * Math.max(p, q));
  if (sameLength(a, b) && near(alpha, 90, 0.05) && near(beta, 90, 0.05) && near(gamma, 120, 0.05)) return true;
  return sameLength(a, b) && sameLength(b, c) && near(alpha, beta, 0.05) && near(beta, gamma, 0.05);
}

// --- AMC output ---

// One dataset's atom table rows (atom, x, y, z, occ, iso, the six U(i,j) in
// AMC order), the values scaled. Coordinates that look like 1/3 or 2/3 when
// thirds aren't allowed are added to thirdLike.
function paperDatasetRows(dataset, options, allowThirds, thirdLike) {
  const { xyzPower, isoPower, anisoPower } = options;
  const coordinate = (atom, axis) => {
    const token = atom.values[axis];
    const v = token === undefined ? null : parsePaperValue(token);
    if (!v) return '';
    const scaled = scalePaperValue(v, xyzPower);
    if (v.su || v.exact !== undefined) return scaled;
    const special = specialPositionValue(parseFloat(scaled), xyzPower, v.fracPart.length, allowThirds);
    if (special && special.looksLikeThird) {
      thirdLike.push(`${atom.label} ${axis}`);
      return scaled;
    }
    return special || scaled;
  };
  return dataset.atoms.map(atom => {
    const { occ, iso, aniso } = atom.values;
    const hasAniso = AMC_ANISO_ORDER.every(ij => aniso[ij] !== undefined);
    return [
      normalizeAtomLabel(atom.label),
      coordinate(atom, 'x'),
      coordinate(atom, 'y'),
      coordinate(atom, 'z'),
      occ !== undefined && !isFullOccupancy(occ) ? formatAmcDecimal(occ) : '',
      iso !== undefined ? scalePaperValue(parsePaperValue(iso), isoPower) : '',
      ...AMC_ANISO_ORDER.map(ij => (hasAniso ? scalePaperValue(parsePaperValue(aniso[ij]), anisoPower) : '')),
    ];
  });
}

// --- Site contents ---
// A paper's table gives one row per site, but a site shared by several
// elements is written in AMC as one row per element at the same coordinates,
// each with its occupancy. The contents come from the paper's text and
// chemistry table, one line per site:
//   T1 Si.85 Al.15
//   M1 Li0.35 Al0.10 Fe2+0.07 Mg.05 Mn.03 □0.55
//   F  F.60 OH.40
// Each species is an element with an optional charge (Fe2+), or OH, Wat or
// H2O, followed by its occupancy; a vacancy (□, [], Vac) is skipped. A line
// whose site isn't in the table is pointed out.

const SITE_SPECIES_RE = /^(OH|Wat|H2O|[A-Z][a-z]?(?:\d[+-])?)(\d*\.\d+|\d+)$/;
const SITE_VACANCY_RE = /^(□|☐|\[\]|vac|vacancy|v)(\d*\.\d+|\d+)?$/i;

// { site: [{ species, occ }] } from the site contents text, plus notes.
function readSiteContents(text) {
  const sites = new Map();
  const notes = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    // "Li 0.35" is read the same as "Li0.35", and "Li_0.35" (a pasted subscript) too.
    const tokens = line.trim().replace(/_/g, '').replace(/([A-Za-z+-])\s+(\d*\.\d+)/g, '$1$2').split(/[\s,;]+/).filter(Boolean);
    if (!tokens.length) continue;
    const [site, ...rest] = tokens;
    const species = [];
    const unread = [];
    for (const token of rest) {
      if (SITE_VACANCY_RE.test(token)) continue;
      const m = token.match(SITE_SPECIES_RE);
      if (m) species.push({ species: m[1] === 'H2O' ? 'Wat' : m[1], occ: m[2] });
      else unread.push(token);
    }
    if (unread.length) notes.push(`Couldn't read ${unread.join(', ')} in the site contents of ${site} (write each as an element and its occupancy, e.g. Al.15).`);
    if (species.length) sites.set(site.replace(/[*:]+$/, ''), species);
  }
  return { sites, notes };
}

// An occupancy as AMC writes it: no leading zero, and blank when full.
function amcOccupancy(text) {
  const value = parseFloat(text);
  if (Math.abs(value - 1) < 1e-9) return '';
  return text.replace(/^0+(?=\.)/, '');
}

// The label of one species on a site: the species then the site ("SiT1",
// "Fe2+M1"), the species alone when the site is named by a bare element
// symbol ("K" site: K, Na, Rb; "F" site: F, OH), or the species in place of
// the element when the site is an element and a number ("Y1": Y1, Yb1;
// "F3": F3, OH3).
function siteSpeciesLabel(species, site) {
  const element = UnitCell.elementOf(site);
  if (element === site) return species;
  if (element && /^\d+[a-z]?$/.test(site.slice(element.length))) return species + site.slice(element.length);
  return species + site;
}

// Rows with each site that has contents replaced by one row per species,
// same coordinates and displacement parameters, with its occupancy. used
// collects the sites found.
function applySiteContents(rows, sites, used) {
  return rows.flatMap(row => {
    const species = sites.get(row[0]);
    if (!species) return [row];
    used.add(row[0]);
    return species.map(({ species: s, occ }) => {
      const copy = [...row];
      copy[0] = siteSpeciesLabel(s, row[0]);
      copy[4] = amcOccupancy(occ);
      return copy;
    });
  });
}

// --- Charge balance ---
// The usual charge of each element, for a label that doesn't give one
// ("Fe2+M1" does). Elements with more than one common charge take the one
// listed; a label can always say otherwise.
const USUAL_CHARGE = {
  H: 1, Li: 1, Be: 2, B: 3, C: 4, O: -2, F: -1, Na: 1, Mg: 2, Al: 3, Si: 4, P: 5, Cl: -1,
  K: 1, Ca: 2, Sc: 3, Ti: 4, V: 5, Cr: 3, Mn: 2, Fe: 2, Co: 2, Ni: 2, Cu: 2, Zn: 2, Ga: 3,
  Ge: 4, As: 5, Br: -1, Rb: 1, Sr: 2, Y: 3, Zr: 4, Nb: 5, Mo: 6, Ag: 1, Cd: 2, In: 3, Sn: 4,
  Sb: 3, I: -1, Cs: 1, Ba: 2, La: 3, Ce: 3, Pr: 3, Nd: 3, Sm: 3, Eu: 3, Gd: 3, Tb: 3, Dy: 3,
  Ho: 3, Er: 3, Tm: 3, Yb: 3, Lu: 3, Hf: 4, Ta: 5, W: 6, Hg: 2, Tl: 1, Pb: 2, Bi: 3, Th: 4, U: 6,
};

// The charge one atom with this label carries: OH -1, water 0, a charge in
// the label ("Fe3+M1"), or its element's usual one; null when unknown.
function labelCharge(label) {
  if (/^Wat/i.test(label)) return 0;
  if (/^O-?H/.test(label)) return -1;
  const element = UnitCell.elementOf(label);
  if (!element) return null;
  const given = label.slice(element.length).match(/^(\d)([+-])/);
  if (given) return Number(given[1]) * (given[2] === '-' ? -1 : 1);
  return Object.prototype.hasOwnProperty.call(USUAL_CHARGE, element) ? USUAL_CHARGE[element] : null;
}

// Positive and negative charge per formula unit of the expanded unit cell,
// with the labels whose charge isn't known, or null without atoms.
function chargeBalance(atoms, Z) {
  let positive = 0;
  let negative = 0;
  const unknown = new Set();
  for (const atom of atoms) {
    const charge = labelCharge(atom.label);
    if (charge === null) { unknown.add(atom.label); continue; }
    const amount = charge * (Number.isFinite(atom.occ) ? atom.occ : 1);
    if (amount > 0) positive += amount; else negative -= amount;
  }
  return { positive: positive / Z, negative: negative / Z, unknown: [...unknown] };
}

function chargeBalanceNote({ positive, negative, unknown }, name) {
  const difference = positive - negative;
  const text = `${name}Charge per formula unit +${positive.toFixed(2)} / -${negative.toFixed(2)} (${difference >= 0 ? '+' : ''}${difference.toFixed(2)}).`;
  return unknown.length ? `${text} No charge known for ${unknown.join(', ')}.` : text;
}

// The scale powers to use for a dataset. A scaled table prints whole numbers
// ("3375(1)"), so a column whose values mostly have a decimal point already
// ("0.7940(3)", "1.64(5)") is taken as unscaled whatever the scale box says,
// and that is noted. Isotropic and anisotropic values of 10 or more are
// taken as still scaled ("12.5" under U x 10^3).
function datasetPowers(dataset, options, notes, name) {
  const tokens = kind => dataset.atoms.flatMap(atom => (kind === 'aniso' ? Object.values(atom.values.aniso) : [atom.values[kind]]))
    .filter(t => t !== undefined && parseFloat(t) !== 0 && !t.includes('/'));
  const unscaled = (list, limit) => list.length > 0
    && list.filter(t => parsePaperValue(t).fracPart !== '' && Math.abs(parseFloat(t)) < limit).length * 2 > list.length;
  const powers = { ...options };
  const plain = [];
  if (options.xyzPower && unscaled(['x', 'y', 'z'].flatMap(tokens), 2)) { powers.xyzPower = 0; plain.push('coordinates'); }
  if (options.isoPower && unscaled(tokens('iso'), 10)) { powers.isoPower = 0; plain.push('isotropic values'); }
  if (options.anisoPower && unscaled(tokens('aniso'), 10)) { powers.anisoPower = 0; plain.push('anisotropic values'); }
  if (plain.length) notes.push(`${name}The ${plain.join(' and ')} already have decimal points, so they weren't scaled.`);
  // β(i,j) are small (β11 of .0255 is a B of about 2 in a 5 Å cell); when most
  // atoms have a diagonal term of .1 or more, the paper printed them x 10^4
  // (or 10^5), not the scale box's power, so the power is raised until they fit.
  if (dataset.anisoConvention === 'B' && powers.anisoPower) {
    const diagonals = dataset.atoms.map(a => ['11', '22', '33'].map(ij => a.values.aniso[ij]).filter(t => t !== undefined)).filter(d => d.length);
    const tooBig = power => diagonals.filter(d => d.some(t => Math.abs(parseFloat(scalePaperValue(parsePaperValue(t), power))) >= 0.1)).length * 2 > diagonals.length;
    const given = powers.anisoPower;
    while (powers.anisoPower < given + 2 && tooBig(powers.anisoPower)) powers.anisoPower++;
    if (powers.anisoPower !== given) notes.push(`${name}β(i,j) scaled by 10^${powers.anisoPower}, not 10^${given}: at 10^${given} they would be far too large for β.`);
  }
  return powers;
}

const PAPER_CELL_PLACEHOLDER = 'a b c alpha beta gamma spacegroup';

// The AMC text for every dataset of the pasted tables, one after another,
// each with the optional header lines (mineral, authors, journal, title) in
// front, a "Sample:" line naming it when it has a title, its cell line, and
// its atom table. options: { xyzPower, isoPower, anisoPower, allowThirds,
// cellText, siteText (see readSiteContents), headerText }. Returns { text, notes, count }.
function buildAmcFromPaperTables(tableText, options) {
  tableText = normalizeMinusSigns(tableText);
  options = { ...options, cellText: normalizeMinusSigns(options.cellText || ''), headerText: normalizeMinusSigns(options.headerText || '') };
  const { datasets, notes } = readPaperTables(tableText, options, options.columnsText || '');
  if (!datasets.some(d => d.atoms.length)) {
    const why = notes.length ? ` ${[...new Set(notes)].slice(0, 3).join(' ')}` : '';
    throw new Error(`No atom rows could be read (an atom label followed by numbers, e.g. "M 3375(1) 0 2500 8(1)").${why}`);
  }
  const cells = readCellLines(options.cellText || '');
  notes.push(...cells.notes);
  let headerLines = (options.headerText || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  // An AMCSD code belongs to one record, so it is left off when the paper
  // gives several datasets, each of which will be a record of its own.
  const codeLine = l => /^_database_code_amcsd\b/i.test(l.trim());
  if (datasets.filter(d => d.atoms.length).length > 1 && headerLines.some(codeLine)) {
    headerLines = headerLines.filter(l => !codeLine(l));
    notes.push('The _database_code_amcsd line was left off, as each dataset will be a record with its own code.');
  }
  const contents = readSiteContents(normalizeMinusSigns(options.siteText || ''));
  notes.push(...contents.notes);
  const usedSites = new Set();

  const blocks = [];
  const missingCells = [];
  datasets.filter(d => d.atoms.length).forEach((dataset, index) => {
    const named = dataset.title && cells.byTitle.find(entry => sameTitle(entry.title, dataset.title));
    const positional = !dataset.title && cells.byTitle.length === datasets.length ? cells.byTitle[index] : null;
    const cell = (named || positional || {}).cell || cells.shared;
    const spaceGroup = cell && (cell.spaceGroup || cells.spaceGroup);
    const allowThirds = cell ? isHexagonalOrRhombohedral(cell) : options.allowThirds;

    const thirdLike = [];
    const several = datasets.filter(d => d.atoms.length).length > 1;
    const name = dataset.title ? `${dataset.title}: ` : several ? `Dataset ${index + 1}: ` : '';
    // A site the paper labels with two species ("F, OH") is split evenly
    // unless the site contents say how.
    const sites = new Map(contents.sites);
    const evenSplits = [];
    const fromTable = [];
    for (const atom of dataset.atoms) {
      const site = normalizeAtomLabel(atom.label);
      if (atom.contents && !sites.has(site)) {
        // The table's occupancy column says what is on the site; Site contents override it.
        sites.set(site, atom.contents.map(({ species, occ }) => ({ species: species === 'H2O' ? 'Wat' : species, occ })));
        fromTable.push(`${site} ${atom.contents.map(p => p.species + amcOccupancy(p.occ)).join(' ')}`);
        continue;
      }
      if (!atom.shared || sites.has(site)) continue;
      const share = amcOccupancy((1 / atom.shared.length).toFixed(2).replace(/0+$/, ''));
      sites.set(site, atom.shared.map(species => ({ species, occ: share })));
      evenSplits.push(`${site} ${atom.shared.map(s => s + share).join(' ')}`);
    }
    if (evenSplits.length) notes.push(`${name}Split evenly, as the table doesn't say how: ${evenSplits.join('; ')}. Give the real split under Site contents.`);
    if (fromTable.length) notes.push(`${name}Site contents taken from the table's occupancy column: ${fromTable.join('; ')}.`);
    const powers = datasetPowers(dataset, options, notes, name);
    const siteRows = paperDatasetRows(dataset, powers, allowThirds, thirdLike);
    const rows = applySiteContents(siteRows, sites, usedSites);
    const noElement = rows.map(row => row[0]).filter(label => labelCharge(label) === null && !UnitCell.elementOf(label));
    // Hydrogen's displacement is large by nature, so it is left out of this check.
    const heavyRows = siteRows.filter(row => !['H', 'D'].includes(UnitCell.elementOf(row[0])));
    const isoValues = heavyRows.map(row => parseFloat(row[5])).filter(Number.isFinite).sort((a, b) => a - b);
    const median = isoValues[Math.floor((isoValues.length - 1) / 2)];
    const outliers = heavyRows.filter(row => parseFloat(row[5]) > 4 * median).map(row => row[0]);
    if (isoValues.length >= 4 && outliers.length) notes.push(`${name}Check the isotropic value of ${outliers.join(', ')}: it is far above the others (median ${median}).`);
    if (noElement.length) notes.push(`${name}${noElement.join(', ')} ${noElement.length === 1 ? 'names' : 'name'} no element; say what's on ${noElement.length === 1 ? 'it' : 'them'} under Site contents (e.g. ${noElement[0]} Si.85 Al.15).`);
    if (thirdLike.length) {
      notes.push(`${name}${thirdLike.join(', ')} ${thirdLike.length === 1 ? 'looks' : 'look'} like 1/3 or 2/3, which are only special positions in a hexagonal or rhombohedral cell.`);
    }
    const big = rows.filter(row => row.slice(1, 4).some(v => Math.abs(amcNumber(v)) > 1.5)).map(row => row[0]);
    if (big.length) notes.push(`${name}${big.join(', ')} ${big.length === 1 ? 'has a coordinate' : 'have coordinates'} over 1.5; check the coordinate scale.`);

    const isoLabel = dataset.isoConvention === 'B' ? 'Biso' : 'Uiso';
    const anisoLabel = dataset.anisoConvention || 'U';
    let cellLine = PAPER_CELL_PLACEHOLDER;
    if (cell && spaceGroup) cellLine = ['a', 'b', 'c', 'alpha', 'beta', 'gamma'].map(k => cell[k]).concat(spaceGroup).join(' ');
    else missingCells.push(dataset.title || `dataset ${index + 1}`);

    const block = [
      ...headerLines,
      ...(dataset.title ? [`Sample: ${dataset.title}`] : []),
      cellLine,
      ...formatAmcAtomTable(rows, isoLabel, anisoLabel),
    ].join('\n');

    // A complete dataset is checked by building its unit cell, which catches
    // a space group the symmetry list doesn't have.
    if (cellLine !== PAPER_CELL_PLACEHOLDER && typeof unitCellFromAmc === 'function') {
      try {
        const [unitCell] = unitCellFromAmc(headerLines.length ? block : `x\n${block}`);
        const chem = UnitCell.chemistry(unitCell.atoms, unitCell.cell);
        if (!noElement.length) {
          notes.push(`${name}Formula ${chem.formula}, Z = ${chem.Z}.`);
          notes.push(chargeBalanceNote(chargeBalance(unitCell.atoms, chem.Z), name));
        }
      } catch (err) {
        notes.push(`${name}${err.message}`);
      }
    }
    blocks.push(block);
  });

  const unusedSites = [...contents.sites.keys()].filter(site => !usedSites.has(site));
  if (unusedSites.length) notes.push(`Site contents for ${unusedSites.join(', ')} match no atom in the table.`);
  if (missingCells.length) {
    notes.push(`No cell parameters and space group for ${missingCells.join(', ')}: replace the "${PAPER_CELL_PLACEHOLDER}" line, or add them below the table.`);
  }
  return { text: `${blocks.join('\n\n')}\n`, notes, count: blocks.length };
}

// --- Page ---

if (typeof document !== 'undefined' && document.getElementById('tableToAmcSection')) {
  const field = id => document.getElementById(id);
  const power = id => {
    const n = parseInt(field(id).value, 10);
    return Number.isFinite(n) ? n : 0;
  };

  // Once the output is edited by hand (its Edit button, set up in app.js),
  // changes to the boxes above no longer replace it, so the edits aren't lost;
  // "Discard edits" goes back to the converted output.
  let handEdited = false;
  const discardButton = field('discardTableToAmcEditsBtn');
  const HAND_EDITED_NOTE = "The output has been edited by hand, so changes above aren't applied to it; Discard edits to update it.";

  // The status box: a headline, then the notes as a list that can be
  // minimized; whether it is open is kept across conversions and visits.
  const NOTES_OPEN_KEY = 'cifViewerTableNotesOpen';
  let notesOpen = true;
  try { notesOpen = localStorage.getItem(NOTES_OPEN_KEY) !== '0'; } catch (e) { /* no storage */ }

  const showStatus = (headline, notes = [], isError = false) => {
    const status = field('tableToAmcStatus');
    status.replaceChildren();
    status.classList.toggle('error', isError);
    if (!headline) return;
    if (!notes.length) {
      const title = document.createElement('p');
      title.textContent = headline;
      status.append(title);
      return;
    }
    const details = document.createElement('details');
    details.open = notesOpen;
    const summary = document.createElement('summary');
    summary.textContent = headline;
    const list = document.createElement('ul');
    for (const note of notes) {
      const item = document.createElement('li');
      item.textContent = note;
      list.append(item);
    }
    details.append(summary, list);
    details.addEventListener('toggle', () => {
      notesOpen = details.open;
      try { localStorage.setItem(NOTES_OPEN_KEY, notesOpen ? '1' : '0'); } catch (e) { /* no storage */ }
    });
    status.append(details);
  };

  const convertPaperTables = () => {
    const output = field('tableToAmcOutput');
    const tableText = field('tableInput').value;
    if (handEdited) {
      showStatus(HAND_EDITED_NOTE);
      return;
    }
    if (!tableText.trim()) {
      output.value = '';
      showStatus('');
      autoSizeTextarea(output);
      return;
    }
    try {
      const { text, notes, count } = buildAmcFromPaperTables(tableText, {
        xyzPower: power('tableXyzPower'),
        isoPower: power('tableIsoPower'),
        anisoPower: power('tableAnisoPower'),
        allowThirds: field('tableHexagonal').checked,
        columnsText: field('tableColumnsInput').value,
        cellText: field('tableCellInput').value,
        siteText: field('tableSiteInput').value,
        headerText: field('tableHeaderInput').value,
      });
      output.value = toAscii(text);
      const unique = [...new Set(notes)];
      showStatus(`${count} dataset${count === 1 ? '' : 's'}${unique.length ? ` · ${unique.length} note${unique.length === 1 ? '' : 's'}` : ''}`, unique);
    } catch (err) {
      output.value = '';
      showStatus(err.message, [], true);
    }
    autoSizeTextarea(output);
  };

  // The header comes from the record loaded from ?UUID= (the CIF -> AMC
  // Header box's header, up to its cell line), whenever the record or its CIF
  // loads - unless the header box has been edited since it was last filled.
  let filledHeader = '';
  const recordHeader = () => {
    if (typeof currentApiRecord === 'undefined' || !currentApiRecord) return '';
    const data = currentCifData || { blockName: '', tags: {}, loops: [], blocks: [] };
    const lines = buildAmcHeader(data, currentApiRecord, currentFileName).split('\n');
    const end = lines.findIndex(l => isAmcCellLine(l) || isAtomTableHeaderLine(l));
    return (end === -1 ? lines : lines.slice(0, end)).join('\n');
  };
  document.addEventListener('amcheaderchange', () => {
    const box = field('tableHeaderInput');
    if (box.value.trim() && box.value !== filledHeader) return;
    let header = '';
    try { header = recordHeader(); } catch (err) { return; }
    if (!header) return;
    box.value = filledHeader = header;
    convertPaperTables();
  });

  ['tableInput', 'tableColumnsInput', 'tableCellInput', 'tableSiteInput', 'tableHeaderInput', 'tableXyzPower', 'tableIsoPower', 'tableAnisoPower', 'tableHexagonal']
    .forEach(id => field(id).addEventListener('input', convertPaperTables));
  field('tableToAmcOutput').addEventListener('input', () => {
    handEdited = true;
    discardButton.hidden = false;
  });
  discardButton.addEventListener('click', () => {
    handEdited = false;
    discardButton.hidden = true;
    const output = field('tableToAmcOutput');
    const edit = field('editTableToAmcBtn');
    if (!output.readOnly) edit.click();
    convertPaperTables();
  });
  field('copyTableToAmcBtn').addEventListener('click', () => copyTextarea('tableToAmcOutput'));
  field('downloadTableToAmcBtn').addEventListener('click', () => {
    const text = field('tableToAmcOutput').value;
    if (!text) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    link.download = 'tables.amc';
    link.click();
    URL.revokeObjectURL(link.href);
  });
}
