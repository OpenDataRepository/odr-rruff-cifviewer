#!/usr/bin/env node
// Send the space group data to the ODR symmetry database, one record per space group.
//
// Builds each record's field values from the files space_group_csv.js writes:
//   data/SpaceGroupData.csv  one row per group: name, lattice, crystal system, generators...
//   data/SymmetryOps.csv     every symmetry operation, joined into the SymmetryOpXYZs and
//                            SymmetryOpMs fields (one op per line, same layout as GeneratorMs)
//   data/ReciprocalSymmetryOps.csv  the reciprocal space operations (reciprocal_ops.js), one row
//                            per group whose SymmetryOphkls and ReciprocalSymmetryOpMs cells
//                            are sent as is (one op per line, 3x3s in the GeneratorMs layout)
//
// Modes:
//   node scripts/symmetry_upload.js                    dry run: no API calls; writes the
//                                                      payloads to data/symmetry_payloads.json
//   node scripts/symmetry_upload.js --token            check the login: get a token (not shown)
//   node scripts/symmetry_upload.js --list [db-uuid]  log in and fetch every record UUID in the
//                                                      database (DATABASE_UUID by default), saved
//                                                      to data/symmetry_record_uuids.json
//   node scripts/symmetry_upload.js --read <uuid>      log in and fetch one record, saved to
//                                                      data/symmetry_record_<uuid>.json; also
//                                                      saves its field names -> field UUIDs to
//                                                      data/symmetry_fields.json for --send
//   node scripts/symmetry_upload.js --fields           log in and fetch the database's field list
//                                                      (GET template/<db-uuid>), saving every
//                                                      field name -> field UUID to
//                                                      data/symmetry_fields.json; unlike --read it
//                                                      includes fields with no value yet
//   node scripts/symmetry_upload.js --check            fetch every record in one call and report
//                                                      which SEND_FIELDS are empty or different
//                                                      (data/symmetry_check.json); sends nothing
//   node scripts/symmetry_upload.js --send --group 2  set SEND_FIELDS on the selected groups'
//                                                      records (--all for every group); add
//                                                      --create to make records for groups that
//                                                      have none yet (except SKIP_GROUPS)
// Options: --group <GroupID> or --limit <n> to only take some groups; --gap <ms> to space API
// calls further apart than MIN_REQUEST_GAP_MS (e.g. --gap 3000 when the server is busy);
// --start <GroupID> to resume from that group; --no-fetch (with --send) to skip the bulk fetch
// and send every field without comparing, e.g. for newly added fields.
//
// --send fetches every record in one call (GET dataset/<uuid>.json; a record missing from it is
// fetched on its own), then for each of SEND_FIELDS whose value differs uses
// POST record/<record_uuid>/<field_uuid>/value with { "value": ... }
// (https://docs.odr.io/odr-search-api-v-4/record-record-uuid-field-uuid-value). The record UUID
// comes from --list (external_id is our GroupID) and the field UUIDs from --read; field UUIDs
// are the same for every record in the database. Each response is the updated record, and its
// stored value is checked against what was sent.
//
// Auth: a token from .env (token=) is used as is; without one the script logs in with
// username= and password= from .env and gets a new token shortly before the last expires.
// API calls are at least MIN_REQUEST_GAP_MS apart, and the run stops on the first HTTP error.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const API_BASE = 'https://www.rruff.net/odr_rruff/api/v4';
const TOKEN_URL = `${API_BASE}/token`;
const RECORD_URL = `${API_BASE}/dataset/record/`;
// The symmetry database. Its record list is GET search/database/<uuid>/records/<limit>/<offset>.json,
// where a limit of 0 returns every record:
//   { "records": [ { "internal_id", "unique_id", "external_id", "record_name" }, ... ] }
const DATABASE_UUID = 'e1caf946bba4b04aa57262848214';
const recordListUrl = uuid => `${API_BASE}/search/database/${encodeURIComponent(uuid)}/records/0/0.json`;
const fieldValueUrl = (recordUuid, fieldUuid) =>
  `${API_BASE}/record/${encodeURIComponent(recordUuid)}/${encodeURIComponent(fieldUuid)}/value`;
