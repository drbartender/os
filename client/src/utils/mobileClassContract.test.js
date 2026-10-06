import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const css = read('index.css');
const SOURCES = [
  'components/mobile/AssignmentSheet.js',
  'components/mobile/EditSheet.js',
  'components/mobile/MobileHeader.js',
  'components/mobile/NoteSheet.js',
  'pages/mobile/EventDetailPhone.js',
  'pages/mobile/EventDetailSections.js',
];

// Every m-* token that appears inside a string or template literal in the
// source. Comments are stripped first so prose cannot add or hide a class.
function classesIn(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...new Set(code.match(/\bm-[a-z][a-z0-9-]*/g) || [])];
}

test.each(SOURCES)('%s uses only classes the stylesheet defines', (rel) => {
  const missing = classesIn(read(rel)).filter((name) => !new RegExp(`\\.${name}(?![a-z0-9-])`).test(css));
  expect(missing).toEqual([]);
});

test('no file under pages/mobile or components/mobile imports the desktop ShiftDrawer', () => {
  for (const dir of ['pages/mobile', 'components/mobile']) {
    const folder = path.resolve(__dirname, '..', dir);
    for (const file of fs.readdirSync(folder).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))) {
      expect(`${dir}/${file}: ${/drawers\/ShiftDrawer/.test(fs.readFileSync(path.join(folder, file), 'utf8'))}`).toBe(`${dir}/${file}: false`);
    }
  }
});

// offlineGet lets the service worker answer a read from the phone's cache.
// Only a screen that renders the staleness line may ask for that, and only the
// phone screens do. A desktop screen that imported it would show yesterday's
// roster or invoice list under live buttons, with nothing saying so.
const SRC = path.resolve(__dirname, '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  if (e.isDirectory()) return walk(full);
  return /\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) ? [full] : [];
});
const holders = (pattern) => walk(SRC)
  .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
  .map((file) => path.relative(SRC, file).split(path.sep).join('/'));

test('only phone screens import offlineRead', () => {
  // Any quoted path that ends in offlineRead: an import, a require, a dynamic
  // import, with or without the .js.
  const importers = holders(/['"][^'"]*\/offlineRead(\.js)?['"]/);
  expect(importers.length).toBeGreaterThan(0);
  expect(importers.filter((rel) => !/^(pages|components)\/mobile\//.test(rel))).toEqual([]);
});

// The likeliest way round the gate above is to send the header by hand.
test('the offline header is written in exactly one source file', () => {
  expect(holders(/x-offline-ok/i)).toEqual(['utils/offlineRead.js']);
});
