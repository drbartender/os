'use strict';

// Tests for scripts/lib/gatePaths.js (instruction rewrite step 3, lane
// ship-state). Every git case runs in a throwaway repo under the temp dir,
// removed when the test ends.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const G = require('./gatePaths');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(repo, message, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(repo, 'add', '--', ...Object.keys(files));
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function makeRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatepaths-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const base = commit(repo, 'seed', {
    'docs/seed.md': 'seed\n',
    'server/app.js': 'app v1\n',
    'client/src/App.jsx': 'app v1\n',
    'package.json': '{}\n',
    'package-lock.json': '{}\n',
    'client/package.json': '{}\n',
    'client/package-lock.json': '{}\n',
  });
  return { repo, base };
}

const FALSE_FLAGS = { server: false, client: false, money: false, install: false, client_install: false, docs_only: false };
const flags = (t) => ({ server: t.server, client: t.client, money: t.money, install: t.install, client_install: t.client_install, docs_only: t.docs_only });

test('a server/ change two commits before the tip reports server and money over the range', (t) => {
  const r = makeRepo(t);
  const one = commit(r.repo, 'server', { 'server/app.js': 'app v2\n' });
  commit(r.repo, 'docs a', { 'docs/a.md': 'a\n' });
  const tip = commit(r.repo, 'docs b', { 'docs/b.md': 'b\n' });
  const range = G.touches(r.base, tip, { cwd: r.repo });
  assert.deepEqual(flags(range), { ...FALSE_FLAGS, server: true, money: true });
  assert.deepEqual([...range.files].sort(), ['docs/a.md', 'docs/b.md', 'server/app.js']);
  // The tip commit alone is docs only; the range is what the gate reads.
  assert.deepEqual(flags(G.touches(one, tip, { cwd: r.repo })), { ...FALSE_FLAGS, docs_only: true });
});

test('a root lock change reports install and money, not client_install', (t) => {
  const r = makeRepo(t);
  const tip = commit(r.repo, 'lock', { 'package-lock.json': '{"v":2}\n' });
  assert.deepEqual(flags(G.touches(r.base, tip, { cwd: r.repo })), { ...FALSE_FLAGS, install: true, money: true });
});

test('client/package.json reports client_install and client, not install or money', (t) => {
  const r = makeRepo(t);
  const tip = commit(r.repo, 'client deps', { 'client/package.json': '{"v":2}\n' });
  assert.deepEqual(flags(G.touches(r.base, tip, { cwd: r.repo })), { ...FALSE_FLAGS, client: true, client_install: true });
  const lock = commit(r.repo, 'client lock', { 'client/package-lock.json': '{"v":2}\n' });
  assert.equal(G.touches(tip, lock, { cwd: r.repo }).client_install, true);
});

test('a client/ source change reports client only', (t) => {
  const r = makeRepo(t);
  const tip = commit(r.repo, 'client', { 'client/src/App.jsx': 'app v2\n' });
  assert.deepEqual(flags(G.touches(r.base, tip, { cwd: r.repo })), { ...FALSE_FLAGS, client: true });
});

test('a range of docs only reports docs_only', (t) => {
  const r = makeRepo(t);
  commit(r.repo, 'plan', { 'docs/superpowers/plans/x.md': 'plan\n' });
  const tip = commit(r.repo, 'readme', { 'README.md': 'readme\n', 'ARCHITECTURE.md': 'arch\n' });
  const range = G.touches(r.base, tip, { cwd: r.repo });
  assert.deepEqual(flags(range), { ...FALSE_FLAGS, docs_only: true });
});

test('a listed sensitive doc is not docs_only', (t) => {
  const r = makeRepo(t);
  const list = path.join(r.repo, 'list.txt');
  fs.writeFileSync(list, '# a throwaway list\ndocs/listed-runbook.md\n');
  const listed = commit(r.repo, 'listed doc', { 'docs/listed-runbook.md': 'x\n' });
  assert.equal(G.touches(r.base, listed, { cwd: r.repo, listFile: list }).docs_only, false);
  const plain = commit(r.repo, 'plain doc', { 'docs/plain.md': 'x\n' });
  assert.equal(G.touches(listed, plain, { cwd: r.repo, listFile: list }).docs_only, true);
  // The real list beside sensitive-match.js lists this runbook.
  const runbook = commit(r.repo, 'runbook', { 'docs/runbooks/override-conversion.md': 'x\n' });
  assert.equal(G.touches(plain, runbook, { cwd: r.repo }).docs_only, false);
  // A hinge doc is never docs-only either.
  const laws = commit(r.repo, 'laws', { 'docs/money-laws.md': 'x\n' });
  assert.equal(G.touches(runbook, laws, { cwd: r.repo }).docs_only, false);
});

test('a file moved out of server/ still touches server/ (renames off)', (t) => {
  const r = makeRepo(t);
  git(r.repo, 'mv', 'server/app.js', 'docs/app.md');
  git(r.repo, 'commit', '-q', '-m', 'move');
  const tip = git(r.repo, 'rev-parse', 'HEAD');
  const range = G.touches(r.base, tip, { cwd: r.repo });
  assert.equal(range.server, true);
  assert.equal(range.money, true);
  assert.equal(range.docs_only, false);
});

test('an exact entry matches that path and what sits under it, never a longer name', () => {
  assert.equal(G.classifyFiles(['package.json.bak']).money, false);
  assert.equal(G.classifyFiles(['scripts/testdb-smoke.js.orig']).money, false);
  assert.equal(G.classifyFiles(['serverless/x.js']).server, false);
  assert.equal(G.classifyFiles(['scripts/testdb-smoke.js']).money, true);
  assert.equal(G.classifyFiles(['server/utils/x.js']).money, true);
  assert.equal(G.classifyFiles(['client/package.json']).money, false);
});

test('an empty range touches nothing and is not docs-only', (t) => {
  const r = makeRepo(t);
  const range = G.touches(r.base, r.base, { cwd: r.repo });
  assert.deepEqual(flags(range), FALSE_FLAGS);
  assert.deepEqual(range.files, []);
});

test('touches refuses a ref that is not a commit', (t) => {
  const r = makeRepo(t);
  assert.throws(() => G.touches('no-such-ref', r.base, { cwd: r.repo }), /not a commit/);
  assert.throws(() => G.touches(r.base, '--output=x', { cwd: r.repo }), /not a commit/);
});

test('every suite on the money smoke list sits under a MONEY_PATHS entry', () => {
  const list = fs.readFileSync(path.join(__dirname, '..', 'money-smoke-list.txt'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  assert.ok(list.length > 0, 'the smoke list has entries');
  const outside = list.filter((f) => !G.classifyFiles([f]).money);
  assert.deepEqual(outside, []);
  assert.ok(G.MONEY_PATHS.includes('scripts/override-conversion/'));
});

test('MONEY_PATHS holds push-gate.js list and the three new lib paths; CLIENT_PATHS matches', () => {
  for (const p of ['scripts/lib/worktreeLinks.js', 'scripts/lib/gatePaths.js', 'scripts/lib/rangeCheck.js']) {
    assert.ok(G.MONEY_PATHS.includes(p), `${p} is in MONEY_PATHS`);
  }
  const PG = require('../push-gate');
  for (const p of PG.MONEY_PATHS) assert.ok(G.MONEY_PATHS.includes(p), `push-gate's ${p} is kept`);
  assert.deepEqual([...G.CLIENT_PATHS], [...PG.CLIENT_PATHS]);
  assert.deepEqual([...G.INSTALL_PATHS], ['package.json', 'package-lock.json', 'client/package.json', 'client/package-lock.json']);
});
