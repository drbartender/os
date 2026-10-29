'use strict';

// The end to end harness of the merge-lane.sh ship suites
// (scripts/merge-lane.ship.test.js and its siblings; plan 2026-10-28 step 5,
// lane merge-ship): a throwaway os under the temp dir with a local bare
// origin and the lanes in linked worktrees under its ../worktrees/, carrying
// its own copy of scripts/ (out of git through .git/info/exclude, but for the
// sensitive list, which main holds), so the locks, the markers, the receipts
// and the ship records are all its own; the flip marker written in its common
// dir unless flip is false; real receipts through the review-receipt CLI
// (scripts/lib/receiptTestkit.js); the sha gate and the watch as stubs named
// by DRB_SHIP_GATE_CMD and DRB_SHIP_WATCH_CMD, each recording its runs; HOME a
// temp dir. The copy holds no scripts/gen-docs.js unless genDocs is set: then
// a stand-in (GEN_DOCS) whose --generated-only always says the change is
// inside the generated sections and whose --staged appends one marked line to
// the index's README.md and stages it, as step 7's regeneration rewrites the
// docs. A suite sets TMPDIR to its own temp dir before its first case.
// Nothing here touches os, its origin or the dev database.

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const K = require('./receiptTestkit');
const SM = require('../sensitive-match');

const SCRIPTS = path.resolve(__dirname, '..');
const { git, commit } = K;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s7 = (sha) => sha.slice(0, 7);
const SUITE = ["'use strict';", "const test = require('node:test');", "const assert = require('node:assert');", "const fs = require('node:fs');",
  "test('the flag reads ok', () => assert.equal(fs.readFileSync('docs/flag.md', 'utf8').trim(), 'ok'));", ''].join('\n');

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const d of fs.readdirSync(from, { withFileTypes: true })) {
    if (d.isDirectory()) copyTree(path.join(from, d.name), path.join(to, d.name));
    else if (!d.name.endsWith('.test.js')) fs.copyFileSync(path.join(from, d.name), path.join(to, d.name));
  }
}

// A stub executable that reads its config from <path>.json.
function stub(h, name, body, cfg) {
  const p = path.join(h.root, 'stubs', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [`#!${process.execPath}`, "'use strict';", "const fs = require('fs');", "const path = require('path');",
    "const { execFileSync, spawnSync } = require('child_process');", "const cfg = JSON.parse(fs.readFileSync(__filename + '.json', 'utf8'));",
    'const wait = (f) => { for (let i = 0; i < 1200 && !fs.existsSync(f); i++) spawnSync("sleep", ["0.05"]); };', body, ''].join('\n'), { mode: 0o755 });
  fs.writeFileSync(`${p}.json`, JSON.stringify(cfg));
  return p;
}
const setCfg = (p, patch) => fs.writeFileSync(`${p}.json`, JSON.stringify({ ...JSON.parse(fs.readFileSync(`${p}.json`, 'utf8')), ...patch }));
const records = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// The sha gate: a passing version 2 sha receipt through the copy's shaGate.
// hold: the first run waits for the go file; advance: a second clone pushes
// to origin first (so the push is rejected).
const GATE = `
const sha = process.argv[3];
const cwd = process.cwd();
const out = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
fs.appendFileSync(cfg.record, JSON.stringify({ sha }) + '\\n');
if (cfg.hold && !fs.existsSync(cfg.held)) { fs.writeFileSync(cfg.held, ''); wait(cfg.go); }
if (cfg.advance) execFileSync('git', ['-C', cfg.advance, 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { stdio: 'ignore' });
const SG = require(path.join(cfg.scripts, 'lib', 'shaGate.js'));
const base = out('rev-parse', 'refs/remotes/origin/main');
const cls = SG.classifyRange(base, sha, { cwd });
const at = new Date().toISOString();
console.log(SG.writeShaReceipt({ version: 2, sha, tree: out('rev-parse', sha + '^{tree}'), base, files: cls.touches.files, gates_needed: cls.needed,
  gates_passed: cls.needed, nothing_to_run: cls.nothing_to_run, static_checks: null, node_modules: null, env_keys: [], stubbed: [], started_at: at, finished_at: at }, { cwd }));
`;

