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
  const columns = headerWords(tokens).map(scannedColumn).filter(Boolean);
  const kinds = new Set(columns.map(c => c.kind));
  const hasXyz = ['x', 'y', 'z'].every(k => kinds.has(k));
  const terms = new Set(columns.filter(c => c.kind === 'aniso').map(c => c.ij));
  if (!hasXyz && terms.size !== 6) return null;
  // Half a set of U(i,j) can't be told apart from a row of numbers, so it is left out.
  const usable = terms.size === 6 ? columns : columns.filter(c => c.kind !== 'aniso');
  return { columns: usable, hasXyz };
}

// A header's column words (without the label column's), with a scan's
// misread x y z put right. The column grid reads headers the same way.
function headerWords(tokens) {
  // A scan often misreads the italic x, y and z ("ae y eZ B", "rda yfo z/c"):
  // when the three words before the other columns aren't all read as x, y
  // and z but one of them is, and the rest read as columns, they are taken
  // as x y z.
  const axes = tokens.slice(0, 3).map(scannedColumn);
  const isAxis = (c, k) => c && c.kind === k;
  // x, y and z read cleanly in another order ("y x z", columns picked that way) are kept as they are.
  const cleanAxes = new Set(axes.filter(c => c && ['x', 'y', 'z'].includes(c.kind)).map(c => c.kind)).size === 3;
  const scanned = tokens.length >= 3 && !cleanAxes
    && ['x', 'y', 'z'].some((k, i) => isAxis(axes[i], k) || /^[xyz]/i.test(tokens[i]))
    && tokens.slice(0, 3).every(t => t.length <= 4) && tokens.slice(3).every(scannedColumn);
  return scanned ? ['x', 'y', 'z', ...tokens.slice(3)] : tokens;
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
// A line that is an atom row with values that can't be read ("M 3375(1) 0 8(1)0"):
// a label, then mostly values. Its unreadable tokens, or null when it isn't one.
function brokenAtomRow(tokens) {
  if (tokens.length < 4 || isPaperValue(tokens[0]) || LABEL_COLUMN_RE.test(tokens[0])) return null;
  const rest = tokens.slice(1);
  const bad = rest.filter(t => !isPaperValue(t));
  return bad.length && rest.length - bad.length >= 2 && (rest.length - bad.length) * 2 >= rest.length ? bad : null;
}

// anisoText is a separate U(i,j) table pasted on its own, with its columns in
// anisoColumnsText (the six terms, in the paper's order); its rows add to the
// atoms of the same labels, as a second header in the main paste does.
function readPaperTables(text, powers, columnsText = '', anisoText = '', anisoColumnsText = '') {
  const datasets = [];
  const notes = [];
  // Columns the user typed replace any header in the paste.
  let typed = columnsText.trim() ? readPaperHeader(paperTableTokens(columnsText)) : null;
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

  const readLine = line => {
    const tokens = paperTableTokens(line);
    if (!tokens.length) return;

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
        if (!warnedNoHeader) notes.push('No header row found: the column names were guessed from how many values each row has (x y z, then Uiso, U11 to U23, occupancy); check them above the table.');
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
      if (current.skip) return;
      const { label, values, dropped } = row;
      if (dropped.length) notes.push(`"${tokens.slice(0, tokens.length - values.length).join(' ')}" was read as the label ${label}.`);
      const columns = rowColumns(header.columns, values, powers);
      if (!columns) {
        notes.push(`${label}${current.title ? ` (${current.title})` : ''} has ${values.length} values, which doesn't fit the header's columns; it was left out.`);
        return;
      }
      let atom = current.atoms.find(a => a.label === label);
      if (!header.hasXyz && !atom) {
        notes.push(`${label}${current.title ? ` (${current.title})` : ''} has U(i,j) but no coordinates; it was left out.`);
        return;
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
      return;
    }

    const newHeader = readPaperHeader(tokens);
    if (newHeader) {
      if (!typed) header = newHeader;
      current = null;
      pendingTitle = '';
      supplementGroup = -1;
      return;
    }

    // A header row too garbled to read ("Atom ...") isn't a dataset title;
    // the columns are worked out from the rows (or typed under Columns).
    if (LABEL_COLUMN_RE.test(tokens[0]) && tokens.length >= 4) {
      if (!typed) notes.push(`Couldn't read the header "${line.trim()}"; choose the columns above the table if the values come out in the wrong places.`);
      current = null;
      pendingTitle = '';
      return;
    }

    // An atom row with a value that can't be read ("8(1)0") is pointed out
    // rather than taken for a dataset title, which would lose the row.
    const bad = brokenAtomRow(tokens);
    if (bad) {
      notes.push(`${tokens[0]}: couldn't read ${bad.map(t => `"${t}"`).join(', ')} as ${bad.length === 1 ? 'a number' : 'numbers'}, so the row was left out; fix ${bad.length === 1 ? 'it' : 'them'} in the table (marked red).`);
      return;
    }

    // A row whose label reads as a number (a scan's "01" for O1) can't be told
    // from a row of values, so it is pointed out rather than guessed at.
    if (header && tokens.length >= 4 && tokens.every(isPaperValue)) {
      notes.push(`"${line.trim()}" starts with a number, not an atom label; it was left out.`);
      return;
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
      return;
    }

    // A caption, a footnote, or a dataset title: whichever line comes last
    // before a block of rows titles it.
    current = null;
    pendingTitle = cleanTitle(line);
  };

  text.replace(/\r\n?/g, '\n').split('\n').forEach(readLine);

  if (anisoText.trim()) {
    const columns = anisoColumnsText.trim() || AMC_ANISO_ORDER.map(ij => `U${ij}`).join(' ');
    typed = readPaperHeader(paperTableTokens(columns));
    if (!typed || typed.hasXyz) {
      notes.push(`Couldn't read the U(i,j) table's columns "${columns}"; they need the six terms (e.g. U11 U22 U33 U23 U13 U12).`);
    } else {
      header = typed;
      current = null;
      pendingTitle = '';
      supplementGroup = -1;
      anisoText.replace(/\r\n?/g, '\n').split('\n').forEach(readLine);
    }
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
// A space group starred for a shifted origin ("*Fd-3m", as AMCSD writes it)
// takes the shift from the next line, three values ("1/8 1/8 1/8" or ".125 .125
// .125"), which is kept as `shift` and written after the cell line.
function readCellLines(text) {
  const result = { byTitle: [], shared: null, spaceGroup: '', notes: [] };
  let lastCell = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const tokens = paperTableTokens(line);
    if (!tokens.length) continue;
    const first = tokens.findIndex(isPaperValue);
    if (first === -1) {
      if (tokens.length === 1) result.spaceGroup = tokens[0];
      else result.notes.push(`Couldn't read the cell line "${line.trim()}".`);
      lastCell = null;
      continue;
    }
    if (first === 0 && tokens.length === 3 && tokens.every(isPaperValue) && lastCell && lastCell.spaceGroup.startsWith('*')) {
      lastCell.shift = tokens.join(' ');
      lastCell = null;
      continue;
    }
    let last = first;
    while (last < tokens.length && isPaperValue(tokens[last])) last++;
    const numbers = tokens.slice(first, last).map(t => t.replace(/\(\d+\)$/, ''));
    const title = cleanTitle(tokens.slice(0, first).join(' '));
    // A footnote mark after the symbol ("Cccm*") is dropped; a leading star is AMC's shifted origin.
    const spaceGroup = tokens.slice(last).join('').replace(/(.)\*+$/, '$1');
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
    lastCell = cell;
  }
  return result;
}

// Each cell line's space group checked against the space group list (the
// symmetry database's groups and settings), as [{ title, spaceGroup, ok,
// message }], for showing under the cell box as it is typed.
function checkCellLines(text) {
  const cells = readCellLines(normalizeMinusSigns(text || ''));
  const entries = [...cells.byTitle, ...(cells.shared ? [{ title: '', cell: cells.shared }] : [])];
  const checks = entries.map(({ title, cell }) => {
    const raw = cell.spaceGroup || cells.spaceGroup;
    if (!raw) return { title, spaceGroup: '', ok: false, message: 'no space group after the six numbers' };
    try {
      const ops = amcSymmetryMatrices({ ...cell, spaceGroup: raw.replace(/^\*/, ''), starred: raw.startsWith('*') }, cell.shift);
      return { title, spaceGroup: raw, ok: true, message: `${ops.length} symmetry operations${cell.shift ? `, origin shifted by ${cell.shift}` : ''}` };
    } catch (err) {
      return { title, spaceGroup: raw, ok: false, message: err.message };
    }
  });
  return { checks, notes: cells.notes };
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

// --- Site occupancies ---
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

// { site: [{ species, occ }] } from the site occupancies text, plus notes.
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
    if (unread.length) notes.push(`Couldn't read ${unread.join(', ')} in the site occupancies of ${site} (write each as an element and its occupancy, e.g. Al.15).`);
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
// cellText, siteText (see readSiteContents), headerText, idealFormula (the
// record's IMA formula, which sets the scale of Z) }. Returns { text, notes, count }.
function buildAmcFromPaperTables(tableText, options) {
  tableText = normalizeMinusSigns(tableText);
  options = { ...options, cellText: normalizeMinusSigns(options.cellText || ''), headerText: normalizeMinusSigns(options.headerText || '') };
  const { datasets, notes } = readPaperTables(tableText, options, options.columnsText || '', normalizeMinusSigns(options.anisoTableText || ''), options.anisoColumnsText || '');
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
  const formulas = [];
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
    // unless the site occupancies say how.
    const sites = new Map(contents.sites);
    const evenSplits = [];
    const fromTable = [];
    for (const atom of dataset.atoms) {
      const site = normalizeAtomLabel(atom.label);
      if (atom.contents && !sites.has(site)) {
        // The table's occupancy column says what is on the site; Site occupancies override it.
        sites.set(site, atom.contents.map(({ species, occ }) => ({ species: species === 'H2O' ? 'Wat' : species, occ })));
        fromTable.push(`${site} ${atom.contents.map(p => p.species + amcOccupancy(p.occ)).join(' ')}`);
        continue;
      }
      if (!atom.shared || sites.has(site)) continue;
      const share = amcOccupancy((1 / atom.shared.length).toFixed(2).replace(/0+$/, ''));
      sites.set(site, atom.shared.map(species => ({ species, occ: share })));
      evenSplits.push(`${site} ${atom.shared.map(s => s + share).join(' ')}`);
    }
    if (evenSplits.length) notes.push(`${name}Split evenly, as the table doesn't say how: ${evenSplits.join('; ')}. Give the real split under Site occupancies.`);
    if (fromTable.length) notes.push(`${name}Site occupancies taken from the table's occupancy column: ${fromTable.join('; ')}.`);
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
    if (noElement.length) notes.push(`${name}${noElement.join(', ')} ${noElement.length === 1 ? 'names' : 'name'} no element; say what's on ${noElement.length === 1 ? 'it' : 'them'} under Site occupancies (e.g. ${noElement[0]} Si.85 Al.15).`);
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
    const shiftLines = cell && cell.shift && spaceGroup.startsWith('*') ? [cell.shift] : [];

    const block = [
      ...headerLines,
      ...(dataset.title ? [`Sample: ${dataset.title}`] : []),
      cellLine,
      ...shiftLines,
      ...formatAmcAtomTable(rows, isoLabel, anisoLabel),
    ].join('\n');

    // A complete dataset is checked by building its unit cell, which catches
    // a space group the symmetry list doesn't have.
    if (cellLine !== PAPER_CELL_PLACEHOLDER && typeof unitCellFromAmc === 'function') {
      try {
        const [unitCell] = unitCellFromAmc(headerLines.length ? block : `x\n${block}`);
        const chem = UnitCell.chemistry(unitCell.atoms, unitCell.cell, { symmetryCount: unitCell.symmetryCount, idealFormula: options.idealFormula });
        if (!noElement.length) {
          formulas.push({ name: name.replace(/: $/, ''), formula: chem.formula, Z: chem.Z, charge: chargeBalanceNote(chargeBalance(unitCell.atoms, chem.Z), '') });
        }
      } catch (err) {
        notes.push(`${name}${err.message}`);
      }
    }
    blocks.push(block);
  });

  const unusedSites = [...contents.sites.keys()].filter(site => !usedSites.has(site));
  if (unusedSites.length) notes.push(`Site occupancies for ${unusedSites.join(', ')} match no atom in the table.`);
  if (missingCells.length) {
    notes.push(`No cell parameters and space group for ${missingCells.join(', ')}: fill in Cell parameters and space group.`);
  }
  return { text: `${blocks.join('\n\n')}\n`, notes, count: blocks.length, formulas };
}

// --- Column grid ---
// A pasted table shown as rows and columns: each cell can be edited (an
// emptied cell is removed, which clears a stray token), a row can be removed,
// and above each column a list says what it holds, picked from the AMC
// column names (or "leave out", for a column that shouldn't go into the AMC).
// Edits are written back into the paste box, which stays the one source.

const GRID_COLUMN_CHOICES = [
  ['x', 'x'], ['y', 'y'], ['z', 'z'],
  ['Uiso', 'Uiso / Ueq'], ['Biso', 'Biso / Beq'], ['occ', 'Occ'],
  ...['U', 'B', 'beta'].flatMap(p => AMC_ANISO_ORDER.map(ij => [`${p}${ij}`, `${p === 'beta' ? 'β' : p}${ij}`])),
  ['skip', 'leave out'],
];

// What one header word names, as a GRID_COLUMN_CHOICES key ('skip' when none).
function gridColumnKey(word) {
  const c = scannedColumn(word);
  if (!c) return 'skip';
  if (c.kind === 'iso') return c.convention === 'B' ? 'Biso' : 'Uiso';
  if (c.kind === 'aniso') return c.convention === 'U' ? `U${c.ij}` : /^b(?!eta)/i.test(word) ? `B${c.ij}` : `beta${c.ij}`;
  return c.kind;
}

// 'header', 'atom' (an atom row, readable or not) or 'text' (a title or caption).
function gridLineKind(tokens) {
  if (readPaperHeader(tokens)) return 'header';
  if (paperAtomRow(tokens) || brokenAtomRow(tokens)) return 'atom';
  if (/^0\d{1,2}$/.test(tokens[0]) && tokens.length >= 4 && tokens.slice(1).every(isPaperValue)) return 'atom';
  return 'text';
}

// The column choices a header line gives, one per value column.
function gridHeaderKeys(tokens) {
  return headerWords(LABEL_COLUMN_RE.test(tokens[0]) ? tokens.slice(1) : tokens).map(gridColumnKey);
}

const MAIN_DEFAULT_KEYS = ['x', 'y', 'z', 'Uiso', ...AMC_ANISO_ORDER.map(ij => `U${ij}`), 'occ'];
const ANISO_DEFAULT_KEYS = AMC_ANISO_ORDER.map(ij => `U${ij}`);

// U, B or β: the convention a column name is in (null for x, y, z, occ, leave out).
const columnFamily = key => (key === 'Uiso' || /^U\d/.test(key) ? 'U' : key === 'Biso' || /^B\d/.test(key) ? 'B' : /^beta/.test(key) ? 'beta' : null);

// A column name moved to another convention: Uiso <-> Biso (β's isotropic
// term is a B), U11 <-> B11 <-> β11.
function inFamily(key, family) {
  if (!family || !columnFamily(key)) return key;
  if (key === 'Uiso' || key === 'Biso') return family === 'U' ? 'Uiso' : 'Biso';
  return key.replace(/^(U|B|beta)/, family);
}

// The names in the order papers print them, in one convention. In the
// U(i,j) box the six terms come first, then the isotropic term.
function columnSequence(family, anisoOnly) {
  const iso = family === 'U' ? 'Uiso' : 'Biso';
  const aniso = AMC_ANISO_ORDER.map(ij => `${family}${ij}`);
  return anisoOnly ? [...aniso, iso] : ['x', 'y', 'z', iso, ...aniso, 'occ'];
}

// The column names after column i is set to value:
//  - a U, B or β name puts every isotropic and anisotropic column in that
//    convention (Biso makes U11 B11; β11 makes Uiso Biso);
//  - a column to the left that had the name takes column i's old one;
//  - each column to the right (except those left out) takes the next name
//    in the usual order not already used to its left, so picking Uiso puts
//    U11 U22 ... after it, and picking U23 then U13 follows the paper's order.
function relabelColumns(choices, i, value, anisoOnly) {
  const family = columnFamily(value) || choices.map(columnFamily).find(Boolean) || 'U';
  const next = choices.map(k => inFamily(k, columnFamily(value)));
  const previous = inFamily(choices[i], family);
  next[i] = value;
  if (value !== 'skip') {
    const left = next.findIndex((k, j) => j < i && k === value);
    if (left !== -1) next[left] = previous;
  }
  // Only the convention changed (Uiso to Biso, U11 to β11): the order stays.
  if (previous === value) return next;
  const sequence = columnSequence(family, anisoOnly);
  for (let j = i + 1; j < next.length; j++) {
    if (next[j] === 'skip') continue;
    const used = new Set(next.slice(0, j));
    next[j] = sequence.find(k => !used.has(k)) || 'skip';
  }
  return next;
}

function createPasteGrid({ textarea, container, status, defaults, onChange, anisoOnly }) {
  const grid = { choices: [], chosen: false, signature: '' };
  const lines = () => textarea.value.replace(/\r\n?/g, '\n').split('\n');
  const setLine = (index, text) => {
    const all = lines();
    all[index] = text;
    textarea.value = all.join('\n');
  };

  const analyse = () => {
    const rows = lines().map((line, index) => ({ index, tokens: paperTableTokens(line) }))
      .filter(r => r.tokens.length)
      .map(r => ({ ...r, kind: gridLineKind(r.tokens) }));
    const header = rows.find(r => r.kind === 'header');
    const width = Math.max(0, ...rows.filter(r => r.kind === 'atom').map(r => r.tokens.length - 1));
    return { rows, header, width };
  };

  // Without a header: the defaults in order; in the U(i,j) box the six terms
  // come last, after a Ueq or columns to leave out.
  const defaultKeys = width => {
    if (anisoOnly) {
      const extra = Math.max(0, width - 6);
      return [...Array(extra).fill(extra === 1 ? 'Uiso' : 'skip'), ...ANISO_DEFAULT_KEYS].slice(0, width);
    }
    return Array.from({ length: width }, (_, i) => defaults[i] || 'skip');
  };

  // The columns line for the parser. In the main box it is '' (the parser
  // reads the paste's own headers, and without one works the columns out from
  // each row's number of values) until a column is chosen or left out.
  grid.columnsText = () => {
    if (!anisoOnly && !grid.chosen && !grid.choices.includes('skip')) return '';
    return grid.choices.filter(k => k !== 'skip').join(' ');
  };

  // Column names picked for more than one column, which the parser can't place.
  grid.duplicates = () => [...new Set(grid.choices.filter((k, i) => k !== 'skip' && grid.choices.indexOf(k) !== i))]
    .map(k => GRID_COLUMN_CHOICES.find(([value]) => value === k)[1]);

  // The paste with left-out columns taken off its atom rows.
  grid.text = () => {
    const skipped = new Set(grid.choices.map((k, i) => (k === 'skip' ? i + 1 : -1)).filter(i => i > 0));
    if (!skipped.size) return textarea.value;
    const all = lines();
    for (const { index, tokens, kind } of analyse().rows) {
      if (kind === 'atom') all[index] = tokens.filter((_, i) => !skipped.has(i)).join('  ');
    }
    return all.join('\n');
  };

  const cellInput = (value, className) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.className = className;
    input.spellcheck = false;
    input.size = Math.max(3, value.length + 1);
    return input;
  };

  // A value cell that doesn't read as a number is marked, as its row is left out.
  const markCell = (input, isLabel) => {
    const v = input.value.trim();
    input.classList.toggle('bad', !isLabel && v !== '' && v.split(/\s+/).some(t => !isPaperValue(t)));
    input.size = Math.max(3, input.value.length + 1);
  };

  const removeLine = index => {
    const all = lines();
    all.splice(index, 1);
    textarea.value = all.join('\n');
  };

  // The choices with columns added or removed where a row (the same line as
  // before, now longer or shorter by the change in width) gained or lost
  // values; null when no row shows where.
  const shiftedChoices = (rows, width) => {
    const delta = width - grid.choices.length;
    if (!delta || !grid.lastRows) return null;
    for (const row of rows) {
      const before = grid.lastRows.get(row.index);
      if (row.kind !== 'atom' || !before || row.tokens.length - before.length !== delta) continue;
      const longer = delta > 0 ? row.tokens : before;
      const shorter = delta > 0 ? before : row.tokens;
      let at = 1;
      while (at < shorter.length && shorter[at] === longer[at]) at++;
      let choices = [...grid.choices];
      if (delta > 0) choices.splice(at - 1, 0, ...Array(delta).fill('skip'));
      else choices.splice(at - 1, -delta);
      // The first three columns are x, y and z in nearly every paper, so they
      // stay there; a column added among them pushes the next name along.
      if (!anisoOnly && width >= 3 && ['x', 'y', 'z'].every(k => grid.choices.includes(k))) {
        choices = ['x', 'y', 'z', ...choices.filter(k => !['x', 'y', 'z'].includes(k))];
      }
      return choices.slice(0, width);
    }
    return null;
  };

  grid.render = () => {
    const { rows, header, width } = analyse();
    // A new paste (another number of columns or another header) starts the
    // choices over, except when values were typed into or deleted from a row:
    // then the columns keep their names and a new column (left out until it is
    // named) goes in where the values were added, or the name goes with them.
    const headerText = header ? header.tokens.join(' ') : '';
    const signature = `${width}|${headerText}`;
    if (signature !== grid.signature) {
      const shifted = grid.signature && grid.signature.endsWith(`|${headerText}`) ? shiftedChoices(rows, width) : null;
      grid.signature = signature;
      if (shifted) {
        grid.choices = shifted;
      } else {
        grid.chosen = false;
        const fromHeader = header ? gridHeaderKeys(header.tokens) : null;
        grid.choices = fromHeader && fromHeader.length === width ? fromHeader : defaultKeys(width);
      }
    }
    grid.lastRows = new Map(rows.filter(r => r.kind === 'atom').map(r => [r.index, r.tokens]));

    status.replaceChildren();
    if (header) {
      status.append('Header row found: the column names below come from it. ');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link-button';
      remove.textContent = 'Remove header row';
      remove.addEventListener('click', () => {
        removeLine(header.index);
        // The choices it gave are kept.
        grid.signature = `${width}|`;
        grid.chosen = true;
        grid.render();
        onChange();
      });
      status.append(remove);
    } else if (width) {
      status.append('No header row found: pick what each column holds above the table, or "leave out" for a column that shouldn\'t go into the AMC file.');
    }

    container.replaceChildren();
    if (!width) return;
    const table = document.createElement('table');
    table.className = 'paste-grid';
    const head = table.createTHead().insertRow();
    const atomHead = document.createElement('th');
    atomHead.textContent = 'atom';
    head.append(atomHead);
    // Picking a column's name re-lays the columns after it (see relabelColumns).
    const selects = [];
    const showChoice = j => {
      selects[j].value = grid.choices[j];
      selects[j].classList.toggle('skip', grid.choices[j] === 'skip');
      table.querySelectorAll(`td[data-col="${j + 1}"]`).forEach(td => td.classList.toggle('skip', grid.choices[j] === 'skip'));
    };
    grid.choices.forEach((key, i) => {
      const th = document.createElement('th');
      const select = document.createElement('select');
      select.setAttribute('aria-label', `Column ${i + 2}`);
      for (const [value, label] of GRID_COLUMN_CHOICES) select.add(new Option(label, value, false, value === key));
      select.classList.toggle('skip', key === 'skip');
      select.addEventListener('change', () => {
        grid.choices = relabelColumns(grid.choices, i, select.value, anisoOnly);
        grid.chosen = true;
        grid.choices.forEach((_, j) => showChoice(j));
        onChange();
      });
      selects.push(select);
      th.append(select);
      head.append(th);
    });
    head.append(document.createElement('th'));

    const body = table.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      tr.className = `grid-${row.kind}`;
      if (row.kind === 'atom') {
        const inputs = [];
        for (let i = 0; i <= width; i++) {
          const td = tr.insertCell();
          td.dataset.col = i;
          if (i > 0 && grid.choices[i - 1] === 'skip') td.classList.add('skip');
          if (i >= row.tokens.length) continue;
          // A value is shown as it goes into the AMC, without its uncertainty
          // ("3375(1)" shows 3375). The uncertainty is kept in the paste, as it
          // tells a refined coordinate from a special position, and stays on
          // the value when the cell is edited.
          const su = i > 0 && isPaperValue(row.tokens[i]) ? (row.tokens[i].match(/\(\d+\)$/) || [''])[0] : '';
          const input = cellInput(su ? row.tokens[i].slice(0, -su.length) : row.tokens[i], i === 0 ? 'grid-label' : 'grid-value');
          input.dataset.su = su;
          if (su) input.title = `Printed as ${row.tokens[i]}`;
          markCell(input, i === 0);
          input.addEventListener('input', () => {
            markCell(input, i === 0);
            const token = inp => {
              const v = inp.value.trim();
              return v && inp.dataset.su && !/[\s(]/.test(v) ? v + inp.dataset.su : v;
            };
            setLine(row.index, inputs.map(token).filter(Boolean).join('  '));
            onChange();
          });
          // Once the edit is done the row is split again, so a cell typed as two values becomes two.
          input.addEventListener('change', () => grid.render());
          inputs.push(input);
          td.append(input);
        }
      } else {
        const td = tr.insertCell();
        td.colSpan = width + 1;
        const input = cellInput(lines()[row.index].trim(), 'grid-line');
        input.title = row.kind === 'header' ? 'Header row' : 'A title (it names the dataset below it) or a caption';
        input.addEventListener('input', () => { setLine(row.index, input.value); onChange(); });
        input.addEventListener('change', () => grid.render());
        td.append(input);
      }
      const removeCell = tr.insertCell();
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'grid-remove';
      remove.title = 'Remove this row';
      remove.setAttribute('aria-label', 'Remove this row');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        removeLine(row.index);
        grid.render();
        onChange();
      });
      removeCell.append(remove);
    }
    container.append(table);
  };

  textarea.addEventListener('input', () => { grid.render(); onChange(); });
  return grid;
}