// Every field the payloads carry: payload key (the CSV column) -> field name in ODR.
const ALL_FIELDS = {
  GroupID: 'GroupID',
  SpaceGroupName: 'SpaceGroupName',
  Lattice: 'Lattice',
  CrystalSystem: 'CrystalSystem',
  PointGroup: 'PointGroup',
  SpaceGroupNumber: 'SpaceGroupNumber',
  GeneratorXYZs: 'Generator XYZs',
  GeneratorMs: 'Generator Ms',
  SymmetryOpXYZs: 'SymmetryOpXYZs',
  SymmetryOpMs: 'SymmetryOpMs',
  SymmetryOphkls: 'SymmetryOphkl',
  ReciprocalSymmetryOpMs: 'ReciprocalSymmetryOpM',
};
// The fields --send sets and --check compares. The others are already in ODR, so only the
// reciprocal space fields are sent now; add a key back here to send it again.
const SEND_KEYS = ['SymmetryOphkls', 'ReciprocalSymmetryOpMs'];
const SEND_FIELDS = Object.fromEntries(SEND_KEYS.map(k => [k, ALL_FIELDS[k]]));
// Groups in the .txt that get no record of their own: same group as another record, under a
// different name. They stay in the .txt so the calculations recognize both names.
const SKIP_GROUPS = { 'F4/m2/m2/m': 'same group as F4/mmm' };
const RECORD_UUIDS_FILE =path.join(DATA, 'symmetry_record_uuids.json');
const FIELDS_FILE = path.join(DATA, 'symmetry_fields.json');
let MIN_REQUEST_GAP_MS = 1100;

// CSV parser that handles quoted cells with commas, quotes, tabs and line breaks.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.length > 1 || r[0]);
  return body.map(r => Object.fromEntries(header.map((h, k) => [h, r[k] ?? ''])));
}

function readCsv(file, script = 'space_group_csv.js') {
  const full = path.join(DATA, file);
  if (!fs.existsSync(full)) throw new Error(`${full} not found - run node scripts/${script} first`);
  return parseCsv(fs.readFileSync(full, 'utf8'));
}

// Same matrix layout as space_group_csv.js: rows of 4 padded to 15 characters, tab between.
// (ReciprocalSymmetryOps.csv already stores its 3x3s this way.)
const matrixRows = matrix => [0, 4, 8].map(k => matrix.split(' ').slice(k, k + 4).join(' '))
  .map((row, k) => (k < 2 ? row.padEnd(15) : row)).join('\t');

// CSV rows -> GroupID -> its rows in OpIndex order.
function groupRows(rows) {
  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.GroupID)) byGroup.set(r.GroupID, []);
    byGroup.get(r.GroupID).push(r);
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.OpIndex - b.OpIndex);
  return byGroup;
}

// One payload per space group: GroupID plus every field value, keyed by field name.
function buildPayloads() {
  const opsByGroup = groupRows(readCsv('SymmetryOps.csv'));
  const reciprocalByGroup = new Map(readCsv('ReciprocalSymmetryOps.csv', 'reciprocal_ops.js').map(r => [r.GroupID, r]));
  return readCsv('SpaceGroupData.csv').map(g => {
    const ops = opsByGroup.get(g.GroupID) || [];
    const reciprocal = reciprocalByGroup.get(g.GroupID) || {};
    return {
      GroupID: g.GroupID,
      fields: {
        ...g,
        SymmetryOpXYZs: ops.map(op => op.Operator).join('\n'),
        SymmetryOpMs: ops.map(op => matrixRows(op.OperatorM)).join('\n'),
        SymmetryOphkls: reciprocal.SymmetryOphkls || '',
        ReciprocalSymmetryOpMs: reciprocal.ReciprocalSymmetryOpMs || '',
      },
    };
  });
}

