// Cross-checks only the crystallographic DATA the app generates from a CIF
// (cell params, space group, atom table) against the real published AMC
// file's own data - deliberately skipping the citation header (name,
// authors, journal, title, locality, database code), since that part is
// expected to differ until the API-lookup path fills it in properly.
const fs = require('fs');
const path = require('path');

const REPO = 'D:/Repositories/CiftoAMC';
const AMC_DIR = 'C:/Users/natha/Downloads/amc';
const CIF_DIR = 'C:/Users/natha/Downloads/cif';
const OUT_CSV = 'C:/Users/natha/Downloads/cif_amc_data_mismatches.csv';

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
  `this.__lib = { parseCIF, resolveSpaceGroup, getTag, stripUncertainty, parseAmcText, buildAtomTableRows, bisoToUiso, betaToU, computeReciprocalCellLengths };`;

const ctx = {};
new Function(src).call(ctx);
const { parseCIF, resolveSpaceGroup, getTag, stripUncertainty, parseAmcText, buildAtomTableRows, bisoToUiso, betaToU, computeReciprocalCellLengths } = ctx.__lib;

function idFromFileName(name) {
  const m = name.match(/__(\d+)\.(cif|amc)$/i);
  return m ? m[1] : null;
}

const cifByld = new Map();
for (const name of fs.readdirSync(CIF_DIR)) {
  if (!/\.cif$/i.test(name)) continue;
  const id = idFromFileName(name);
  if (!id) continue;
  const isOriginal = /__original__/i.test(name);
  const existing = cifByld.get(id);
  if (!existing || (existing.isOriginal && !isOriginal)) cifByld.set(id, { name, isOriginal });
}

function norm(s) { return (s || '').trim(); }

// Values can be a plain decimal, or an AMC-style fraction like "1/3" / "-2/3".
function toFloat(v) {
  if (v === undefined || v === null || v === '') return NaN;
  const s = String(v).trim();
  const fracMatch = s.match(/^(-?)(\d+)\/(\d+)$/);
  if (fracMatch) {
    const [, sign, num, den] = fracMatch;
    return (sign === '-' ? -1 : 1) * (parseInt(num, 10) / parseInt(den, 10));
  }
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : NaN;
}

function valuesClose(a, b, eps) {
  const na = norm(a), nb = norm(b);
  if (na === '' && nb === '') return true;
  if (na === '' || nb === '') return false;
  const fa = toFloat(na), fb = toFloat(nb);
  if (Number.isFinite(fa) && Number.isFinite(fb)) return Math.abs(fa - fb) < eps;
  return na === nb;
}

const POSITION_COLS = ['x', 'y', 'z', 'occ'];
const ANISO_KEYS = ['U11', 'U22', 'U33', 'U12', 'U13', 'U23'];
// Matches the AMC_ATOM_COLUMN_MAP values used by parseAmcAtomTable/AMC_ATOM_COLUMN_MAP.
const REAL_COL_KEYS = { fract_x: 'x', fract_y: 'y', fract_z: 'z', occupancy: 'occ' };

const EIGHT_PI_SQUARED = 8 * Math.PI * Math.PI;

// Some fields can genuinely be expressed in two different unit conventions
// (Uiso vs Biso, U_ij vs beta_ij) that both encode the same physical value -
// try a straight comparison first, and only fall back to converting one side
// when that fails, so a file isn't flagged just because it uses the other
// convention. Only a value that still disagrees after trying the conversion
// is a genuine problem.
function isoValuesEquivalent(genVal, genLabel, realVal, realLabel) {
  if (valuesClose(genVal, realVal, 0.001)) return true;
  if (!genLabel || !realLabel || genLabel === realLabel) return false;
  const genFloat = toFloat(genVal);
  if (!Number.isFinite(genFloat)) return false;
  // Convert the generated value into the real side's convention.
  const converted = genLabel === 'Uiso' ? genFloat * EIGHT_PI_SQUARED : genFloat / EIGHT_PI_SQUARED;
  return valuesClose(String(converted), realVal, 0.001);
}

const amcFiles = fs.readdirSync(AMC_DIR).filter(f => /\.amc$/i.test(f));
console.log(`AMC files: ${amcFiles.length}, CIF ids indexed: ${cifByld.size}`);

