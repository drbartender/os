'use strict';

// Tests for scripts/lib/receiptPosition.js (instruction rewrite step 2, lane
// receipt-lib): the position snapshot. The store-time refusals run through the
// CLI (review-receipt.position.test.js); these cover the snapshot file
// itself. Every repo is a throwaway under the temp dir, removed when the test
// ends; nothing here touches the dev database.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const P = require('./receiptPosition');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-position-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n');
  git(dir, 'add', '--', 'a.js');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

test('take writes the snapshot with a seq one more than the last; read returns it', (t) => {
  const r = repo(t);
  const work = path.join(r, '.git', 'work');
  fs.mkdirSync(work);
  const state = { name: 'main', mode: 'lane' };
  assert.strictEqual(P.read(work), null);
  const head = git(r, 'rev-parse', 'HEAD');
  const one = P.take(work, state, r);
  assert.deepStrictEqual([one.seq, one.tip, one.tree, one.main], [1, head, null, head]);
  assert.strictEqual(P.take(work, state, r).seq, 2);
  assert.strictEqual(P.read(work).seq, 2);
  assert.throws(() => P.take(work, { name: 'gone', mode: 'lane' }, r), /no branch gone/);
  // A store passes the seq its input was read at; only the current one is taken.
  assert.throws(() => P.forStore(work, state, r, 'the lens', 1), /^Error: this report was read at position 1; the current snapshot is 2: store it before running position again, or re-run the lens$/);
  assert.throws(() => P.forStore(work, state, r, 'the tests', undefined), /read at position undefined; the current snapshot is 2: .* re-run the tests$/);
  assert.deepStrictEqual(P.forStore(work, state, r, 'the lens', 2), { tip: head, main: head, position: 2 });
});

test('a position.json that is not a snapshot is named by its path and refused, never read as one', (t) => {
  const r = repo(t);
  const work = path.join(r, '.git', 'work');
  fs.mkdirSync(work);
  const file = path.join(work, P.FILE);
  fs.writeFileSync(file, '{"seq": 1, "tip": "STORED-ONLY-7f3a" oops');
  assert.throws(() => P.read(work), (e) => e.message.includes(file) && !e.message.includes('STORED-ONLY') && /not valid JSON/.test(e.message));
  for (const body of ['{"seq": 1}', '{"seq": "1", "tip": "x", "main": "y"}', '[]']) {
    fs.writeFileSync(file, body);
    assert.throws(() => P.read(work), /is not a position snapshot; run position again/, body);
  }
  assert.throws(() => P.forStore(work, { name: 'main', mode: 'lane' }, r, 'the lens'), /is not a position snapshot/);
});

test('the next seq is one more than the highest of position.json and every stored entry, so a lost snapshot never reuses one', (t) => {
  const r = repo(t);
  const work = path.join(r, '.git', 'work');
  fs.mkdirSync(work);
  const state = {
    name: 'main',
    mode: 'lane',
    reports: [{ position: 5 }, { position: 2 }],
    tests: [{ position: 7 }],
    tests_superseded: [{ position: 9 }],
    externals: { codex: { state: 'run', position: 3 } },
  };
  assert.strictEqual(P.take(work, state, r).seq, 10, 'no position.json: past every stored entry');
  assert.strictEqual(P.take(work, state, r).seq, 11);
  fs.writeFileSync(path.join(work, P.FILE), JSON.stringify({ ...P.read(work), seq: 20 }));
  assert.strictEqual(P.take(work, state, r).seq, 21, 'position.json higher than every entry');
});

test('position replaces an unreadable position.json, saying so once; a quick-fix snapshot with no staged tree is refused by name', (t) => {
  const r = repo(t);
  const work = path.join(r, '.git', 'work');
  fs.mkdirSync(work);
  const file = path.join(work, P.FILE);
  const state = { name: 'main', mode: 'lane', reports: [{ position: 4 }], tests: [] };
  for (const body of ['{"seq": 1, "tip": "STORED-ONLY-7f3a" oops', '{"seq": "x"}']) {
    fs.writeFileSync(file, body);
    const replaced = [];
    const snap = P.take(work, state, r, { onReplace: (f) => replaced.push(f) });
    assert.deepStrictEqual([snap.seq, replaced], [5, [file]], body);
    assert.strictEqual(P.read(work).seq, 5);
  }
  // A hand-edited quick-fix snapshot with no tree: named, never printed as a sha.
  const head = git(r, 'rev-parse', 'HEAD');
  fs.writeFileSync(file, JSON.stringify({ seq: 1, tip: head, main: head }));
  assert.throws(() => P.forStore(work, { name: 'qf', mode: 'quick-fix' }, r, 'the lens', 1), (e) => /records no staged tree; run position again/.test(e.message) && !/undefin/.test(e.message));
});