function readEnv() {
  const env = {};
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch {
    return env;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

// A busy server answers 502/503/504 or drops the connection; those are retried after
// RETRY_WAITS_MS, then the run stops.
const RETRY_WAITS_MS = [30000, 60000, 120000];
let lastRequestTime = 0;
async function apiFetch(url, options) {
  let res;
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestTime + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestTime = Date.now();
    let problem;
    try {
      res = await fetch(url, options);
      if ([502, 503, 504].includes(res.status)) problem = `HTTP ${res.status}`;
    } catch (e) {
      if (attempt === RETRY_WAITS_MS.length) throw e;
      problem = e.cause?.code || e.message;
    }
    if (!problem || attempt === RETRY_WAITS_MS.length) break;
    console.log(`  ${options?.method || 'GET'} ${url}: ${problem}, retrying in ${RETRY_WAITS_MS[attempt] / 1000}s`);
    await new Promise(r => setTimeout(r, RETRY_WAITS_MS[attempt]));
  }
  const redirected = options?.redirect === 'manual' && res.status >= 300 && res.status < 400;
  if (!res.ok && !redirected) throw new Error(`${options?.method || 'GET'} ${url}: HTTP ${res.status} ${res.statusText}`);
  return res;
}

// Seconds-since-epoch expiry from a JWT, less a minute; null if it carries none.
function tokenExpiry(jwt) {
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    if (exp) return exp * 1000 - 60 * 1000;
  } catch {}
  return null;
}

// Uses its own .env keys, not the viewer's username/password (a different account).
let token = null;
let tokenExpires = 0;
async function getToken() {
  if (token && Date.now() < tokenExpires) return token;
  const env = readEnv();
  if (env.symmetry_token && !token) {
    token = env.symmetry_token;
    tokenExpires = tokenExpiry(token) ?? Infinity;
    if (Date.now() >= tokenExpires) throw new Error('symmetry_token in .env has expired - make a new one.');
    return token;
  }
  const { symmetry_username: username, symmetry_password: password } = env;
  if (!username || !password) {
    throw new Error(token
      ? 'symmetry_token in .env has expired - make a new one, or add symmetry_username / symmetry_password to .env.'
      : 'No symmetry_token, or symmetry_username / symmetry_password, in .env.');
  }
  const res = await apiFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = (res.headers.get('content-type') || '').includes('application/json')
    ? await res.json() : { token: (await res.text()).trim() };
  token = data.token?.value || data.token || data.access_token || data.jwt;
  if (!token || typeof token !== 'string') throw new Error('Login response had no token');
  // No expiry in the token: assume ~15 minutes (Nate's estimate) and renew after 10.
  tokenExpires = tokenExpiry(token) ?? Date.now() + 10 * 60 * 1000;
  return token;
}

async function readRecord(uuid) {
  const auth = await getToken();
  const res = await apiFetch(RECORD_URL + encodeURIComponent(uuid), { headers: { Authorization: `Bearer ${auth}` } });
  const record = await res.json();
  const out = path.join(DATA, `symmetry_record_${uuid.replace(/[^\w-]/g, '')}.json`);
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
  const fields = Object.fromEntries((record.fields || []).map(f => [f.field_name, f.field_uuid]));
  fs.writeFileSync(FIELDS_FILE, JSON.stringify(fields, null, 2));
  console.log(`Saved record ${uuid} to ${out}\nSaved ${Object.keys(fields).length} field UUIDs to ${FIELDS_FILE}`);
  for (const f of record.fields || []) {
    console.log(`  ${f.field_name}  ${f.field_uuid}  ${JSON.stringify(String(f.value ?? '')).slice(0, 70)}`);
  }
}

