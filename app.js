function tokenizeLine(line) {
  const tokens = [];
  let i = 0;
  const len = line.length;
  while (i < len) {
    while (i < len && /\s/.test(line[i])) i++;
    if (i >= len) break;
    if (line[i] === '#') break;
    if (line[i] === "'" || line[i] === '"') {
      // Per the CIF spec, a quote only closes the string when immediately
      // followed by whitespace or end-of-line - an embedded quote with no
      // following space (e.g. the apostrophe in "D'Ippolito") is just part
      // of the value, not a terminator.
      const quote = line[i];
      const start = i + 1;
      let end = start;
      while (end < len && !(line[end] === quote && (end + 1 >= len || /\s/.test(line[end + 1])))) end++;
      tokens.push(line.slice(start, end));
      i = end + 1;
    } else {
      const start = i;
      while (i < len && !/\s/.test(line[i])) i++;
      tokens.push(line.slice(start, i));
    }
  }
  return tokens;
}

// Tracks which source line produced each token (a semicolon-delimited multi-line
// string counts as living on the line it started on), and whether that token came
// from such a multi-line block, so loop rows can be grouped by physical line rather
// than by counting up to the declared tag count - a loop row that's missing (or has
// an extra) trailing "." placeholder is a common real-world CIF typo, and count-based
// chunking lets that single typo desync every row after it. Line-based grouping is
// only safe for loops where each row genuinely is one physical line though - a row
// can legitimately spread its columns across several lines by giving one of them as
// a semicolon block (common in bibliographic loops like _publ_author_name, where the
// footnote/address columns are often multi-line blocks on their own lines) - isBlock
// lets the loop-row logic detect that and fall back to plain count-based chunking.
function tokenizeCIF(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const tokens = [];
  const tokenLineIndex = [];
  const tokenIsBlock = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith(';')) {
      const startLine = i;
      const content = [line.slice(1)];
      i++;
      while (i < lines.length && !lines[i].startsWith(';')) {
        content.push(lines[i]);
        i++;
      }
      i++;
      tokens.push(content.join('\n').trim());
      tokenLineIndex.push(startLine);
      tokenIsBlock.push(true);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    const lineTokens = tokenizeLine(line);
    tokens.push(...lineTokens);
    for (let k = 0; k < lineTokens.length; k++) {
      tokenLineIndex.push(i);
      tokenIsBlock.push(false);
    }
    i++;
  }
  return { tokens, tokenLineIndex, tokenIsBlock };
}

function parseCIF(text) {
  const { tokens, tokenLineIndex, tokenIsBlock } = tokenizeCIF(text);
  // A CIF file can have multiple `data_` blocks (e.g. a "data_global" bibliographic
  // block plus one or more structural blocks like "data_I"/"data_II" for separately
  // refined twin domains). `blocks` keeps each one separate so callers that care about
  // block boundaries (e.g. per-dataset atom tables) can see them; the top-level
  // tags/loops/blockName remain a flat merge across all blocks for existing callers.
  const result = { blockName: '', tags: {}, loops: [], blocks: [] };
  let currentBlock = { blockName: '', tags: {}, loops: [] };
  result.blocks.push(currentBlock);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^data_/i.test(tok)) {
      currentBlock = { blockName: tok.slice(5), tags: {}, loops: [] };
      result.blocks.push(currentBlock);
      result.blockName = currentBlock.blockName;
      i++;
      continue;
    }
    if (/^loop_$/i.test(tok)) {
      i++;
      const loopTags = [];
      while (i < tokens.length && tokens[i].startsWith('_')) {
        loopTags.push(tokens[i]);
        i++;
      }
      // Collect this loop's data tokens first (without chunking into rows yet) so we
      // can decide how to split them into rows based on what's actually in there.
      const dataTokens = [];
      const dataLines = [];
      let anyBlockToken = false;
      while (
        i < tokens.length &&
        !tokens[i].startsWith('_') &&
        !/^loop_$/i.test(tokens[i]) &&
        !/^data_/i.test(tokens[i])
      ) {
        dataTokens.push(tokens[i]);
        dataLines.push(tokenLineIndex[i]);
        if (tokenIsBlock[i]) anyBlockToken = true;
        i++;
      }

      // Some CIFs (apparently converted from an .amc file by another tool) leak
      // that format's own "END" table-terminator in as stray trailing text after
      // the loop's real data - it's never legitimate loop data, so drop it before
      // chunking into rows, or it becomes a bogus extra row (e.g. a fake atom
      // labeled "END").
      while (dataTokens.length > 0 && /^END$/i.test(dataTokens[dataTokens.length - 1])) {
        dataTokens.pop();
        dataLines.pop();
      }

      const rows = [];
      if (anyBlockToken) {
        // A row's columns are spread across several physical lines (e.g. a
        // bibliographic loop with footnote/address as their own semicolon blocks) -
        // line boundaries don't mark row boundaries here, so just chunk by count.
        for (let start = 0; start < dataTokens.length; start += loopTags.length) {
          const row = dataTokens.slice(start, start + loopTags.length);
          while (row.length < loopTags.length) row.push('');
          rows.push(row);
        }
      } else {
        // Purely tabular data (e.g. _atom_site) is reliably one full row per physical
        // line, so group by line - this way a row that's missing (or has an extra)
        // trailing "." placeholder can't desync every row after it.
        let row = [];
        let rowLine = dataLines[0];
        for (let k = 0; k < dataTokens.length; k++) {
          if (row.length > 0 && dataLines[k] !== rowLine) {
            while (row.length < loopTags.length) row.push('');
            rows.push(row.slice(0, loopTags.length));
            row = [];
          }
          rowLine = dataLines[k];
          row.push(dataTokens[k]);
        }
        if (row.length > 0) {
          while (row.length < loopTags.length) row.push('');
          rows.push(row.slice(0, loopTags.length));
        }
      }
      const loop = { tags: loopTags, rows };
      currentBlock.loops.push(loop);
      result.loops.push(loop);
      continue;
    }
    if (tok.startsWith('_')) {
      const tag = tok;
      i++;
      if (i < tokens.length) {
        currentBlock.tags[tag] = tokens[i];
        result.tags[tag] = tokens[i];
        i++;
      }
      continue;
    }
    i++;
  }
  // Drop the placeholder block pushed before any "data_" token was seen, if nothing
  // was ever added to it (a well-formed CIF always starts with a data_ block).
  if (result.blocks[0].blockName === '' && Object.keys(result.blocks[0].tags).length === 0 && result.blocks[0].loops.length === 0 && result.blocks.length > 1) {
    result.blocks.shift();
  }
  return result;
}

