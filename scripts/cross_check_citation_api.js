// Cross-checks the citation part of the AMC header the app builds WITH the API
// record (the way the viewer really runs: fetch record -> build header) against
// the real, published AMC file's header. Only the data is compared, field by
// field with whitespace collapsed - where a long line wraps doesn't matter.
//
// API use is deliberately capped: at most MAX_API_CALLS requests per run (the
// login counts as one), at least 1 second apart, and every fetched record is
// cached to disk so re-running the comparison never re-fetches it.
//
// Record UUIDs come from UUID_MAP_FILE, a JSON object of AMCSD code -> record
// UUID, e.g. { "0021564": "b19c33fd6e0d0648cb4a3fb9904b" }. Only codes that have
// a UUID plus a local CIF and AMC file are checked.
const fs = require('fs');
const path = require('path');

const REPO = 'D:/Repositories/CiftoAMC';
const AMC_DIR = 'C:/Users/natha/Downloads/amc';
const CIF_DIR = 'C:/Users/natha/Downloads/cif';
const UUID_MAP_FILE = path.join(REPO, 'scripts/amcsd_uuids.json');
const CACHE_DIR = 'C:/Users/natha/Downloads/amcsd_api_cache';
const OUT_CSV = 'C:/Users/natha/Downloads/cif_amc_citation_api_mismatches.csv';

const API_BASE = 'https://www.rruff.net/odr_rruff/api/v4';
const MAX_RECORDS = 200;
const MAX_API_CALLS = 200;
const MIN_REQUEST_GAP_MS = 1100;

const stub = `
var document = { getElementById: () => ({ addEventListener(){}, value:'', textContent:'', style:{} }) };
var window = { location: { search: '' }, AMCSD_AUTH_READY: null, addEventListener(){} };
function setupDropZone() {}
var navigator = { clipboard: { writeText: () => Promise.resolve() } };
`;

const src = stub + '\n' +
  fs.readFileSync(path.join(REPO, 'spacegroups.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(REPO, 'amc2cif.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(REPO, 'app.js'), 'utf8').replace(/^function setupDropZone[\s\S]*?^}\r?\n/m, '') + '\n' +
  `this.__lib = { parseCIF, buildAmcHeader, isAmcCellLine, parseAmcHeaderLines };`;

const ctx = {};
new Function(src).call(ctx);
const { parseCIF, buildAmcHeader, isAmcCellLine, parseAmcHeaderLines } = ctx.__lib;

function idFromFileName(name) {
  const m = name.match(/__(\d+)\.(cif|amc)$/i);
  return m ? m[1] : null;
}

function indexDir(dir, ext) {
  const byId = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(ext)) continue;
    const id = idFromFileName(name);
    if (!id) continue;
    const isOriginal = /__original__/i.test(name);
    const existing = byId.get(id);
    if (!existing || (existing.isOriginal && !isOriginal)) byId.set(id, { name, isOriginal });
  }
  return byId;
}