// A field name maps to one broad reason category, so one file with (say) 40
// atoms all mismatched shows up as a single row, not 40 separate lines. Note:
// iso/aniso fields only get flagged after a same-convention AND a
// converted-convention comparison both failed (see isoValuesEquivalent /
// the aniso handling below) - so unlike the older report, these categories
// mean a genuine value disagreement, not just a Uiso/Biso or U_ij/beta_ij
// labeling difference.
function categoryFor(field) {
  if (field.startsWith('PARSE_ERROR')) return 'parseError';
  if (field.startsWith('cell.')) return 'cell';
  if (field === 'spaceGroup') return 'spaceGroup';
  if (field === 'atomDatasetCount') return 'datasetCount';
  if (field.endsWith('.iso')) return 'isoMismatch';
  if (/\.(U11|U22|U33|U12|U13|U23)$/.test(field)) return 'anisoMismatch';
  if (field.endsWith('.missing') || field.endsWith('.extra')) return 'labelMismatch';
  if (/\.(x|y|z|occ)$/.test(field)) return 'coordMismatch';
  return 'other';
}

const recordRows = [['id', 'amcFile', 'cifFile', 'categories', 'fieldMismatchCount']];
let compared = 0, noMatch = 0, parseErrors = 0;
const mismatchCountByCategory = {};
const mismatchedRecordIds = new Set();

