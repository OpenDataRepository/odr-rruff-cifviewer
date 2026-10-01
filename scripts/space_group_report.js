// Space-group inventory of the local AMC and CIF datasets, checked against
// Downs' space-group list (DownsSpaceGroupData.txt), the blueprint of every
// symbol the AMC format is supposed to use. Writes one report per dataset:
//   1. every distinct space group seen, with counts. A leading "*" is not
//      really part of the symbol, so it is dropped ("*Fd3m" counts as "Fd3m"),
//      but every starred file is still tracked and listed
//   2. the check against Downs: symbols used but missing from Downs' list, and
//      Downs entries no file uses
// plus a per-file CSV for each dataset so any entry can be traced to its files.
//
// CIFs write Hermann-Mauguin symbols ("P 21 21 2"), so they are converted to
// AMC form ("P2_12_12") with the app's own resolveSpaceGroup before the check.
// Downs marks alternate settings with a ":n" suffix that AMC files leave off
// (the cell parameters tell them apart), so the check compares with it removed.
const fs = require('fs');
const path = require('path');

const REPO = 'D:/Repositories/CiftoAMC';
const DOWNLOADS = 'C:/Users/natha/Downloads';
const AMC_DIR = path.join(DOWNLOADS, 'amc');
const CIF_DIR = path.join(DOWNLOADS, 'cif');
const DOWNS_FILE = path.join(DOWNLOADS, 'DownsSpaceGroupData.txt');
const OUT_DIR = DOWNLOADS;
const MAX_EXAMPLE_FILES = 10;

const stub = `
var document = { getElementById: () => ({ addEventListener(){}, value:'', textContent:'', style:{} }) };
var window = { location: { search: '' }, AMCSD_AUTH_READY: null, addEventListener(){} };
var navigator = { clipboard: { writeText: () => Promise.resolve() } };
function setupDropZone() {}
`;

const src = stub + '\n' +
  fs.readFileSync(path.join(REPO, 'spacegroups.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(REPO, 'amc2cif.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(REPO, 'app.js'), 'utf8').replace(/^function setupDropZone[\s\S]*?^}\r?\n/m, '') + '\n' +
  `this.__lib = { parseCIF, resolveSpaceGroup, getTag, AMC_CELL_LINE_RE };`;

const ctx = {};
new Function(src).call(ctx);
const { parseCIF, resolveSpaceGroup, getTag, AMC_CELL_LINE_RE } = ctx.__lib;

// --- Downs' list ---------------------------------------------------------

function loadDowns() {
  const entries = [];
  for (const raw of fs.readFileSync(DOWNS_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(Date|Note):/i.test(line)) continue;
    const name = line.split(/\s+/)[0];
    entries.push({ name, key: downsKey(name), starred: name.startsWith('*') });
  }
  return entries;
}

// Downs' ":1".."":5" alternate-setting markers are never written in AMC files,
// and its "*" entries carry their origin shift in brackets, e.g.
// "*Fd3m[.125,.125,.125]". With the star dropped as well, that entry and plain
// "Fd3m" both count as the symbol "Fd3m".
function downsKey(name) {
  return name.replace(/^\*/, '').replace(/\[.*\]$/, '').replace(/:\d+$/, '');
}

// A dataset symbol drops its setting suffix too - CIFs write e.g. "R-3m:H"
// where Downs has "R-3m:4". (The "*" is already off: see splitStar.)
function symbolKey(symbol) {
  return symbol.replace(/:.*$/, '');
}

function splitStar(symbol) {
  return { symbol: symbol.replace(/^\*/, ''), starred: symbol.startsWith('*') };
}

// --- dataset scanning ----------------------------------------------------

function scanAmc() {
  const rows = [];
  for (const file of fs.readdirSync(AMC_DIR).filter(n => /\.amc$/i.test(n)).sort()) {
    const lines = fs.readFileSync(path.join(AMC_DIR, file), 'utf8').split(/\r?\n/);
    const cellLine = lines.find(l => AMC_CELL_LINE_RE.test(l.trim()));
    const raw = cellLine ? cellLine.trim().match(AMC_CELL_LINE_RE)[7] : '';
    rows.push({ file, raw, ...splitStar(raw) });
  }
  return rows;
}

