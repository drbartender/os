'use strict';

// push-gate — the receipt logic that decides whether the pre-push hook can skip
// an 8-minute re-run. The whole safety property lives here: skip ONLY when the
// exact bytes on disk were already gated AND the commit being pushed is the one
// those bytes belong to. A false yes ships code no gate ever saw.
//
// Nearly every case below is a regression test for a hole the 2026-08-14
// push-gate review (Claude fleet + codex + gemini) actually exploited in the
// first draft of this file, each one demonstrated shipping ungated code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkReceipt, treeFingerprint, parsePushedShas, neededGates,
  RECEIPT_VERSION, MAX_AGE_MS, MONEY_PATHS,
} = require('./push-gate');

const NOW = Date.parse('2026-08-14T12:00:00Z');
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const fresh = (over = {}) => ({
  version: RECEIPT_VERSION,
  fingerprint: 'abc123',
  head: HEAD,
  gates: ['money', 'client'],
  at: new Date(NOW - 60_000).toISOString(),
  ...over,
});
const ask = (receipt, over = {}) => checkReceipt(receipt, {
  fingerprint: 'abc123', head: HEAD, needed: ['money', 'client'], pushedShas: [HEAD], now: NOW, ...over,
});

// ── Accepts ──

test('accepts a fresh receipt for the same tree, same HEAD, pushing HEAD', () => {
  assert.equal(ask(fresh()), null);
});

test('accepts when the receipt covers MORE than this push needs', () => {
  assert.equal(ask(fresh(), { needed: ['client'] }), null);
});

test('accepts a nothing-to-run receipt when nothing is needed (docs-only push)', () => {
  assert.equal(ask(fresh({ gates: [] }), { needed: [] }), null);
});

test('accepts right up to the age boundary', () => {
  assert.equal(ask(fresh({ at: new Date(NOW - MAX_AGE_MS + 1000).toISOString() })), null);
});

// ── Refusals. Each is a case where saying yes ships ungated code ──

test('refuses when there is no receipt at all', () => {
  const why = ask(null);
  assert.match(why, /no receipt/);
  assert.match(why, /npm run gate/, 'must tell the human how to fix it');
});

test('refuses when the working tree changed since the gate ran', () => {
  assert.match(ask(fresh(), { fingerprint: 'different' }), /working tree changed/);
});

test('refuses when HEAD moved even if the fingerprint somehow matched', () => {
  assert.match(ask(fresh({ head: OTHER })), /HEAD moved/);
});

// THE finding the review ranked highest: this repo pushes `git push origin
// <sha>:main`, and both gates only ever test the WORKING TREE. A receipt earned
// by HEAD said yes to a completely different commit, shipping a money bug.
test('refuses when the sha being pushed is not HEAD', () => {
  const why = ask(fresh(), { pushedShas: [OTHER] });
  assert.match(why, /not HEAD/);
  assert.match(why, /working tree/, 'must say WHY: the gates cannot describe another commit');
});

test('refuses when ANY of several pushed shas is not HEAD', () => {
  assert.match(ask(fresh(), { pushedShas: [HEAD, OTHER] }), /not HEAD/);
});

test('refuses when the receipt does not cover a needed gate', () => {
  assert.match(ask(fresh({ gates: ['client'] })), /does not cover: money/);
});

test('refuses a receipt older than the max age', () => {
  assert.match(ask(fresh({ at: new Date(NOW - MAX_AGE_MS - 1000).toISOString() })), /receipt is \d+h old/);
});

test('refuses a FUTURE-dated receipt (clock skew or forgery must not read as fresh)', () => {
  assert.match(ask(fresh({ at: new Date(NOW + 86_400_000).toISOString() })), /dated in the future/);
});

test('refuses an unreadable timestamp rather than treating it as fresh', () => {
  assert.match(ask(fresh({ at: 'not-a-date' })), /timestamp is unreadable/);
});

// ── Which shas are being pushed (git feeds this on the hook's stdin) ──

const ZERO = '0'.repeat(40);
const SHA = 'e612a8d430c8ace52cbfde6d12bd92c814018223';
const SHA2 = '9acd6694bad2e9a31b9e361d4dc8ef1070c0a84d';

test('reads the local sha from a normal push line', () => {
  assert.deepEqual(parsePushedShas(`refs/heads/main ${SHA} refs/heads/main ${ZERO}`), { kind: 'shas', shas: [SHA] });
});

