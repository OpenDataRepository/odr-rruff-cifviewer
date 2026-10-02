// Cross-checks the app's CIF -> AMC header conversion against the real,
// published AMC files, to find records where our generated header (name,
// authors, journal, title, locality, database code, cell params + space
// group) doesn't match the real file - stopping short of the atom table.
const fs = require('fs');
const path = require('path');

const REPO = 'D:/Repositories/CiftoAMC';
const AMC_DIR = 'C:/Users/natha/Downloads/amc';
const CIF_DIR = 'C:/Users/natha/Downloads/cif';
const OUT_CSV = 'C:/Users/natha/Downloads/cif_amc_header_mismatches.csv';

// Load the app's own pure parsing/formatting functions and run them in a
// throwaway scope, stubbing the DOM globals app.js touches at its top level
// so the whole (unmodified) file can just be evaluated as-is.
const stub = `
var document = { getElementById: () => ({ addEventListener(){}, value:'', textContent:'', style:{} }) };
var window = { location: { search: '' }, addEventListener(){} };
function setupDropZone() {}
var navigator = { clipboard: { writeText: () => Promise.resolve() } };
`;

const src = stub + '\n' +
  fs.readFileSync(path.join(REPO, 'spacegroups.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(REPO, 'amc2cif.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(REPO, 'app.js'), 'utf8').replace(/^function setupDropZone[\s\S]*?^}\r?\n/m, '') + '\n' +
  `this.__lib = { parseCIF, buildAmcHeader, getMineralName, formatAuthors, resolveSpaceGroup, getTag, stripUncertainty, getCitationField, getApiField, parseAmcText, wrapText };`;

const ctx = {};
new Function(src).call(ctx);
const {
  parseCIF, getMineralName, formatAuthors, resolveSpaceGroup, getTag,
  stripUncertainty, getCitationField, getApiField, parseAmcText,
} = ctx.__lib;

function idFromFileName(name) {
  const m = name.match(/__(\d+)\.(cif|amc)$/i);
  return m ? m[1] : null;
}

// Build id -> cif path, preferring the plain "Name__ID.cif" over any
// "Name__original__ID.cif" variant for the same id.
const cifByld = new Map();
for (const name of fs.readdirSync(CIF_DIR)) {
  if (!/\.cif$/i.test(name)) continue;
  const id = idFromFileName(name);
  if (!id) continue;
  const isOriginal = /__original__/i.test(name);
  const existing = cifByld.get(id);
  if (!existing || (existing.isOriginal && !isOriginal)) {
    cifByld.set(id, { name, isOriginal });
  }
}

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function floatsClose(a, b, eps) {
  const fa = parseFloat(a);
  const fb = parseFloat(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) return norm(a) === norm(b);
  return Math.abs(fa - fb) < eps;
}

const amcFiles = fs.readdirSync(AMC_DIR).filter(f => /\.amc$/i.test(f));
console.log(`AMC files: ${amcFiles.length}, CIF ids indexed: ${cifByld.size}`);

const rows = [['id', 'amcFile', 'cifFile', 'field', 'generated', 'real']];
let compared = 0;
let noMatch = 0;
let parseErrors = 0;
const mismatchCountByField = {};
const mismatchedRecordIds = new Set();

for (const amcFile of amcFiles) {
  const id = idFromFileName(amcFile);
  if (!id) continue;
  const cifEntry = cifByld.get(id);
  if (!cifEntry) { noMatch++; continue; }

  let real, data;
  try {
    const amcText = fs.readFileSync(path.join(AMC_DIR, amcFile), 'utf8');
    real = parseAmcText(amcText);
  } catch (err) {
    parseErrors++;
    rows.push([id, amcFile, cifEntry.name, 'PARSE_ERROR_AMC', '', String(err.message || err)]);
    continue;
  }
  try {
    const cifText = fs.readFileSync(path.join(CIF_DIR, cifEntry.name), 'utf8');
    data = parseCIF(cifText);
  } catch (err) {
    parseErrors++;
    rows.push([id, amcFile, cifEntry.name, 'PARSE_ERROR_CIF', '', String(err.message || err)]);
    continue;
  }

  compared++;
  const realCell = (real.datasets[0] || {}).cell || {};
  const fields = [];

  fields.push(['name', getMineralName(data, null, cifEntry.name), real.header.name]);
  fields.push(['authors', formatAuthors(data, null), real.header.authors.join(', ')]);

  const journal = getCitationField(null, 'Journal') || getTag(data, '_journal_name_full') || '';
  const volume = getTag(data, '_journal_volume') || '';
  const year = getTag(data, '_journal_year') || '';
  const pageFirst = getTag(data, '_journal_page_first') || '';
  const pageLast = getTag(data, '_journal_page_last') || '';
  fields.push(['journal', journal, real.header.journal || '']);
  fields.push(['volume', volume, real.header.volume || '']);
  fields.push(['year', year, real.header.year || '']);
  fields.push(['pageFirst', pageFirst, real.header.pageFirst || '']);
  fields.push(['pageLast', pageLast, real.header.pageLast || '']);

  const title = getTag(data, '_publ_section_title') || '';
  fields.push(['title', norm(title), norm(real.header.titleLines.join(' '))]);

  const locality = getApiField(null, 'Locality') || getTag(data, '_chemical_compound_source') || '';
  fields.push(['locality', locality, real.header.locality || '']);

  const amcsd = getTag(data, '_database_code_amcsd') || '';
  fields.push(['amcsd', amcsd, real.header.amcsd || '']);

  const cellTags = ['_cell_length_a', '_cell_length_b', '_cell_length_c', '_cell_angle_alpha', '_cell_angle_beta', '_cell_angle_gamma'];
  const cellKeys = ['a', 'b', 'c', 'alpha', 'beta', 'gamma'];
  cellKeys.forEach((key, i) => {
    const gen = stripUncertainty(getTag(data, cellTags[i]) || '');
    fields.push([`cell.${key}`, gen, realCell[key] || '']);
  });

  fields.push(['spaceGroup', resolveSpaceGroup(data), realCell.spaceGroup || '']);

  let recordMismatched = false;
  for (const [field, gen, real2] of fields) {
    let mismatch;
    if (field.startsWith('cell.')) mismatch = !floatsClose(gen, real2, 0.005);
    else if (field === 'name' || field === 'authors' || field === 'title' || field === 'locality') mismatch = norm(gen).toLowerCase() !== norm(real2).toLowerCase();
    else mismatch = norm(gen) !== norm(real2);

    if (mismatch) {
      rows.push([id, amcFile, cifEntry.name, field, gen, real2]);
      mismatchCountByField[field] = (mismatchCountByField[field] || 0) + 1;
      recordMismatched = true;
    }
  }
  if (recordMismatched) mismatchedRecordIds.add(id);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
fs.writeFileSync(OUT_CSV, rows.map(r => r.map(csvCell).join(',')).join('\n'), 'utf8');

console.log(`Compared: ${compared}`);
console.log(`No matching CIF found: ${noMatch}`);
console.log(`Parse errors: ${parseErrors}`);
console.log(`Records with at least one mismatch: ${mismatchedRecordIds.size}`);
console.log('Mismatches by field:', mismatchCountByField);
console.log(`Report written to: ${OUT_CSV}`);
