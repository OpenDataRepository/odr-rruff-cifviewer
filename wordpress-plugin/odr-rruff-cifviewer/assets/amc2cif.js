// AMC -> CIF conversion. AMC (.amc) is the plain-text AMCSD format: a short
// bibliographic header, a single "a b c alpha beta gamma spacegroup" line, then
// a fixed-width atom table (optionally followed by "END" and another dataset).
//
// The atom table's columns are NOT whitespace-delimited in the usual sense - a
// blank cell (e.g. full occupancy, so no "occ" value) is just spaces, not a
// placeholder token, and can fall in the MIDDLE of a row (see e.g. AMCSD's own
// Widenmannite atom C1, which has x/y/z/Uiso but no occ). Every column is
// right-aligned (except the leftmost "atom" label column) and padded to a fixed
// width that is identical across the header row and every data row, so a
// column's right edge sits at the same character offset on every line. That
// lets each row be sliced by character position (anchored on the header's own
// token end-offsets) rather than guessing which whitespace-separated token maps
// to which column.

function findAtomLabelExtent(line) {
  const m = line.match(/^\S+/);
  return m ? m[0].length : 0;
}

// Returns [{text, start, end}, ...] for each whitespace-separated token in `line`,
// in left-to-right order, with `end` being the exclusive character offset right
// after the token - which for every column but the first is that column's fixed
// right edge (shared by the header row and every data row of the same table).
function tokenizeWithOffsets(line) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

// Slices `line` into one raw string per header column, using the header's own
// token end-offsets as each column's fixed right edge. A blank cell (mid-row or
// trailing) comes back as ''.
function sliceAtomRow(line, headerTokens) {
  const cells = [];
  const labelEnd = findAtomLabelExtent(line);
  cells.push(line.slice(0, labelEnd).trim());
  for (let col = 1; col < headerTokens.length; col++) {
    const left = col === 1 ? labelEnd : headerTokens[col - 1].end;
    const right = headerTokens[col].end;
    cells.push(line.slice(left, right).trim());
  }
  return cells;
}

const AMC_THIRD_FRACTIONS = {
  '1/3': '0.33333',
  '-1/3': '-0.33333',
  '2/3': '0.66667',
  '-2/3': '-0.66667',
};

// Reverses formatAmcCoordinate: restores the leading zero AMC drops (".25" ->
// "0.25"), and expands AMC's exact-thirds shorthand ("1/3") back to a decimal.
function cifCoordFromAmc(value) {
  if (value === undefined || value === '') return '';
  if (Object.prototype.hasOwnProperty.call(AMC_THIRD_FRACTIONS, value)) return AMC_THIRD_FRACTIONS[value];
  if (value === '0') return '0';
  if (value.startsWith('-.')) return `-0.${value.slice(2)}`;
  if (value.startsWith('.')) return `0${value}`;
  return value;
}

// Reverses formatAmcDecimal (occupancy / Uiso / Biso / anisotropic U terms) -
// same leading-zero restoration, no thirds handling (those never apply here).
function cifDecimalFromAmc(value) {
  if (value === undefined || value === '') return '';
  if (value === '0') return '0';
  if (value.startsWith('-.')) return `-0.${value.slice(2)}`;
  if (value.startsWith('.')) return `0${value}`;
  return value;
}

const AMC_DIGIT_PAIRS = [
  ['2_1', '21'], ['3_1', '31'], ['3_2', '32'],
  ['4_1', '41'], ['4_2', '42'], ['4_3', '43'],
  ['6_1', '61'], ['6_2', '62'], ['6_3', '63'], ['6_4', '64'], ['6_5', '65'],
];

function amcDigitsToPlain(token) {
  let out = token;
  for (const [amcForm, plain] of AMC_DIGIT_PAIRS) out = out.split(amcForm).join(plain);
  return out;
}