test('reads the literal-sha refspec form the push model uses', () => {
  assert.deepEqual(parsePushedShas(`${SHA} ${SHA} refs/heads/main ${SHA2}`), { kind: 'shas', shas: [SHA] });
});

// The review shipped a money bug through this: `git push origin docs main` fed
// two lines, the old code returned on the first, and main went ungated.
test('returns EVERY pushed sha, not just the first', () => {
  const input = `refs/heads/docs ${SHA2} refs/heads/docs ${ZERO}\nrefs/heads/main ${SHA} refs/heads/main ${ZERO}`;
  assert.deepEqual(parsePushedShas(input), { kind: 'shas', shas: [SHA2, SHA] });
});

test('a deletion-only push is nothing to gate', () => {
  assert.equal(parsePushedShas(`(delete) ${ZERO} refs/heads/stale ${SHA}`).kind, 'deletes');
});

test('skips the deleted ref but still gates the real one when both arrive', () => {
  const input = `(delete) ${ZERO} refs/heads/stale ${SHA}\nrefs/heads/main ${SHA} refs/heads/main ${ZERO}`;
  assert.deepEqual(parsePushedShas(input), { kind: 'shas', shas: [SHA] });
});

// A truncated line used to read as "deletions only" and skip every gate.
test('MALFORMED stdin is unknown, never deletes', () => {
  assert.equal(parsePushedShas('refs/heads/main').kind, 'unknown', 'a line with no sha field');
  assert.equal(parsePushedShas('refs/heads/main not-a-sha refs/heads/main x').kind, 'unknown', 'a non-hex sha');
  assert.equal(parsePushedShas(`refs/heads/main ${SHA} r x\ngarbage`).kind, 'unknown', 'one bad line poisons the batch');
});

// ── The fingerprint ──

test('treeFingerprint is stable across calls and reports HEAD', () => {
  const a = treeFingerprint();
  const b = treeFingerprint();
  assert.equal(a.fingerprint, b.fingerprint, 'same tree must hash the same twice');
  assert.match(a.head, /^[0-9a-f]{40}$/);
  assert.equal(a.fingerprint.length, 64);
  assert.equal(typeof a.dirty, 'boolean');
});