for (const amcFile of amcFiles) {
  const id = idFromFileName(amcFile);
  if (!id) continue;
  const cifEntry = cifByld.get(id);
  if (!cifEntry) { noMatch++; continue; }

  let real, data;
  let parseErrorMsg = null;
  try {
    real = parseAmcText(fs.readFileSync(path.join(AMC_DIR, amcFile), 'utf8'));
  } catch (err) {
    parseErrors++;
    recordRows.push([id, amcFile, cifEntry.name, 'parseError:amc', 1]);
    mismatchCountByCategory.parseError = (mismatchCountByCategory.parseError || 0) + 1;
    mismatchedRecordIds.add(id);
    continue;
  }
  try {
    data = parseCIF(fs.readFileSync(path.join(CIF_DIR, cifEntry.name), 'utf8'));
  } catch (err) {
    parseErrors++;
    recordRows.push([id, amcFile, cifEntry.name, 'parseError:cif', 1]);
    mismatchCountByCategory.parseError = (mismatchCountByCategory.parseError || 0) + 1;
    mismatchedRecordIds.add(id);
    continue;
  }

  compared++;
  let recordMismatched = false;
  let fieldCount = 0;
  const categoriesSeen = new Set();
  const flag = (field) => {
    fieldCount++;
    categoriesSeen.add(categoryFor(field));
    recordMismatched = true;
  };

  const realCell = (real.datasets[0] || {}).cell || {};
  const cellTags = ['_cell_length_a', '_cell_length_b', '_cell_length_c', '_cell_angle_alpha', '_cell_angle_beta', '_cell_angle_gamma'];
  const cellKeys = ['a', 'b', 'c', 'alpha', 'beta', 'gamma'];
  cellKeys.forEach((key, i) => {
    const gen = stripUncertainty(getTag(data, cellTags[i]) || '');
    if (!valuesClose(gen, realCell[key], 0.005)) flag(`cell.${key}`, gen, realCell[key] || '');
  });

  const genSg = resolveSpaceGroup(data);
  if (norm(genSg) !== norm(realCell.spaceGroup)) flag('spaceGroup', genSg, realCell.spaceGroup || '');

  // Atom table: match generated CIF blocks to real AMC datasets by index.
  const genTables = data.blocks.map(block => buildAtomTableRows(block)).filter(Boolean);
  const realDatasets = real.datasets || [];

  if (genTables.length !== realDatasets.length) {
    flag('atomDatasetCount', genTables.length, realDatasets.length);
  } else {
    genTables.forEach((genTable, dsIdx) => {
      const realDs = realDatasets[dsIdx];
      const genByLabel = new Map(genTable.rows.map(r => [r[0], r]));
      const realByLabel = new Map();
      for (const r of realDs.rows) realByLabel.set(r.label, r);

      const realIsoLabel = realDs.columns.includes('Uiso') ? 'Uiso' : realDs.columns.includes('Biso') ? 'Biso' : null;
      const realAnisoConvention = ANISO_KEYS.every(k => realDs.columns.includes(k)) ? 'U'
        : ['B11', 'B22', 'B33', 'B12', 'B13', 'B23'].every(k => realDs.columns.includes(k)) ? 'B'
        : null;
      let reciprocal = null;
      const getReciprocal = () => {
        if (!reciprocal) {
          reciprocal = computeReciprocalCellLengths(
            parseFloat(realCell.a), parseFloat(realCell.b), parseFloat(realCell.c),
            parseFloat(realCell.alpha), parseFloat(realCell.beta), parseFloat(realCell.gamma),
          );
        }
        return reciprocal;
      };

      const allLabels = new Set([...genByLabel.keys(), ...realByLabel.keys()]);
      for (const label of allLabels) {
        const genRow = genByLabel.get(label);
        const realRow = realByLabel.get(label);
        if (!genRow) { flag(`atom[${label}].missing`); continue; }
        if (!realRow) { flag(`atom[${label}].extra`); continue; }

        POSITION_COLS.forEach((col, colIdx) => {
          const genVal = genRow[colIdx + 1] || '';
          const realColIdx = realDs.columns.findIndex(c => REAL_COL_KEYS[c] === col);
          const realVal = realColIdx === -1 ? '' : (realRow.values[realColIdx] || '');
          if (!valuesClose(genVal, realVal, 0.001)) flag(`atom[${label}].${col}`);
        });

        // Isotropic displacement: try a same-convention comparison first,
        // then a Uiso<->Biso converted one, before calling it a mismatch.
        const genIsoVal = genRow[5] || '';
        const realIsoColIdx = realIsoLabel ? realDs.columns.indexOf(realIsoLabel) : -1;
        const realIsoVal = realIsoColIdx === -1 ? '' : (realRow.values[realIsoColIdx] || '');
        if (genIsoVal === '' && realIsoVal === '') {
          // both absent - fine
        } else if (genIsoVal === '' || realIsoVal === '') {
          flag(`atom[${label}].iso`);
        } else if (!isoValuesEquivalent(genIsoVal, genTable.isoLabel, realIsoVal, realIsoLabel)) {
          flag(`atom[${label}].iso`);
        }

        // Anisotropic displacement: generated is always U-convention; real
        // may be U or beta_ij - convert real's beta values to U first (using
        // this dataset's reciprocal cell lengths) before comparing.
        const genAnisoIdx = [6, 7, 8, 9, 10, 11];
        const genHasAllAniso = genAnisoIdx.every(idx => genRow[idx]);
        if (realAnisoConvention) {
          const realOrder = (realAnisoConvention === 'U' ? ANISO_KEYS : ['B11', 'B22', 'B33', 'B12', 'B13', 'B23']).map(k => realDs.columns.indexOf(k));
          const realHasAllAniso = realOrder.every(idx => realRow.values[idx]);
          if (realHasAllAniso && genHasAllAniso) {
            const realRaw = realOrder.map(idx => parseFloat(realRow.values[idx]));
            const realU = realAnisoConvention === 'B'
              ? betaToU(realRaw, getReciprocal().aStar, getReciprocal().bStar, getReciprocal().cStar)
              : realRaw;
            ANISO_KEYS.forEach((key, k) => {
              const genVal = parseFloat(genRow[6 + k]);
              if (!Number.isFinite(genVal) || !Number.isFinite(realU[k]) || Math.abs(genVal - realU[k]) >= 0.001) {
                flag(`atom[${label}].${key}`);
              }
            });
          } else if (realHasAllAniso !== genHasAllAniso) {
            ANISO_KEYS.forEach(key => flag(`atom[${label}].${key}`));
          }
        } else if (genHasAllAniso) {
          ANISO_KEYS.forEach(key => flag(`atom[${label}].${key}`));
        }
      }
    });
  }

  if (recordMismatched) {
    mismatchedRecordIds.add(id);
    for (const cat of categoriesSeen) mismatchCountByCategory[cat] = (mismatchCountByCategory[cat] || 0) + 1;
    recordRows.push([id, amcFile, cifEntry.name, [...categoriesSeen].sort().join(';'), fieldCount]);
  }
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
fs.writeFileSync(OUT_CSV, recordRows.map(r => r.map(csvCell).join(',')).join('\n'), 'utf8');

console.log(`Compared: ${compared}`);
console.log(`No matching CIF found: ${noMatch}`);
console.log(`Parse errors: ${parseErrors}`);
console.log(`Records with at least one DATA mismatch: ${mismatchedRecordIds.size}`);
console.log('Records affected, by category (a file can count toward more than one):', Object.fromEntries(
  Object.entries(mismatchCountByCategory).sort((a, b) => b[1] - a[1])
));
console.log(`Report written to: ${OUT_CSV}`);