function scanCif() {
  const rows = [];
  for (const file of fs.readdirSync(CIF_DIR).filter(n => /\.cif$/i.test(n)).sort()) {
    const data = parseCIF(fs.readFileSync(path.join(CIF_DIR, file), 'utf8'));
    // Same lookup the app does, but per data block so a multi-block CIF
    // reports each structural block's space group.
    const blocks = data.blocks.filter(b =>
      getTag(b, '_symmetry_space_group_name_H-M') || getTag(b, '_space_group_name_H-M_alt') || getTag(b, '_space_group_IT_number'));
    if (!blocks.length) {
      rows.push({ file, raw: '', itNumber: '', symbol: '', starred: false });
      continue;
    }
    for (const block of blocks) {
      const raw = getTag(block, '_symmetry_space_group_name_H-M') || getTag(block, '_space_group_name_H-M_alt') || '';
      const { symbol, starred } = splitStar(resolveSpaceGroup(block));
      rows.push({
        file,
        raw,
        itNumber: getTag(block, '_space_group_IT_number') || '',
        symbol,
        starred: starred || raw.trim().startsWith('*'),
      });
    }
  }
  return rows;
}

// --- report --------------------------------------------------------------

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function byCountThenName([a, ra], [b, rb]) {
  return rb.length - ra.length || a.localeCompare(b);
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const fmt = r => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(headers), widths.map(w => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n');
}

function examples(rows) {
  const files = [...new Set(rows.map(r => r.file))];
  const shown = files.slice(0, MAX_EXAMPLE_FILES).map(f => `      ${f}`);
  if (files.length > MAX_EXAMPLE_FILES) shown.push(`      ... and ${files.length - MAX_EXAMPLE_FILES} more (see the CSV)`);
  return shown.join('\n');
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildReport(label, rows, downs, isCif) {
  const downsKeys = new Set(downs.map(d => d.key));
  const downsStarredKeys = new Set(downs.filter(d => d.starred).map(d => d.key));
  const downsKeysLower = new Map(downs.map(d => [d.key.toLowerCase(), d.key]));
  const out = [];
  const files = new Set(rows.map(r => r.file));
  const found = rows.filter(r => r.symbol);
  const missing = rows.filter(r => !r.symbol);
  const starred = rows.filter(r => r.starred);
  const bySymbol = [...groupBy(found, r => r.symbol)].sort(byCountThenName);
  const inDowns = sym => downsKeys.has(symbolKey(sym));

  out.push(`${label} space group report`);
  out.push(`Generated ${new Date().toISOString()}`);
  out.push(`Checked against ${path.basename(DOWNS_FILE)} (${downs.length} entries, ${downsKeys.size} distinct symbols once "*", origin shifts and setting markers are removed)`);
  out.push('');
  out.push('A leading "*" is dropped before anything is counted or matched ("*Fd3m" counts as');
  out.push('"Fd3m"); the Starred column and the starred list below keep track of which files had one.');
  out.push('');
  out.push(`Files scanned:            ${files.size}`);
  if (isCif) out.push(`Space-group entries:      ${rows.length} (a CIF with several data blocks counts once per block)`);
  out.push(`Distinct space groups:    ${bySymbol.length}`);
  out.push(`Had a leading "*":        ${starred.length} (${new Set(starred.map(r => r.symbol)).size} different space groups)`);
  out.push(`No space group found:     ${missing.length}`);

  // Part 1 - inventory
  out.push('');
  out.push('='.repeat(78));
  out.push('PART 1 - ALL SPACE GROUPS');
  out.push('='.repeat(78));
  out.push('');
  if (isCif) {
    out.push('The "Space group" column is the CIF symbol converted the way the viewer converts it;');
    out.push('the H-M spellings column shows how the CIFs actually wrote it.');
    out.push('');
  }
  out.push(table(
    ['Space group', 'Count', 'Starred', 'In Downs', ...(isCif ? ['H-M spellings in CIFs'] : [])],
    bySymbol.map(([sym, rs]) => {
      const starCount = rs.filter(r => r.starred).length;
      const base = [sym, rs.length, starCount || '', inDowns(sym) ? 'yes' : 'NO'];
      if (!isCif) return base;
      const spellings = [...groupBy(rs, r => r.raw || `(IT number ${r.itNumber} only)`)].sort(byCountThenName)
        .map(([raw, rr]) => `${raw} (${rr.length})`).join('; ');
      return [...base, spellings];
    }),
  ));

  out.push('');
  out.push(`--- Files that had a leading "*" (${starred.length}) ---`);
  out.push('  "Downs has *" says whether Downs\' list also has a starred (origin-shifted) entry');
  out.push('  for that space group.');
  if (!starred.length) out.push('  none');
  for (const [sym, rs] of [...groupBy(starred, r => r.symbol)].sort(byCountThenName)) {
    const downsNote = downsStarredKeys.has(symbolKey(sym)) ? 'Downs has *' : 'Downs has no *';
    out.push(`  *${sym}  (${rs.length})  [${downsNote}]`);
    out.push(examples(rs));
  }

  out.push('');
  out.push('--- Files with no space group found ---');
  if (!missing.length) out.push('  none');
  else out.push(examples(missing));

  // Part 2 - check against Downs
  out.push('');
  out.push('='.repeat(78));
  out.push(`PART 2 - CHECK AGAINST ${path.basename(DOWNS_FILE)}`);
  out.push('='.repeat(78));
  out.push('');
  out.push('Matching ignores the "*", Downs\' bracketed origin shifts, and setting suffixes');
  out.push('(Downs\' ":1".."":5", CIF ":H"/":1"), so "*Fd3m", "Fd3m" and Downs\' "*Fd3m[.125,.125,.125]"');
  out.push('are all the same space group.');

  const notInDowns = bySymbol.filter(([sym]) => !inDowns(sym));
  out.push('');
  out.push(`--- Used in ${label} files but NOT in Downs' list (${notInDowns.length}) ---`);
  if (!notInDowns.length) out.push('  none');
  for (const [sym, rs] of notInDowns) {
    const near = downsKeysLower.get(symbolKey(sym).toLowerCase());
    const starCount = rs.filter(r => r.starred).length;
    const notes = [
      starCount ? `${starCount} starred` : '',
      near ? `Downs has "${near}" (case differs)` : '',
      isCif ? `H-M: ${[...new Set(rs.map(r => r.raw || `(IT ${r.itNumber})`))].join('; ')}` : '',
    ].filter(Boolean).join('; ');
    out.push(`  ${sym}  (${rs.length})${notes ? `  -- ${notes}` : ''}`);
    out.push(examples(rs));
  }

  const usedKeys = new Set(found.map(r => symbolKey(r.symbol)));
  const unusedKeys = [...new Set(downs.map(d => d.key))].filter(k => !usedKeys.has(k));
  const downsNamesByKey = groupBy(downs, d => d.key);
  out.push('');
  out.push(`--- In Downs' list but NOT used by any ${label} file (${unusedKeys.length} of ${downsKeys.size} space groups) ---`);
  out.push('  Each line is one space group, followed by the Downs entries it covers when there');
  out.push('  are several (settings like P2:1 / P2:2 / P2:3, or a starred origin-shifted version).');
  if (!unusedKeys.length) out.push('  none');
  const width = Math.max(...unusedKeys.map(k => k.length), 1) + 2;
  for (const key of unusedKeys) {
    const names = downsNamesByKey.get(key).map(d => d.name);
    const covers = names.length === 1 && names[0] === key ? '' : names.join(', ');
    out.push(`  ${key.padEnd(width)}${covers}`.trimEnd());
  }

  return out.join('\n') + '\n';
}

function writeCsv(file, headers, rows) {
  const lines = [headers.join(','), ...rows.map(r => r.map(csvCell).join(','))];
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

const downs = loadDowns();
const downsKeySet = new Set(downs.map(d => d.key));

const amcRows = scanAmc();
const amcReport = path.join(OUT_DIR, 'space_group_report_AMC.txt');
fs.writeFileSync(amcReport, buildReport('AMC', amcRows, downs, false));
writeCsv(path.join(OUT_DIR, 'space_group_files_AMC.csv'), ['file', 'space_group', 'had_star', 'as_written', 'in_downs'],
  amcRows.map(r => [r.file, r.symbol, r.starred, r.raw, r.symbol ? downsKeySet.has(symbolKey(r.symbol)) : '']));
console.log(`wrote ${amcReport}`);

const cifRows = scanCif();
const cifReport = path.join(OUT_DIR, 'space_group_report_CIF.txt');
fs.writeFileSync(cifReport, buildReport('CIF', cifRows, downs, true));
writeCsv(path.join(OUT_DIR, 'space_group_files_CIF.csv'), ['file', 'space_group', 'had_star', 'hm_symbol', 'it_number', 'in_downs'],
  cifRows.map(r => [r.file, r.symbol, r.starred, r.raw, r.itNumber, r.symbol ? downsKeySet.has(symbolKey(r.symbol)) : '']));
console.log(`wrote ${cifReport}`);
