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
// point as a comma ("0,1724(2)").
function paperTableTokens(line) {
  return normalizeMinusSigns(line)
    .replace(/(\d)\s+(\(\d+\))/g, '$1$2')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(t => (/^[+-]?\d+,\d+(\(\d+\))?$/.test(t) ? t.replace(',', '.') : t));
}

function parsePaperValue(token) {
  const m = token.match(PAPER_VALUE_RE);
  if (!m || !/\d/.test((m[2] || '') + (m[3] || ''))) return null;
  return { sign: m[1] === '-' ? '-' : '', intPart: m[2] || '', fracPart: m[3] || '', su: m[4] || null };
}

const isPaperValue = token => parsePaperValue(token) !== null;

// The value divided by 10^power, done on the digits so nothing is lost to
// floating point, in AMC form: no leading zero, all printed digits kept
// ("3375", 4 -> ".3375"; "782", 4 -> ".0782"; "8", 3 -> ".008"), "0" for zero.
function scalePaperValue({ sign, intPart, fracPart }, power) {
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
  if (/^([UB]\s*\(?\s*(eq|iso)\s*\)?|iso|[UB])$/i.test(w)) return { kind: 'iso', convention: /^b/i.test(w) ? 'B' : 'U' };
  const term = w.match(/^(U|B|β|beta)?\s*\(?\s*([123])\s*,?\s*([123])\s*\)?$/i);
  if (term) return { kind: 'aniso', ij: [term[2], term[3]].sort().join(''), convention: term[1] && !/^u$/i.test(term[1]) ? 'B' : 'U' };
  if (/^(occ|occupancy|sof|s\.o\.f)$/i.test(w)) return { kind: 'occ' };
  return null;
}

// The columns a header line names, or null when it isn't a header: a header
// names x, y and z, or all six anisotropic terms (a separate U(i,j) table).
function readPaperHeader(tokens) {
  const columns = tokens.map(paperColumn).filter(Boolean);
  const kinds = new Set(columns.map(c => c.kind));
  const hasXyz = ['x', 'y', 'z'].every(k => kinds.has(k));
  const terms = new Set(columns.filter(c => c.kind === 'aniso').map(c => c.ij));
  if (!hasXyz && terms.size !== 6) return null;
  // Half a set of U(i,j) can't be told apart from a row of numbers, so it is left out.
  const usable = terms.size === 6 ? columns : columns.filter(c => c.kind !== 'aniso');
  return { columns: usable, hasXyz };
}

