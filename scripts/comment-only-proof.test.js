'use strict';

// Tests for scripts/comment-only-proof.js and scripts/lib/commentOnly.js's
// proveDiff (instruction rewrite step 4, lane comment-proof, the plan's
// acceptance check 2). The CLI runs against throwaway repos under the temp dir
// named by REVIEW_RECEIPT_ROOT (the receipt testkit scrubs the git variables a
// hook would set and keeps the user's git config out); nothing here reads or
// writes this repo, origin or the dev database.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const K = require('./lib/receiptTestkit');
const { proveDiff } = require('./lib/commentOnly');

const { git, commit, makeRepo, tmpDir } = K;
const CLI = path.join(__dirname, 'comment-only-proof.js');

const SEED = {
  'server/item.js': "'use strict';\n\nconst name = 'item';\nfunction auth(x) {\n  return x === name;\n}\nmodule.exports = { auth };\n",
  'client/src/View.js': "import React from 'react';\n\nexport default function View({ name }) {\n  return <div className=\"item\">Hello {name}</div>;\n}\n",
  'scripts/run.sh': '#!/bin/sh\nset -e\necho item\n',
  'server/db/schema.sql': 'CREATE TABLE IF NOT EXISTS item (id INT, name TEXT, note TEXT);\n',
  '.env.example': '# Section\n\nNAME=item\n',
};

// A repo whose main carries SEED on top of the testkit's seed, with branch
// `lane` checked out at main -> {repo, base}.
function seeded(t) {
  const repo = makeRepo(t);
  commit(repo, 'seed sources', SEED);
  const base = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  return { repo, base };
}

function withHeader(file, header) {
  const text = SEED[file];
  if (file.endsWith('.sh')) return text.replace('#!/bin/sh\n', `#!/bin/sh\n# ${header}\n`);
  if (file.endsWith('.sql') || file.endsWith('.example')) return `${file.endsWith('.sql') ? '--' : '#'} ${header}\n${text}`;
  return text.startsWith("'use strict';") ? text.replace("'use strict';\n", `'use strict';\n\n// ${header}\n`) : `// ${header}\n${text}`;
}

function cli(repo, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, REVIEW_RECEIPT_ROOT: repo } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function lines(r) {
  return r.stdout.split('\n').filter(Boolean);
}

test('a range of header-only commits is ok, with every file listed, and the JSON is the contract', (t) => {
  const { repo, base } = seeded(t);
  commit(repo, 'headers, code', { 'server/item.js': withHeader('server/item.js', 'The item check.'), 'client/src/View.js': withHeader('client/src/View.js', 'The item view.') });
  const tip = commit(repo, 'headers, the rest', Object.fromEntries(['scripts/run.sh', 'server/db/schema.sql', '.env.example'].map((f) => [f, withHeader(f, 'What it holds.')])));
  const out = path.join(tmpDir(t, 'proof'), 'proof.json');
  const r = cli(repo, '--base', 'main', '--tip', 'lane', '--out', out);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const files = ['.env.example', 'client/src/View.js', 'scripts/run.sh', 'server/db/schema.sql', 'server/item.js'];
  assert.deepStrictEqual(lines(r), [...files.map((f) => `  ok  ${f}`), 'comment-only: yes']);
  const proof = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual(Object.keys(proof), ['version', 'mode', 'base', 'tip', 'tree', 'files', 'skipped', 'ok']);
  assert.deepStrictEqual(proof, {
    version: 1,
    mode: 'range',
    base,
    tip,
    tree: git(repo, 'rev-parse', `${tip}^{tree}`),
    files: files.map((f) => ({ path: f, ok: true, reason: null })),
    skipped: [],
    ok: true,
  });
  assert.deepStrictEqual(proveDiff({ base, tip, cwd: repo }), proof, 'the library and the CLI agree');
});

test('one code line in one file makes the whole proof not ok, naming that file', (t) => {
  const { repo } = seeded(t);
  commit(repo, 'a header and a code line', {
    'server/item.js': withHeader('server/item.js', 'The item check.'),
    'client/src/View.js': SEED['client/src/View.js'].replace('Hello {name}', 'Hello {name}!'),
  });
  const out = path.join(tmpDir(t, 'proof'), 'proof.json');
  const r = cli(repo, '--base', 'main', '--tip', 'lane', '--out', out);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  const got = lines(r);
  assert.match(got[0], /^ {2}NO {2}client\/src\/View\.js: code changed at token \d+ \(line 4 of the new text, line 4 of the old\)$/);
  assert.deepStrictEqual(got.slice(1), ['  ok  server/item.js', 'comment-only: NO (1 file)']);
  const proof = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(proof.ok, false);
  assert.deepStrictEqual(proof.files.map((f) => [f.path, f.ok]), [['client/src/View.js', false], ['server/item.js', true]]);
});

test('an added file, a deleted file, a renamed file and a mode change are not ok', (t) => {
  const { repo } = seeded(t);
  fs.writeFileSync(path.join(repo, 'server/new.js'), '// only a comment\n');
  fs.chmodSync(path.join(repo, 'scripts/run.sh'), 0o755);
  git(repo, 'add', '--', 'server/new.js', 'scripts/run.sh');
  git(repo, 'rm', '-q', '--', 'server/b.js');
  git(repo, 'mv', 'server/a.js', 'server/moved.js');
  git(repo, 'commit', '-q', '-m', 'add, delete, rename, chmod');
  const r = cli(repo, '--base', 'main', '--tip', 'lane');
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.deepStrictEqual(lines(r), [
    '  NO  scripts/run.sh: mode changed (100644 to 100755)',
    '  NO  server/a.js: deleted',
    '  NO  server/b.js: deleted',
    '  NO  server/moved.js: added',
    '  NO  server/new.js: added',
    'comment-only: NO (5 files)',
  ]);
});