function getLoopValues(data, tag) {
  for (const loop of data.loops) {
    const idx = loop.tags.indexOf(tag);
    if (idx !== -1) return loop.rows.map(row => row[idx]);
  }
  return null;
}

// Besides CIF's own formal null markers ("?" and "."), an unfilled publCIF template
// commonly leaves software-specific boilerplate behind instead, e.g. "Title (type
// here to add)" or "(type here to add abstract)" - that's just as much a placeholder
// as "?" and must be treated as missing data too, or it wins over real API data
// (e.g. the actual title) instead of falling back to it.
function isPlaceholderValue(value) {
  return value === undefined || value === '?' || value === '.' || /\(type here to add\b/i.test(value);
}

function getTag(data, tag) {
  const value = data.tags[tag];
  return isPlaceholderValue(value) ? undefined : value;
}

function getApiField(apiRecord, fieldName) {
  if (!apiRecord || !Array.isArray(apiRecord.fields)) return undefined;
  const field = apiRecord.fields.find(f => f.field_name === fieldName);
  if (!field || field.value === undefined || field.value === null || field.value === '') return undefined;
  return String(field.value);
}

// The citation (Article Title/Journal/Year/Volume/Pages) for this specific AMCSD
// record lives in a "Bibliography" record that is a direct sibling of the Mineral
// record in the top-level `records` array. The same Bibliography database_uuid also
// shows up much deeper in the tree (e.g. under the Mineral's other locality/reference
// entries) but those are unrelated citations, so only the top-level array is searched.
const CITATION_DATABASE_UUID = 'e7e7e1706e6163550eb03129883a';

function findRecordByDatabaseUuid(record, databaseUuid) {
  if (!record || !Array.isArray(record.records)) return undefined;
  return record.records.find(child => child.database_uuid === databaseUuid);
}

// Citation fields come from the API's raw bibliography entry, which uses diacritics
// and wiki-style markup (_2_ subscript, ^-^ superscript, <i> italics, · multiplication)
// that .amc files can't contain. ODR's own generated "AMC File Contents" field shows
// the correct ASCII target, e.g. "Al_2_(H_2_O)(OH)_4_·<i>n</i>(Cl,OH^-^,H_2_O)"
// becomes "Al2(H2O)(OH)4*n(Cl,OH-,H2O)" - the rules below reproduce that exactly.
function stripDiacritics(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function convertCitationMarkup(text) {
  return text
    .replace(/_(.+?)_/g, '$1')
    .replace(/<i>(.*?)<\/i>/gi, '$1')
    .replace(/·/g, '*')
    .replace(/\^(.+?)\^/g, '$1')
    .replace(/◻/g, '[]');
}

function sanitizeCitationText(text) {
  return stripDiacritics(convertCitationMarkup(text));
}

function getCitationField(apiRecord, fieldName) {
  const citationRecord = findRecordByDatabaseUuid(apiRecord, CITATION_DATABASE_UUID);
  const value = getApiField(citationRecord, fieldName);
  return value === undefined ? undefined : sanitizeCitationText(value);
}

function formatAuthors(data, apiRecord) {
  let names = [];
  if (getTag(data, '_publ_author_name')) {
    names = [getTag(data, '_publ_author_name')];
  } else {
    // getLoopValues doesn't filter placeholder values the way getTag does, so an
    // unfilled author loop (a lone "?" row, common in never-completed publCIF
    // templates) would otherwise count as real data and incorrectly win over the
    // API's actual Authors field.
    names = (getLoopValues(data, '_publ_author_name') || []).filter(name => !isPlaceholderValue(name));
  }
  const fromCif = names
    .map(name => name.replace(/[,.]/g, '').replace(/\s+/g, ' ').trim())
    .join(', ');
  // The API record is whatever was fetched first and deliberately looked up, so it
  // takes priority over the CIF's own (often unfilled/boilerplate) header fields.
  return getApiField(apiRecord, 'Authors') || fromCif || '';
}

// AMCSD file names are conventionally "MineralName__<id>.cif" (sometimes with an
// "__original__" marker in between) - the part before the first "__" is the name.
function mineralNameFromFileName(fileName) {
  if (!fileName) return '';
  return fileName.replace(/\.cif$/i, '').split('__')[0].trim();
}

function getMineralName(data, apiRecord, fileName) {
  return getApiField(apiRecord, 'Mineral') || getTag(data, '_chemical_name_mineral') ||
    mineralNameFromFileName(fileName) || 'No Name Found';
}

function convertHermannMauguinToWyckoffSpaceGroup(hmSpaceGroup) {
  if (!hmSpaceGroup) return '';

  // An origin-choice/setting suffix (": 1", ": 2", ": H") is appended after
  // the symbol itself, e.g. "P 1 1 m : 1" -> "Pm:1" - pull it off before the
  // axis-setting cleanup below (which strips lone "1"s, and would otherwise
  // eat the "1" here too), then reattach it verbatim at the end.
  const originMatch = hmSpaceGroup.match(/\s*:\s*(\S+)\s*$/);
  const originSuffix = originMatch ? `:${originMatch[1]}` : '';
  const symbol = originMatch ? hmSpaceGroup.slice(0, originMatch.index) : hmSpaceGroup;

  let numSpaces = 0;
  for (const ch of symbol) {
    if (ch === ' ') numSpaces++;
  }

  let wyckoff = symbol;
  if (numSpaces > 1 && !symbol.includes('P 3') && !symbol.includes('P -3')) {
    wyckoff = wyckoff.split(' 1').join('');
  }

  // Some CIFs write screw-axis subscripts as e.g. "2(1)" instead of "21" -
  // (n) always means the same thing as the digit-pair form, so normalize it
  // to the digit-pair form first and let the table below turn it into "2_1".
  wyckoff = wyckoff.replace(/\((\d+)\)/g, '$1');

  const digitPairs = [
    ['21', '2_1'], ['31', '3_1'], ['32', '3_2'],
    ['41', '4_1'], ['42', '4_2'], ['43', '4_3'],
    ['61', '6_1'], ['62', '6_2'], ['63', '6_3'], ['64', '6_4'], ['65', '6_5'],
  ];
  for (const [search, replace] of digitPairs) {
    wyckoff = wyckoff.split(search).join(replace);
  }

  wyckoff = wyckoff.split(' ').join('');
  if (wyckoff.length === 1) wyckoff += '1';

  wyckoff = wyckoff.toLowerCase();
  wyckoff = wyckoff.charAt(0).toUpperCase() + wyckoff.slice(1);

  return wyckoff + originSuffix;
}

function getSpaceGroupSymbolFromITNumber(number) {
  const entries = SPACE_GROUP_TABLE[number];
  if (!entries) return undefined;
  // Only unambiguous when the IT number maps to a single Wyckoff symbol;
  // numbers with multiple axis-setting synonyms need the H-M text to disambiguate
  return entries.length === 1 ? entries[0] : undefined;
}

// Crystal system is a property of the space group, not the cell parameters - a
// cell can satisfy e.g. the "a,a,c / 90,90,120" hexagonal pattern by coincidence
// without the structure actually having hexagonal symmetry, and symmetry does not
// force its "ideal" cell shape to hold exactly either. So this only goes one way:
// space group -> crystal system. It is derived from the IT number's standard range;
// trigonal (143-167) is folded into Hexagonal since this app doesn't track that as
// a separate 7th system.
function crystalSystemFromITNumber(number) {
  if (!Number.isFinite(number)) return '';
  if (number >= 1 && number <= 2) return 'Triclinic';
  if (number >= 3 && number <= 15) return 'Monoclinic';
  if (number >= 16 && number <= 74) return 'Orthorhombic';
  if (number >= 75 && number <= 142) return 'Tetragonal';
  if (number >= 143 && number <= 194) return 'Hexagonal';
  if (number >= 195 && number <= 230) return 'Cubic';
  return '';
}

// Crystal system (like the space group itself) must come only from the CIF, not
// the API. Returns '' when the CIF doesn't carry a usable space group IT number.
function getCrystalSystem(data) {
  const itNumber = getTag(data, '_space_group_IT_number');
  if (!itNumber) return '';
  return crystalSystemFromITNumber(Number(itNumber));
}

function resolveSpaceGroup(data) {
  const itNumber = getTag(data, '_space_group_IT_number');
  const hmText = getTag(data, '_symmetry_space_group_name_H-M') || getTag(data, '_space_group_name_H-M_alt');

  if (itNumber) {
    const calculated = getSpaceGroupSymbolFromITNumber(Number(itNumber));
    if (calculated) return calculated;

    if (hmText) {
      const converted = convertHermannMauguinToWyckoffSpaceGroup(hmText);
      const entries = SPACE_GROUP_TABLE[Number(itNumber)] || [];
      if (entries.includes(converted)) return converted;
    }
  }

  if (hmText) return convertHermannMauguinToWyckoffSpaceGroup(hmText);

  return '';
}

function buildAmcHeader(data, apiRecord, fileName) {
  const lines = [];
  lines.push(getMineralName(data, apiRecord, fileName));
  lines.push(formatAuthors(data, apiRecord));

  // The API record (already fetched and looked up deliberately) takes priority over
  // the CIF's own header fields, which are frequently unfilled/boilerplate - the CIF
  // is only the fallback here. This does NOT apply to cell params/space group below,
  // which must only ever come from the CIF.
  const journal = getCitationField(apiRecord, 'Journal') || getTag(data, '_journal_name_full') || '';
  const volume = getCitationField(apiRecord, 'Volume') || getTag(data, '_journal_volume') || '';
  const year = getCitationField(apiRecord, 'Year') || getTag(data, '_journal_year') || '';
  const pages = getCitationField(apiRecord, 'Pages');
  const pageFirst = getTag(data, '_journal_page_first') || '';
  const pageLast = getTag(data, '_journal_page_last') || '';
  let journalLine = journal;
  if (volume) journalLine += ` ${volume}`;
  if (year) journalLine += ` (${year})`;
  if (pages) {
    journalLine += ` ${pages}`;
  } else if (pageFirst) {
    journalLine += ` ${pageFirst}${pageLast ? '-' + pageLast : ''}`;
  }
  lines.push(journalLine.trim());

  const title = getCitationField(apiRecord, 'Article Title') || getTag(data, '_publ_section_title');
  if (title) {
    title
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length)
      .forEach(l => lines.push(l));
  }

  const locality = getApiField(apiRecord, 'Locality') || getTag(data, '_chemical_compound_source');
  if (locality) lines.push(`Locality: ${locality}`);

  const amcsd = getApiField(apiRecord, 'database_code_amcsd') || getTag(data, '_database_code_amcsd');
  if (amcsd) lines.push(`_database_code_amcsd ${amcsd}`);

  // Cell parameters and space group must come only from the CIF file, not the API.
  const a = getTag(data, '_cell_length_a');
  const b = getTag(data, '_cell_length_b');
  const c = getTag(data, '_cell_length_c');
  const alpha = getTag(data, '_cell_angle_alpha');
  const beta = getTag(data, '_cell_angle_beta');
  const gamma = getTag(data, '_cell_angle_gamma');
  const sg = resolveSpaceGroup(data);
  if (a && b && c && alpha && beta && gamma) {
    // Refinement uncertainty (the "(12)" in "19.840(12)") isn't wanted here.
    const [a2, b2, c2] = trimSharedZeros([a, b, c]);
    const [alpha2, beta2, gamma2] = [alpha, beta, gamma].map(stripUncertainty);
    lines.push(`${a2} ${b2} ${c2} ${alpha2} ${beta2} ${gamma2} ${sg}`.trim());
  }

  // Word-wrap only the header lines built so far (mineral name, authors, journal,
  // title, locality, database code, cell params) at 80 characters - the atom table
  // appended below is fixed-width columnar data and must never be wrapped, or its
  // columns stop lining up.
  const wrappedLines = lines.flatMap(line => wrapText(line, 80));

  const atomDatasetsOutput = buildAtomDatasetsOutput(data);
  if (atomDatasetsOutput) wrappedLines.push(atomDatasetsOutput);

  return wrappedLines.join('\n');
}

const ATOM_SITE_TAGS = ['_atom_site_label', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z'];

function getAtomSiteLoop(block) {
  return block.loops.find(loop => ATOM_SITE_TAGS.every(tag => loop.tags.includes(tag))) || null;
}

function getAtomSiteAnisoLoop(block) {
  return block.loops.find(loop => loop.tags.includes('_atom_site_aniso_label')) || null;
}

function stripUncertainty(rawValue) {
  return rawValue.replace(/\(\d+\)/g, '');
}

// Some CIFs label a water oxygen site as all-caps "WAT" or as its formula "H2O"
// instead of the correct AMC-style "Wat" (see e.g. Petersite-(Ce)'s "WAT" atom, or
// the Abellaite CIF's own comment: "Wat == water, O-H == hydroxyl"). Only the
// label's display form is normalized - any numeric/prime suffix is kept as-is.
function normalizeAtomLabel(label) {
  return label.replace(/^(WAT|H2O)(.*)$/, (_, __, suffix) => `Wat${suffix}`);
}

// In a hexagonal-setting cell (alpha=beta=90, gamma=120), atoms sitting on a 3-fold
// axis land at x=1/3 or 2/3 exactly, which refinement software still writes out as a
// long decimal like "0.333333" - AMC convention writes these as the actual fraction.
const THIRDS_TOLERANCE = 0.001;
const THIRD_FRACTIONS = [[1 / 3, '1/3'], [-1 / 3, '-1/3'], [2 / 3, '2/3'], [-2 / 3, '-2/3']];

function matchThirdFraction(numericValue) {
  const wrapped = numericValue - Math.trunc(numericValue);
  for (const [target, label] of THIRD_FRACTIONS) {
    if (Math.abs(wrapped - target) < THIRDS_TOLERANCE) return label;
  }
  return null;
}

// A value's integer part (e.g. the "1" in "1.08330") is kept as-is, not
// collapsed to 0 - the real published AMC files keep it too (a twin-related
// position shifted by a whole unit translation is written out with that
// offset, not silently wrapped into (-1, 1)). Refinement uncertainty in
// parens is dropped, and a leading zero before the decimal point is dropped,
// e.g. "-0.35390(4)" -> "-.35390". A coordinate fixed by symmetry has no
// refinement uncertainty and is written by the refinement software padded to
// match the column width of refined values (e.g. "0.500000"), so trailing
// zeros are trimmed down to the true value (-> ".5") - but only when there's
// no uncertainty, since for a genuinely refined value (e.g. "0.7520(5)") a
// trailing zero is real precision and must be kept as-is.
function formatAmcCoordinate(rawValue, allowThirds) {
  if (rawValue === undefined) return rawValue;
  const hasUncertainty = /\(\d+\)/.test(rawValue);
  const value = stripUncertainty(rawValue);
  const numericValue = parseFloat(value);
  if (numericValue === 0) return '0';
  if (allowThirds) {
    const fraction = matchThirdFraction(numericValue);
    if (fraction) return fraction;
  }
  const decimalMatch = value.match(/^(-?)(\d+)\.(\d+)$/);
  if (decimalMatch) {
    const [, sign, intPart, rawDecimals] = decimalMatch;
    const decimals = hasUncertainty ? rawDecimals : rawDecimals.replace(/0+$/, '');
    if (decimals === '') return intPart === '0' ? '0' : `${sign}${intPart}`;
    const intPrefix = intPart === '0' ? '' : intPart;
    return `${sign}${intPrefix}.${decimals}`;
  }
  const intMatch = value.match(/^(-?)(\d+)$/);
  if (intMatch && intMatch[2] === '1') return '0';
  return value;
}

// Occupancies and ADP terms just drop refinement uncertainty, collapse an exact zero
// to "0", and drop a leading zero otherwise - unlike fractional coordinates they are
// NOT wrapped mod 1 (an occupancy of "1.88" stays "1.88"; see conversation re:
// Cadwaladerite's CL3 site, which really represents a Cl/water disorder the CIF
// doesn't itself resolve - so it's kept as literal CIF data) and their trailing zeros
// are kept as-is (they convey the refined value's actual precision).
function formatAmcDecimal(rawValue) {
  // A "?"/"." placeholder for just this one atom (column exists, but this row never
  // got a value) must not leak into the table as literal text - treat it the same as
  // the column being absent entirely, i.e. blank.
  if (rawValue === undefined || isPlaceholderValue(rawValue)) return '';
  const value = stripUncertainty(rawValue);
  if (parseFloat(value) === 0) return '0';
  return value.replace(/^(-?)0\./, '$1.');
}

// --- Precision (significant decimal places) ---
// CIFs often pad every number to a fixed width ("0.07600", "0.50000", "5.43200"), so a
// trailing zero may be padding or genuine precision - the CIF alone can't say which. The
// rules below recover the intended precision from the values reported alongside instead;
// they were checked against ~21,500 published AMC files. A value carrying a refinement
// uncertainty, e.g. "0.7520(5)", is never touched: there, every digit shown is real.
const PLAIN_DECIMAL_RE = /^(-?)(\d+)(?:\.(\d*))?$/;

// Decimal places a value needs once trailing zeros are dropped ("0.07600" -> 3, "0.5000"
// -> 1), or null when the rules don't apply to it: a placeholder, a value with an
// uncertainty, anything other than a plain decimal, or zero (always written "0").
function significantDecimals(rawValue) {
  if (rawValue === undefined || isPlaceholderValue(rawValue) || /\(\d+\)/.test(rawValue)) return null;
  const m = rawValue.trim().match(PLAIN_DECIMAL_RE);
  if (!m || parseFloat(rawValue) === 0) return null;
  return (m[3] || '').replace(/0+$/, '').length;
}

// The value written with `places` decimal places and no leading zero ("0.07600", 4 ->
// ".0760"). Only trailing zeros are ever dropped or added, never a nonzero digit, so a
// value with more significant decimals than `places` keeps all of them.
function withDecimals(rawValue, places) {
  const [, sign, intPart, decimals = ''] = rawValue.trim().match(PLAIN_DECIMAL_RE);
  const digits = decimals.replace(/0+$/, '').padEnd(places, '0');
  if (!digits) return `${sign}${intPart}`;
  return `${sign}${intPart === '0' ? '' : intPart}.${digits}`;
}

// Places for a value given the values reported alongside it (the rest of its row): at
// least as many as the least precise of them. Values in one row are normally reported to
// similar precision, so "0.43700" next to "0.05521" and "0.83810" is .4370, not .437 - but
// a row can legitimately mix 4 and 5 places (".1867 .19583 .2905"), which is why the floor
// is the least precise neighbour rather than the most precise one.
function placesAmongNeighbours(rawValue, neighbours) {
  const others = neighbours.map(significantDecimals).filter(p => p !== null);
  return Math.max(significantDecimals(rawValue), others.length ? Math.min(...others) : 0);
}

// Cell lengths padded with zeros ("5.43200 5.43200 10.12300") lose the zeros that a, b
// and c all end with (-> 5.432 5.432 10.123). Only shared zeros go, and none are ever
// added: a, b and c are often reported to different precision (8.306 8.52 6.043), so
// one length ending in zero is no evidence of padding on its own. When all three are the
// same number (a cubic cell) they're no evidence for each other either, so a single
// trailing zero is kept (8.1010 is usually real) and only a run of two or more goes.
function trimSharedZeros(rawValues) {
  const decimals = rawValues.map(raw => (significantDecimals(raw) === null ? null : (raw.trim().match(PLAIN_DECIMAL_RE)[3] || '')));
  if (decimals.some(d => d === null)) return rawValues.map(stripUncertainty);
  let shared = Math.min(...decimals.map(d => d.length - d.replace(/0+$/, '').length));
  const allSame = rawValues.every(raw => raw.trim() === rawValues[0].trim());
  if (allSame && shared < 2) shared = 0;
  return rawValues.map((raw, i) => withDecimals(raw, decimals[i].length - shared));
}

// Coordinates fixed by symmetry - multiples of 1/8 (0, .125, .25, .5, .75 ...) - are
// written as short as possible rather than padded to their neighbours' precision.
const isEighthMultiple = v => Math.abs(v * 8 - Math.round(v * 8)) < 1e-9;

// Rewrites the precision of an atom table's cells in place (rows as built by
// buildAtomTableRows; the raw* arrays hold the matching CIF strings, one entry per row):
//  - x, y, z: a coordinate fixed by symmetry (a multiple of 1/8, or 1/3 / 2/3 in a
//    hexagonal cell) stays short; any other gets at least as many places as the least
//    precise of the other refined coordinates in its row (a lone .289 among 4-place values
//    becomes .2890).
//  - occ: trailing zeros dropped (.5000 -> .5); occupancies are mostly simple fractions.
//  - Uiso/Biso: at least as many places as the column's median, so a column padded to
//    "0.00840" comes out .0084, while a .065 among 4-place values stays .0650.
//  - U(i,j): like coordinates, at least the least precise of the atom's other five terms.
function applyPrecision(rows, rawCoords, rawOcc, rawIso, rawAniso, allowThirds) {
  rawCoords.forEach((raws, i) => {
    const refined = raws.map(raw => {
      if (significantDecimals(raw) === null) return false;
      const v = parseFloat(raw);
      return !isEighthMultiple(v) && !(allowThirds && matchThirdFraction(v));
    });
    raws.forEach((raw, k) => {
      if (!refined[k]) return;
      const neighbours = raws.filter((_, kk) => kk !== k && refined[kk]);
      rows[i][1 + k] = withDecimals(raw, placesAmongNeighbours(raw, neighbours));
    });
  });

  if (rawOcc) {
    rawOcc.forEach((raw, i) => {
      if (rows[i][4] !== '' && significantDecimals(raw) !== null) rows[i][4] = withDecimals(raw, 0);
    });
  }

  if (rawIso) {
    const places = rawIso.map(significantDecimals).filter(p => p !== null).sort((a, b) => a - b);
    const median = places.length ? places[Math.floor((places.length - 1) / 2)] : 0;
    rawIso.forEach((raw, i) => {
      const own = significantDecimals(raw);
      if (own !== null) rows[i][5] = withDecimals(raw, Math.max(own, median));
    });
  }

  if (rawAniso) {
    rawAniso.forEach((raws, i) => {
      raws.forEach((raw, j) => {
        if (significantDecimals(raw) === null) return;
        rows[i][6 + j] = withDecimals(raw, placesAmongNeighbours(raw, raws.filter((_, jj) => jj !== j)));
      });
    });
  }
}

function isFullOccupancy(rawValue) {
  const parsed = parseFloat(stripUncertainty(rawValue));
  return Number.isFinite(parsed) && Math.abs(parsed - 1) < 1e-9;
}

function padColumn(text, width, alignRight) {
  const pad = ' '.repeat(Math.max(0, width - text.length));
  return alignRight ? pad + text : text + pad;
}

// AMC column order differs from the CIF aniso loop's own column order.
const ANISO_COLUMN_ORDER = [
  '_atom_site_aniso_U_11', '_atom_site_aniso_U_22', '_atom_site_aniso_U_33',
  '_atom_site_aniso_U_12', '_atom_site_aniso_U_13', '_atom_site_aniso_U_23',
];

const CELL_ANGLE_TOLERANCE = 0.05;

// Whether this block's own cell is in the hexagonal setting (alpha=beta=90,
// gamma=120), which is when atom coordinates can legitimately be exactly 1/3 or 2/3.
function isHexagonalCellAngles(block) {
  const alpha = parseFloat(stripUncertainty(block.tags['_cell_angle_alpha'] || ''));
  const beta = parseFloat(stripUncertainty(block.tags['_cell_angle_beta'] || ''));
  const gamma = parseFloat(stripUncertainty(block.tags['_cell_angle_gamma'] || ''));
  const is90 = angle => Math.abs(angle - 90) < CELL_ANGLE_TOLERANCE;
  const is120 = angle => Math.abs(angle - 120) < CELL_ANGLE_TOLERANCE;
  return is90(alpha) && is90(beta) && is120(gamma);
}

// Builds one block's atom table (label, x, y, z, occupancy, Uiso, and the 6 ADP terms
// when refined anisotropically) straight from that block's own _atom_site/
// _atom_site_aniso loops, keeping the CIF's own atom labels and values as-is - no
// relabeling or splitting of disordered sites (that requires chemistry knowledge -
// e.g. which fraction of a mixed site is Cl vs water - that isn't present in the CIF).
function buildAtomTableRows(block) {
  const atomLoop = getAtomSiteLoop(block);
  if (!atomLoop) return null;

  const labelIdx = atomLoop.tags.indexOf('_atom_site_label');
  const xIdx = atomLoop.tags.indexOf('_atom_site_fract_x');
  const yIdx = atomLoop.tags.indexOf('_atom_site_fract_y');
  const zIdx = atomLoop.tags.indexOf('_atom_site_fract_z');
  const occIdx = atomLoop.tags.indexOf('_atom_site_occupancy');
  // Some CIFs report the isotropic displacement parameter as B instead of U (two
  // different unit conventions for the same physical quantity, B = 8pi^2 * U) via a
  // completely separate tag, _atom_site_B_iso_or_equiv - when that tag is present,
  // it should be used (and labeled "Biso") instead of _atom_site_U_iso_or_equiv.
  const bisoIdx = atomLoop.tags.indexOf('_atom_site_B_iso_or_equiv');
  const uisoIdx = atomLoop.tags.indexOf('_atom_site_U_iso_or_equiv');
  const isoIdx = bisoIdx !== -1 ? bisoIdx : uisoIdx;

  // Some CIFs store the value under _atom_site_U_iso_or_equiv but the column is
  // actually B, not U - the only indicator is a separate _atom_site_thermal_displace_type
  // column reading "Biso" (the tag name itself is misleading there). That type column
  // is authoritative over the value tag's own name when it says Biso.
  const thermalTypeIdx = atomLoop.tags.indexOf('_atom_site_thermal_displace_type');
  const typedAsBiso = thermalTypeIdx !== -1 &&
    atomLoop.rows.some(row => (row[thermalTypeIdx] || '').trim().toLowerCase() === 'biso');
  const isoLabel = (bisoIdx !== -1 || typedAsBiso) ? 'Biso' : 'Uiso';

  const anisoLoop = getAtomSiteAnisoLoop(block);
  const anisoLabelIdx = anisoLoop ? anisoLoop.tags.indexOf('_atom_site_aniso_label') : -1;
  const anisoColumnIdx = anisoLoop ? ANISO_COLUMN_ORDER.map(tag => anisoLoop.tags.indexOf(tag)) : null;
  const anisoByLabel = new Map();
  if (anisoLoop) {
    for (const row of anisoLoop.rows) anisoByLabel.set(row[anisoLabelIdx], row);
  }

  const allowThirds = isHexagonalCellAngles(block);

  const rows = atomLoop.rows.map(row => {
    const cells = [
      normalizeAtomLabel(row[labelIdx]),
      formatAmcCoordinate(row[xIdx], allowThirds),
      formatAmcCoordinate(row[yIdx], allowThirds),
      formatAmcCoordinate(row[zIdx], allowThirds),
      occIdx !== -1 && !isFullOccupancy(row[occIdx]) ? formatAmcDecimal(row[occIdx]) : '',
      isoIdx !== -1 ? formatAmcDecimal(row[isoIdx]) : '',
    ];
    const anisoRow = anisoByLabel.get(row[labelIdx]);
    for (const anisoTagIdx of anisoColumnIdx || []) {
      cells.push(anisoRow ? formatAmcDecimal(anisoRow[anisoTagIdx]) : '');
    }
    while (cells.length < 12) cells.push('');
    return cells;
  });

  applyPrecision(
    rows,
    atomLoop.rows.map(row => [row[xIdx], row[yIdx], row[zIdx]]),
    occIdx !== -1 ? atomLoop.rows.map(row => row[occIdx]) : null,
    isoIdx !== -1 ? atomLoop.rows.map(row => row[isoIdx]) : null,
    anisoLoop ? atomLoop.rows.map(row => {
      const anisoRow = anisoByLabel.get(row[labelIdx]);
      return anisoColumnIdx.map(j => (anisoRow ? anisoRow[j] : undefined));
    }) : null,
    allowThirds,
  );

  return { rows, isoLabel };
}

// All 12 columns (atom, x, y, z, occ, Uiso, U(1,1)-U(2,3)) are shown.
const VISIBLE_ATOM_COLUMNS = 12;

// Produced for every block that has its own _atom_site loop - a CIF with a single
// structural block gets one table, one with multiple separately-refined datasets
// (e.g. "data_I" and "data_II" for two twin domains) gets one table per block.
function buildAtomDatasetsOutput(data) {
  const datasetTables = data.blocks
    .map(block => buildAtomTableRows(block))
    .filter(table => table !== null);

  if (datasetTables.length === 0) return '';

  const alignRight = [false, true, true, true, true, true, true, true, true, true, true, true]
    .slice(0, VISIBLE_ATOM_COLUMNS);

  const lines = [];
  for (const { rows: fullRows, isoLabel } of datasetTables) {
    let rows = fullRows.map(row => row.slice(0, VISIBLE_ATOM_COLUMNS));
    // The isotropic displacement column is labeled "Biso" or "Uiso" depending on
    // which this particular dataset's CIF actually used - see buildAtomTableRows.
    let headers = ['atom', 'x', 'y', 'z', 'occ', isoLabel, 'U(1,1)', 'U(2,2)', 'U(3,3)', 'U(1,2)', 'U(1,3)', 'U(2,3)']
      .slice(0, VISIBLE_ATOM_COLUMNS);
    let datasetAlignRight = alignRight;

    // Drop any column beyond atom/x/y/z entirely (header included) if not a single
    // atom in this dataset has a value for it - e.g. no anisotropic data at all means
    // 6 empty U(i,j) columns showing headers over nothing but blank cells.
    const keepColumn = headers.map((_, col) => col < 4 || rows.some(r => r[col] !== ''));
    if (keepColumn.includes(false)) {
      headers = headers.filter((_, col) => keepColumn[col]);
      datasetAlignRight = datasetAlignRight.filter((_, col) => keepColumn[col]);
      rows = rows.map(row => row.filter((_, col) => keepColumn[col]));
    }

    // Each column is padded to the widest value it holds (label included), so
    // columns line up regardless of how long any individual atom label or
    // coordinate is - this is plain fixed-width text, not an HTML table.
    const widths = headers.map((header, col) => Math.max(header.length, ...rows.map(r => r[col].length)));

    const formatRow = cells => cells.map((cell, col) => padColumn(cell, widths[col], datasetAlignRight[col])).join('  ').trimEnd();

    lines.push(formatRow(headers));
    rows.forEach(row => lines.push(formatRow(row)));
    lines.push('END');
  }
  return lines.join('\n');
}

let currentCifData = null;
let currentApiRecord = null;
let currentFileName = '';
let currentGMatrix = null;
let currentCellParams = null;
let currentCellVolume = null;

// A fixed row count either wastes space (short header) or forces scrolling (long
// one with a big atom table) - grow the textarea to fit its content instead.
function autoSizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

const METRIC_TENSOR_AXES = ['a', 'b', 'c'];

function renderMetricTensorTable(container, G) {
  if (!G) {
    container.innerHTML = '';
    return;
  }
  const headerRow = `<tr><th></th>${METRIC_TENSOR_AXES.map(axis => `<th>${axis}</th>`).join('')}</tr>`;
  const bodyRows = G.map((row, i) => {
    const cells = row.map((v, j) => `<td${i === j ? ' class="diagonal"' : ''}>${v.toFixed(4)}</td>`).join('');
    return `<tr><th>${METRIC_TENSOR_AXES[i]}</th>${cells}</tr>`;
  }).join('');
  container.innerHTML = `<table class="matrix-table"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}

function renderData(data) {
  const crystalSystem = getCrystalSystem(data);
  document.getElementById('crystalSystemDisplay').textContent = crystalSystem ? `Crystal System: ${crystalSystem}` : '';

  const metricTensorOutput = document.getElementById('metricTensorOutput');
  const a = parseFloat(stripUncertainty(getTag(data, '_cell_length_a') || ''));
  const b = parseFloat(stripUncertainty(getTag(data, '_cell_length_b') || ''));
  const c = parseFloat(stripUncertainty(getTag(data, '_cell_length_c') || ''));
  const alpha = parseFloat(stripUncertainty(getTag(data, '_cell_angle_alpha') || ''));
  const beta = parseFloat(stripUncertainty(getTag(data, '_cell_angle_beta') || ''));
  const gamma = parseFloat(stripUncertainty(getTag(data, '_cell_angle_gamma') || ''));
  const G = [a, b, c, alpha, beta, gamma].every(Number.isFinite)
    ? computeMetricTensor(a, b, c, alpha, beta, gamma)
    : null;
  renderMetricTensorTable(metricTensorOutput, G);
  // Stays hidden until a CIF with a full set of cell parameters is loaded.
  document.getElementById('metricTensorSection').hidden = !G;
  currentGMatrix = G;
  currentCellParams = G ? { a, b, c, alpha, beta, gamma } : null;
  currentCellVolume = G ? computeCellVolume(a, b, c, alpha, beta, gamma) : null;
  document.getElementById('cellVolumeDisplay').textContent = currentCellVolume ? `Unit cell volume: ${currentCellVolume.toFixed(4)} Å³` : '';

  const amcHeaderOutput = document.getElementById('amcHeaderOutput');
  amcHeaderOutput.value = buildAmcHeader(data, currentApiRecord, currentFileName);
  autoSizeTextarea(amcHeaderOutput);
}

// Dropping a file onto a .drop-zone feeds it through the zone's file input
// and fires 'change', so drag-and-drop and "choose a file" share one handler.
function setupDropZone(input) {
  const zone = input.closest('.drop-zone');
  const fileLabel = zone.querySelector('.drop-zone-file');
  const allowedExts = input.accept.split(',').map(s => s.trim().toLowerCase()).filter(s => s.startsWith('.'));
  if (input.accept.includes('text/plain')) allowedExts.push('.txt');

  input.addEventListener('change', () => {
    const file = input.files[0];
    fileLabel.textContent = file ? file.name : '';
    zone.classList.toggle('has-file', !!file);
  });

  let dragDepth = 0;
  zone.addEventListener('dragenter', event => {
    event.preventDefault();
    dragDepth++;
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragover', event => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      zone.classList.remove('dragover');
    }
  });
  zone.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    zone.classList.remove('dragover');
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (allowedExts.length && !allowedExts.some(ext => name.endsWith(ext))) {
      fileLabel.textContent = `Not a ${allowedExts[0]} file: ${file.name}`;
      zone.classList.remove('has-file');
      return;
    }
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  });
}

// A file dropped just outside a drop zone would otherwise make the browser
// navigate away from the page to open it.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());

setupDropZone(document.getElementById('fileInput'));

document.getElementById('fileInput').addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file) return;
  currentFileName = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    currentCifData = parseCIF(reader.result);
    renderData(currentCifData);
  };
  reader.readAsText(file);
});

// Records are fetched through server.js (/api/record/<uuid>), which logs in
// with the .env credentials and calls the ODR API server-side. The browser
// can't call the API directly: it answers the CORS preflight with 405.
let lastApiRequestTime = 0;

async function rateLimitedFetch(url, options) {
  const wait = Math.max(0, lastApiRequestTime + 1000 - Date.now());
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastApiRequestTime = Date.now();
  return fetch(url, options);
}

async function fetchAmcsdRecord(uuid) {
  const res = await rateLimitedFetch(`api/record/${encodeURIComponent(uuid)}`);
  if (!res.ok) {
    let message = `Request failed: ${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && body.message) message = body.message;
    } catch {
      // Not our server's JSON error - most likely the page isn't being served
      // by server.js.
      if (res.status === 404) message += ' - start the page with "node server.js"';
    }
    throw new Error(message);
  }
  return res.json();
}

