'use strict';

// vercel-ignore.test.js: the suite for client/scripts/vercel-ignore.sh, the
// client project's Ignored Build Step on Vercel (plan 2026-10-28 step 5, lane
// vercel-ignore). Every case builds its own throwaway repo under os.tmpdir()
// with a client/ directory, runs the script from that client/ the way Vercel
// does, with VERCEL_GIT_PREVIOUS_SHA set (or absent) by hand, and asserts the
// exit status and the one stdout line. It never runs the script against a real
// repository, and each case removes its temp directories when it ends.
//
//   node --test scripts/vercel-ignore.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', 'client', 'scripts', 'vercel-ignore.sh');

// The setup's git runs with no GIT_* variable from the caller (a hook's GIT_DIR
// or GIT_INDEX_FILE would aim it at the real repo) and with no global or system
// config, so no user hook, signing or default fires inside a case.
const SETUP_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
SETUP_ENV.GIT_CONFIG_NOSYSTEM = '1';
SETUP_ENV.GIT_CONFIG_GLOBAL = '/dev/null';

// Run a setup git command in cwd, returning trimmed stdout.
function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: SETUP_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A fresh directory under os.tmpdir(), removed when the case ends.
function tmpDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vercel-ignore-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Write (a string) or delete (null) each repo-relative path, stage exactly
// those paths, commit, and return the new HEAD sha.
function commit(repo, changes, message) {
  for (const [rel, content] of Object.entries(changes)) {
    if (content === null) {
      git(repo, ['rm', '-q', '--', rel]);
      continue;
    }
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    git(repo, ['add', '--', rel]);
  }
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

// A throwaway repo with one seed commit (client/package.json, docs/seed.md), so
// client/ exists to run from. Returns {repo, client, seed}.
function makeRepo(t, label) {
  const repo = tmpDir(t, label);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'lane-test']);
  git(repo, ['config', 'user.email', 'lane-test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  const seed = commit(repo, { 'client/package.json': '{}\n', 'docs/seed.md': 'seed\n' }, 'seed');
  return { repo, client: path.join(repo, 'client'), seed };
}

// Run the script as Vercel does: from cwd, with PATH, HOME and the one variable
// (absent when sha is undefined). The ceiling at os.tmpdir() stops git's
// repository search there, so no case can ever walk up into a real repo.
function runIgnore(cwd, sha) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CEILING_DIRECTORIES: os.tmpdir() };
  if (sha !== undefined) env.VERCEL_GIT_PREVIOUS_SHA = sha;
  const res = spawnSync('bash', [SCRIPT], { cwd, env, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// The exit status and exactly one stdout line.
function expectLine(res, code, line) {
  assert.strictEqual(res.code, code, `exit (stdout ${JSON.stringify(res.stdout)}, stderr ${JSON.stringify(res.stderr)})`);
  assert.strictEqual(res.stdout, `${line}\n`);
}

const cancelLine = (sha, n) => `cancelled: docs-only since ${sha.slice(0, 7)}, ${n} files`;
const offList = (p) => `built: ${p} is not docs-only`;

test('1: a docs-only range over two commits cancels, naming 3 files', (t) => {
  const { repo, client, seed } = makeRepo(t, 'docs-only');
  commit(repo, { 'docs/a.md': 'a\n', 'README.md': 'readme\n' }, 'docs and readme');
  commit(repo, { 'ARCHITECTURE.md': 'arch\n' }, 'architecture');
  expectLine(runIgnore(client, seed), 0, cancelLine(seed, 3));
});

test('2: a mixed range builds, naming the client path', (t) => {
  const { repo, client, seed } = makeRepo(t, 'mixed');
  commit(repo, { 'docs/a.md': 'a\n', 'client/src/x.js': 'module.exports = 1;\n' }, 'mixed');
  expectLine(runIgnore(client, seed), 1, offList('client/src/x.js'));
});

test('3: docs/money-laws.md alone builds', (t) => {
  const { repo, client, seed } = makeRepo(t, 'money-laws');
  commit(repo, { 'docs/money-laws.md': 'laws\n' }, 'hinge doc');
  expectLine(runIgnore(client, seed), 1, offList('docs/money-laws.md'));
});

test('4: a file under docs/runbooks/ alone builds', (t) => {
  const { repo, client, seed } = makeRepo(t, 'runbooks');
  commit(repo, { 'docs/runbooks/r.md': 'runbook\n' }, 'hinge doc');
  expectLine(runIgnore(client, seed), 1, offList('docs/runbooks/r.md'));
});

test('5: the deployed range is judged, not the last commit: a client commit before a docs-only one builds', (t) => {
  const { repo, client, seed } = makeRepo(t, 'deployed-range');
  const clientCommit = commit(repo, { 'client/src/x.js': 'module.exports = 1;\n' }, 'client change');
  commit(repo, { 'docs/b.md': 'b\n' }, 'docs only');
  expectLine(runIgnore(client, seed), 1, offList('client/src/x.js'));
  // The same last commit judged from the commit before it alone would cancel.
  expectLine(runIgnore(client, clientCommit), 0, cancelLine(clientCommit, 1));
});

test('6: the variable empty builds', (t) => {
  const { repo, client } = makeRepo(t, 'empty-var');
  commit(repo, { 'docs/a.md': 'a\n' }, 'docs');
  expectLine(runIgnore(client, ''), 1, 'built: no previous deployment sha');
});

test('7: the variable unset builds', (t) => {
  const { repo, client } = makeRepo(t, 'unset-var');
  commit(repo, { 'docs/a.md': 'a\n' }, 'docs');
  expectLine(runIgnore(client, undefined), 1, 'built: no previous deployment sha');
});

test('8: a previous sha outside a depth-10 clone builds; the clone boundary commit still judges', (t) => {
  const origin = tmpDir(t, 'origin');
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.name', 'lane-test']);
  git(origin, ['config', 'user.email', 'lane-test']);
  git(origin, ['config', 'commit.gpgsign', 'false']);
  const shas = [commit(origin, { 'client/package.json': '{}\n', 'docs/seed.md': 'seed\n' }, 'c1')];
  shas.push(commit(origin, { 'client/src/x.js': 'module.exports = 1;\n' }, 'c2'));
  for (let i = 3; i <= 12; i += 1) shas.push(commit(origin, { [`docs/n${i}.md`]: `${i}\n` }, `c${i}`));

  const clone = path.join(tmpDir(t, 'clone'), 'repo');
  git(os.tmpdir(), ['clone', '-q', '--depth=10', `file://${origin}`, clone]);
  assert.strictEqual(git(clone, ['rev-parse', '--is-shallow-repository']), 'true');
  const held = (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: clone, env: SETUP_ENV }).status === 0;
  assert.deepStrictEqual(shas.map(held), [false, false, true, true, true, true, true, true, true, true, true, true]);

  const client = path.join(clone, 'client');
  expectLine(runIgnore(client, shas[0]), 1, 'built: previous sha not in the clone');
  expectLine(runIgnore(client, shas[1]), 1, 'built: previous sha not in the clone');
  // The oldest commit the clone holds (its shallow boundary) diffs fine.
  expectLine(runIgnore(client, shas[2]), 0, cancelLine(shas[2], 9));
});

test('9: the previous sha equal to HEAD builds (a redeploy)', (t) => {
  const { repo, client } = makeRepo(t, 'redeploy');
  const head = commit(repo, { 'docs/a.md': 'a\n' }, 'docs');
  expectLine(runIgnore(client, head), 1, 'built: no change since the previous deployment (a redeploy)');
});

test('10: a lookalike of an allowlist entry builds (docsx/, client/docs/, src/README.md)', (t) => {
  for (const p of ['docsx/f.md', 'client/docs/x.md', 'src/README.md']) {
    const { repo, client, seed } = makeRepo(t, 'lookalike');
    commit(repo, { [p]: 'x\n' }, 'lookalike');
    expectLine(runIgnore(client, seed), 1, offList(p));
  }
});

test('11: a rename from client/ into docs/ builds, naming its deletion', (t) => {
  const { repo, client } = makeRepo(t, 'rename');
  const before = commit(repo, { 'client/src/old.js': 'module.exports = 1;\n' }, 'client file');
  git(repo, ['mv', 'client/src/old.js', 'docs/new.md']);
  git(repo, ['commit', '-q', '-m', 'move into docs']);
  // With rename detection on, git would print only the docs path.
  assert.strictEqual(git(repo, ['diff', '--name-only', '-M', before, 'HEAD']), 'docs/new.md');
  expectLine(runIgnore(client, before), 1, offList('client/src/old.js'));
});

test('12: a deleted doc alone cancels', (t) => {
  const { repo, client, seed } = makeRepo(t, 'deleted-doc');
  commit(repo, { 'docs/seed.md': null }, 'delete a doc');
  expectLine(runIgnore(client, seed), 0, cancelLine(seed, 1));
});

test('13: run from a directory inside no git repository builds, git diff failed', (t) => {
  const dir = tmpDir(t, 'no-repo');
  // The diff is never started there: outside a repository git diff turns into
  // --no-index and would compare two files named by its arguments.
  expectLine(runIgnore(dir, 'f'.repeat(40)), 1, 'built: git diff failed (no repository)');
});

test('14: a docs path with a space in its name is one path and cancels', (t) => {
  const { repo, client, seed } = makeRepo(t, 'space');
  commit(repo, { 'docs/a file.md': 'a\n' }, 'spaced doc');
  expectLine(runIgnore(client, seed), 0, cancelLine(seed, 1));
});

test('15: a non-ASCII docs path prints raw and cancels', (t) => {
  const { repo, client, seed } = makeRepo(t, 'non-ascii');
  commit(repo, { 'docs/café.md': 'a\n' }, 'accented doc');
  expectLine(runIgnore(client, seed), 0, cancelLine(seed, 1));
});

test('16: a path git still quotes opens with a quote and builds', (t) => {
  const { repo, client, seed } = makeRepo(t, 'quoted');
  commit(repo, { 'docs/a"b.md': 'a\n' }, 'quoted doc');
  expectLine(runIgnore(client, seed), 1, offList('"docs/a\\"b.md"'));
});

test('17: diff.relative in the repo config cannot shorten client/docs/x.md into docs/x.md', (t) => {
  const { repo, client, seed } = makeRepo(t, 'relative');
  git(repo, ['config', 'diff.relative', 'true']);
  commit(repo, { 'client/docs/x.md': 'x\n' }, 'client doc');
  expectLine(runIgnore(client, seed), 1, offList('client/docs/x.md'));
});

test('18: a value that is no commit sha builds: a tree id, an option-shaped value, a garbage word, revision syntax', (t) => {
  const { repo, client, seed } = makeRepo(t, 'not-commit');
  commit(repo, { 'docs/a.md': 'a\n' }, 'docs');
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
  const leak = path.join(tmpDir(t, 'leak'), 'out');
  // HEAD~1 and :/seed both name the seed commit to git; only the hex check
  // refuses them, so the diff only ever reads a sha.
  assert.strictEqual(git(repo, ['rev-parse', 'HEAD~1']), seed);
  assert.strictEqual(git(repo, ['rev-parse', ':/seed']), seed);
  for (const value of [tree, `--output=${leak}`, 'no-such-ref', 'HEAD~1', ':/seed']) {
    expectLine(runIgnore(client, value), 1, 'built: previous sha not in the clone');
  }
  assert.strictEqual(fs.existsSync(leak), false);
});