test('--staged proves the index against HEAD, records the staged tree, and ignores the working tree', (t) => {
  const { repo } = seeded(t);
  const head = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'server/item.js'), withHeader('server/item.js', 'The item check.'));
  git(repo, 'add', '--', 'server/item.js');
  // An unstaged code edit and an untracked file: the proof reads the index only.
  fs.writeFileSync(path.join(repo, 'client/src/View.js'), SEED['client/src/View.js'].replace('Hello', 'Hi'));
  fs.writeFileSync(path.join(repo, 'server/scratch.js'), 'const x = 1;\n');
  const out = path.join(tmpDir(t, 'proof'), 'proof.json');
  const r = cli(repo, '--staged', '--out', out);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(lines(r), ['  ok  server/item.js', 'comment-only: yes']);
  const proof = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual(proof, {
    version: 1,
    mode: 'staged',
    base: head,
    tip: null,
    tree: git(repo, 'write-tree'),
    files: [{ path: 'server/item.js', ok: true, reason: null }],
    skipped: [],
    ok: true,
  });
  git(repo, 'add', '--', 'client/src/View.js');
  const staged = cli(repo, '--staged');
  assert.strictEqual(staged.status, 1);
  assert.match(lines(staged).join('\n'), /^ {2}NO {2}client\/src\/View\.js: code changed/m);
});

test('an empty diff is not ok: exit 1 and the empty-diff line, in both modes', (t) => {
  const { repo } = seeded(t);
  const out = path.join(tmpDir(t, 'proof'), 'proof.json');
  const r = cli(repo, '--base', 'main', '--tip', 'lane', '--out', out);
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(lines(r), ['comment-only: NO (empty diff)']);
  const proof = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual([proof.files, proof.skipped, proof.ok], [[], [], false]);
  const staged = cli(repo, '--staged');
  assert.strictEqual(staged.status, 1);
  assert.deepStrictEqual(lines(staged), ['comment-only: NO (empty diff)']);
});

test('the generated docs are skipped as the receipt key skips them, listed, and never prove anything alone', (t) => {
  const { repo, base } = seeded(t);
  commit(repo, 'a comment and the regenerated docs', {
    'server/item.js': withHeader('server/item.js', 'The item check.'),
    'README.md': 'readme, regenerated\n',
    'ARCHITECTURE.md': 'architecture\n',
  });
  const out = path.join(tmpDir(t, 'proof'), 'proof.json');
  const r = cli(repo, '--base', base, '--tip', 'lane', '--out', out);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(lines(r), ['  ok  server/item.js', '  skipped (generated docs): ARCHITECTURE.md, README.md', 'comment-only: yes']);
  const proof = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual([proof.files.map((f) => f.path), proof.skipped, proof.ok], [['server/item.js'], ['ARCHITECTURE.md', 'README.md'], true]);
  // Only the root files are the generated docs: a README elsewhere is a file like any other.
  commit(repo, 'a nested readme', { 'docs/README.md': 'notes\n' });
  assert.deepStrictEqual(lines(cli(repo, '--base', base, '--tip', 'lane')).slice(0, 1), ['  NO  docs/README.md: added']);
  // A diff of nothing but generated docs proves nothing.
  const head = git(repo, 'rev-parse', 'HEAD');
  commit(repo, 'docs only', { 'README.md': 'readme, regenerated again\n' });
  const only = cli(repo, '--base', head, '--tip', 'lane', '--out', out);
  assert.strictEqual(only.status, 1);
  assert.deepStrictEqual(lines(only), ['  skipped (generated docs): README.md', 'comment-only: NO (nothing but generated docs)']);
  const empty = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual([empty.files, empty.skipped, empty.ok], [[], ['README.md'], false]);
  // --staged skips them the same way.
  fs.writeFileSync(path.join(repo, 'README.md'), 'readme, staged\n');
  fs.writeFileSync(path.join(repo, 'server/item.js'), withHeader('server/item.js', 'The item check, reworded.'));
  git(repo, 'add', '--', 'README.md', 'server/item.js');
  assert.deepStrictEqual(lines(cli(repo, '--staged')), ['  ok  server/item.js', '  skipped (generated docs): README.md', 'comment-only: yes']);
});

test('argv misuse and a ref that names no commit exit 2 with the usage line', (t) => {
  const { repo } = seeded(t);
  for (const args of [[], ['--staged', '--base', 'main'], ['--base', 'main'], ['--tip', 'lane'], ['--base', 'main', '--tip', 'lane', '--frob'], ['main'], ['--base', 'no-such-ref', '--tip', 'lane'], ['--base', 'main', '--tip', '--out'], ['--staged', '--staged']]) {
    const r = cli(repo, ...args);
    assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^usage: comment-only-proof\.js/m, args.join(' '));
    assert.strictEqual(r.stdout, '', args.join(' '));
  }
});