const DEFAULT_PAPER_COLUMNS = ['x', 'y', 'z', 'iso'].map(kind => ({ kind, convention: 'U' }));

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
  const looksLike = {
    occ: token => { const v = parsePaperValue(token); return v.fracPart !== '' && parseFloat(token) <= 1; },
    iso: token => powers.isoPower === 0 || parsePaperValue(token).fracPart === '',
    aniso: token => powers.anisoPower === 0 || parsePaperValue(token).fracPart === '',
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
const sameTitle = (a, b) => a.toLowerCase() === b.toLowerCase();

// Every dataset in the pasted text, as [{ title, atoms: [{ label, values: {
// x, y, z, iso, occ, aniso: { ij: token } } }], isoConvention, anisoConvention }],
// plus notes worth telling the user.
function readPaperTables(text, powers) {
  const datasets = [];
  const notes = [];
  let header = null;
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

    if (tokens.length >= 2 && !isPaperValue(tokens[0]) && tokens.slice(1).every(isPaperValue)) {
      if (!header) {
        header = { columns: DEFAULT_PAPER_COLUMNS, hasXyz: true };
        if (!warnedNoHeader) notes.push('No header row found, so the columns were read as x y z U(eq).');
        warnedNoHeader = true;
      }
      if (!current) current = datasetFor(pendingTitle);
      pendingTitle = '';
      if (current.skip) continue;
      const [label, ...values] = tokens;
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
        atom = { label, values: { aniso: {} } };
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
      header = newHeader;
      current = null;
      pendingTitle = '';
      supplementGroup = -1;
      continue;
    }

    // A row whose label reads as a number (a scan's "01" for O1) can't be told
    // from a row of values, so it is pointed out rather than guessed at.
    if (header && tokens.length >= 4 && tokens.every(isPaperValue)) {
      notes.push(`"${line.trim()}" starts with a number, not an atom label; it was left out.`);
      continue;
    }

    // A caption, a footnote, or a dataset title: whichever line comes last
    // before a block of rows titles it.
    current = null;
    pendingTitle = cleanTitle(line);
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
    if (v.su) return scaled;
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

const PAPER_CELL_PLACEHOLDER = 'a b c alpha beta gamma spacegroup';

// The AMC text for every dataset of the pasted tables, one after another,
// each with the optional header lines (mineral, authors, journal, title) in
// front, a "Sample:" line naming it when it has a title, its cell line, and
// its atom table. options: { xyzPower, isoPower, anisoPower, allowThirds,
// cellText, headerText }. Returns { text, notes, count }.
function buildAmcFromPaperTables(tableText, options) {
  tableText = normalizeMinusSigns(tableText);
  options = { ...options, cellText: normalizeMinusSigns(options.cellText || ''), headerText: normalizeMinusSigns(options.headerText || '') };
  const { datasets, notes } = readPaperTables(tableText, options);
  if (!datasets.some(d => d.atoms.length)) throw new Error('No atom rows found (an atom label followed by numbers, e.g. "M 3375(1) 0 2500 8(1)").');
  const cells = readCellLines(options.cellText || '');
  notes.push(...cells.notes);
  const headerLines = (options.headerText || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd()).filter(l => l.trim());

  const blocks = [];
  const missingCells = [];
  datasets.filter(d => d.atoms.length).forEach((dataset, index) => {
    const named = dataset.title && cells.byTitle.find(entry => sameTitle(entry.title, dataset.title));
    const positional = !dataset.title && cells.byTitle.length === datasets.length ? cells.byTitle[index] : null;
    const cell = (named || positional || {}).cell || cells.shared;
    const spaceGroup = cell && (cell.spaceGroup || cells.spaceGroup);
    const allowThirds = cell ? isHexagonalOrRhombohedral(cell) : options.allowThirds;

    const thirdLike = [];
    const rows = paperDatasetRows(dataset, options, allowThirds, thirdLike);
    const name = dataset.title ? `${dataset.title}: ` : '';
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
        unitCellFromAmc(headerLines.length ? block : `x\n${block}`);
      } catch (err) {
        notes.push(`${name}${err.message}`);
      }
    }
    blocks.push(block);
  });

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

  const convertPaperTables = () => {
    const output = field('tableToAmcOutput');
    const status = field('tableToAmcStatus');
    const tableText = field('tableInput').value;
    if (!tableText.trim()) {
      output.value = '';
      status.textContent = '';
      autoSizeTextarea(output);
      return;
    }
    try {
      const { text, notes, count } = buildAmcFromPaperTables(tableText, {
        xyzPower: power('tableXyzPower'),
        isoPower: power('tableIsoPower'),
        anisoPower: power('tableAnisoPower'),
        allowThirds: field('tableHexagonal').checked,
        cellText: field('tableCellInput').value,
        headerText: field('tableHeaderInput').value,
      });
      output.value = toAscii(text);
      status.textContent = [`${count} dataset${count === 1 ? '' : 's'}.`, ...new Set(notes)].join(' ');
    } catch (err) {
      output.value = '';
      status.textContent = `Error: ${err.message}`;
    }
    autoSizeTextarea(output);
  };

  ['tableInput', 'tableCellInput', 'tableHeaderInput', 'tableXyzPower', 'tableIsoPower', 'tableAnisoPower', 'tableHexagonal']
    .forEach(id => field(id).addEventListener('input', convertPaperTables));
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