async function fetchRecordForUuid(uuid) {
  const status = document.getElementById('apiStatus');
  status.textContent = 'Fetching...';
  try {
    currentApiRecord = await fetchAmcsdRecord(uuid);
    status.textContent = 'Fetched successfully.';
    if (currentCifData) renderData(currentCifData);
    else renderData({ blockName: '', tags: {}, loops: [], blocks: [] });
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

// The record loads automatically from ?UUID=<record-uuid> in the page URL.
const recordId = new URLSearchParams(window.location.search).get('UUID');
if (recordId) {
  fetchRecordForUuid(recordId.trim());
} else {
  document.getElementById('apiStatus').textContent = 'No record UUID in URL (expected ?UUID=...).';
}

function copyTextarea(id) {
  const textarea = document.getElementById(id);
  textarea.select();
  navigator.clipboard.writeText(textarea.value).catch(() => document.execCommand('copy'));
}

document.getElementById('copyHeaderBtn').addEventListener('click', () => copyTextarea('amcHeaderOutput'));
document.getElementById('copyCitationBtn').addEventListener('click', () => copyTextarea('citationOutput'));

// Runs a submit.js call, showing "Sending..." then the result in `statusId` -
// shared by every "Send" button so each one only has to say what to send.
async function runSubmit(statusId, submitFn) {
  const status = document.getElementById(statusId);
  status.textContent = 'Sending...';
  try {
    await submitFn();
    status.textContent = 'Sent.';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

function currentDatabaseCode() {
  return getApiField(currentApiRecord, 'database_code_amcsd') ||
    (currentCifData ? getTag(currentCifData, '_database_code_amcsd') : undefined);
}

document.getElementById('sendHeaderBtn').addEventListener('click', () => {
  runSubmit('sendHeaderStatus', () => submitAmcHeader({
    headerText: document.getElementById('amcHeaderOutput').value,
    databaseCode: currentDatabaseCode(),
    mineralName: currentCifData ? getMineralName(currentCifData, currentApiRecord, currentFileName) : '',
  }));
});

document.getElementById('sendGMatrixBtn').addEventListener('click', () => {
  runSubmit('sendGMatrixStatus', () => submitGMatrix({
    gMatrix: currentGMatrix,
    cell: currentCellParams,
    cellVolume: currentCellVolume,
    databaseCode: currentDatabaseCode(),
  }));
});

function wrapText(text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current && (current + ' ' + word).length > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function parseCitationString(citation) {
  const cleaned = citation.trim().replace(/\s+/g, ' ');

  const yearMatch = cleaned.match(/^(.*?)\s*\((\d{4})\)\s*(.*)$/);
  if (!yearMatch) return null;
  const authors = yearMatch[1].trim();
  const year = yearMatch[2];
  const remainder = yearMatch[3].trim();

  // Greedy title capture backtracks to the LAST ". " in the string, which is what
  // separates the title from "Journal Volume, Pages" even when the title itself
  // contains internal periods (e.g. "...carbonates. III. Crystal structures...")
  const tailMatch = remainder.match(/^(.*)\.\s+([A-Za-z][A-Za-z .]*?)\s+([A-Za-z0-9]+(?:\([^)]*\))?),\s*(\d+(?:[-–]\d+)?)\s*$/);
  if (!tailMatch) return null;

  const titleRaw = tailMatch[1].trim();
  const journal = tailMatch[2].trim();
  const volume = tailMatch[3].trim();
  const pages = tailMatch[4].trim();
  const journalLine = `${journal} ${volume} (${year}) ${pages}`;

  let mineralName = null;
  let localityLine = null;
  let title = titleRaw;

  // "New mineral" description papers reliably end in "...a new X mineral from <locality>."
  // and start with "<MineralName>, <formula...>, ..." - pull both out when that pattern shows up
  const hasMineralWord = /\bmineral\b/i.test(titleRaw);
  const localityMatch = hasMineralWord && titleRaw.match(/^(.*)\bfrom\s+(.+)$/i);

  if (localityMatch) {
    const titleMain = localityMatch[1].trim().replace(/,$/, '');
    const locality = localityMatch[2].trim();
    title = `${titleMain} from ${locality}`;
    localityLine = `Locality: ${locality}`;

    const nameMatch = titleRaw.match(/^([A-Z][^,]*),/);
    if (nameMatch) mineralName = nameMatch[1].trim();
  }

  return {
    mineralName: mineralName ? sanitizeCitationText(mineralName) : null,
    authors: sanitizeCitationText(authors),
    journalLine: sanitizeCitationText(journalLine),
    title: sanitizeCitationText(title),
    localityLine: localityLine ? sanitizeCitationText(localityLine) : null,
  };
}

function formatCitationBlock(citation) {
  const parsed = parseCitationString(citation);
  if (!parsed) return null;
  const lines = [];
  if (parsed.mineralName) lines.push(parsed.mineralName);
  lines.push(parsed.authors);
  lines.push(parsed.journalLine);
  lines.push(parsed.title);
  if (parsed.localityLine) lines.push(parsed.localityLine);
  // Same line-wrapping method as the AMC header: word-wrap every line at 80 chars.
  return lines.flatMap(line => wrapText(line, 80)).join('\n');
}

document.getElementById('formatCitationBtn').addEventListener('click', () => {
  const input = document.getElementById('citationInput').value;
  const status = document.getElementById('citationStatus');
  const output = document.getElementById('citationOutput');

  const formatted = formatCitationBlock(input);
  if (formatted === null) {
    status.textContent = "Couldn't parse that citation — expected format: Authors (Year) Title. Journal Volume, Pages";
    output.value = '';
  } else {
    status.textContent = '';
    output.value = formatted;
  }
  autoSizeTextarea(output);
});

document.getElementById('citationInput').addEventListener('input', event => autoSizeTextarea(event.target));