// --- Page ---

if (typeof document !== 'undefined' && document.getElementById('tableToAmcSection')) {
  const field = id => document.getElementById(id);
  const power = id => {
    const n = parseInt(field(id).value, 10);
    return Number.isFinite(n) ? n : 0;
  };

  // The header fields, each filled from the record loaded with ?UUID= (see
  // amcHeaderFields in app.js) unless it has been typed in since. They only
  // make the AMC text here: nothing is written to the record.
  const HEADER_FIELDS = {
    tableNameInput: 'name',
    tableAuthorsInput: 'authors',
    tableJournalInput: 'journal',
    tableTitleInput: 'title',
    tableExtraInput: 'extra',
    tableLocalityInput: 'locality',
    tableCodeInput: 'code',
  };
  const headerText = () => {
    const fields = {};
    for (const [id, key] of Object.entries(HEADER_FIELDS)) fields[key] = normalizeMinusSigns(field(id).value);
    if (!Object.values(fields).some(v => v.trim())) return '';
    return amcHeaderLines(fields).flatMap(line => wrapText(toAscii(line), 80)).join('\n');
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

  // The formula worked out from the atoms, per dataset, updated with every edit.
  const showFormulas = formulas => {
    const box = field('tableFormula');
    box.replaceChildren();
    for (const { name, formula, Z, charge } of formulas) {
      const line = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = formula;
      line.append(`${name ? `${name}: ` : ''}Formula from the data `, strong, ` · Z = ${Z} · ${charge}`);
      box.append(line);
    }
  };

  // Each space group checked against the space group list as it is typed.
  const showCellChecks = () => {
    const box = field('tableCellCheck');
    box.replaceChildren();
    const { checks, notes } = checkCellLines(field('tableCellInput').value);
    for (const { title, spaceGroup, ok, message } of checks) {
      const item = document.createElement('li');
      item.className = ok ? 'ok' : 'bad';
      item.textContent = `${title ? `${title}: ` : ''}${spaceGroup ? `${spaceGroup}: ` : ''}${message}`;
      box.append(item);
    }
    for (const note of notes) {
      const item = document.createElement('li');
      item.className = 'bad';
      item.textContent = note;
      box.append(item);
    }
  };

  // The ideal formula of the record's IMA mineral, shown (not editable) by the name.
  const showIdealFormula = () => {
    const box = field('tableIdealFormula');
    const ideal = typeof imaIdealFormula === 'function' && typeof currentApiRecord !== 'undefined' ? imaIdealFormula(currentApiRecord) : '';
    box.hidden = !ideal;
    box.textContent = ideal ? `IMA ideal formula: ${sanitizeCitationText(ideal)}` : '';
  };

  // Before any atoms are pasted, the header and cell lines on their own, so
  // the file can be seen as it is built.
  const headerAndCellPreview = () => {
    const cells = readCellLines(normalizeMinusSigns(field('tableCellInput').value));
    const cellLines = [...cells.byTitle.map(e => e.cell), ...(cells.shared ? [cells.shared] : [])].flatMap(cell => [
      ['a', 'b', 'c', 'alpha', 'beta', 'gamma'].map(k => cell[k]).concat(cell.spaceGroup || cells.spaceGroup).join(' ').trim(),
      ...(cell.shift ? [cell.shift] : []),
    ]);
    return [headerText(), ...cellLines].filter(Boolean).join('\n');
  };

  let mainGrid = null;
  let anisoGrid = null;

  const convertPaperTables = () => {
    const output = field('tableToAmcOutput');
    showCellChecks();
    if (handEdited) {
      showStatus(HAND_EDITED_NOTE);
      return;
    }
    const tableText = mainGrid.text();
    // Every AMC atom has x, y and z, so none can be left out; reading the
    // table without one would slide the next column's values into its place.
    const missingAxes = mainGrid.choices.length ? ['x', 'y', 'z'].filter(k => !mainGrid.choices.includes(k)) : [];
    if (!tableText.trim() || missingAxes.length) {
      const preview = headerAndCellPreview();
      output.value = preview ? toAscii(`${preview}\n`) : '';
      showFormulas([]);
      if (missingAxes.length) {
        showStatus(`Every atom needs x, y and z: pick a column for ${missingAxes.join(', ')} in the atom table.`, [], true);
      } else {
        showStatus(preview ? 'Paste the atom table to add the atoms.' : '');
      }
      autoSizeTextarea(output);
      return;
    }
    try {
      const { text, notes, count, formulas } = buildAmcFromPaperTables(tableText, {
        xyzPower: power('tableXyzPower'),
        isoPower: power('tableIsoPower'),
        anisoPower: power('tableAnisoPower'),
        allowThirds: field('tableHexagonal').checked,
        columnsText: mainGrid.columnsText(),
        anisoTableText: anisoGrid.text(),
        anisoColumnsText: anisoGrid.columnsText(),
        cellText: field('tableCellInput').value,
        siteText: field('tableSiteInput').value,
        headerText: headerText(),
        idealFormula: typeof imaIdealFormula === 'function' && typeof currentApiRecord !== 'undefined' ? imaIdealFormula(currentApiRecord) : undefined,
      });
      output.value = toAscii(text);
      showFormulas(formulas);
      const duplicates = [['atom table', mainGrid], ['anisotropic table', anisoGrid]]
        .filter(([, grid]) => grid.duplicates().length)
        .map(([name, grid]) => `In the ${name}, ${grid.duplicates().join(', ')} ${grid.duplicates().length === 1 ? 'is' : 'are'} picked for more than one column; pick each once.`);
      const unique = [...new Set([...duplicates, ...notes])];
      showStatus(`${count} dataset${count === 1 ? '' : 's'}${unique.length ? ` · ${unique.length} note${unique.length === 1 ? '' : 's'}` : ''}`, unique);
    } catch (err) {
      const preview = headerAndCellPreview();
      output.value = preview ? toAscii(`${preview}\n`) : '';
      showFormulas([]);
      showStatus(err.message, [], true);
    }
    autoSizeTextarea(output);
  };

  mainGrid = createPasteGrid({
    textarea: field('tableInput'),
    container: field('tableGrid'),
    status: field('tableHeaderStatus'),
    defaults: MAIN_DEFAULT_KEYS,
    onChange: convertPaperTables,
  });
  anisoGrid = createPasteGrid({
    textarea: field('tableAnisoInput'),
    container: field('tableAnisoGrid'),
    status: field('tableAnisoHeaderStatus'),
    defaults: ANISO_DEFAULT_KEYS,
    onChange: convertPaperTables,
    anisoOnly: true,
  });

  const filled = {};
  document.addEventListener('amcheaderchange', () => {
    showIdealFormula();
    if (typeof currentApiRecord === 'undefined' || !currentApiRecord) return;
    let fields;
    try {
      fields = amcHeaderFields(currentCifData || { blockName: '', tags: {}, loops: [], blocks: [] }, currentApiRecord, currentFileName);
    } catch (err) { return; }
    if (fields.name === 'No Name Found') fields.name = '';
    for (const [id, key] of Object.entries(HEADER_FIELDS)) {
      const box = field(id);
      if (fields[key] === undefined || (box.value.trim() && box.value !== filled[id])) continue;
      box.value = filled[id] = toAscii(fields[key]);
    }
    convertPaperTables();
  });

  [...Object.keys(HEADER_FIELDS), 'tableCellInput', 'tableSiteInput', 'tableXyzPower', 'tableIsoPower', 'tableAnisoPower', 'tableHexagonal']
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
  showIdealFormula();
}