// The AMC/Wyckoff space-group string (e.g. "P2_1/c", "Fd-3m", "C-1") has no
// spaces; standard Hermann-Mauguin notation inserts a space between each
// symmetry-direction symbol (e.g. "P 21/c", "F d -3 m"). This reconstructs that
// spacing by walking the string left to right, treating a rotoinversion
// ("-" + one digit), a rotation/screw digit (one digit, optionally with a
// single-digit "_n" screw subscript), or a single letter as one symbol, and
// folding a following "/x" into the same group. The subscript is read as
// exactly one digit (never a run) because AMC's screw-axis pairs (2_1, 4_2, ...)
// are always single-digit/single-digit - a naive digit run would otherwise
// swallow the next direction's leading digit when two digit-only symbols sit
// back to back with no separator (e.g. "2_12_12" is "21", "21", "2", not "21212").
function wyckoffToHermannMauguin(wyckoff) {
  if (!wyckoff) return '';
  const lattice = wyckoff[0];
  const rest = wyckoff.slice(1);
  const groups = [];
  let i = 0;

  const readSymbol = () => {
    const start = i;
    if (rest[i] === '-') {
      i += 2;
    } else if (/\d/.test(rest[i])) {
      i++;
      if (rest[i] === '_') {
        i++;
        if (/\d/.test(rest[i])) i++;
      }
    } else {
      i++;
    }
    return rest.slice(start, i);
  };

  while (i < rest.length) {
    let group = readSymbol();
    if (rest[i] === '/') {
      const slashStart = i;
      i++;
      group += rest.slice(slashStart, i) + readSymbol();
    }
    groups.push(amcDigitsToPlain(group));
  }

  return [lattice, ...groups].join(' ');
}

// The IT number is recovered by exact lookup against the same table the CIF ->
// AMC direction uses to go the other way (SPACE_GROUP_TABLE, from spacegroups.js).
function itNumberFromWyckoff(wyckoff) {
  for (const [number, entries] of Object.entries(SPACE_GROUP_TABLE)) {
    if (entries.includes(wyckoff)) return Number(number);
  }
  return undefined;
}

const AMC_CELL_LINE_RE = /^(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(\S+)$/;

function isAmcCellLine(line) {
  return AMC_CELL_LINE_RE.test(line.trim());
}

function parseAmcCellLine(line) {
  const m = line.trim().match(AMC_CELL_LINE_RE);
  const [, a, b, c, alpha, beta, gamma, rawSpaceGroup] = m;
  // AMCSD prefixes a "*" onto the space-group symbol for some origin-choice-2
  // settings (e.g. "*Fd-3m", "*I4_1/a") - not part of the symbol itself.
  const spaceGroup = rawSpaceGroup.replace(/^\*/, '');
  return { a, b, c, alpha, beta, gamma, spaceGroup };
}

// Metric tensor G for cell parameters a, b, c, alpha, beta, gamma (angles in
// degrees). Symmetric 3x3: G[i][j] === G[j][i].
function computeMetricTensor(a, b, c, alpha, beta, gamma) {
  const toRad = deg => (deg * Math.PI) / 180;
  const cosAlpha = Math.cos(toRad(alpha));
  const cosBeta = Math.cos(toRad(beta));
  const cosGamma = Math.cos(toRad(gamma));

  const G = [
    [a * a, a * b * cosGamma, a * c * cosBeta],
    [a * b * cosGamma, b * b, b * c * cosAlpha],
    [a * c * cosBeta, b * c * cosAlpha, c * c],
  ];
  return G;
}

function determinant3x3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

// Inverts a 3x3 matrix via the adjugate/cofactor method - used to turn the
// (real-space) metric tensor G into the reciprocal metric tensor G*.
function invertMatrix3x3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const Gc = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  return [
    [A / det, D / det, Gc / det],
    [B / det, E / det, H / det],
    [C / det, F / det, I / det],
  ];
}

// Unit cell volume = sqrt(det(G)) - the metric tensor's determinant is the
// square of the volume of the parallelepiped the cell edges a,b,c span.
function computeCellVolume(a, b, c, alpha, beta, gamma) {
  return Math.sqrt(determinant3x3(computeMetricTensor(a, b, c, alpha, beta, gamma)));
}

// Reciprocal cell lengths a*, b*, c*, from G* = inverse(G) - needed to convert
// anisotropic displacement parameters between the beta_ij and U_ij conventions.
function computeReciprocalCellLengths(a, b, c, alpha, beta, gamma) {
  const gStar = invertMatrix3x3(computeMetricTensor(a, b, c, alpha, beta, gamma));
  return {
    aStar: Math.sqrt(gStar[0][0]),
    bStar: Math.sqrt(gStar[1][1]),
    cStar: Math.sqrt(gStar[2][2]),
  };
}

const EIGHT_PI_SQUARED = 8 * Math.PI * Math.PI;
const TWO_PI_SQUARED = 2 * Math.PI * Math.PI;