test('treeFingerprint hashes file CONTENT, not just the porcelain status line', () => {
  // The original bug: re-editing an already-modified file left the status text
  // identical, so the fingerprint never moved and the receipt stayed valid.
  const fs = require('fs');
  const tmp = `scratch-push-gate-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, 'first');
    const a = treeFingerprint().fingerprint;
    fs.writeFileSync(tmp, 'second'); // same path, same status letter, different bytes
    const b = treeFingerprint().fingerprint;
    assert.notEqual(a, b, 'changing the CONTENT of an untracked file must move the fingerprint');
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ── Gate selection ──

test('the money trigger covers the gate machinery itself, not just server/', () => {
  // Changing testdb-smoke.js or the suite list changes what the gate DOES, so
  // a pure server/ trigger would let the gate be edited without being run.
  // testdb-smoke.js loads tapSummary.js and flockExec.js at startup, so a
  // change to either alone changes what the gate does.
  for (const p of ['server/', 'scripts/money-smoke-list.txt', 'scripts/testdb-smoke.js', 'scripts/push-gate.js', 'scripts/lib/tapSummary.js', 'scripts/lib/flockExec.js']) {
    assert.ok(MONEY_PATHS.includes(p), `${p} must trigger the money gate`);
  }
});

test('the smoke and suite-runner machinery is on the sensitive list (full review)', () => {
  const { isSensitive } = require('./sensitive-match');
  for (const p of ['scripts/lib/tapSummary.js', 'scripts/lib/flockExec.js', 'scripts/run-suites.js']) {
    assert.ok(isSensitive([p]), `${p} must be sensitive-listed`);
  }
});

test('neededGates unions over multiple refs rather than taking the first', () => {
  // HEAD vs HEAD is empty; unioning with a ref that differs must still find work.
  const one = neededGates(['HEAD']).gates;
  const many = neededGates(['HEAD', 'HEAD~1']).gates;
  assert.ok(many.length >= one.length, 'a second ref can only add gates, never remove them');
});

// ── Residuals closed at the second review pass ──

test('an empty pushedShas list cannot satisfy the foreign-sha check by vacuity', () => {
  // Documents WHY verify must not call checkReceipt with [] on unknown stdin:
  // this passes, and that is exactly the hole.
  assert.equal(ask(fresh(), { pushedShas: [] }), null);
});

// ── The gate lock (the money gate resets a SHARED Neon branch) ──

test('EMPTY stdin is its own kind: nothing ships, so nothing to gate', () => {
  // git feeds no lines only when no ref is being updated. Blocking here would
  // fail a no-op push for nothing.
  for (const v of ['', '\n  \n']) assert.equal(parsePushedShas(v).kind, 'empty');
});

test('MALFORMED stdin stays unknown so the caller can BLOCK', () => {
  // Distinct from empty on purpose: we cannot tell what ships, and gating HEAD
  // then allowing would let a different commit through ungated.
  assert.equal(parsePushedShas('refs/heads/main').kind, 'unknown', 'no sha field');
  assert.equal(parsePushedShas('refs/heads/main not-a-sha r x').kind, 'unknown', 'non-hex sha');
  assert.equal(parsePushedShas(`refs/heads/main ${SHA} r x\ngarbage`).kind, 'unknown', 'one bad line poisons it');
  assert.equal(parsePushedShas(null).kind, 'unknown');
  assert.equal(parsePushedShas(undefined).kind, 'unknown');
});

test('the gate serializes with flock, not a hand-rolled pidfile', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'push-gate.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.match(code, /spawnSync\('flock'/, 'must re-exec under flock');
  assert.match(code, /'-n'/, 'must refuse rather than wait: waiting inside pre-push is the original bug');
  assert.match(code, /--git-common-dir/, 'the lock must span every worktree, they share one Neon branch');
  // The pidfile machinery must be gone: it leaked on every signal and its
  // stale-reclaim let two gates run at once.
  assert.doesNotMatch(code, /pidAlive|readHolder|acquireLock/, 'no hand-rolled lock may remain');
});

test('flock -n genuinely refuses a second holder (the property we rely on)', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const path = require('path');
  const lock = path.join(os.tmpdir(), `drb-gate-locktest-${process.pid}`);
  // Hold the lock in one process for a moment, and try to take it in another.
  const held = spawnSync('sh', ['-c', `flock -n ${lock} sh -c 'flock -n ${lock} true; echo inner=$?'`], { encoding: 'utf8' });
  assert.match(`${held.stdout}`, /inner=1/, 'a second flock -n on a held lock must fail');
  try { require('fs').unlinkSync(lock); } catch { /* fine */ }
});

// ---- Instruction rewrite step 3, lane gate-sha: verify in throwaway repos ----
//
// Checks 2 and 6 of the lane. Every case below runs in a throwaway repo under
// the temp dir (removed when the test ends) with a local bare origin, carrying
// its own copy of scripts/ kept out of git through .git/info/exclude, so the
// common dir, the locks, the receipts and the markers are all the
// throwaway's. The flip marker is <common dir>/drb-flip.json. Review receipts
// over a range are written through the copy's review-receipt CLI, the way
// scripts/lib/rangeCheck.test.js writes them (its helpers copied, not
// imported), and the sha receipt through the copy's shaGate.writeShaReceipt.

const gs = {
  cp: require('child_process'),
  fs: require('fs'),
  os: require('os'),
  path: require('path'),
};
const GS_SCRIPTS = __dirname;
const GS_MARK = 'STORED-ONLY-7f3a';
const GS_ENV = (() => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete env[k];
  }
  delete env.DRB_GATE_LOCKED;
  return env;
})();
const GS_ZERO = '0'.repeat(40);

function gsGit(cwd, ...args) {
  return gs.cp.execFileSync('git', args, { cwd, env: GS_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gsCommit(repo, message, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = gs.path.join(repo, rel);
    gs.fs.mkdirSync(gs.path.dirname(full), { recursive: true });
    gs.fs.writeFileSync(full, content);
  }
  gsGit(repo, 'add', '--', ...Object.keys(files));
  gsGit(repo, 'commit', '-q', '-m', message);
  return gsGit(repo, 'rev-parse', 'HEAD');
}

function gsRepo(t) {
  const root = gs.fs.mkdtempSync(gs.path.join(gs.os.tmpdir(), 'push-gate-verify-'));
  t.after(() => gs.fs.rmSync(root, { recursive: true, force: true }));
  const repo = gs.path.join(root, 'repo');
  const origin = gs.path.join(root, 'origin.git');
  gs.fs.mkdirSync(repo);
  gsGit(root, 'init', '-q', '--bare', '-b', 'main', origin);
  gsGit(repo, 'init', '-q', '-b', 'main');
  gsGit(repo, 'config', 'user.email', ['test', 'example.com'].join('@'));
  gsGit(repo, 'config', 'user.name', 'Test User');
  gsGit(repo, 'config', 'commit.gpgsign', 'false');
  const lib = gs.path.join(repo, 'scripts', 'lib');
  gs.fs.mkdirSync(lib, { recursive: true });
  for (const f of ['sensitive-match.js', 'review-receipt.js', 'push-gate.js']) gs.fs.copyFileSync(gs.path.join(GS_SCRIPTS, f), gs.path.join(repo, 'scripts', f));
  for (const f of gs.fs.readdirSync(gs.path.join(GS_SCRIPTS, 'lib'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) gs.fs.copyFileSync(gs.path.join(GS_SCRIPTS, 'lib', f), gs.path.join(lib, f));
  }
  gs.fs.writeFileSync(gs.path.join(repo, 'scripts', 'sensitive-paths.txt'), '# The throwaway list.\nserver/money.js\n');
  gs.fs.appendFileSync(gs.path.join(repo, '.git', 'info', 'exclude'), '/scripts/\n');
  const h = { root, repo, origin, lanes: 0 };
  h.seed = gsCommit(repo, 'seed', { 'README.md': 'readme\n', 'docs/notes.md': 'notes\n', 'server/a.js': 'a v1\n', 'server/b.js': 'b v1\n' });
  gsGit(repo, 'remote', 'add', 'origin', origin);
  gsGit(repo, 'push', '-q', 'origin', 'main');
  gsGit(repo, 'fetch', '-q', 'origin');
  h.common = gs.path.join(repo, '.git');
  h.lib = (name) => require(gs.path.join(repo, 'scripts', 'lib', name));
  return h;
}

function gsVerify(h, stdin, env = {}) {
  return gs.cp.spawnSync(process.execPath, [gs.path.join(h.repo, 'scripts', 'push-gate.js'), 'verify'], { cwd: h.repo, input: stdin, encoding: 'utf8', env: { ...GS_ENV, ...env } });
}

function gsFlip(h) {
  gs.fs.writeFileSync(gs.path.join(h.common, 'drb-flip.json'), JSON.stringify({ sha: h.seed, pushed_at: new Date().toISOString(), written_by: 'test' }));
}

const gsLine = (sha, remote = 'refs/heads/main', old = GS_ZERO) => `refs/heads/main ${sha} ${remote} ${old}\n`;

// The review-receipt CLI of the copy, as rangeCheck.test.js drives it.
function gsCli(h, ...args) {
  const r = gs.cp.spawnSync(process.execPath, [gs.path.join(h.repo, 'scripts', 'review-receipt.js'), ...args], { cwd: h.repo, encoding: 'utf8', env: { ...GS_ENV, REVIEW_RECEIPT_ROOT: h.repo } });
  assert.equal(r.status, 0, `review-receipt ${args[0]} exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r.stdout;
}

function gsScratch(h, name, text) {
  const dir = gs.path.join(h.root, 'scratch');
  gs.fs.mkdirSync(dir, { recursive: true });
  const p = gs.path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`);
  gs.fs.writeFileSync(p, text);
  return p;
}

function gsTap(pass) {
  return ['TAP version 13', `ok 1 - a test # ${GS_MARK}`, `1..${pass}`, `# tests ${pass}`, '# suites 0',
    `# pass ${pass}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 5', ''].join('\n');
}

function gsRunDir(h, suites) {
  const { smokeSummary } = h.lib('tapSummary.js');
  const dir = gs.fs.mkdtempSync(gs.path.join(h.root, 'run-'));
  const summary = smokeSummary(suites.map((s) => ({ file: s.file, text: s.text, exitOk: true })));
  for (const s of suites) {
    const entry = summary.suites.find((e) => e.file === s.file);
    gs.fs.writeFileSync(gs.path.join(dir, entry.log), s.text);
    gs.fs.writeFileSync(gs.path.join(dir, entry.out), `${GS_MARK}\n`);
  }
  gs.fs.writeFileSync(gs.path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return dir;
}

// A tier B lane commit off main, reviewed through the copy's CLI and
// finalized, then main fast-forwarded onto it (rangeCheck.test.js's landLane).
function gsLandLane(h, files) {
  const lane = `lane-${++h.lanes}`;
  const base = gsGit(h.repo, 'rev-parse', 'main');
  gsGit(h.repo, 'checkout', '-q', '-b', lane);
  const sha = gsCommit(h.repo, `${lane} work`, files);
  gsCli(h, 'init', '--branch', lane);
  const seq = /^position (\d+) /m.exec(gsCli(h, 'position', lane))[1];
  const rows = Object.keys(files).map((f) => `| ${f} | pass |  |`);
  const report = [`Read the brief. ${GS_MARK}`, '', '', '| file | verdict | note |', '|---|---|---|', ...rows, ''].join('\n');
  gsCli(h, 'verdicts', lane, 'seams', gsScratch(h, 'seams.md', report), '--position', seq);
  gsCli(h, 'tests', lane, '--suites', gsRunDir(h, [{ file: 'server/a.test.js', text: gsTap(4) }]), '--position', seq);
  const SM = require(gs.path.join(h.repo, 'scripts', 'sensitive-match.js'));
  const tiers = SM.tierFromGit({ base, tip: sha }, { cwd: h.repo });
  const select = gsScratch(h, 'select.json', JSON.stringify({ tier: 'B', tiers_by_file: tiers.tiersByFile }));
  gsCli(h, 'finalize', lane, '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', 'B', '--select', select, '--not-a-fix', 'a feature');
  gsGit(h.repo, 'checkout', '-q', 'main');
  gsGit(h.repo, 'merge', '-q', '--ff-only', lane);
  return sha;
}

// A sha receipt for `sha` against origin/main as it stands, through the copy.
function gsShaReceipt(h, sha, over = {}) {
  const SG = h.lib('shaGate.js');
  const base = gsGit(h.repo, 'rev-parse', 'refs/remotes/origin/main');
  const cls = SG.classifyRange(base, sha, { cwd: h.repo });
  const at = new Date().toISOString();
  return SG.writeShaReceipt({
    version: 2, sha, tree: gsGit(h.repo, 'rev-parse', `${sha}^{tree}`), base, files: cls.touches.files, gates_needed: cls.needed,
    gates_passed: cls.needed, nothing_to_run: cls.nothing_to_run, static_checks: cls.static ? { blocking: 0, file: null } : null,
    node_modules: cls.nothing_to_run ? null : 'linked', env_keys: cls.nothing_to_run ? [] : [...SG.GATE_ENV_KEYS], stubbed: [], started_at: at, finished_at: at, ...over,
  }, { cwd: h.repo });
}

// A reviewed server commit on main with a valid sha receipt, the flip present.
function gsReady(t) {
  const h = gsRepo(t);
  gsFlip(h);
  h.sha = gsLandLane(h, { 'server/a.js': 'a v2\n' });
  gsShaReceipt(h, h.sha);
  return h;
}

async function gsHoldLock(t, h) {
  const lock = gs.path.join(h.common, 'drb-push-gate.lock');
  const holder = gs.cp.spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  for (let i = 0; i < 100 && gs.cp.spawnSync('flock', ['-n', lock, 'true']).status === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(gs.cp.spawnSync('flock', ['-n', lock, 'true']).status, 1, 'the test must hold the gate lock');
  return holder;
}

// ---- check 2: no flip marker, today's path on every stdin shape ----

test('gate-sha check 2: with no flip marker, verify answers each stdin shape as today', (t) => {
  const h = gsRepo(t);
  const head = gsCommit(h.repo, 'docs', { 'docs/notes.md': 'notes v2\n' });
  const del = gsVerify(h, `(delete) ${GS_ZERO} refs/heads/stale ${head}\n`);
  assert.equal(del.status, 0);
  assert.match(del.stdout, /deletions only/);
  const empty = gsVerify(h, '');
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /git listed no updated refs/);
  const bad = gsVerify(h, 'refs/heads/main\n');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /could not read the refs being pushed/);
  const run = gs.cp.spawnSync(process.execPath, [gs.path.join(h.repo, 'scripts', 'push-gate.js'), 'run'], { cwd: h.repo, encoding: 'utf8', env: GS_ENV });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no gated paths changed/);
  const legacy = JSON.parse(gs.fs.readFileSync(gs.path.join(h.common, 'drb-push-gate-receipt.json'), 'utf8'));
  assert.deepEqual(Object.keys(legacy).sort(), ['at', 'fingerprint', 'gates', 'head', 'version']);
  assert.equal(legacy.version, RECEIPT_VERSION);
  assert.equal(legacy.head, head);
  assert.deepEqual(legacy.gates, []);
  // A gate marker stands, but before the flip the hook never reads it.
  gs.fs.mkdirSync(gs.path.join(h.common, 'drb-markers'), { recursive: true });
  gs.fs.writeFileSync(gs.path.join(h.common, 'drb-markers', 'gate.json'), JSON.stringify({ sha: head, at: new Date().toISOString(), reason: 'x', gates: ['money'] }));
  const ok = gsVerify(h, gsLine(head));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /gate receipt valid for this exact tree \(nothing to run\)/);
  const other = gsVerify(h, gsLine(h.seed));
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /running the full gate .*which is not HEAD/);
  assert.match(other.stdout, /WARNING/);
});

test('gate-sha check 2: with no flip marker, verify still takes the gate lock', async (t) => {
  const h = gsRepo(t);
  const head = gsCommit(h.repo, 'docs', { 'docs/notes.md': 'notes v2\n' });
  await gsHoldLock(t, h);
  const r = gsVerify(h, gsLine(head));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /another push gate is already running/);
});

// ---- check 6: the flip marker present ----

test('gate-sha check 6: a push to main with a valid sha receipt and review receipts passes with no lock taken', async (t) => {
  const h = gsReady(t);
  await gsHoldLock(t, h);
  const r = gsVerify(h, gsLine(h.sha, 'refs/heads/main', h.seed));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`pre-push: ${h.sha.slice(0, 7)}: the sha receipt and the review receipts over origin/main are valid`));
});

test('gate-sha check 6: a real git push runs the hook on the stdin git feeds', (t) => {
  const h = gsReady(t);
  const hook = gs.path.join(h.common, 'hooks', 'pre-push');
  gs.fs.mkdirSync(gs.path.dirname(hook), { recursive: true });
  gs.fs.writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${gs.path.join(h.repo, 'scripts', 'push-gate.js')}" verify\n`, { mode: 0o755 });
  const refused = gs.cp.spawnSync('git', ['push', 'origin', `${h.sha}:refs/heads/elsewhere`], { cwd: h.repo, env: GS_ENV, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /updates refs\/heads\/elsewhere/);
  const pushed = gs.cp.spawnSync('git', ['push', 'origin', `${h.sha}:main`], { cwd: h.repo, env: GS_ENV, encoding: 'utf8' });
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.match(pushed.stdout + pushed.stderr, /the sha receipt and the review receipts over origin\/main are valid/);
  assert.equal(gsGit(h.origin, 'rev-parse', 'refs/heads/main'), h.sha);
});

