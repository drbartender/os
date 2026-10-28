'use strict';

// Suite for git's view of the tree (scripts/lib/genDocs/source.js), in
// throwaway repos under the temp dir: the three modes, the untracked and
// staged-source lists, unmerged paths and GIT_INDEX_FILE.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { open } = require('./source');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-docs-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', ['test', 'example.com'].join('@'));
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function put(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

function commit(dir, files, message = 'c') {
  put(dir, files);
  git(dir, 'add', '--', ...Object.keys(files));
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

test('worktree mode: the index lists, the working tree reads; untracked files are not listed', (t) => {
  const dir = repo(t);
  commit(dir, { 'server/a.js': '// A one.\n', 'b.md': 'b\n' });
  put(dir, { 'server/a.js': '// A two.\n', 'server/new.js': '// New.\n', 'scripts/scratch.js': 'x\n' });
  git(dir, 'add', '--', 'server/new.js');
  const s = open({ cwd: path.join(dir, 'server') });
  assert.equal(s.top, fs.realpathSync(dir));
  assert.deepEqual(s.list(), ['b.md', 'server/a.js', 'server/new.js']);
  assert.equal(s.read('server/a.js'), '// A two.\n');
  assert.equal(s.has('scripts/scratch.js'), false);
  assert.deepEqual(s.untrackedSource(), ['scripts/scratch.js']);
  assert.equal(s.read('missing.js'), null);
});

test('staged mode: the index for both; changedSource is the added and modified source files', (t) => {
  const dir = repo(t);
  commit(dir, { 'server/a.js': '// A one.\n', 'server/b.js': '// B.\n', 'server/c.test.js': '' });
  put(dir, { 'server/a.js': '// A staged.\n' });
  git(dir, 'add', '--', 'server/a.js');
  put(dir, { 'server/a.js': '// A unstaged.\n', 'server/b.js': '// B unstaged.\n', 'server/new.js': '// New.\n', 'server/d.test.js': '' });
  git(dir, 'add', '--', 'server/new.js', 'server/d.test.js');
  const s = open({ mode: 'staged', cwd: dir });
  assert.equal(s.read('server/a.js'), '// A staged.\n');
  assert.equal(s.read('server/b.js'), '// B.\n');
  assert.deepEqual(s.changedSource(), ['server/a.js', 'server/new.js']);
  assert.deepEqual(s.untrackedSource(), []);
});

test('staged mode before a first commit diffs against the empty tree', (t) => {
  const dir = repo(t);
  put(dir, { 'scripts/x.js': '// X.\n', 'README.md': 'r\n' });
  git(dir, 'add', '--', 'scripts/x.js', 'README.md');
  assert.deepEqual(open({ mode: 'staged', cwd: dir }).changedSource(), ['scripts/x.js']);
});

test('ref mode: one commit for both, whatever the index and the working tree hold', (t) => {
  const dir = repo(t);
  const first = commit(dir, { 'server/a.js': '// First.\n' });
  commit(dir, { 'server/a.js': '// Second.\n', 'server/b.js': '// B.\n' });
  put(dir, { 'server/a.js': '// Dirty.\n' });
  const s = open({ mode: 'ref', ref: first, cwd: dir });
  assert.equal(s.commit, first);
  assert.deepEqual(s.list(), ['server/a.js']);
  assert.equal(s.read('server/a.js'), '// First.\n');
  assert.throws(() => open({ mode: 'ref', ref: 'no-such-ref', cwd: dir }), /git rev-parse failed/);
  assert.throws(() => open({ mode: 'ref', cwd: dir }), /needs a commit/);
  assert.throws(() => open({ mode: 'other', cwd: dir }), /unknown source mode/);
});

test('prefetch reads many blobs in one batch, identical blobs included', (t) => {
  const dir = repo(t);
  const files = {};
  for (let k = 0; k < 40; k += 1) files[`server/f${k}.js`] = `// File ${k % 5}.\n`;
  commit(dir, files);
  const s = open({ mode: 'staged', cwd: dir });
  s.prefetch(s.list());
  for (let k = 0; k < 40; k += 1) assert.equal(s.read(`server/f${k}.js`), `// File ${k % 5}.\n`);
});

test('GIT_INDEX_FILE is honored: a temporary index is the index read', (t) => {
  const dir = repo(t);
  commit(dir, { 'server/a.js': '// Committed.\n' });
  const tmpIndex = path.join(dir, '.git', 'other-index');
  put(dir, { 'server/a.js': '// Only in the other index.\n' });
  execFileSync('git', ['add', '--', 'server/a.js'], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
  git(dir, 'checkout', '--', 'server/a.js');
  process.env.GIT_INDEX_FILE = tmpIndex;
  try {
    assert.equal(open({ mode: 'staged', cwd: dir }).read('server/a.js'), '// Only in the other index.\n');
  } finally {
    delete process.env.GIT_INDEX_FILE;
  }
  assert.equal(open({ mode: 'staged', cwd: dir }).read('server/a.js'), '// Committed.\n');
});

test('an unmerged path is listed, unread in staged mode, and named by unmerged()', (t) => {
  const dir = repo(t);
  commit(dir, { 'README.md': 'base\n' });
  git(dir, 'checkout', '-q', '-b', 'side');
  commit(dir, { 'README.md': 'side\n' });
  git(dir, 'checkout', '-q', 'main');
  commit(dir, { 'README.md': 'main\n' });
  try { git(dir, 'merge', '-q', 'side'); } catch { /* the conflict is the point */ }
  const s = open({ mode: 'staged', cwd: dir });
  assert.deepEqual(s.unmerged(), ['README.md']);
  assert.deepEqual(s.list(), ['README.md']);
  assert.equal(s.read('README.md'), null);
});
