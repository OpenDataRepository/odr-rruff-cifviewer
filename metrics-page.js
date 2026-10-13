// The metrics view, beside the converter on the same page: counts from metrics.json (written
// by scripts/metrics.js), each one a filter on the table of structures below it. The button
// at the top swaps the two views in place, so the page's URL (and its ?UUID=) never changes.
// Wrapped in a function so its names don't meet the converter scripts' globals.
(() => {

// --- The counts, in groups. Each metric is a filter on the rows: its count is how many rows
// pass it, out of the rows its `of` filter passes (all rows when there's none). ---
const has = v => v !== undefined && v !== null;
const GROUPS = [
  {
    title: 'Computed chemical formula',
    note: 'The formula from the unit cell (sum of occupancies over every position, divided by Z), as AMC → CIF writes it.',
    metrics: [
      { id: 'computed', label: 'Formula computed', test: r => has(r.formula) },
      { id: 'notComputed', label: 'No formula computed', test: r => !has(r.formula) },
      { id: 'whole', label: 'All whole-number amounts', test: r => r.whole === true, of: 'computed' },
      { id: 'fractional', label: 'Some fractional amounts', test: r => r.whole === false, of: 'computed' },
      { id: 'divisor', label: 'Common divisor in formula', test: r => r.divisor > 1, of: 'whole', hint: 'Whole-number formulas whose amounts are all divisible by the same number (e.g. Ce2 P10 O30 N4 → 2)' },
      { id: 'noDivisor', label: 'No common divisor in formula', test: r => r.divisor === 1, of: 'whole' },
      { id: 'z1', label: 'Z = 1 (whole cell)', test: r => r.Z === 1, of: 'computed' },
      { id: 'zOver1', label: 'Z > 1', test: r => r.Z > 1, of: 'computed' },
      { id: 'z1Divisor', label: 'Z = 1 and a common divisor', test: r => r.Z === 1 && r.divisor > 1, of: 'z1' },
      { id: 'z1NoDivisor', label: 'Z = 1 and no common divisor', test: r => r.Z === 1 && !(r.divisor > 1), of: 'z1' },
      { id: 'amcsdDivisor', label: "Common divisor in AMCSD's formula", test: r => r.amcsdDivisor > 1, of: 'amcsdFormula' },
      { id: 'amcsdNoDivisor', label: "No common divisor in AMCSD's formula", test: r => has(r.amcsdFormula) && has(r.formula) && !(r.amcsdDivisor > 1), of: 'amcsdFormula' },
    ],
  },
  {
    title: 'Compared with AMCSD',
    note: "Our formula, volume and density against the AMCSD CIF's _chemical_formula_sum, _cell_volume and _exptl_crystal_density_diffrn.",
    metrics: [
      { id: 'amcsdFormula', label: 'Have an AMCSD formula', test: r => has(r.amcsdFormula) && has(r.formula) },
      { id: 'exact', label: 'Formula matches exactly', test: r => r.match === 'exact', of: 'amcsdFormula' },
      { id: 'notExact', label: "Formula doesn't match exactly", test: r => has(r.match) && r.match !== 'exact', of: 'amcsdFormula' },
      { id: 'scaled', label: 'Same chemistry, different Z', test: r => r.match === 'scaled', of: 'amcsdFormula' },
      { id: 'hOnly', label: 'Differs only in H or D', test: r => r.match === 'hOnly', of: 'amcsdFormula' },
      { id: 'differs', label: 'Formula differs', test: r => r.match === 'differs', of: 'amcsdFormula' },
      { id: 'volumeMatch', label: 'Volume matches', test: r => r.volumeMatch === true, of: 'hasVolume' },
      { id: 'volumeDiffers', label: 'Volume differs', test: r => r.volumeMatch === false, of: 'hasVolume' },
      { id: 'densityMatch', label: 'Density matches', test: r => r.densityMatch === true, of: 'hasDensity' },
      { id: 'densityDiffers', label: 'Density differs', test: r => r.densityMatch === false, of: 'hasDensity' },
    ],
  },
  {
    title: 'CIF vs AMC unit cell',
    note: 'Whether the CIF and the AMC file of the same structure give the same unit cell atoms (scripts/check_unit_cell.js).',
    metrics: [
      { id: 'compared', label: 'Pairs compared', test: r => has(r.cifVsAmc) },
      { id: 'notCompared', label: 'Pairs not compared', test: r => !has(r.cifVsAmc) },
      { id: 'same', label: 'Same atoms', test: r => r.cifVsAmc === 'same', of: 'compared' },
      { id: 'notSame', label: 'Different atoms (any reason below)', test: r => has(r.cifVsAmc) && r.cifVsAmc !== 'same', of: 'compared' },
      ...['datasetCount', 'atomCount', 'position', 'occupancy', 'lastDigit', 'printed', 'labelOnly'].map(kind => ({
        id: `cell-${kind}`, label: { datasetCount: 'Different dataset count', atomCount: 'Different atom count', position: 'Different position', occupancy: 'Different occupancy', lastDigit: 'Differ in last digit', printed: 'Print differently', labelOnly: 'Labels only' }[kind],
        test: r => r.cifVsAmc === kind, of: 'compared',
      })),
      { id: 'error', label: 'File could not be read', test: r => has(r.error) },
      { id: 'noError', label: 'Both files read', test: r => !has(r.error) },
    ],
  },
];
// Filters used only as denominators.
const HIDDEN = [
  { id: 'hasVolume', test: r => has(r.amcsdVolume) && has(r.volume) },
  { id: 'hasDensity', test: r => has(r.amcsdDensity) && has(r.density) },
];
const METRICS = new Map([...GROUPS.flatMap(g => g.metrics), ...HIDDEN].filter(m => m.id).map(m => [m.id, m]));

// --- Table columns ---
const fmt = v => (v === true ? 'yes' : v === false ? 'no' : has(v) ? String(v) : '');
const COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'Name' },
  { key: 'sg', label: 'Space group' },
  { key: 'formula', label: 'Computed formula', cls: 'formula' },
  { key: 'Z', label: 'Z', cls: 'num' },
  { key: 'divisor', label: 'Divisor', cls: 'num' },
  { key: 'amcsdFormula', label: 'AMCSD formula', cls: 'formula' },
  { key: 'match', label: 'Formula vs AMCSD', bad: r => r.match && r.match !== 'exact' },
  { key: 'impliedZ', label: 'AMCSD Z', cls: 'num' },
  { key: 'volume', label: 'Volume', cls: 'num', bad: r => r.volumeMatch === false },
  { key: 'density', label: 'Density', cls: 'num', bad: r => r.densityMatch === false },
  { key: 'cifVsAmc', label: 'CIF vs AMC', bad: r => r.cifVsAmc && r.cifVsAmc !== 'same' },
];
// Every field, in order, for the detail view.
const DETAIL_FIELDS = [
  ['id', 'ID'], ['name', 'Name'], ['amc', 'AMC file'], ['cif', 'CIF file'], ['sg', 'Space group'],
  ['datasets', 'Datasets'], ['atoms', 'Atoms in cell'], ['orders', 'Site orders'], ['Z', 'Z'],
  ['formula', 'Computed formula'], ['whole', 'Whole numbers'], ['divisor', 'Common divisor'],
  ['amcsdFormula', 'AMCSD formula'], ['amcsdDivisor', 'AMCSD common divisor'], ['amcsdZ', 'AMCSD _cell_formula_units_Z'],
  ['match', 'Formula vs AMCSD'], ['impliedZ', 'Z implied by AMCSD formula'],
  ['volume', 'Volume'], ['amcsdVolume', 'AMCSD volume'], ['volumeMatch', 'Volume matches'],
  ['density', 'Density'], ['amcsdDensity', 'AMCSD density'], ['densityMatch', 'Density matches'],
  ['unknown', 'Labels with no element'], ['cifVsAmc', 'CIF vs AMC'], ['cifVsAmcDetail', 'CIF vs AMC detail'], ['error', 'Error'],
];

