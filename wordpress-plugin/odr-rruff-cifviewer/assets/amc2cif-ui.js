let currentAmcFileName = '';

setupDropZone(document.getElementById('amcFileInput'));

document.getElementById('amcFileInput').addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file) return;
  currentAmcFileName = file.name;
  const status = document.getElementById('amcToCifStatus');
  const output = document.getElementById('amcToCifOutput');
  const reader = new FileReader();
  reader.onload = () => {
    try {
      output.value = buildCifFromAmc(reader.result);
      status.textContent = '';
    } catch (err) {
      output.value = '';
      status.textContent = `Error: ${err.message}`;
    }
    autoSizeTextarea(output);
  };
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