function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(REPO, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

let apiCalls = 0;
let lastRequestTime = 0;

async function apiFetch(url, options) {
  if (apiCalls >= MAX_API_CALLS) throw new Error('API call budget used up');
  const wait = lastRequestTime + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();
  apiCalls++;
  return fetch(url, options);
}

let token = null;
async function getToken() {
  if (token) return token;
  const env = readEnv();
  const username = env.API_CLIENT_ID || env.username;
  const password = env.API_CLIENT_SECRET || env.password;
  if (!username || !password) throw new Error('No credentials in .env');
  const res = await apiFetch(`${API_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Login failed: HTTP ${res.status}`);
  const data = await res.json();
  token = data.token || data.access_token || data.jwt;
  if (!token) throw new Error('Login response had no token');
  return token;
}

// Returns the cached record, or fetches (and caches) it. Throws on any HTTP
// error so the run stops rather than hammering a server that's refusing us.
async function getRecord(id, uuid) {
  const cacheFile = path.join(CACHE_DIR, `${id}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const auth = await getToken();
  const res = await apiFetch(`${API_BASE}/dataset/record/${uuid}`, { headers: { Authorization: `Bearer ${auth}` } });
  if (!res.ok) throw new Error(`Record ${id} (${uuid}): HTTP ${res.status}`);
  const record = await res.json();
  fs.writeFileSync(cacheFile, JSON.stringify(record), 'utf8');
  return record;
}

function headerLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cellIndex = lines.findIndex(isAmcCellLine);
  return (cellIndex === -1 ? lines : lines.slice(0, cellIndex)).map(l => l.trim()).filter(Boolean);
}

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Picks up to `count` ids spread evenly across the sorted list, so the sample
// covers old and new records rather than just the first 200 codes.
function spreadSample(ids, count) {
  if (ids.length <= count) return ids;
  const step = ids.length / count;
  return Array.from({ length: count }, (_, i) => ids[Math.floor(i * step)]);
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const uuidById = fs.existsSync(UUID_MAP_FILE) ? JSON.parse(fs.readFileSync(UUID_MAP_FILE, 'utf8')) : {};
  const cifById = indexDir(CIF_DIR, '.cif');
  const amcById = indexDir(AMC_DIR, '.amc');

  const candidates = Object.keys(uuidById).filter(id => cifById.has(id) && amcById.has(id)).sort();
  const sample = spreadSample(candidates, MAX_RECORDS);
  console.log(`UUIDs known: ${Object.keys(uuidById).length}, with CIF+AMC: ${candidates.length}, checking: ${sample.length}`);

  const rows = [['id', 'field', 'generated', 'real']];
  const mismatchCountByField = {};
  const mismatchedIds = new Set();
  let compared = 0;
  let stoppedReason = '';

  for (const id of sample) {
    let record;
    try {
      record = await getRecord(id, uuidById[id]);
    } catch (err) {
      stoppedReason = err.message;
      break;
    }

    const cifName = cifById.get(id).name;
    const data = parseCIF(fs.readFileSync(path.join(CIF_DIR, cifName), 'utf8'));
    const genLines = headerLines(buildAmcHeader(data, record, cifName));
    const realLines = headerLines(fs.readFileSync(path.join(AMC_DIR, amcById.get(id).name), 'utf8'));
    const gen = parseAmcHeaderLines(genLines);
    const real = parseAmcHeaderLines(realLines);
    compared++;

    const fields = [
      ['name', gen.name, real.name],
      ['authors', gen.authors.join(', '), real.authors.join(', ')],
      ['journal', gen.journal, real.journal],
      ['volume', gen.volume, real.volume],
      ['year', gen.year, real.year],
      ['pageFirst', gen.pageFirst, real.pageFirst],
      ['pageLast', gen.pageLast, real.pageLast],
      ['title', gen.titleLines.join(' '), real.titleLines.join(' ')],
      ['locality', gen.locality, real.locality],
      ['amcsd', gen.amcsd, real.amcsd],
    ];
    for (const [field, g, r] of fields) {
      if (norm(g) === norm(r)) continue;
      rows.push([id, field, g, r]);
      mismatchCountByField[field] = (mismatchCountByField[field] || 0) + 1;
      mismatchedIds.add(id);
    }
  }

  const csvCell = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(OUT_CSV, rows.map(r => r.map(csvCell).join(',')).join('\n'), 'utf8');

  console.log(`API calls this run: ${apiCalls} (cap ${MAX_API_CALLS})`);
  if (stoppedReason) console.log(`Stopped early: ${stoppedReason}`);
  console.log(`Compared: ${compared}`);
  console.log(`Records with a citation mismatch: ${mismatchedIds.size}`);
  console.log('Mismatches by field:', mismatchCountByField);
  console.log(`Report written to: ${OUT_CSV}`);
}

main();
