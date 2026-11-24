#!/usr/bin/env node
// Pulls what scripts/net_charge.mjs needs from the ODR API into a folder:
//  - amcsd/page-NNNN.json: every AMCSD record, 100 per dataset search, keeping only its id,
//    name, last update, Chemistry, AMC File Contents and its IMA mineral's Valence Formula;
//  - elements.json: the FormulaCalcElements records, the element table the mineral calc
//    loads over its bundled one.
//
//   node scripts/amcsd_pull.js outDir
//
// Logs in with username / password from .env. Requests are at least 1.1 s apart, a page
// already saved isn't fetched again (delete the folder for a fresh pull), and any failed
// or rejected request stops the run. A full pull is about 220 requests (~75 minutes).
const fs = require('fs');
const path = require('path');

const API = 'https://www.rruff.net/odr_rruff/api/v4';
const AMCSD_DB = 'bf04d8bf310bcf7a1126d2f042c6';
const IMA_DB = '8737e9e4212f5eac3703aeeb5cae';
const ELEMENTS_DB = '7064266bc2cd52543b43b679de22';
const PAGE = 100;
const GAP_MS = 1100;

const outDir = process.argv[2];
if (!outDir) {
  console.error('Usage: node scripts/amcsd_pull.js outDir');
  process.exit(1);
}
fs.mkdirSync(path.join(outDir, 'amcsd'), { recursive: true });

function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

let token = '';
let expiry = 0;
let last = 0;
let calls = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pace() {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  calls++;
}

async function getToken() {
  if (token && Date.now() < expiry) return token;
  const { username, password } = readEnv();
  if (!username || !password) throw new Error('No username / password in .env');
  await pace();
  const res = await fetch(`${API}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : (await res.text()).trim();
  token = typeof data === 'string' ? data : (data.token && data.token.value) || data.token || data.access_token || data.jwt;
  try {
    expiry = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp * 1000 - 120000;
  } catch {
    expiry = Date.now() + 20 * 60000;
  }
  return token;
}

// One page of a dataset search: { results, records }.
async function search(db, offset) {
  const t = await getToken();
  await pace();
  const res = await fetch(`${API}/dataset/${db}/search/${PAGE}/${offset}.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataset_uuid: db }),
  });
  if (!res.ok) throw new Error(`Search of ${db} at ${offset} failed: ${res.status}`);
  return res.json();
}

const field = (record, name) => ((record.fields || []).find(f => f.field_name === name) || {}).value;

function keep(record) {
  const ima = (record.records || []).find(c => c.database_uuid === IMA_DB && field(c, 'Valence Formula'));
  return {
    id: field(record, 'database_code_amcsd') || record.record_name,
    name: field(record, 'Mineral') || '',
    updated: (record._record_metadata || {})._update_date || '',
    chemistry: field(record, 'Chemistry') || '',
    valenceFormula: ima ? field(ima, 'Valence Formula') : '',
    imaName: ima ? field(ima, 'Mineral Name') || '' : '',
    amc: field(record, 'AMC File Contents') || '',
  };
}

(async () => {
  const elementsFile = path.join(outDir, 'elements.json');
  if (!fs.existsSync(elementsFile)) {
    const elements = [];
    for (let offset = 0, total = Infinity; offset < total; offset += PAGE) {
      const page = await search(ELEMENTS_DB, offset);
      total = page.results;
      for (const r of page.records || []) elements.push(Object.fromEntries((r.fields || []).map(f => [f.field_name, f.value ?? null])));
      if (!(page.records || []).length) break;
    }
    fs.writeFileSync(elementsFile, JSON.stringify(elements, null, 1));
    console.error(`${elements.length} elements`);
  }

  let total = Infinity;
  for (let n = 0; n * PAGE < total; n++) {
    const file = path.join(outDir, 'amcsd', `page-${String(n).padStart(4, '0')}.json`);
    if (fs.existsSync(file)) {
      total = JSON.parse(fs.readFileSync(file, 'utf8')).total;
      continue;
    }
    const page = await search(AMCSD_DB, n * PAGE);
    total = page.results;
    const records = (page.records || []).map(keep);
    fs.writeFileSync(file, JSON.stringify({ total, offset: n * PAGE, records }));
    console.error(`page ${n}: ${n * PAGE + records.length}/${total}`);
    if (!records.length) break;
  }
  console.error(`done, ${calls} requests`);
})().catch(e => {
  console.error(`Stopped: ${e.message} (${calls} requests)`);
  process.exit(1);
});