test('gate-sha check 6: a receipt written with stubs refuses, unless DRB_GATE_ALLOW_STUBBED=1', (t) => {
  const h = gsRepo(t);
  gsFlip(h);
  const sha = gsLandLane(h, { 'server/a.js': 'a v2\n' });
  gsShaReceipt(h, sha, { stubbed: ['smoke'] });
  const refused = gsVerify(h, gsLine(sha));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /written with stubs in place of smoke; a stubbed gate never vouches/);
  const allowed = gsVerify(h, gsLine(sha), { DRB_GATE_ALLOW_STUBBED: '1' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /DRB_GATE_ALLOW_STUBBED=1 is set/);
  assert.match(allowed.stdout, /are valid \(stubbed: smoke\); nothing runs here/);
});

test('gate-sha check 6: a push to another remote ref refuses, naming it and the escape', (t) => {
  const h = gsReady(t);
  const r = gsVerify(h, `${gsLine(h.sha)}${gsLine(h.sha, 'refs/heads/side')}`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /this push updates refs\/heads\/side/);
  assert.match(r.stderr, /git push --no-verify/);
});

test('gate-sha check 6: deletes, empty and malformed stdin answer as today', (t) => {
  const h = gsReady(t);
  assert.match(gsVerify(h, `(delete) ${GS_ZERO} refs/heads/stale ${h.sha}\n`).stdout, /deletions only/);
  assert.match(gsVerify(h, '').stdout, /git listed no updated refs/);
  const bad = gsVerify(h, `refs/heads/main ${h.sha}\n`);
  assert.equal(bad.status, 1, 'a line with no remote ref is malformed');
  assert.match(bad.stderr, /could not read the refs being pushed/);
});