// Biso = 8*pi^2 * Uiso (both express the same isotropic displacement).
function bisoToUiso(biso) {
  return biso / EIGHT_PI_SQUARED;
}

// beta_ij = 2*pi^2 * U_ij * (reciprocal length product for that ij pair) -
// see computeReciprocalCellLengths for a*/b*/c*.
function betaToU(betas, aStar, bStar, cStar) {
  const [b11, b22, b33, b12, b13, b23] = betas;
  return [
    b11 / (TWO_PI_SQUARED * aStar * aStar),
    b22 / (TWO_PI_SQUARED * bStar * bStar),
    b33 / (TWO_PI_SQUARED * cStar * cStar),
    b12 / (TWO_PI_SQUARED * aStar * bStar),
    b13 / (TWO_PI_SQUARED * aStar * cStar),
    b23 / (TWO_PI_SQUARED * bStar * cStar),
  ];
}

// "American Mineralogist 99 (2014) 276-282" -> journal/volume/year/pages.
function parseAmcJournalLine(line) {
  const m = line.trim().match(/^(.+?)\s+(\S+)\s*\((\d{4})\)\s*(\S+)?\s*$/);
  if (!m) return { journal: line.trim(), volume: '', year: '', pageFirst: '', pageLast: '' };
  const [, journal, volume, year, pages] = m;
  const [pageFirst, pageLast] = (pages || '').split(/[-–]/);
  return { journal, volume, year, pageFirst: pageFirst || '', pageLast: pageLast || '' };
}

// A journal line always carries a "(YYYY)" year, which nothing else in the
// header does - used to tell where the author list (line 1) ends, since a long
// author list commonly wraps onto one or more extra lines before the journal.
function looksLikeJournalLine(line) {
  return /\(\d{4}\)/.test(line);
}

function parseAmcHeaderLines(lines) {
  const name = (lines[0] || '').trim();

  let journalIndex = 2;
  while (journalIndex < lines.length && !looksLikeJournalLine(lines[journalIndex])) journalIndex++;
  const authorLines = lines.slice(1, journalIndex);
  const authors = authorLines.join(' ').split(/,\s*/).map(s => s.trim()).filter(Boolean);
  const { journal, volume, year, pageFirst, pageLast } = parseAmcJournalLine(lines[journalIndex] || '');

  const titleLines = [];
  const notes = [];
  let locality = '';
  let amcsd = '';

  for (const raw of lines.slice(journalIndex + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const amcsdMatch = line.match(/^_database_code_amcsd\s+(\S+)/i);
    if (amcsdMatch) { amcsd = amcsdMatch[1]; continue; }
    const localityMatch = line.match(/^Locality:\s*(.*)$/i);
    if (localityMatch) { locality = localityMatch[1].trim(); continue; }
    if (/^(Note|Sample):/i.test(line)) { notes.push(line); continue; }
    titleLines.push(line);
  }

  return { name, authors, journal, volume, year, pageFirst, pageLast, titleLines, notes, locality, amcsd };
}

const AMC_ATOM_COLUMN_MAP = {
  x: 'fract_x', y: 'fract_y', z: 'fract_z',
  occ: 'occupancy', Uiso: 'Uiso', Biso: 'Biso',
  'U(1,1)': 'U11', 'U(2,2)': 'U22', 'U(3,3)': 'U33',
  'U(1,2)': 'U12', 'U(1,3)': 'U13', 'U(2,3)': 'U23',
  'B(1,1)': 'B11', 'B(2,2)': 'B22', 'B(3,3)': 'B33',
  'B(1,2)': 'B12', 'B(1,3)': 'B13', 'B(2,3)': 'B23',
};

// Parses one dataset's atom table (the header row plus every following row up
// to a blank line, "END", the next cell-parameter line, or end of input).
function parseAmcAtomTable(lines, startIndex) {
  const headerLine = lines[startIndex];
  if (headerLine === undefined) return { columns: [], rows: [], nextIndex: startIndex };
  const headerTokens = tokenizeWithOffsets(headerLine);
  const columns = headerTokens.slice(1).map(t => AMC_ATOM_COLUMN_MAP[t.text] || t.text);

  const rows = [];
  let i = startIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || /^END$/i.test(trimmed) || isAmcCellLine(line)) break;
    const cells = sliceAtomRow(line, headerTokens);
    rows.push({ label: cells[0], values: cells.slice(1) });
    i++;
  }
  // Some files have a stray repeated "END" (or one followed by a blank line)
  // between datasets - each one just marks "this section is over", so skip
  // all of them rather than only the first, or the next real section
  // (whatever follows) gets silently dropped.
  while (i < lines.length && (lines[i].trim() === '' || /^END$/i.test(lines[i].trim()))) i++;
  return { columns, rows, nextIndex: i };
}