// Every field in the database, from its template: GET template/<db-uuid> (a database UUID works
// in place of a template UUID). A record's JSON leaves out fields it has no value for, so new,
// still-empty fields only show up here.
async function readFields() {
  const auth = await getToken();
  const res = await apiFetch(`${API_BASE}/template/${encodeURIComponent(DATABASE_UUID)}`,
    { headers: { Authorization: `Bearer ${auth}` } });
  const { fields: list = [] } = await res.json();
  const fields = Object.fromEntries(list.map(f => [f.name, f.field_uuid]));
  fs.writeFileSync(FIELDS_FILE, JSON.stringify(fields, null, 2));
  console.log(`Saved ${list.length} field UUIDs to ${FIELDS_FILE}`);
  for (const f of list) console.log(`  ${f.name}  ${f.field_uuid}  ${f.fieldtype}`);
}

async function listRecords(dbUuid) {
  const auth = await getToken();
  const res = await apiFetch(recordListUrl(dbUuid), { headers: { Authorization: `Bearer ${auth}` } });
  const { records = [] } = await res.json();
  const out = path.join(DATA, 'symmetry_record_uuids.json');
  fs.writeFileSync(out, JSON.stringify(records, null, 2));
  console.log(`${records.length} record(s) in database ${dbUuid}. Saved to ${out}`);
  for (const r of records.slice(0, 5)) console.log(`  ${r.unique_id}  ${r.external_id || '-'}  ${r.record_name || '-'}`);
  if (records.length > 5) console.log('  ...');
}

