// Sends the app's computed outputs (AMC header, AMC<->CIF conversion result,
// G-Matrix) to their own separate destination APIs. Each destination gets its
// own independent submit call, fired right after that output is computed, so
// one destination being slow/down doesn't block the others.
//
// The endpoint URLs/API keys below are placeholders - none of these
// destinations exist yet. Fill in a destination's `url` (and `apiKey` if it
// needs one) once it's ready; until then, submitting to it fails fast with a
// clear "not configured" error instead of silently doing nothing or hanging.
const SUBMIT_CONFIG = {
  header: { url: '', apiKey: '' },
  amcToCif: { url: '', apiKey: '' },
  gMatrix: { url: '', apiKey: '' },
};

async function submitToDestination(destination, payload) {
  const config = SUBMIT_CONFIG[destination];
  if (!config || !config.url) {
    throw new Error(`No endpoint configured yet for "${destination}".`);
  }
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const res = await fetch(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  return res.json().catch(() => ({}));
}

// The generated AMC header text (name, authors, journal, title, locality,
// database code, cell params + space group, atom table) plus enough
// identifying metadata for the destination to know which record it's for.
async function submitAmcHeader({ headerText, databaseCode, mineralName }) {
  return submitToDestination('header', { databaseCode, mineralName, header: headerText });
}

// The converted file's full text (either direction - CIF built from an AMC,
// or the AMC header text built from a CIF), plus which direction it went and
// the source filename, so the destination can tell what it's looking at.
async function submitAmcToCif({ fileText, direction, sourceFileName }) {
  return submitToDestination('amcToCif', { direction, sourceFileName, file: fileText });
}

// The G-Matrix (metric tensor) itself as a raw 3x3 array, the cell
// parameters it was derived from, and the unit cell volume (sqrt(det(G))),
// so the destination doesn't have to recompute any of it from scratch.
async function submitGMatrix({ gMatrix, cell, cellVolume, databaseCode }) {
  return submitToDestination('gMatrix', { databaseCode, cell, gMatrix, cellVolume });
}