const PAGE_SIZE = 100;
const state = { rows: [], filter: '', search: '', sort: null, desc: false, page: 0 };
const $ = id => document.getElementById(id);

function count(id) {
  const m = METRICS.get(id);
  return state.rows.filter(m.test).length;
}

function renderSummary() {
  const summary = $('metricsSummary');
  summary.innerHTML = '';
  for (const group of GROUPS) {
    const section = document.createElement('section');
    section.className = 'group';
    section.innerHTML = `<h2></h2><p></p><div class="cards"></div>`;
    section.querySelector('h2').textContent = group.title;
    section.querySelector('p').textContent = group.note;
    const cards = section.querySelector('.cards');
    for (const m of group.metrics) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      const n = count(m.id);
      const total = m.of ? count(m.of) : null;
      const pct = total ? `${((100 * n) / total).toFixed(1)}%` : '';
      card.innerHTML = `<span class="value">${n.toLocaleString()}<span class="pct"></span></span><span class="label"></span>`;
      card.querySelector('.pct').textContent = total !== null ? `of ${total.toLocaleString()}${pct ? ` · ${pct}` : ''}` : '';
      card.querySelector('.label').textContent = m.label;
      if (m.hint) card.title = m.hint;
      card.dataset.filter = m.id;
      card.addEventListener('click', () => { setFilter(m.id); $('metricsExplorer').scrollIntoView({ behavior: 'smooth' }); });
      cards.appendChild(card);
    }
    summary.appendChild(section);
  }
}

function renderFilterOptions() {
  const select = $('metricsFilter');
  select.innerHTML = '<option value="">All structures</option>';
  for (const group of GROUPS) {
    const og = document.createElement('optgroup');
    og.label = group.title;
    for (const m of group.metrics) og.appendChild(new Option(m.label, m.id));
    if (og.children.length) select.appendChild(og);
  }
}