function readJson(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`${file} not found - ${hint}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const storedValue = (record, fieldUuid) => {
  const field = (record.fields || []).find(f => f.field_uuid === fieldUuid);
  return field ? String(field.value ?? '') : undefined;
};

// Every record in the database with its field values, in one call:
// GET dataset/<uuid>.json -> { "count", "records": [ <same shape as dataset/record/<uuid>> ] }.
// Saved to data/symmetry_all_records.json. Returns a Map of record UUID -> record.
async function fetchAllRecords() {
  const auth = await getToken();
  const res = await apiFetch(`${API_BASE}/dataset/${encodeURIComponent(DATABASE_UUID)}.json`,
    { headers: { Authorization: `Bearer ${auth}` } });
  const { records = [] } = await res.json();
  fs.writeFileSync(path.join(DATA, 'symmetry_all_records.json'), JSON.stringify(records, null, 2));
  return new Map(records.map(r => [r.record_uuid, r]));
}

// Creates an empty record: POST dataset/<uuid>/record, form-encoded. ODR answers with a redirect
// to dataset/record/<new uuid>, which is read without following it. public_date makes it public
// now, like the imported records (the API default is private). The new UUID is added to
// RECORD_UUIDS_FILE straight away so a rerun can't create the group twice.
async function createRecord(groupId) {
  const auth = await getToken();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const res = await apiFetch(`${API_BASE}/dataset/${encodeURIComponent(DATABASE_UUID)}/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${auth}` },
    body: new URLSearchParams({ public_date: now }).toString(),
    redirect: 'manual',
  });
  const recordUuid = (res.headers.get('location') || '').match(/dataset\/record\/(\w+)/)?.[1];
  if (!recordUuid) throw new Error(`Creating a record for GroupID ${groupId}: no record UUID in the response (HTTP ${res.status})`);
  const list = readJson(RECORD_UUIDS_FILE, 'run --list first');
  list.push({ unique_id: recordUuid, external_id: Number(groupId), record_name: '', created_by_script: now });
  fs.writeFileSync(RECORD_UUIDS_FILE, JSON.stringify(list, null, 2));
  return recordUuid;
}

// The SEND_FIELDS whose value in the record differs from the payload's ('' counts as empty).
const fieldsToSend = (payload, record, fieldUuids) => Object.entries(SEND_FIELDS)
  .filter(([key, name]) => storedValue(record, fieldUuids[name]) !== payload.fields[key])
  .map(([key, name]) => ({ key, name, empty: !storedValue(record, fieldUuids[name]) }));

// Sets each of SEND_FIELDS whose value differs from the record's current one (fetched here if
// not given), then checks the value each response stores. Returns the field names sent and
// any stored differently.
async function sendRecord(payload, recordUuid, fieldUuids, current) {
  let auth = await getToken();
  if (!current) {
    current = await (await apiFetch(RECORD_URL + encodeURIComponent(recordUuid),
      { headers: { Authorization: `Bearer ${auth}` } })).json();
  }
  const sent = [], mismatches = [];
  for (const { key, name } of fieldsToSend(payload, current, fieldUuids)) {
    const value = payload.fields[key];
    auth = await getToken();
    const res = await apiFetch(fieldValueUrl(recordUuid, fieldUuids[name]), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({ value }),
    });
    sent.push(name);
    const stored = storedValue(await res.json(), fieldUuids[name]);
    if (stored !== value) mismatches.push({ name, sent: value, stored });
  }
  return { sent, mismatches };
}

// --check: which fields each record is missing (empty) or has different, without changing
// anything. Writes the details to data/symmetry_check.json.
function report(payloads, recordUuids, current, fieldUuids) {
  const rows = [], noRecord = [], notFetched = [];
  const counts = Object.fromEntries(Object.values(SEND_FIELDS).map(name => [name, { empty: 0, different: 0 }]));
  for (const p of payloads) {
    if (SKIP_GROUPS[p.fields.SpaceGroupName]) continue;
    const recordUuid = recordUuids.get(p.GroupID);
    if (!recordUuid) { noRecord.push(`${p.GroupID} ${p.fields.SpaceGroupName}`); continue; }
    const record = current.get(recordUuid);
    if (!record) { notFetched.push(`${p.GroupID} ${p.fields.SpaceGroupName}`); continue; }
    const todo = fieldsToSend(p, record, fieldUuids);
    todo.forEach(({ name, empty }) => counts[name][empty ? 'empty' : 'different']++);
    if (todo.length) {
      rows.push({
        GroupID: p.GroupID, SpaceGroupName: p.fields.SpaceGroupName, record_uuid: recordUuid,
        empty: todo.filter(t => t.empty).map(t => t.name),
        different: todo.filter(t => !t.empty).map(t => t.name),
      });
    }
  }
  const out = path.join(DATA, 'symmetry_check.json');
  fs.writeFileSync(out, JSON.stringify({ needsUpdate: rows, noRecord, notFetched }, null, 2));
  const skipped = payloads.filter(p => SKIP_GROUPS[p.fields.SpaceGroupName]);
  const checked = payloads.length - skipped.length - noRecord.length - notFetched.length;
  console.log(`Checked ${checked} record(s) (${current.size} fetched): ${checked - rows.length} up to date, ${rows.length} need fields set.`);
  for (const [name, c] of Object.entries(counts)) console.log(`  ${name.padEnd(17)} empty ${String(c.empty).padStart(4)}   different ${String(c.different).padStart(4)}`);
  const posts = rows.reduce((n, r) => n + r.empty.length + r.different.length, 0);
  console.log(`--send --all would make ${posts} POST(s), about ${Math.ceil(posts * MIN_REQUEST_GAP_MS / 60000)} min.`);
  if (noRecord.length) console.log(`No ODR record yet (--send --create adds them): ${noRecord.join(', ')}`);
  for (const p of skipped) console.log(`No record of its own: ${p.GroupID} ${p.fields.SpaceGroupName} (${SKIP_GROUPS[p.fields.SpaceGroupName]})`);
  if (notFetched.length) console.log(`Not in the bulk fetch (--send GETs these one by one): ${notFetched.length}`);
  console.log(`Details in ${out}`);
}

function argValue(args, name) {
  const k = args.indexOf(name);
  if (k === -1) return undefined;
  if (!args[k + 1] || args[k + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[k + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const gap = argValue(args, '--gap');
  if (gap) {
    if (!(Number(gap) >= 1100)) throw new Error('--gap must be at least 1100 (ms)');
    MIN_REQUEST_GAP_MS = Number(gap);
  }
  if (args.includes('--token')) {
    await getToken();
    const exp = tokenExpiry(token);
    console.log(`Got a token${exp ? `, good until about ${new Date(exp + 60 * 1000).toLocaleTimeString()}` : ''}.`);
    return;
  }
  const listAt = args.indexOf('--list');
  if (listAt !== -1) {
    const next = args[listAt + 1];
    return listRecords(next && !next.startsWith('--') ? next : DATABASE_UUID);
  }
  if (args.includes('--fields')) return readFields();
  const readUuid = argValue(args, '--read');
  if (readUuid) return readRecord(readUuid);

  let payloads = buildPayloads();
  const group = argValue(args, '--group');
  const limit = argValue(args, '--limit');
  if (group) payloads = payloads.filter(p => p.GroupID === group);
  const start = argValue(args, '--start');
  if (start) payloads = payloads.filter(p => Number(p.GroupID) >= Number(start));
  if (limit) payloads = payloads.slice(0, Number(limit));
  if (!payloads.length) throw new Error('No space groups selected');

  const check = args.includes('--check');
  if (!args.includes('--send') && !check) {
    const out = path.join(DATA, 'symmetry_payloads.json');
    fs.writeFileSync(out, JSON.stringify(payloads, null, 2));
    const longest = Math.max(...payloads.map(p => p.fields.SymmetryOpMs.length));
    console.log(`Dry run: ${payloads.length} space group(s), no API calls. Longest SymmetryOpMs: ${longest} characters.\nWrote ${out}`);
    return;
  }
  if (!check && !group && !limit && !start && !args.includes('--all')) {
    throw new Error('--send needs --group <GroupID>, --limit <n>, --start <GroupID> or --all');
  }
  const fieldUuids = readJson(FIELDS_FILE, 'run --read <record-uuid> on a record first');
  const missingFields = Object.values(SEND_FIELDS).filter(name => !fieldUuids[name]);
  if (missingFields.length) {
    throw new Error(`No field named ${missingFields.join(', ')} in ${FIELDS_FILE}` +
      ' (add it in ODR, then rerun --read <record-uuid> to refresh the field UUIDs)');
  }
  const recordUuids = new Map(readJson(RECORD_UUIDS_FILE, 'run --list first')
    .map(r => [String(r.external_id), r.unique_id]));
  // --no-fetch skips the bulk fetch (it can time out when the server is busy) and sends every
  // SEND_FIELD without comparing, as for newly added, still-empty fields; each response is still
  // checked against what was sent.
  const noFetch = args.includes('--no-fetch');
  if (noFetch && check) throw new Error('--check needs the bulk fetch; drop --no-fetch');
  const current = noFetch ? new Map() : await fetchAllRecords();

  if (check) return report(payloads, recordUuids, current, fieldUuids);

  for (const [k, p] of payloads.entries()) {
    const label = `${k + 1}/${payloads.length} GroupID ${p.GroupID} (${p.fields.SpaceGroupName})`;
    if (SKIP_GROUPS[p.fields.SpaceGroupName]) {
      console.log(`${label}: no record of its own (${SKIP_GROUPS[p.fields.SpaceGroupName]}), skipped`);
      continue;
    }
    let recordUuid = recordUuids.get(p.GroupID);
    if (!recordUuid && !args.includes('--create')) {
      console.log(`${label}: no ODR record, skipped (--create to add one)`);
      continue;
    }
    if (!recordUuid) {
      recordUuid = await createRecord(p.GroupID);
      console.log(`${label}: created record ${recordUuid}`);
    }
    const { sent, mismatches } = await sendRecord(p, recordUuid, fieldUuids, noFetch ? { fields: [] } : current.get(recordUuid));
    console.log(`${label} -> ${recordUuid}: ${sent.length ? `set ${sent.join(', ')}` : 'already up to date'}` +
      (mismatches.length ? '; stored differently:' : ''));
    for (const m of mismatches) console.log(`  ${m.name}\n    sent:   ${JSON.stringify(m.sent)}\n    stored: ${JSON.stringify(m.stored)}`);
  }
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