test('gate-sha check 6: a standing gate marker refuses naming it', (t) => {
  const h = gsReady(t);
  const res = h.lib('markers.js').setGate({ sha: h.sha, reason: 'money smoke: 1 failing of 40 suite(s)', gates: ['money'], cwd: h.repo });
  assert.equal(res.written, true);
  const r = gsVerify(h, gsLine(h.sha));
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`BLOCKED: gate marker stands on ${h.sha.slice(0, 7)}`));
});

test('gate-sha check 6: a standing watch marker refuses with the ack line', (t) => {
  const h = gsReady(t);
  h.lib('markers.js').setWatch({ sha: h.seed, deploy_at: new Date().toISOString(), count: 3, by_issue: null, cwd: h.repo });
  const r = gsVerify(h, gsLine(h.sha));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BLOCKED: watch marker stands on .*npm run ship -- --ack-watch/);
});

test('gate-sha check 6: a missing sha receipt refuses with run npm run ship', (t) => {
  const h = gsRepo(t);
  gsFlip(h);
  const sha = gsLandLane(h, { 'server/a.js': 'a v2\n' });
  const r = gsVerify(h, gsLine(sha));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no sha receipt \(run: npm run ship\)/);
});

test('gate-sha check 6: a sha receipt whose base is stale refuses', (t) => {
  const h = gsRepo(t);
  gsFlip(h);
  const first = gsLandLane(h, { 'server/a.js': 'a v2\n' });
  const sha = gsLandLane(h, { 'server/b.js': 'b v2\n' });
  gsShaReceipt(h, sha, { base: first });
  const r = gsVerify(h, gsLine(sha));
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`gated against origin/main at ${first.slice(0, 7)}; origin/main is now ${h.seed.slice(0, 7)}`));
});

