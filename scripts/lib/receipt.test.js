'use strict';

// Tests for scripts/lib/receipt.js (instruction rewrite step 2, lane
// receipt-lib). Every git test runs in a throwaway repo under the temp dir,
// removed when the test ends; nothing here touches the dev database.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A test run from inside a git hook inherits variables that point git at the
// hook's repo; the throwaway repos must never see them. The user's global and
// system config stay out too, so a test proves the key pins its own flags.
for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const receipt = require('./receipt');
const {
  laneKey, quickFixKey, commitKey,
  workDir, receiptDir, writeReceipt, readReceipt, indexSet, indexLookup,
  commitBlock, LENSES, KINDS, VERDICTS,
} = receipt;

const CLI = path.join(__dirname, '..', 'review-receipt.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(repo, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function commit(repo, message, files) {
  write(repo, files);
  git(repo, 'add', '--', ...Object.keys(files));
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

const A_JS = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, 'seed', { 'README.md': 'readme v1\n', 'ARCHITECTURE.md': 'arch v1\n', 'a.js': A_JS, 'b.js': 'b v1\n' });
  return dir;
}

// Rebases the checked-out branch onto `onto`; each conflict is resolved by
// `resolve(paths)` (which writes the files) until the rebase ends.
function rebase(repo, onto, resolve) {
  const env = { ...process.env, GIT_EDITOR: 'true' };
  let r = spawnSync('git', ['rebase', '-q', onto], { cwd: repo, env, encoding: 'utf8' });
  while (r.status !== 0) {
    const conflicted = git(repo, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
    assert.ok(conflicted.length > 0, `rebase failed with no conflict: ${r.stderr}`);
    resolve(conflicted);
    git(repo, 'add', '--', ...conflicted);
    r = spawnSync('git', ['rebase', '--continue'], { cwd: repo, env, encoding: 'utf8' });
  }
}

// ---- keys -------------------------------------------------------------------

test('the lane key survives a content-identical rebase and churn in the generated docs', (t) => {
  const repo = makeRepo(t);
  const main1 = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  commit(repo, 'lane: a.js line 3', { 'a.js': A_JS.replace('line 3\n', 'line 3 changed\n'), 'README.md': 'readme v1\nlane row\n' });
  commit(repo, 'lane: c.js', { 'c.js': 'c v1\n' });
  const tip1 = git(repo, 'rev-parse', 'HEAD');
  const k1 = laneKey(main1, tip1, { cwd: repo });
  assert.match(k1, /^[0-9a-f]{40}$/);

  // main moves: an unrelated file and both generated docs.
  git(repo, 'checkout', '-q', 'main');
  const main2 = commit(repo, 'main: b.js and docs', { 'b.js': 'b v2\n', 'README.md': 'readme v2 from main\n', 'ARCHITECTURE.md': 'arch v2\n' });
  git(repo, 'checkout', '-q', 'lane');
  // The README conflicts; the generator's answer resolves it.
  rebase(repo, 'main', (paths) => {
    assert.deepStrictEqual(paths, ['README.md']);
    write(repo, { 'README.md': 'readme regenerated after rebase\n' });
  });
  commit(repo, 'docs: regenerate', { 'README.md': 'readme regenerated again\n', 'ARCHITECTURE.md': 'arch regenerated\n' });
  const tip2 = git(repo, 'rev-parse', 'HEAD');
  assert.notStrictEqual(tip2, tip1);
  // The generated docs really did churn between the two reviews.
  assert.notStrictEqual(git(repo, 'diff', main1, tip1, '--', 'README.md'), git(repo, 'diff', main2, tip2, '--', 'README.md'));
  assert.strictEqual(laneKey(main2, tip2, { cwd: repo }), k1);
});

test('the lane key changes after a one-line change in the lane', (t) => {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  const tip1 = commit(repo, 'lane', { 'a.js': A_JS.replace('line 3\n', 'line 3 changed\n') });
  const k1 = laneKey(base, tip1, { cwd: repo });
  const tip2 = commit(repo, 'lane: one more line', { 'a.js': A_JS.replace('line 3\n', 'line 3 changed\n').replace('line 9\n', 'line 9 changed\n') });
  assert.notStrictEqual(laneKey(base, tip2, { cwd: repo }), k1);
});

test('the lane key changes after a conflict resolution', (t) => {
  const repo = makeRepo(t);
  const main1 = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  const tip1 = commit(repo, 'lane', { 'a.js': A_JS.replace('line 3\n', 'line 3 from the lane\n') });
  const k1 = laneKey(main1, tip1, { cwd: repo });
  git(repo, 'checkout', '-q', 'main');
  const main2 = commit(repo, 'main: the same line', { 'a.js': A_JS.replace('line 3\n', 'line 3 from main\n') });
  git(repo, 'checkout', '-q', 'lane');
  rebase(repo, 'main', () => write(repo, { 'a.js': A_JS.replace('line 3\n', 'line 3 from the lane\n') }));
  const tip2 = git(repo, 'rev-parse', 'HEAD');
  assert.notStrictEqual(laneKey(main2, tip2, { cwd: repo }), k1);
});

test('a change to a nested README is keyed; only the root generated docs are excluded', (t) => {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  const tip1 = commit(repo, 'lane', { 'a.js': A_JS.replace('line 1\n', 'line 1 changed\n') });
  const k1 = laneKey(base, tip1, { cwd: repo });
  const tip2 = commit(repo, 'docs/README.md is real content', { 'docs/README.md': 'a doc\n' });
  assert.notStrictEqual(laneKey(base, tip2, { cwd: repo }), k1);
});

test('a diff that touches only the generated docs has nothing to key', (t) => {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  const tip = commit(repo, 'docs only', { 'README.md': 'readme v9\n', 'ARCHITECTURE.md': 'arch v9\n' });
  assert.throws(() => laneKey(base, tip, { cwd: repo }), /nothing to key/);
});

// A change myers and patience diff differently (the classic frobnitz pair), so
// the algorithm pin is tested.
const OLD_C = ['#include <stdio.h>', '', '// Frobs foo heartily', 'int frobnitz(int foo)', '{', '    int i;', '    for(i = 0; i < 10; i++)', '    {',
  '        printf("Your answer is: ");', '        printf("%d\\n", foo);', '    }', '}', '', 'int fact(int n)', '{', '    if(n > 1)', '    {',
  '        return fact(n-1) * n;', '    }', '    return 1;', '}', '', 'int main(int argc, char **argv)', '{', '    frobnitz(fact(10));', '}', ''].join('\n');
const NEW_C = ['#include <stdio.h>', '', 'int fib(int n)', '{', '    if(n > 2)', '    {', '        return fib(n-1) + fib(n-2);', '    }', '    return 1;', '}', '',
  '// Frobs foo heartily', 'int frobnitz(int foo)', '{', '    int i;', '    for(i = 0; i < 10; i++)', '    {', '        printf("%d\\n", foo);', '    }', '}', '',
  'int main(int argc, char **argv)', '{', '    frobnitz(fib(10));', '}', ''].join('\n');

test('the key is the same whatever the diff config and environment say', (t) => {
  const repo = makeRepo(t);
  const base = commit(repo, 'old c', { 'f.c': OLD_C });
  git(repo, 'checkout', '-q', '-b', 'lane');
  write(repo, { 'bin.dat': Buffer.from([0, 1, 2, 3, 0, 9]) });
  git(repo, 'add', '--', 'bin.dat');
  git(repo, 'commit', '-q', '-m', 'binary');
  const tip = commit(repo, 'text', { 'a.js': A_JS.replace('line 5\n', 'line 5 changed\n'), 'sub/ünï.js': 'x\n', 'f.c': NEW_C });
  const before = laneKey(base, tip, { cwd: repo });
  for (const [k, v] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['diff.external', '/bin/false'], ['diff.algorithm', 'patience'],
    ['diff.context', '9'], ['diff.interHunkContext', '9'], ['diff.renames', 'copies'], ['diff.relative', 'true'], ['core.abbrev', '12'],
    ['core.quotePath', 'false'], ['color.diff', 'always'], ['patchid.verbatim', 'true']]) {
    git(repo, 'config', k, v);
  }
  process.env.GIT_DIFF_OPTS = '--unified=0';
  process.env.GIT_EXTERNAL_DIFF = '/bin/false';
  t.after(() => { delete process.env.GIT_DIFF_OPTS; delete process.env.GIT_EXTERNAL_DIFF; });
  assert.strictEqual(laneKey(base, tip, { cwd: path.join(repo, 'sub') }), before);
});

