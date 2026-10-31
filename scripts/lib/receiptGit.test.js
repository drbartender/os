'use strict';

// Tests for scripts/lib/receiptGit.js (instruction rewrite step 2, lane
// receipt-lib): the git facts a review reads. Every repo is a throwaway under
// the temp dir, removed when the test ends; nothing here touches the dev
// database.

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

const G = require('./receiptGit');
const { laneKey } = require('./receipt');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(repo, message, files) {
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, rel), content);
  git(repo, 'add', '--', ...Object.keys(files));
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-git-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, 'seed', { 'a.js': 'a v1\n', 'b.js': 'b v1\n' });
  return dir;
}

test('lane facts: the tip, merge-base, ancestry on main, the key and the files changed since each recorded tip', (t) => {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  const read = commit(repo, 'lane', { 'a.js': 'a v2\n', 'b.js': 'b v2\n' });
  const tip = commit(repo, 'post-review', { 'a.js': 'a v3\n' });
  const state = { mode: 'lane', name: 'lane', reports: [{ tip: read, main: base }, { tip }, { tip: 'f'.repeat(40), main: base }] };
  const g = G.finalizeFacts(state, { base, reviewed: base }, true, repo);
  assert.deepStrictEqual(g.problems, []);
  assert.strictEqual(g.tip, tip);
  assert.strictEqual(g.main, base);
  assert.strictEqual(g.mergeBase, base);
  assert.deepStrictEqual([g.baseOnTip, g.baseOnMain, g.reviewedOnMain], [true, true, true]);
  assert.strictEqual(g.key, laneKey(base, tip, { cwd: repo }));
  assert.deepStrictEqual(g.files, ['a.js', 'b.js']);
  assert.deepStrictEqual(g.changedSince, { [read]: ['a.js'] }, 'the final tip needs no diff; a tip git cannot read is left out');
  assert.deepStrictEqual(g.readBase, { [`${base} ${read}`]: base, [`${base} ${'f'.repeat(40)}`]: null }, 'the base each report was read on; null when git cannot say');
  assert.deepStrictEqual(g.olderBase, {});
  assert.deepStrictEqual(g.overlapFiles, {}, 'no report was read on an older base');
  assert.deepStrictEqual(require('./receiptPosition').current(state, repo), { tip, tree: null, main: base });
  assert.deepStrictEqual(G.previewFiles(state, repo), ['a.js', 'b.js']);
});

test('a lane rebased after a report: the files main changed between the older base it was read on and reviewed (review 5, M1)', (t) => {
  const repo = makeRepo(t);
  const m0 = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  const read = commit(repo, 'lane', { 'a.js': 'a v2\n' });
  git(repo, 'checkout', '-q', 'main');
  const m1 = commit(repo, 'main moves', { 'a.js': 'a from main\n', 'c.js': 'c v1\n' });
  // The rebase, its conflict on a.js resolved to the lane's side: a.js is byte-identical at the new tip.
  git(repo, 'checkout', '-q', '-B', 'lane', m1);
  const tip = commit(repo, 'lane, rebased', { 'a.js': 'a v2\n' });
  const state = { mode: 'lane', name: 'lane', reports: [{ tip: read, main: m0 }, { tip, main: m1 }] };
  const g = G.finalizeFacts(state, { base: m1, reviewed: m1 }, true, repo);
  assert.deepStrictEqual(g.problems, []);
  assert.deepStrictEqual(g.files, ['a.js']);
  assert.deepStrictEqual(g.changedSince, { [read]: ['c.js'] }, 'a.js did not change between the two tips');
  assert.deepStrictEqual(g.readBase, { [`${m0} ${read}`]: m0, [`${m1} ${tip}`]: m1 });
  assert.deepStrictEqual(g.olderBase, { [m0]: true });
  assert.deepStrictEqual(g.overlapFiles, { [m0]: ['a.js', 'c.js'] }, 'what main changed since the older base');
});

test('the reviewed patch is read without context: a rebase that moved only the base keeps it, main editing a line beside a lane hunk included; a fix changes it (receipt-cap round 2)', (t) => {
  const repo = makeRepo(t);
  const lines = (edit = {}) => `${Array.from({ length: 20 }, (_, i) => edit[i + 1] || `line ${i + 1}`).join('\n')}\n`;
  const m0 = commit(repo, 'twenty lines', { 'c.js': lines() });
  git(repo, 'checkout', '-q', '-b', 'lane');
  const read = commit(repo, 'a lane hunk at line 10', { 'c.js': lines({ 10: 'lane 10' }) });
  git(repo, 'checkout', '-q', 'main');
  const m1 = commit(repo, 'main edits line 8, two lines above the hunk', { 'c.js': lines({ 8: 'main 8' }) });
  git(repo, 'checkout', '-q', '-B', 'lane', m1);
  const tip = commit(repo, 'the lane, rebased with no new commit', { 'c.js': lines({ 8: 'main 8', 10: 'lane 10' }) });
  const fixed = commit(repo, 'a fix', { 'c.js': lines({ 8: 'main 8', 10: 'lane 10, fixed' }) });
  const state = { mode: 'lane', name: 'lane', reports: [{ tip: read, main: m0 }, { tip, main: m1 }, { tip: fixed, main: m1 }] };
  const g = G.finalizeFacts(state, { base: m1, reviewed: m1 }, true, repo);
  assert.deepStrictEqual(g.problems, []);
  const [p0, p1, p2] = state.reports.map((r) => g.reviewedPatch[G.patchKey(r)]);
  assert.match(p0, /^[0-9a-f]{40}$/);
  assert.strictEqual(p1, p0, 'a move of the base alone, its edit inside the old three-line context');
  assert.notStrictEqual(p2, p1, 'a fix');
});