function setFilter(id) {
  state.filter = id;
  state.page = 0;
  $('metricsFilter').value = id;
  document.querySelectorAll('#metricsView .card').forEach(c => c.classList.toggle('active', c.dataset.filter === id));
  renderTable();
}

function visibleRows() {
  const q = state.search.trim().toLowerCase();
  let rows = state.rows;
  if (state.filter) rows = rows.filter(METRICS.get(state.filter).test);
  if (q) rows = rows.filter(r => [r.id, r.name, r.formula, r.amcsdFormula, r.sg].some(v => v && String(v).toLowerCase().includes(q)));
  if (state.sort) {
    const k = state.sort, dir = state.desc ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const [x, y] = [a[k], b[k]];
      if (!has(x)) return has(y) ? 1 : 0;
      if (!has(y)) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }
  return rows;
}

function renderTable() {
  const rows = visibleRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const label = state.filter ? METRICS.get(state.filter).label : 'All structures';
  $('metricsResultCount').textContent = `${label}: ${rows.length.toLocaleString()} structure${rows.length === 1 ? '' : 's'}${state.search.trim() ? ` matching "${state.search.trim()}"` : ''}`;
  $('metricsPageInfo').textContent = `Page ${state.page + 1} of ${pages}`;
  $('metricsPrevPage').disabled = state.page === 0;
  $('metricsNextPage').disabled = state.page >= pages - 1;

  const head = $('metricsTable').tHead;
  head.innerHTML = '';
  const hr = head.insertRow();
  for (const col of COLUMNS) {
    const th = document.createElement('th');
    th.textContent = col.label + (state.sort === col.key ? (state.desc ? ' ▼' : ' ▲') : '');
    th.addEventListener('click', () => {
      state.desc = state.sort === col.key ? !state.desc : false;
      state.sort = col.key;
      renderTable();
    });
    hr.appendChild(th);
  }
  const body = $('metricsTable').tBodies[0];
  body.innerHTML = '';
  for (const r of rows.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE)) {
    const tr = body.insertRow();
    for (const col of COLUMNS) {
      const td = tr.insertCell();
      td.textContent = fmt(r[col.key]);
      if (col.cls) td.className = col.cls;
      if (col.bad && col.bad(r)) td.classList.add('bad');
    }
    tr.addEventListener('click', () => showDetail(r));
  }
}

function showDetail(r) {
  $('metricsDetailTitle').textContent = `${r.name} (${r.id})`;
  const table = $('metricsDetailTable');
  table.innerHTML = '';
  for (const [key, label] of DETAIL_FIELDS) {
    if (!has(r[key])) continue;
    const tr = table.insertRow();
    tr.insertCell().textContent = label;
    tr.insertCell().textContent = fmt(r[key]);
  }
  $('metricsDetail').showModal();
}

function downloadCsv() {
  const fields = DETAIL_FIELDS.map(([key]) => key);
  const quote = v => { const s = fmt(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [fields.join(','), ...visibleRows().map(r => fields.map(f => quote(r[f])).join(','))];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `metrics${state.filter ? `-${state.filter}` : ''}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function load(data) {
  state.rows = data.rows || [];
  $('metricsLoadPanel').hidden = true;
  $('metricsExplorer').hidden = false;
  $('metricsSource').textContent = `${state.rows.length.toLocaleString()} structures · generated ${new Date(data.generated).toLocaleString()}`;
  renderSummary();
  renderFilterOptions();
  setFilter('');
}

$('metricsSearch').addEventListener('input', e => { state.search = e.target.value; state.page = 0; renderTable(); });
$('metricsFilter').addEventListener('change', e => setFilter(e.target.value));
$('metricsClearFilter').addEventListener('click', () => { $('metricsSearch').value = ''; state.search = ''; setFilter(''); });
$('metricsDownloadCsv').addEventListener('click', downloadCsv);
$('metricsPrevPage').addEventListener('click', () => { state.page--; renderTable(); });
$('metricsNextPage').addEventListener('click', () => { state.page++; renderTable(); });
$('metricsFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (file) load(JSON.parse(await file.text()));
});

// The data is about 9 MB, so it's only fetched the first time the view is opened. The
// WordPress plugin passes its own URL for it (odrRruffCifViewer.metricsUrl).
let requested = false;
function fetchData() {
  if (requested) return;
  requested = true;
  const config = window.odrRruffCifViewer || {};
  $('metricsSource').textContent = 'Loading…';
  fetch(config.metricsUrl || 'data/metrics.json')
    .then(res => { if (!res.ok) throw new Error(res.status); return res.json(); })
    .then(load)
    .catch(() => { $('metricsSource').textContent = ''; $('metricsLoadPanel').hidden = false; });
}

function showView(metrics) {
  $('converterView').hidden = metrics;
  $('metricsView').hidden = !metrics;
  $('viewToggle').textContent = metrics ? '← CIF Converter' : 'CIF and AMC Metrics →';
  if (metrics) fetchData();
}
$('viewToggle').addEventListener('click', () => showView($('metricsView').hidden));
})();