test('every git call reads the repo its cwd names, whatever GIT_DIR and the other repo variables say (review 4, L3)', (t) => {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  const tip = commit(repo, 'lane', { 'server/a.js': 'a\n', 'b.js': 'b v2\n' });
  const key = laneKey(base, tip, { cwd: repo });
  const { tier } = require('../sensitive-match').tierFromGit({ base, tip }, { cwd: repo });
  fs.writeFileSync(path.join(repo, 'b.js'), 'b staged\n');
  git(repo, 'add', '--', 'b.js');
  const tree = git(repo, 'write-tree');
  git(repo, 'restore', '--staged', '--', 'b.js');
  git(repo, 'checkout', '-q', '--', 'b.js');
  // Another repo, another history: what a hook's GIT_DIR would name.
  const foreign = makeRepo(t);
  commit(foreign, 'foreign', { 'f.js': 'f\n' });
  const vars = { GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: foreign, GIT_INDEX_FILE: path.join(foreign, '.git', 'index'), GIT_OBJECT_DIRECTORY: path.join(foreign, '.git', 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(foreign, '.git', 'objects'), GIT_COMMON_DIR: path.join(foreign, '.git') };
  const under = (fn) => {
    Object.assign(process.env, vars);
    try {
      return fn();
    } finally {
      for (const k of Object.keys(vars)) delete process.env[k];
    }
  };
  const P = require('./receiptPosition');
  const G = require('./receiptGit');
  const work = path.join(repo, '.git', 'l3-work');
  fs.mkdirSync(work);
  const state = { name: 'lane', mode: 'lane', reports: [] };
  const got = under(() => ({
    tip: receipt.resolveCommit('refs/heads/lane', { cwd: repo }),
    files: receipt.filesBetween(base, tip, { cwd: repo }),
    key: laneKey(base, tip, { cwd: repo }),
    root: receipt.reviewRoot({ cwd: repo }),
    snap: P.take(work, state, repo),
    facts: G.finalizeFacts(state, { base, reviewed: base }, true, repo),
  }));
  assert.deepStrictEqual([got.tip, got.files, got.key, got.root], [tip, ['b.js', 'server/a.js'], key, path.join(fs.realpathSync(repo), '.git', 'drb-review')]);
  assert.deepStrictEqual([got.snap.tip, got.snap.main], [tip, base]);
  assert.deepStrictEqual([got.facts.problems, got.facts.key, got.facts.computedTier], [[], key, tier]);
  assert.deepStrictEqual(Object.keys(vars).filter((k) => k in process.env), [], 'the variables come back as they were');
  // A quick fix's staged tree is the repo's own index, not the foreign one.
  fs.writeFileSync(path.join(repo, 'b.js'), 'b staged\n');
  git(repo, 'add', '--', 'b.js');
  assert.strictEqual(under(() => quickFixKey({ cwd: repo })), tree);
  git(repo, 'restore', '--staged', '--', 'b.js');
  git(repo, 'checkout', '-q', '--', 'b.js');
  // The CLI, run with the variables in its environment.
  ok(cli(repo, ['init', '--branch', 'lane']));
  const r = under(() => cli(repo, ['position', 'lane']));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^position \\d+ tip ${tip.slice(0, 7)}$`, 'm'));
});

test('an attribute only one checkout has does not move the key: a lane-committed -diff, an untracked .gitattributes, core.attributesFile', (t) => {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'main');
  const wt = path.join(path.dirname(repo), `${path.basename(repo)}-attr`);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  git(repo, 'worktree', 'add', '-q', '-b', 'lane', wt);
  // The lane marks a text file -diff and changes it: on disk in the lane's
  // worktree, absent from main's checkout.
  const tip = commit(wt, 'lane', { '.gitattributes': 'notes.txt -diff\n', 'notes.txt': 'one\ntwo\n' });
  const fromLane = laneKey(base, tip, { cwd: wt });
  assert.strictEqual(laneKey(base, tip, { cwd: repo }), fromLane, 'keyed alike from the lane worktree and from main');
  write(repo, { '.gitattributes': '* -diff\n*.js binary\n' });
  const attrs = path.join(repo, '.git', 'global-attributes');
  fs.writeFileSync(attrs, '* -diff\n');
  git(repo, 'config', 'core.attributesFile', attrs);
  assert.strictEqual(laneKey(base, tip, { cwd: repo }), fromLane, 'an untracked .gitattributes and core.attributesFile change nothing');
});

test('two different changes to one binary file key differently', (t) => {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'one');
  write(repo, { 'bin.dat': Buffer.from([0, 1, 2]) });
  git(repo, 'add', '--', 'bin.dat');
  git(repo, 'commit', '-q', '-m', 'one');
  git(repo, 'checkout', '-q', '-b', 'two', 'main');
  write(repo, { 'bin.dat': Buffer.from([0, 1, 3]) });
  git(repo, 'add', '--', 'bin.dat');
  git(repo, 'commit', '-q', '-m', 'two');
  assert.notStrictEqual(laneKey(base, 'one', { cwd: repo }), laneKey(base, 'two', { cwd: repo }));
});

test('a mode-only change is keyed', (t) => {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  fs.chmodSync(path.join(repo, 'b.js'), 0o755);
  git(repo, 'add', '--', 'b.js');
  git(repo, 'commit', '-q', '-m', 'chmod');
  assert.match(laneKey(base, 'lane', { cwd: repo }), /^[0-9a-f]{40}$/);
});

test('a ref that is not a commit, or reads as an option, is refused', (t) => {
  const repo = makeRepo(t);
  assert.throws(() => laneKey('--output=/tmp/x', 'main', { cwd: repo }), /not a commit/);
  assert.throws(() => laneKey('main', 'no-such-branch', { cwd: repo }), /not a commit/);
  assert.throws(() => laneKey('', 'main', { cwd: repo }), /not a commit/);
  assert.throws(() => commitKey('-p', { cwd: repo }), /not a commit/);
});

test('the quick-fix key equals HEAD^{tree} after committing the staged index', (t) => {
  const repo = makeRepo(t);
  write(repo, { 'a.js': A_JS.replace('line 2\n', 'line 2 fixed\n'), 'README.md': 'readme regenerated\n' });
  git(repo, 'add', '--', 'a.js', 'README.md');
  write(repo, { 'b.js': 'an unstaged edit is not in the key\n' });
  const key = quickFixKey({ cwd: repo });
  git(repo, 'commit', '-q', '-m', 'fix');
  assert.strictEqual(key, git(repo, 'rev-parse', 'HEAD^{tree}'));
});

test('the commit key of a squash equals the lane key when main did not move', (t) => {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  commit(repo, 'lane 1', { 'a.js': A_JS.replace('line 4\n', 'line 4 changed\n'), 'README.md': 'readme lane\n' });
  commit(repo, 'lane 2', { 'c.js': 'c\n' });
  const key = laneKey(base, 'lane', { cwd: repo });
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--squash', 'lane');
  git(repo, 'commit', '-q', '-m', 'merge(lane lane): plan');
  const squash = git(repo, 'rev-parse', 'HEAD');
  assert.strictEqual(commitKey(squash, { cwd: repo }), key);
});

test('a root commit has no commit key', (t) => {
  const repo = makeRepo(t);
  assert.throws(() => commitKey(git(repo, 'rev-parse', 'HEAD'), { cwd: repo }), /no parent/);
});

// The lens-report shape the CLI test below stores (the parser's own tests are
// receiptVerdicts.test.js).
function report(rows, { findings = [], header = '| file | verdict | note |', separator = '|---|---|---|', tail = '' } = {}) {
  const lines = ['Read the brief and the diff.', ''];
  for (const f of findings) lines.push(f);
  lines.push('', header);
  if (separator) lines.push(separator);
  for (const [file, verdict, note = ''] of rows) lines.push(`| ${file} | ${verdict} | ${note} |`);
  if (tail) lines.push(tail);
  return lines.join('\n') + '\n';
}

test('the constants name the six kinds, the four verdicts and the nine lenses', () => {
  assert.deepStrictEqual([...KINDS], ['lane', 'quick-fix', 'commit', 'squash', 'revert', 'comment-only']);
  assert.deepStrictEqual([...VERDICTS], ['pass', 'finding', 'not reached', 'escalate']);
  assert.deepStrictEqual([...LENSES], ['money', 'lifecycle', 'concurrency', 'business-time', 'outcomes-providers', 'access-egress', 'seams', 'schema-data', 'client']);
  for (const lens of LENSES) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '.claude', 'agents', `${lens}.md`)), `${lens}.md is a lens file`);
});

// ---- directories and the index ----------------------------------------------

test('the working and receipt directories live under the common git dir, also from a worktree', (t) => {
  const repo = makeRepo(t);
  const wt = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', wt);
  const common = fs.realpathSync(path.join(repo, '.git'));
  assert.strictEqual(workDir('feature/x', { cwd: wt }), path.join(common, 'drb-review', '_work', 'feature%2Fx'));
  const key = 'a'.repeat(40);
  assert.strictEqual(receiptDir(key, { cwd: wt }), path.join(common, 'drb-review', key));
  assert.throws(() => receiptDir('../etc', { cwd: wt }), /not a receipt key/);
  for (const bad of ['', '../x', 'a/../b', '-x', 'a//b', 'a/', '.hidden', 'a b', 'x\ny']) {
    assert.throws(() => workDir(bad, { cwd: wt }), /not a usable name/, bad);
  }
});

test('writeReceipt and readReceipt round-trip; a missing receipt reads as null', (t) => {
  const repo = makeRepo(t);
  const dir = receiptDir('b'.repeat(40), { cwd: repo });
  assert.strictEqual(readReceipt(dir), null);
  writeReceipt(dir, { version: 1, key: 'b'.repeat(40), kind: 'lane' });
  assert.deepStrictEqual(readReceipt(dir), { version: 1, key: 'b'.repeat(40), kind: 'lane' });
  assert.deepStrictEqual(fs.readdirSync(dir), ['receipt.json']);
});

test('readReceipt needs version 1, and a corrupt receipt.json is named by its path, never quoted', (t) => {
  const repo = makeRepo(t);
  const dir = receiptDir('c'.repeat(40), { cwd: repo });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'receipt.json');
  fs.writeFileSync(file, '{"version": 1, "note": "STORED-ONLY-7f3a" oops');
  assert.throws(() => readReceipt(dir), (e) => e.message.includes(file) && !e.message.includes('STORED-ONLY') && /not valid JSON/.test(e.message));
  for (const body of ['{"version": 2, "key": "x"}', '{"key": "x"}', '[1]', '7']) {
    fs.writeFileSync(file, body);
    assert.throws(() => readReceipt(dir), /is not a version 1 receipt/, body);
  }
});

test('indexLookup finds a receipt by key, then falls back to the branch, and follows a changed key', (t) => {
  const repo = makeRepo(t);
  const k1 = '1'.repeat(40);
  const k2 = '2'.repeat(40);
  writeReceipt(receiptDir(k1, { cwd: repo }), { key: k1 });
  indexSet('lane-a', { key: k1, tip: 'c'.repeat(40), reviewedAgainst: 'd'.repeat(40) }, { cwd: repo });
  assert.strictEqual(indexLookup(k1, { cwd: repo }).key, k1);
  assert.strictEqual(indexLookup('lane-a', { cwd: repo }).key, k1);
  assert.strictEqual(indexLookup('lane-a', { cwd: repo }).via, 'branch');
  writeReceipt(receiptDir(k2, { cwd: repo }), { key: k2 });
  indexSet('lane-a', { key: k2, tip: 'e'.repeat(40), reviewedAgainst: 'd'.repeat(40) }, { cwd: repo });
  const found = indexLookup('lane-a', { cwd: repo });
  assert.strictEqual(found.key, k2);
  assert.strictEqual(found.dir, receiptDir(k2, { cwd: repo }));
  assert.strictEqual(indexLookup(k1, { cwd: repo }).key, k1, 'the old receipt is still found by its own key');
  assert.strictEqual(indexLookup('no-such-lane', { cwd: repo }), null);
  assert.strictEqual(indexLookup('3'.repeat(40), { cwd: repo }), null);
  const idx = JSON.parse(fs.readFileSync(path.join(path.dirname(receiptDir(k1, { cwd: repo })), 'index.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(idx['lane-a']).sort(), ['at', 'key', 'reviewed_against', 'tip']);
});

test('indexSet waits on a held index lock, breaks a stale one, and never drops another entry', (t) => {
  const repo = makeRepo(t);
  const root = path.dirname(receiptDir('1'.repeat(40), { cwd: repo }));
  indexSet('one', { key: '1'.repeat(40), tip: 'c'.repeat(40), reviewedAgainst: 'd'.repeat(40) }, { cwd: repo });
  const lock = path.join(root, 'index.json.lock');
  fs.writeFileSync(lock, '');
  assert.throws(() => indexSet('two', { key: '2'.repeat(40), tip: 'c'.repeat(40), reviewedAgainst: 'd'.repeat(40) }, { cwd: repo, lockWaitMs: 200 }), /held/);
  const old = (Date.now() - 120_000) / 1000;
  fs.utimesSync(lock, old, old);
  indexSet('two', { key: '2'.repeat(40), tip: 'c'.repeat(40), reviewedAgainst: 'd'.repeat(40) }, { cwd: repo, lockWaitMs: 200 });
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(idx).sort(), ['one', 'two']);
  assert.ok(!fs.existsSync(lock));
});

test('a corrupt index is an error, never an empty index that indexSet would overwrite', (t) => {
  const repo = makeRepo(t);
  const root = path.dirname(receiptDir('1'.repeat(40), { cwd: repo }));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.json'), '{not json');
  assert.throws(() => indexLookup('x', { cwd: repo }), /index\.json/);
  assert.throws(() => indexSet('x', { key: '1'.repeat(40), tip: 'c'.repeat(40), reviewedAgainst: 'd'.repeat(40) }, { cwd: repo }), /index\.json/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'index.json'), 'utf8'), '{not json');
});

// ---- the commit block -------------------------------------------------------

// Spec 3.7's example, from "Review:" to the receipt line.
const SPEC_BLOCK = [
  'Review: tier A (sensitive: server/utils/invoiceLineItems.js, server/routes/proposals/*)',
  '  lenses:   money, lifecycle, concurrency, outcomes, access, seams; second opinion (codex, gemini); verify',
  '  files:    14/14 verdicts',
  '  findings: 11 raised, 3 confirmed, 3 fixed and re-reviewed, 8 rejected',
  '  tests:    money-smoke 79/79, invoiceLineItems.test.js 18/18, cancelLineItem.protected.test.js 9/9',
  '  receipt:  patch 3f2a9c1, reviewed against main 8c1c660, 2026-10-19 14:02',
];

const ITEM = '(?:no suites reached|\\S+ \\d+/\\d+)';
const SHAPE = [
  /^Review: tier (A|hinge|B|C|docs)( \([^()]+\))?$/,
  /^ {2}lenses: {3}(none|[a-z-]+(, [a-z-]+)*)(; second opinion( \([a-z ,;]+\)| not run))?(; verify)?$/,
  /^ {2}files: {4}\d+\/\d+ verdicts(, \d+ not reached \(allowed\))?$/,
  /^ {2}findings: \d+ raised, \d+ confirmed, \d+ fixed and re-reviewed, \d+ rejected$/,
  new RegExp(`^ {2}tests: {4}(none recorded|${ITEM}(, ${ITEM})*)$`),
  /^ {2}receipt: {2}(patch|tree) [0-9a-f]{7}, reviewed against main [0-9a-f]{7}, \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
];

function lensEntry(name, raised, confirmed, fixed, rejected) {
  return { name, fired_because: ['floor'], forecast: true, raised, confirmed, fixed, rejected, passes: [`${name}.md`], verdicts: {} };
}

const FIXTURE_FILES = Array.from({ length: 14 }, (_, i) => `server/routes/proposals/f${i}.js`);
const FIXTURE = {
  version: 1,
  key: `3f2a9c1${'e'.repeat(33)}`,
  kind: 'lane',
  branch: 'invoice-step',
  tip: 'a'.repeat(40),
  reviewed_against: `8c1c660${'0'.repeat(33)}`,
  base: `8c1c660${'0'.repeat(33)}`,
  tier: 'A',
  tiers_by_file: {},
  matched_paths: [
    { path: 'server/utils/invoiceLineItems.js', pattern: 'server/utils/invoiceLineItems.js', section: 'money' },
    { path: 'server/routes/proposals/f0.js', pattern: 'server/routes/proposals/*', section: 'money' },
    { path: 'server/routes/proposals/f1.js', pattern: 'server/routes/proposals/*', section: 'money' },
  ],
  content_rule_hits: [],
  lenses: [
    lensEntry('seams', 2, 1, 1, 1),
    lensEntry('money', 4, 1, 1, 3),
    lensEntry('lifecycle', 1, 0, 0, 1),
    lensEntry('concurrency', 1, 0, 0, 1),
    lensEntry('outcomes-providers', 1, 0, 0, 1),
    lensEntry('access-egress', 1, 0, 0, 1),
  ],
  unforecast_lenses: [],
  coverage: { files_in_diff: FIXTURE_FILES, files_with_verdicts: FIXTURE_FILES, not_reached: [] },
  tests: [
    { type: 'suites', command: 'run-suites.js', log: 'tests/suites-1/summary.json', pass: 27, fail: 0, read_from: 'summary.json', skipped: false,
      suites: [{ file: 'server/utils/invoiceLineItems.test.js', pass: 18, fail: 0 }, { file: 'server/routes/cancelLineItem.protected.test.js', pass: 9, fail: 0 }] },
    { type: 'smoke', command: 'testdb-smoke.js', log: 'tests/smoke-1/summary.json', pass: 812, fail: 0, read_from: 'summary.json', skipped: false,
      suites: Array.from({ length: 79 }, (_, i) => ({ file: `server/money/m${i}.test.js`, pass: 10 + (i % 3), fail: 0 })) },
  ],
  failing_test_on_old_code: null,
  not_a_fix: 'a feature',
  externals: { codex: { state: 'run' }, gemini: { state: 'run' } },
  verify: { run: true, findings: 1, raised: 1, confirmed: 1, fixed: 1, rejected: 0, passes: ['verify.md'] },
  escalated: [],
  timestamp: '2026-10-19T19:02:00.000Z',
  written_by: 'review skill',
};

test('the spec 3.7 example matches the block shape line for line', () => {
  assert.strictEqual(SPEC_BLOCK.length, SHAPE.length);
  SPEC_BLOCK.forEach((line, i) => assert.match(line, SHAPE[i]));
});

test('commitBlock renders a fixture receipt in the spec 3.7 shape, line for line', () => {
  const lines = commitBlock(FIXTURE).split('\n');
  assert.strictEqual(lines.length, SHAPE.length);
  lines.forEach((line, i) => assert.match(line, SHAPE[i]));
  assert.deepStrictEqual(lines, [
    'Review: tier A (sensitive: server/utils/invoiceLineItems.js, server/routes/proposals/*)',
    '  lenses:   money, lifecycle, concurrency, outcomes-providers, access-egress, seams; second opinion (codex, gemini); verify',
    '  files:    14/14 verdicts',
    '  findings: 11 raised, 3 confirmed, 3 fixed and re-reviewed, 8 rejected',
    '  tests:    money-smoke 79/79, server/utils/invoiceLineItems.test.js 18/18, server/routes/cancelLineItem.protected.test.js 9/9',
    '  receipt:  patch 3f2a9c1, reviewed against main 8c1c660, 2026-10-19 14:02',
  ]);
});

test('commitBlock: a quick fix, a not-run reviewer, allowed not reached, no tests and the latest run of a suite', () => {
  const r = {
    ...FIXTURE,
    kind: 'quick-fix',
    tier: 'B',
    matched_paths: [],
    content_rule_hits: [{ file: 'server/x.js', line: 3, text: 'never printed', rule: 'money-column' }],
    lenses: [lensEntry('seams', 0, 0, 0, 0)],
    externals: { codex: { state: 'not_run', reason: 'not required at tier B' }, gemini: { state: 'not_run', reason: 'not required at tier B' } },
    verify: { run: false, findings: 0, raised: 0, confirmed: 0, fixed: 0, rejected: 0, passes: [] },
    coverage: { files_in_diff: ['server/x.js', 'server/y.js'], files_with_verdicts: ['server/x.js'], not_reached: [{ lens: 'seams', file: 'server/y.js' }], allowed_not_reached: true },
    tests: [],
  };
  const lines = commitBlock(r).split('\n');
  lines.forEach((line, i) => assert.match(line, SHAPE[i]));
  assert.strictEqual(lines[0], 'Review: tier B (content rule: server/x.js)');
  assert.strictEqual(lines[1], '  lenses:   seams');
  assert.strictEqual(lines[2], '  files:    1/2 verdicts, 1 not reached (allowed)');
  assert.strictEqual(lines[4], '  tests:    none recorded');
  assert.match(lines[5], /^ {2}receipt: {2}tree 3f2a9c1,/);
  assert.ok(!commitBlock(r).includes('never printed'));

  const one = { ...FIXTURE, externals: { codex: { state: 'run' }, gemini: { state: 'not_run', reason: 'quota' } } };
  assert.match(commitBlock(one).split('\n')[1], /; second opinion \(codex; gemini not run\); verify$/);
  assert.ok(!commitBlock(one).includes('quota'));

  const rerun = { ...FIXTURE, tests: [
    { type: 'suites', log: 'tests/suites-1/summary.json', pass: 1, fail: 0, suites: [{ file: 'scripts/x.test.js', pass: 1, fail: 0 }] },
    { type: 'suites', log: 'tests/suites-2/summary.json', pass: 3, fail: 0, suites: [{ file: 'scripts/x.test.js', pass: 3, fail: 0 }] },
    { type: 'suites', log: 'tests/suites-3/summary.json', pass: 0, fail: 0, suites: [] },
    { type: 'log', log: 'tests/1-scripts-lib-receipt.test.js.ab12cd.log', name: 'scripts-lib-receipt.test.js', pass: 40, fail: 0 },
  ] };
  assert.strictEqual(commitBlock(rerun).split('\n')[4], '  tests:    scripts/x.test.js 3/3, no suites reached, scripts-lib-receipt.test.js 40/40');
});

test('commitBlock prints a placeholder for a missing timestamp, sha or count, and never throws', () => {
  const r = { ...FIXTURE, timestamp: undefined, reviewed_against: null, tests: [{ type: 'suites', suites: [{ file: 'server/x.test.js', pass: 3 }] }, { type: 'smoke', pass: 9 }, { type: 'log', name: 'y.test.js' }] };
  const lines = commitBlock(r).split('\n');
  assert.strictEqual(lines[4], '  tests:    money-smoke ?/?, server/x.test.js 3/?, y.test.js ?/?');
  assert.strictEqual(lines[5], '  receipt:  patch 3f2a9c1, reviewed against main (none), (no timestamp)');
  assert.match(commitBlock({ ...FIXTURE, timestamp: 'not a date' }).split('\n')[5], /, \(no timestamp\)$/);
  assert.doesNotThrow(() => commitBlock({ version: 1 }));
});

test('the tests line: the smoke counts suites green over run; suites by repo path, never deduped by basename; a named log by its suite; the latest build', () => {
  const tests = [
    { type: 'smoke', pass: 30, fail: 0, suites: [{ file: 'server/m1.test.js', pass: 10, fail: 0 }, { file: 'server/m2.test.js', pass: 20, fail: 0 }] },
    { type: 'suites', pass: 5, fail: 0, suites: [{ file: 'server/utils/x.test.js', pass: 2, fail: 0 }, { file: 'server/routes/x.test.js', pass: 3, fail: 0 }] },
    { type: 'log', name: 'scripts-lib-receipt.test.js', file: 'scripts/lib/receipt.test.js', pass: 7, fail: 0 },
    { type: 'build', ok: false, exit: 1 },
    { type: 'build', ok: true, exit: 0 },
  ];
  const line = commitBlock({ ...FIXTURE, tests }).split('\n')[4];
  assert.strictEqual(line, '  tests:    money-smoke 2/2, server/utils/x.test.js 2/2, server/routes/x.test.js 3/3, scripts/lib/receipt.test.js 7/7, client-build 1/1');
  assert.match(line, SHAPE[4]);
  assert.match(commitBlock({ ...FIXTURE, tests: [{ type: 'build', ok: false, exit: 2 }] }).split('\n')[4], /client-build 0\/1$/);
});

// ---- finalize after a post-review commit (drives the CLI) -------------------

function cli(repo, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, REVIEW_RECEIPT_ROOT: repo } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function ok(r) {
  assert.strictEqual(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r;
}

test('a post-review commit needs a re-pass of the files it changed; then finalize yields laneKey(base, newTip) and records the new tip', (t) => {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  commit(repo, 'lane', { 'a.js': A_JS.replace('line 3\n', 'line 3 changed\n'), 'b.js': 'b v2\n' });
  ok(cli(repo, ['init', '--branch', 'lane']));
  // position prints the seq every store passes through.
  const position = () => /^position (\d+) tip [0-9a-f]{7}$/m.exec(ok(cli(repo, ['position', 'lane'])).stdout)[1];
  let at = position();
  const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-reports-'));
  t.after(() => fs.rmSync(reports, { recursive: true, force: true }));
  const rep = (name, rows) => {
    const p = path.join(reports, name);
    fs.writeFileSync(p, report(rows));
    return p;
  };
  // a.js and b.js at the root are unclassified: tier hinge, whose floors are seams and access-egress.
  ok(cli(repo, ['verdicts', 'lane', '--position', at, 'seams', rep('seams.md', [['a.js', 'pass'], ['b.js', 'pass']])]));
  ok(cli(repo, ['verdicts', 'lane', '--position', at, 'access-egress', rep('access.md', [['a.js', 'pass'], ['b.js', 'pass']])]));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-suites-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ suites: [], total_pass: 0, total_fail: 0, skipped: false }));
  ok(cli(repo, ['tests', 'lane', '--position', at, '--suites', runDir]));
  const reviewedTip = git(repo, 'rev-parse', 'HEAD');
  // A fix committed after the review pass, before finalize: a.js changes again.
  const newTip = commit(repo, 'post-review fix', { 'a.js': A_JS.replace('line 3\n', 'line 3 changed again\n') });
  assert.notStrictEqual(newTip, reviewedTip);
  const select = path.join(repo, '.git', 'select.json');
  fs.writeFileSync(select, JSON.stringify({ tier: 'hinge', tiers_by_file: { 'a.js': 'hinge', 'b.js': 'hinge' } }));
  const fin = () => cli(repo, ['finalize', 'lane', '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', 'hinge', '--not-a-fix', 'a feature', '--select', select]);
  const stale = (r) => {
    assert.strictEqual(r.status, 1, r.stderr);
    return r.stderr.split('\n').filter((l) => /^ {2}- stale: /.test(l));
  };
  const first = stale(fin());
  assert.deepStrictEqual(first.map((l) => /stale: (\S+) read/.exec(l)[1]), ['access-egress', 'seams'], first.join('\n'));
  for (const l of first) {
    assert.match(l, /\ba\.js\b/);
    assert.doesNotMatch(l, /\bb\.js\b/, 'b.js did not change after its verdict');
  }
  // The re-passes read the new tip: a new snapshot first. A re-pass that does
  // not list a.js leaves it stale.
  at = position();
  ok(cli(repo, ['verdicts', 'lane', '--position', at, 'seams', rep('seams2.md', [['b.js', 'pass']]), '--pass', '1']));
  ok(cli(repo, ['verdicts', 'lane', '--position', at, 'access-egress', rep('access2.md', [['a.js', 'pass']]), '--pass', '1']));
  assert.deepStrictEqual(stale(fin()).map((l) => /stale: (\S+) read a\.js /.exec(l)[1]), ['seams']);
  ok(cli(repo, ['verdicts', 'lane', '--position', at, 'seams', rep('seams3.md', [['a.js', 'pass']]), '--pass', '2']));
  // The suites ran before the fix: they run again on the final tip.
  assert.ok(fin().stderr.includes(`tests: the suites entry tests/suites-1/summary.json ran at ${reviewedTip.slice(0, 7)}, the tip is ${newTip.slice(0, 7)}`));
  ok(cli(repo, ['tests', 'lane', '--position', at, '--suites', runDir]));
  ok(fin());
  const key = laneKey(base, newTip, { cwd: repo });
  const r = readReceipt(receiptDir(key, { cwd: repo }));
  assert.ok(r, 'the receipt sits under the key of the new tip');
  assert.strictEqual(r.key, key);
  assert.strictEqual(r.tip, newTip);
  assert.strictEqual(r.base, base);
  assert.ok(!fs.existsSync(workDir('lane', { cwd: repo })), 'the working directory moved');
});
