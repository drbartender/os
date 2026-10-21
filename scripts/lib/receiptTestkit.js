'use strict';

// The shared fixtures of the review-receipt CLI suites (instruction rewrite
// step 2, lane receipt-lib): throwaway repos under the temp dir, the CLI run
// against them through REVIEW_RECEIPT_ROOT, lens reports, TAP logs, runner
// directories and select.json files. Requiring it scrubs the git variables a
// hook would set and keeps the user's git config out, so a suite proves the
// receipt pins its own flags. Nothing here touches the dev database.

const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { smokeSummary } = require('./tapSummary');
const { tierFromGit } = require('../sensitive-match');

const CLI = path.join(__dirname, '..', 'review-receipt.js');
const FLOORS = {
  A: ['money', 'lifecycle', 'concurrency', 'outcomes-providers', 'access-egress', 'seams'],
  hinge: ['seams', 'access-egress'],
  B: ['seams'],
  C: ['client', 'seams'],
  docs: [],
};
// A string that stands for anything a lens or a log could say: it may be
// stored, never printed.
const MARK = 'STORED-ONLY-7f3a';

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

// Rebases the checked-out branch onto `onto`; each conflict is resolved by
// `resolve(paths)`, which writes the files, until the rebase ends.
function rebase(repo, onto, resolve = () => assert.fail('the rebase conflicted')) {
  const env = { ...process.env, GIT_EDITOR: 'true' };
  let r = spawnSync('git', ['rebase', '-q', onto], { cwd: repo, env, encoding: 'utf8' });
  while (r.status !== 0) {
    const conflicted = git(repo, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
    assert.ok(conflicted.length > 0, `rebase failed with no conflict: ${r.stderr}`);
    resolve(conflicted);
    git(repo, 'add', '--', ...conflicted);
    r = spawnSync('git', ['rebase', '--continue'], { cwd: repo, env, encoding: 'utf8' });
  }
  return git(repo, 'rev-parse', 'HEAD');
}

function tmpDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `review-receipt-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(t) {
  const dir = tmpDir(t, 'repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, 'seed', { 'README.md': 'readme\n', 'server/a.js': 'a v1\n', 'server/b.js': 'b v1\n' });
  return dir;
}

// A repo with branch `lane` checked out, one commit ahead of main.
function laneRepo(t, files = { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n' }) {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'main');
  git(repo, 'checkout', '-q', '-b', 'lane');
  const tip = commit(repo, 'lane', files);
  return { repo, base, tip, files: Object.keys(files).sort() };
}

function cli(repo, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, REVIEW_RECEIPT_ROOT: repo } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
}

function ok(r) {
  assert.strictEqual(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r;
}

function refused(r, status = 1) {
  assert.strictEqual(r.status, status, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r;
}

// The problem lines of a refused finalize.
function problems(r) {
  const m = /finalize refused: (\d+) problem/.exec(r.stderr);
  assert.ok(m, `no refusal header in: ${r.stderr}`);
  const lines = r.stderr.split('\n').filter((l) => l.startsWith('  - '));
  assert.strictEqual(lines.length, Number(m[1]));
  return lines;
}

function report(rows, findings = []) {
  return [
    `Read the brief. ${MARK}`,
    '',
    ...findings,
    '',
    '| file | verdict | note |',
    '|---|---|---|',
    ...rows.map(([f, v, n = '']) => `| ${f} | ${v} | ${n} |`),
    '',
  ].join('\n');
}

function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function tap(pass, fail = 0) {
  return [
    'TAP version 13',
    `# ${MARK} something the suite printed`,
    `ok 1 - a test # ${MARK}`,
    `1..${pass + fail}`,
    `# tests ${pass + fail}`,
    '# suites 0',
    `# pass ${pass}`,
    `# fail ${fail}`,
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 5',
    '',
  ].join('\n');
}