test('quick-fix facts: HEAD, the staged tree as key and tree, and the files changed since each recorded tree', (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, 'a.js'), 'a fixed\n');
  git(repo, 'add', '--', 'a.js');
  const first = git(repo, 'write-tree');
  fs.writeFileSync(path.join(repo, 'b.js'), 'b fixed\n');
  git(repo, 'add', '--', 'b.js');
  const head = git(repo, 'rev-parse', 'HEAD');
  const state = { mode: 'quick-fix', name: 'quick-fix-x', reports: [{ tree: first }] };
  const g = G.finalizeFacts(state, { base: head, reviewed: head }, true, repo);
  assert.deepStrictEqual(g.problems, []);
  assert.strictEqual(g.head, head);
  assert.strictEqual(g.tree, git(repo, 'write-tree'));
  assert.strictEqual(g.key, g.tree);
  assert.deepStrictEqual(g.files, ['a.js', 'b.js']);
  assert.deepStrictEqual(g.changedSince, { [first]: ['b.js'] });
});

test('a ref git cannot resolve is a problem; a kind finalize refuses gathers no key', (t) => {
  const repo = makeRepo(t);
  const g = G.finalizeFacts({ mode: 'lane', name: 'gone', reports: [] }, { base: 'no-such-ref', reviewed: '--output=/tmp/x' }, true, repo);
  assert.ok(g.problems.some((p) => /^base: not a commit/.test(p)), g.problems.join('\n'));
  assert.ok(g.problems.some((p) => /^reviewed-against: not a commit/.test(p)), g.problems.join('\n'));
  assert.ok(g.problems.some((p) => /^branch: gone no longer exists/.test(p)), g.problems.join('\n'));
  const head = git(repo, 'rev-parse', 'HEAD');
  const none = G.finalizeFacts({ mode: 'lane', name: 'main', reports: [] }, { base: head, reviewed: head }, false, repo);
  assert.strictEqual(none.key, null);
  assert.strictEqual(none.tip, null);
});

test('changedSince leaves out only a position git cannot resolve; any other error from the diff propagates (pre-step, swallowed-catch)', () => {
  const unresolved = (a) => { throw new Error(`not a commit: ${a}`); };
  assert.deepStrictEqual(G.changedSince(['p1', 'final'], 'final', unresolved), {}, 'an unresolvable position is left out, so every verdict read there is stale');
  const broken = () => { throw new TypeError('diff is not a function'); };
  assert.throws(() => G.changedSince(['p1'], 'final', broken), TypeError, 'a defect in the diff is not a stale position');
});

test('overlap leaves out only an older base git cannot resolve; any other error propagates (pre-step, swallowed-catch)', (t) => {
  const repo = makeRepo(t);
  const m0 = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  const read = commit(repo, 'lane', { 'a.js': 'a v2\n' });
  git(repo, 'checkout', '-q', 'main');
  const m1 = commit(repo, 'main moves', { 'c.js': 'c v1\n' });
  git(repo, 'checkout', '-q', '-B', 'lane', m1);
  const tip = commit(repo, 'lane, rebased', { 'a.js': 'a v2\n' });
  const state = { mode: 'lane', name: 'lane', reports: [{ tip: read, main: m0 }, { tip, main: m1 }] };
  const R = require('./receipt');
  const real = R.filesBetween;
  t.after(() => { R.filesBetween = real; });
  R.filesBetween = (a, b, opts) => {
    if (a === m0) throw new Error(`not a commit: ${a}`);
    return real(a, b, opts);
  };
  const stale = G.finalizeFacts(state, { base: m1, reviewed: m1 }, true, repo);
  assert.deepStrictEqual(stale.overlapFiles, {}, 'an older base git cannot resolve is left out, so every verdict read on it is stale');
  R.filesBetween = (a, b, opts) => {
    if (a === m0) throw new TypeError('filesBetween broke');
    return real(a, b, opts);
  };
  assert.throws(() => G.finalizeFacts(state, { base: m1, reviewed: m1 }, true, repo), TypeError, 'a defect in filesBetween is not a stale base');
});
