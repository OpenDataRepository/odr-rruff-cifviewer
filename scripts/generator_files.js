#!/usr/bin/env node
// Write each space group's generators to its own text file, named by GroupID (1.txt, 2.txt, ...),
// in two folders:
//
//   GeneratorXYZs/   order:x,y,z form, one generator per line
//   GeneratorMs/     order:3x4 matrix with a tab between rows, each row padded with spaces
//                    so the tabs line up (2:-1 0 0 0<tab>0 -1 0 0<tab>0 0 -1 0),
//                    one generator per line
//
// e.g. GeneratorXYZs/42.txt for a group with two generators:
//   2:-x,-y,-z
//   2:x,y,-z
//
// Usage: node scripts/generator_files.js [output-dir] [data-dir]
//   Defaults: data/ for both (reads Generators.csv, written by space_group_csv.js).
// Existing files in the two folders are overwritten.

const fs = require('fs');
const path = require('path');

const dataDefault = path.join(__dirname, '..', 'data');
const outDir = process.argv[2] || dataDefault;
const dataDir = process.argv[3] || dataDefault;

// Minimal CSV line splitter: handles quoted fields such as "x,y,z".
function splitCsv(line) {
  return [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)]
    .slice(0, -1)
    .map(([, f]) => (f.startsWith('"') ? f.slice(1, -1).replace(/""/g, '"') : f));
}

function readCsv(file) {
  const [header, ...lines] = fs.readFileSync(path.join(dataDir, file), 'utf8').trim().split(/\r?\n/);
  const cols = splitCsv(header);
  return lines.map(l => Object.fromEntries(splitCsv(l).map((v, i) => [cols[i], v])));
}

// Each row of 4 is padded to 15 characters before its tab (the longest, "0 -1 0 -1/2", is 11), so
// the next row starts at column 16 with any tab size up to 16, and the rows line up.
const matrixRows = m => [0, 4, 8].map(k => m.split(' ').slice(k, k + 4).join(' '))
  .map((row, k) => (k < 2 ? row.padEnd(15) : row)).join('\t');

const byGroup = new Map();
for (const g of readCsv('Generators.csv')) {
  if (!byGroup.has(g.GroupID)) byGroup.set(g.GroupID, []);
  byGroup.get(g.GroupID).push(g);
}

const folders = {
  GeneratorXYZs: g => `${g.Order}:${g.Generator}`,
  GeneratorMs: g => `${g.Order}:${matrixRows(g.GeneratorM)}`,
};
for (const [folder, lines] of Object.entries(folders)) {
  const dir = path.join(outDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, gens] of byGroup) {
    fs.writeFileSync(path.join(dir, `${id}.txt`), gens.map(lines).join('\n') + '\n');
  }
}
console.log(`${byGroup.size} space groups. Wrote ${Object.keys(folders).map(f => path.resolve(outDir, f)).join(' and ')}`);