// The atom table's header row always starts with the literal token "atom".
function isAtomTableHeaderLine(line) {
  return /^atom\b/i.test(line.trim());
}

function parseAmcText(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const firstCellIndex = lines.findIndex(isAmcCellLine);
  if (firstCellIndex === -1) throw new Error('No cell-parameter line (a b c alpha beta gamma spacegroup) found.');

  const header = parseAmcHeaderLines(lines.slice(0, firstCellIndex));

  const datasets = [];
  let i = firstCellIndex;
  while (i < lines.length && isAmcCellLine(lines[i])) {
    const cell = parseAmcCellLine(lines[i]);
    let tableStart = i + 1;
    // Some AMCSD files (commonly centrosymmetric space groups with an origin
    // choice, e.g. spinel-type Fd-3m entries) insert an extra line here - an
    // alternate-origin coordinate, not part of the atom table - before the
    // real "atom x y z ..." header. Skip any such line(s) rather than
    // mistaking one for the header, which would corrupt every row after it.
    let originShift;
    while (tableStart < lines.length && lines[tableStart].trim() !== '' && !isAtomTableHeaderLine(lines[tableStart]) && !isAmcCellLine(lines[tableStart])) {
      if (originShift === undefined) originShift = lines[tableStart].trim();
      tableStart++;
    }
    const table = parseAmcAtomTable(lines, tableStart);
    datasets.push({ cell, columns: table.columns, rows: table.rows, originShift });
    i = table.nextIndex;
    while (i < lines.length && lines[i].trim() === '') i++;
  }

  return { header, datasets };
}

