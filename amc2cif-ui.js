let currentAmcFileName = '';

setupDropZone(document.getElementById('amcFileInput'));

// Converts AMC text to a CIF in the AMC -> CIF box and shows its unit cell, for a
// dropped .amc file or the AMC file of the record fetched from the API.
function showCifFromAmc(fileName, text, doneMessage = '') {
  currentAmcFileName = fileName;
  const status = document.getElementById('amcToCifStatus');
  const output = document.getElementById('amcToCifOutput');
  try {
    output.value = buildCifFromAmc(text);
    status.textContent = doneMessage;
  } catch (err) {
    output.value = '';
    status.textContent = `Error: ${err.message}`;
  }
  autoSizeTextarea(output);
  renderUnitCell(fileName, () => unitCellFromAmc(text));
}

// The record's "AMC File Contents" field is the whole AMC file as text. Named the
// way AMCSD names its downloads ("Mineral__<code>.amc").
function showCifFromApiRecord(apiRecord) {
  const text = getApiField(apiRecord, 'AMC File Contents');
  if (!text) return;
  const name = [getApiField(apiRecord, 'Mineral'), getApiField(apiRecord, 'database_code_amcsd')].filter(Boolean).join('__');
  showCifFromAmc(`${name || 'record'}.amc`, text, "Made from the record's AMC file.");
}

document.getElementById('amcFileInput').addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => showCifFromAmc(file.name, reader.result);
  reader.readAsText(file);
});

document.getElementById('copyAmcToCifBtn').addEventListener('click', () => copyTextarea('amcToCifOutput'));

document.getElementById('sendAmcToCifBtn').addEventListener('click', () => {
  runSubmit('sendAmcToCifStatus', () => submitAmcToCif({
    fileText: document.getElementById('amcToCifOutput').value,
    direction: 'amc-to-cif',
    sourceFileName: currentAmcFileName,
  }));
});