// A runner directory in the shape run-suites and testdb-smoke write.
function runDir(t, suites, extra = {}) {
  const dir = tmpDir(t, 'run');
  const summary = { ...smokeSummary(suites.map((s) => ({ file: s.file, text: s.text, exitOk: s.exitOk !== false }))), ...extra };
  for (const s of suites) {
    const entry = summary.suites.find((e) => e.file === s.file);
    fs.writeFileSync(path.join(dir, entry.log), s.text);
    fs.writeFileSync(path.join(dir, entry.out), `${MARK}\n`);
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return dir;
}

function suitesRun(t) {
  return runDir(t, [{ file: 'server/a.test.js', text: tap(4) }]);
}

function smokeRun(t) {
  return runDir(t, [{ file: 'server/m1.test.js', text: tap(10) }, { file: 'server/m2.test.js', text: tap(5) }]);
}

// Runs position (with `extra`, e.g. --overlap <sha>) and returns the seq it
// printed (`position <seq> tip <sha7>`), which every store then passes as
// --position, the way the skill passes it through.
function position(repo, name, ...extra) {
  const r = ok(cli(repo, 'position', name, ...extra));
  const m = /^position (\d+) tip [0-9a-f]{7}$/m.exec(r.stdout);
  assert.ok(m, `no position line in: ${r.stdout}`);
  return m[1];
}

// A position snapshot, a passing report from each lens, and the runs `tier`
// needs (after init) -> {dir (the reports), at (the snapshot's seq)}.
function prepare(t, repo, name, files, { tier = 'B', lenses = FLOORS[tier], tests = true } = {}) {
  const at = position(repo, name);
  const dir = tmpDir(t, 'reports');
  for (const lens of lenses) {
    ok(cli(repo, 'verdicts', name, lens, writeFile(dir, `${lens}.md`, report(files.map((f) => [f, 'pass']))), '--position', at));
  }
  if (tests && ['A', 'B', 'hinge'].includes(tier)) ok(cli(repo, 'tests', name, '--suites', suitesRun(t), '--position', at));
  if (tests && tier === 'A') ok(cli(repo, 'tests', name, '--smoke', smokeRun(t), '--position', at));
  if (tier === 'A') {
    ok(cli(repo, 'verify', name, writeFile(dir, 'verify.md', `No findings.\nChecked the lane. ${MARK}\n`), '--position', at));
    ok(cli(repo, 'externals', name, 'codex=run', `gemini=not_run:quota ${MARK}`));
  }
  return { dir, at };
}

// The per-file tiers of the diff under review, as review-select computes them
// (sensitive-match's tierFromGit): what is staged (a quick fix), else the lane
// branch against its merge-base with main, else HEAD's own commit (a commit
// review). README.md is named like any file.
function diffTiers(repo) {
  if (git(repo, 'diff', '--cached', '--name-only')) return tierFromGit({ staged: true }, { cwd: repo }).tiersByFile;
  try {
    git(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/lane');
  } catch {
    return tierFromGit({ base: 'HEAD^', tip: 'HEAD' }, { cwd: repo }).tiersByFile;
  }
  return tierFromGit({ base: git(repo, 'merge-base', 'main', 'lane'), tip: 'lane' }, { cwd: repo }).tiersByFile;
}

// A select.json in review-select.js's shape, kept inside the throwaway repo's
// git dir (removed with the repo, never part of a diff): its tier is `tier`,
// and tiers_by_file the per-file tiers the diff computes to unless `extra`
// names it.
let selectCount = 0;
function selectFile(repo, tier, extra = {}) {
  const p = path.join(repo, '.git', `select-${++selectCount}.json`);
  fs.writeFileSync(p, JSON.stringify({ tier, tiers_by_file: diffTiers(repo), ...extra }));
  return p;
}

function finalize(repo, name, base, tier, ...extra) {
  const select = extra.includes('--select') ? [] : ['--select', selectFile(repo, tier)];
  return cli(repo, 'finalize', name, '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', tier, ...select, ...extra);
}

module.exports = {
  git, commit, rebase, tmpDir, makeRepo, laneRepo, cli, ok, refused, problems, report, writeFile, tap, runDir, suitesRun, smokeRun, position, prepare, selectFile, finalize, MARK, FLOORS,
};