function cifQuote(value) {
  if (value === undefined || value === '') return "''";
  // CIF allows either quote character as a delimiter - fall back to double
  // quotes when the value itself contains an apostrophe (e.g. an author name
  // like "O'Brien"), since a bare "'" inside a '...'-quoted value isn't escaped.
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

// A value computed by us (a Biso->Uiso or beta_ij->U_ij conversion), not one
// reformatted from the AMC file's own text - formatted at a fixed precision
// rather than reusing cifDecimalFromAmc, which only massages existing text.
function formatComputedDecimal(value) {
  if (!Number.isFinite(value)) return '?';
  return value.toFixed(5);
}

function buildCifAtomLoops(dataset) {
  const hasOcc = dataset.columns.includes('occupancy');
  const isoColumn = dataset.columns.includes('Uiso') ? 'Uiso' : dataset.columns.includes('Biso') ? 'Biso' : null;
  const anisoConvention = ['U11', 'U22', 'U33', 'U12', 'U13', 'U23'].every(c => dataset.columns.includes(c)) ? 'U'
    : ['B11', 'B22', 'B33', 'B12', 'B13', 'B23'].every(c => dataset.columns.includes(c)) ? 'B'
    : null;

  // Isotropic/anisotropic displacement parameters are always written out in
  // the U convention, converting from B/beta_ij when that's what the AMC
  // file used - see bisoToUiso/betaToU. That conversion needs the cell's
  // reciprocal lengths, only computed if actually needed.
  let reciprocal = null;
  const getReciprocal = () => {
    if (!reciprocal) {
      const { a, b, c, alpha, beta, gamma } = dataset.cell;
      reciprocal = computeReciprocalCellLengths(parseFloat(a), parseFloat(b), parseFloat(c), parseFloat(alpha), parseFloat(beta), parseFloat(gamma));
    }
    return reciprocal;
  };

  const siteTags = ['_atom_site_label', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z'];
  if (hasOcc) siteTags.push('_atom_site_occupancy');
  if (isoColumn) siteTags.push('_atom_site_U_iso_or_equiv');

  const colIndex = name => dataset.columns.indexOf(name);
  const xIdx = colIndex('fract_x'), yIdx = colIndex('fract_y'), zIdx = colIndex('fract_z');
  const occIdx = colIndex('occupancy');
  const isoIdx = isoColumn ? colIndex(isoColumn) : -1;

  const siteRows = dataset.rows.map(row => {
    const cells = [
      row.label,
      cifCoordFromAmc(row.values[xIdx]),
      cifCoordFromAmc(row.values[yIdx]),
      cifCoordFromAmc(row.values[zIdx]),
    ];
    if (hasOcc) cells.push(cifDecimalFromAmc(row.values[occIdx]) || '1');
    if (isoColumn) {
      const raw = parseFloat(row.values[isoIdx]);
      const uiso = isoColumn === 'Biso' ? bisoToUiso(raw) : raw;
      cells.push(Number.isFinite(uiso) ? formatComputedDecimal(uiso) : '?');
    }
    return cells;
  });

  const lines = ['loop_', ...siteTags, ...siteRows.map(cells => cells.join(' '))];

  if (anisoConvention) {
    const anisoTags = [
      '_atom_site_aniso_label', '_atom_site_aniso_U_11', '_atom_site_aniso_U_22',
      '_atom_site_aniso_U_33', '_atom_site_aniso_U_12', '_atom_site_aniso_U_13', '_atom_site_aniso_U_23',
    ];
    const anisoOrder = (anisoConvention === 'U' ? ['U11', 'U22', 'U33', 'U12', 'U13', 'U23'] : ['B11', 'B22', 'B33', 'B12', 'B13', 'B23']).map(colIndex);
    const anisoRows = dataset.rows
      .filter(row => anisoOrder.every(idx => row.values[idx]))
      .map(row => {
        const raw = anisoOrder.map(idx => parseFloat(row.values[idx]));
        const uValues = anisoConvention === 'B'
          ? betaToU(raw, getReciprocal().aStar, getReciprocal().bStar, getReciprocal().cStar)
          : raw;
        return [row.label, ...uValues.map(formatComputedDecimal)];
      });
    if (anisoRows.length) {
      lines.push('', 'loop_', ...anisoTags, ...anisoRows.map(cells => cells.join(' ')));
    }
  }

  return lines.join('\n');
}

function buildCifFromAmc(text) {
  const { header, datasets } = parseAmcText(text);
  if (datasets.length === 0) throw new Error('No atom data found.');

  const lines = [];
  lines.push('data_global');
  lines.push(`_chemical_name_mineral ${cifQuote(header.name)}`);

  if (header.authors.length === 1) {
    lines.push(`_publ_author_name ${cifQuote(header.authors[0])}`);
  } else if (header.authors.length > 1) {
    lines.push('loop_');
    lines.push('_publ_author_name');
    for (const author of header.authors) lines.push(cifQuote(author));
  }

  if (header.journal) lines.push(`_journal_name_full ${cifQuote(header.journal)}`);
  if (header.volume) lines.push(`_journal_volume ${header.volume}`);
  if (header.year) lines.push(`_journal_year ${header.year}`);
  if (header.pageFirst) lines.push(`_journal_page_first ${header.pageFirst}`);
  if (header.pageLast) lines.push(`_journal_page_last ${header.pageLast}`);

  const titleBlockLines = [...header.titleLines, ...header.notes];
  if (titleBlockLines.length) {
    lines.push('_publ_section_title');
    lines.push(';');
    for (const t of titleBlockLines) lines.push(` ${t}`);
    lines.push(';');
  }

  if (header.amcsd) lines.push(`_database_code_amcsd ${header.amcsd}`);
  if (header.locality) lines.push(`_chemical_compound_source ${cifQuote(header.locality)}`);

  datasets.forEach((dataset, idx) => {
    if (datasets.length > 1) {
      lines.push('');
      lines.push(`data_${header.amcsd || 'AMCSD'}_${idx + 1}`);
    }
    lines.push(`_cell_length_a ${dataset.cell.a}`);
    lines.push(`_cell_length_b ${dataset.cell.b}`);
    lines.push(`_cell_length_c ${dataset.cell.c}`);
    lines.push(`_cell_angle_alpha ${dataset.cell.alpha}`);
    lines.push(`_cell_angle_beta ${dataset.cell.beta}`);
    lines.push(`_cell_angle_gamma ${dataset.cell.gamma}`);

    const itNumber = itNumberFromWyckoff(dataset.cell.spaceGroup);
    if (itNumber) lines.push(`_space_group_IT_number ${itNumber}`);
    lines.push(`_symmetry_space_group_name_H-M '${wyckoffToHermannMauguin(dataset.cell.spaceGroup)}'`);

    lines.push('');
    lines.push(buildCifAtomLoops(dataset));
  });

  return lines.join('\n') + '\n';
}
