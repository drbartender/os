'use strict';

// The generated folder tree for README.md's gen:tree section (instruction
// rewrite step 4, lane gen-docs; plan 2026-10-27 decision 3 and the contract
// "The tree").
//
//   render(source) -> the fenced tree, from source.list() and source.read()
//
// Within a directory, files come first, then subdirectories, each in byte
// order. The top level lists every tracked file and directory; the three roots
// (server/, client/src/, scripts/) are descended in full with test files
// omitted (one line under the fence: `tests omitted`); a directory that holds
// a root (client/) shows its own files, its root in full, and its other
// subdirectories by name; every other directory is its name alone (`docs/`).
// No line carries a count, so adding a file outside the roots (a spec under
// docs/) never makes the tree stale (plan 2026-10-27 decision 3, amended).
// A directory whose only files are tests is left out. No directory gets a
// description. A file's description is its header's first paragraph
// (headers.readHeader) on one line; a line is `<branches><name>` padded to 30
// characters, then `# <description>` (a longer name gets one space), or the
// name alone when the file has none.

const { readHeader, isTest, styleOf, extOf, ROOTS } = require('./headers');
const { plain } = require('./markers');
const { byteOrder } = require('./source');

const ROOT_DIRS = ROOTS.map((r) => r.replace(/\/$/, ''));
const PAD = 30;

function newNode() {
  return { files: [], dirs: new Map() };
}

function build(paths) {
  const top = newNode();
  for (const p of paths) {
    const parts = p.split('/');
    let node = top;
    for (let k = 0; k < parts.length - 1; k += 1) {
      if (!node.dirs.has(parts[k])) node.dirs.set(parts[k], newNode());
      node = node.dirs.get(parts[k]);
    }
    node.files.push(parts[parts.length - 1]);
  }
  return top;
}

const inRoot = (dir) => ROOT_DIRS.some((r) => dir === r || dir.startsWith(`${r}/`));
const holdsRoot = (dir) => ROOT_DIRS.some((r) => r.startsWith(`${dir}/`));

// A directory in a root with nothing to show once its tests are omitted.
function visible(node) {
  return node.files.some((f) => !isTest(f)) || [...node.dirs.values()].some(visible);
}

function describe(source, filePath) {
  if (!styleOf(extOf(filePath))) return '';
  const text = source.read(filePath);
  if (text == null) return '';
  const h = readHeader(text, extOf(filePath));
  return h.present ? plain(h.description).replace(/`{3,}/g, '``') : '';
}

function line(branches, name, description) {
  const head = `${branches}${name}`;
  if (!description) return head;
  return `${head.length < PAD ? head.padEnd(PAD) : `${head} `}# ${description}`;
}

function render(source) {
  const paths = source.list();
  const shown = (p) => {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    return dir === '' || inRoot(dir) || holdsRoot(dir);
  };
  const describable = paths.filter((p) => styleOf(extOf(p)) && shown(p));
  if (typeof source.prefetch === 'function') source.prefetch(describable);
  const top = build(paths);
  const out = [];

  function entries(node, dir) {
    const full = dir !== '' && inRoot(dir);
    const files = node.files.filter((f) => !(full && isTest(f))).sort(byteOrder);
    const dirs = [...node.dirs.keys()].sort(byteOrder).filter((d) => {
      const sub = dir ? `${dir}/${d}` : d;
      return !inRoot(sub) || visible(node.dirs.get(d));
    });
    return [
      ...files.map((f) => ({ kind: 'file', name: f, path: dir ? `${dir}/${f}` : f })),
      ...dirs.map((d) => ({ kind: 'dir', name: d, path: dir ? `${dir}/${d}` : d, node: node.dirs.get(d) })),
    ];
  }

  function emit(node, dir, prefix) {
    const list = entries(node, dir);
    list.forEach((e, k) => {
      const last = k === list.length - 1;
      const branches = `${prefix}${last ? '└── ' : '├── '}`;
      const next = `${prefix}${last ? '    ' : '│   '}`;
      if (e.kind === 'file') {
        out.push(line(branches, e.name, describe(source, e.path)));
      } else if (inRoot(e.path) || holdsRoot(e.path)) {
        out.push(`${branches}${e.name}/`);
        emit(e.node, e.path, next);
      } else {
        out.push(`${branches}${e.name}/`);
      }
    });
  }

  emit(top, '', '');
  return ['```', 'tests omitted', ...out, '```'].join('\n');
}

module.exports = { render };