// The watch: its start line through the copy's shipLog, then records; hold:
// it waits until it sees the ship lock free, then for the go file.
const WATCH = `
const sha = process.argv[2];
require(path.join(cfg.scripts, 'lib', 'shipLog.js')).watchLine(sha, 'start', 'stub watch', { cwd: process.cwd() });
const lockPath = fs.realpathSync(cfg.lock);
const holds = fs.readdirSync('/proc/self/fd').some((n) => { try { return fs.readlinkSync('/proc/self/fd/' + n) === lockPath; } catch { return false; } });
const rec = (what, extra) => fs.appendFileSync(cfg.record, JSON.stringify({ sha, what, holds, ...extra }) + '\\n');
rec('started');
if (cfg.hold) {
  let free = false;
  for (let i = 0; i < 1200 && !free; i++) { free = spawnSync('flock', ['-n', cfg.lock, 'true']).status === 0; if (!free) spawnSync('sleep', ['0.05']); }
  rec('lock', { free });
  wait(cfg.go);
}
rec('done');
`;

// The gen-docs.js stand-in (header): a --readme <path> or --arch <path>
// render writes the index's doc, marked, to that path; a plain --staged
// render writes README.md and stages it.
const GEN_DOCS = `#!/usr/bin/env node
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--generated-only')) process.exit(0);
const MARK = '<!-- the generated sections, rendered -->\\n';
const at = (doc) => { try { const x = execFileSync('git', ['show', ':' + doc], { encoding: 'utf8' }); return x.endsWith(MARK) ? x : x + MARK; } catch { return null; } };
const to = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
if (to('--readme') || to('--arch')) {
  for (const [flag, doc] of [['--readme', 'README.md'], ['--arch', 'ARCHITECTURE.md']]) if (to(flag) && at(doc) !== null) fs.writeFileSync(to(flag), at(doc));
} else if (args.includes('--staged') && at('README.md') !== null) {
  fs.writeFileSync('README.md', at('README.md'));
  execFileSync('git', ['add', '--', 'README.md']);
}
`;