test('gate-sha check 6: a range commit with no review receipt refuses naming the sha', (t) => {
  const h = gsRepo(t);
  gsFlip(h);
  const reviewed = gsLandLane(h, { 'server/a.js': 'a v2\n' });
  const bare = gsCommit(h.repo, 'unreviewed', { 'server/b.js': 'b v2\n' });
  gsShaReceipt(h, bare);
  const r = gsVerify(h, gsLine(bare));
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`- ${bare.slice(0, 7)}: no review receipt`));
  assert.doesNotMatch(r.stderr, new RegExp(`- ${reviewed.slice(0, 7)}:`), 'the reviewed commit passes');
});

test('gate-sha check 6: an unreadable flip marker refuses and takes no lock', async (t) => {
  const h = gsRepo(t);
  gs.fs.writeFileSync(gs.path.join(h.common, 'drb-flip.json'), '{"sha": ');
  await gsHoldLock(t, h);
  const r = gsVerify(h, gsLine(h.seed));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BLOCKED: the flip marker .*drb-flip\.json is unreadable/);
  assert.doesNotMatch(r.stderr, /another push gate/);
});

test('gate-sha: parsePushedRefs carries the remote ref beside the sha', () => {
  const { parsePushedRefs } = require('./push-gate');
  assert.deepEqual(parsePushedRefs(`${SHA} ${SHA} refs/heads/main ${SHA2}\n(delete) ${ZERO} refs/heads/x ${SHA}`), [{ sha: SHA, remote: 'refs/heads/main' }]);
  assert.equal(parsePushedRefs(`refs/heads/main ${SHA}`), null);
  assert.equal(parsePushedRefs(null), null);
});

test('gate-sha: push-gate re-exports the sha gate helpers and its path lists from gatePaths', () => {
  const PG = require('./push-gate');
  const GP = require('./lib/gatePaths');
  assert.equal(PG.MONEY_PATHS, GP.MONEY_PATHS);
  assert.equal(PG.CLIENT_PATHS, GP.CLIENT_PATHS);
  for (const name of ['classifyRange', 'checkShaReceipt', 'gateEnvFile', 'gateWorktreePath']) assert.equal(typeof PG[name], 'function', name);
});