// A throwaway os on main, its seed (with `seed`'s files over the default
// ones) pushed to a bare origin, the flip marker written unless flip is false,
// the gen-docs.js stand-in in place when genDocs is set.
function makeOs(t, { flip = true, seed = {}, genDocs = false } = {}) {
  const root = K.tmpDir(t, 'ship');
  const repo = path.join(root, 'os');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(root, 'home'));
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', ['test', 'example.com'].join('@'));
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'commit.gpgsign', 'false');
  copyTree(SCRIPTS, path.join(repo, 'scripts'));
  if (genDocs) fs.writeFileSync(path.join(repo, 'scripts', 'gen-docs.js'), GEN_DOCS, { mode: 0o755 });
  else fs.rmSync(path.join(repo, 'scripts', 'gen-docs.js'));
  fs.symlinkSync(path.resolve(SCRIPTS, '..', 'node_modules'), path.join(repo, 'node_modules'));
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/scripts/*\n!/scripts/sensitive-paths.txt\n/node_modules\n');
  const h = { root, repo, origin, common: path.join(repo, '.git'), shell: path.join(repo, 'scripts', 'merge-lane.sh') };
  h.seed = commit(repo, 'seed', { 'README.md': 'readme\n', 'docs/notes.md': 'notes\n', 'docs/flag.md': 'ok\n', 'server/a.js': 'a v1\n', 'server/b.js': 'b v1\n',
    'server/a.test.js': SUITE, 'scripts/sensitive-paths.txt': fs.readFileSync(path.join(SCRIPTS, 'sensitive-paths.txt'), 'utf8'), ...seed });
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  if (flip) flipOn(h);
  const scripts = path.join(repo, 'scripts');
  h.rec = (name) => path.join(root, `${name}.jsonl`);
  h.lock = path.join(h.common, 'drb-ship.lock');
  h.gate = stub(h, 'gate', GATE, { scripts, record: h.rec('gate'), held: path.join(root, 'gate-held'), go: path.join(root, 'gate-go') });
  h.watch = stub(h, 'watch', WATCH, { scripts, record: h.rec('watch'), lock: h.lock, go: path.join(root, 'watch-go') });
  h.env = { ...process.env, HOME: path.join(root, 'home'), DRB_SHIP_ALLOW_STUBS: '1', DRB_SHIP_GATE_CMD: h.gate, DRB_SHIP_WATCH_CMD: h.watch, DRB_SHIP_FETCH_WINDOW_MS: '1500' };
  return h;
}

// The flip marker, written in the throwaway's common dir.
function flipOn(h) {
  fs.writeFileSync(path.join(h.common, 'drb-flip.json'), JSON.stringify({ sha: h.seed, pushed_at: new Date().toISOString(), written_by: 'test' }));
}

function lane(h, branch, files) {
  const wt = path.join(h.root, 'worktrees', branch);
  git(h.repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  return { wt, tip: commit(wt, `${branch} work`, files) };
}

let selects = 0;
function review(t, h, branch, tier = 'B') {
  K.ok(K.cli(h.repo, 'init', '--branch', branch));
  const base = git(h.repo, 'merge-base', 'main', branch);
  const files = git(h.repo, 'diff', '--name-only', base, branch).split('\n').filter((f) => f && f !== 'README.md' && f !== 'ARCHITECTURE.md');
  K.prepare(t, h.repo, branch, files, { tier });
  const select = path.join(h.common, `select-ship-${++selects}.json`);
  fs.writeFileSync(select, JSON.stringify({ tier, tiers_by_file: SM.tierFromGit({ base, tip: branch }, { cwd: h.repo }).tiersByFile }));
  const out = K.ok(K.cli(h.repo, 'finalize', branch, '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', tier, '--select', select, '--not-a-fix', 'a test lane')).stdout;
  return path.basename(/dir: (\S+)/.exec(out)[1]);
}

// A comment-only receipt for the lane: the proof through the copy's
// comment-only-proof.js, finalized with --kind comment-only (no lens, no
// select); reviewedAgainst defaults to the merge base. Returns the lane key.
function reviewCommentOnly(t, h, branch, { reviewedAgainst = null } = {}) {
  K.ok(K.cli(h.repo, 'init', '--branch', branch));
  const base = git(h.repo, 'merge-base', 'main', branch);
  const proof = path.join(K.tmpDir(t, 'proof'), 'proof.json');
  const r = spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'comment-only-proof.js'), '--base', base, '--tip', git(h.repo, 'rev-parse', branch), '--out', proof],
    { cwd: h.repo, encoding: 'utf8', env: { ...process.env, REVIEW_RECEIPT_ROOT: h.repo } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const out = K.ok(K.cli(h.repo, 'finalize', branch, '--kind', 'comment-only', '--base', base, '--reviewed-against', reviewedAgainst || base, '--tier', 'B', '--proof', proof)).stdout;
  return path.basename(/dir: (\S+)/.exec(out)[1]);
}

function ship(h, branch, flags = [], env = {}) {
  const r = spawnSync('bash', [h.shell, 'ship', branch, 'docs/plan.md', ...flags], { cwd: h.repo, env: { ...h.env, ...env }, encoding: 'utf8', timeout: 240000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}${r.stderr}` };
}

const logFile = (h, tip) => path.join(h.common, 'drb-ship', `${tip}.log`);
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const steps = (ls) => ls.map((l) => l.split(' ')[1]);
const textOf = (ls, step) => ls.filter((l) => l.split(' ')[1] === step).map((l) => l.split(' ').slice(2).join(' '));

// The detached run's result line, polled from its log.
async function settled(h, tip, ms = 180000) {
  for (const end = Date.now() + ms; ;) {
    const ls = lines(logFile(h, tip));
    const hit = ls.map((l) => /^\S+ result (\S+) (.*)$/.exec(l)).filter(Boolean).at(-1);
    if (hit) return { state: hit[1], text: hit[2], lines: ls };
    if (Date.now() > end) assert.fail(`no result in the log:\n${ls.join('\n')}\n${lines(path.join(h.common, 'drb-ship', `${tip}.stdio.log`)).join('\n')}`);
    await sleep(100);
  }
}

const head = (h) => git(h.repo, 'rev-parse', 'HEAD');
const originMain = (h) => git(h.origin, 'rev-parse', 'refs/heads/main');
const status = (h) => git(h.repo, 'status', '--porcelain');
const exists = (h, ref) => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: h.repo }).status === 0;
const patchKey = (h, sha) => execFileSync('git', ['patch-id', '--stable'], { cwd: h.repo, encoding: 'utf8',
  input: execFileSync('git', ['diff', `${sha}^`, sha, '--', '.', ':!README.md', ':!ARCHITECTURE.md'], { cwd: h.repo }) }).trim().split(/\s+/)[0];

function hookOnce(h, body) {
  const hook = path.join(h.common, 'hooks', 'pre-commit');
  fs.writeFileSync(hook, ['#!/usr/bin/env bash', '[ -e .git/hook-done ] && exit 0', ': > .git/hook-done', ...body, ''].join('\n'), { mode: 0o755 });
}

module.exports = { K, git, commit, sleep, s7, SUITE, stub, setCfg, records, makeOs, flipOn, lane, review, reviewCommentOnly, ship, logFile, lines, steps, textOf, settled, head, originMain, status, exists, patchKey, hookOnce };
