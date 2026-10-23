'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseWorktrees,
  evaluateLane,
  safeScrapCheck,
  STALE_MAIN_ADVANCE,
} = require('./lane-status');

// Run git in `cwd`, returning trimmed stdout.
function git(cwd, args, env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

// Commit a file with a fixed author/committer date so age-based assertions are
// deterministic. `date` is an ISO-ish git date string.
function commitAt(cwd, relPath, content, message, date) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  git(cwd, ['add', '--', relPath]);
  const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : null;
  git(cwd, ['commit', '-q', '-m', message], env);
}

// Build a fresh repo under /tmp with one seed commit on main. Returns its root.
function makeRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lane-status-${label}-`));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

// Create a branch `lane` off main HEAD. We model a lane as a branch in the same
// repo (evaluateLane / safeScrapCheck take a {branch, path} record and an
// explicit cwd, so we do not need a separate worktree checkout to test the
// staleness + scrap logic).
function cutLane(repo, branch) {
  git(repo, ['branch', branch, 'main']);
  return { branch, path: repo };
}

test('parseWorktrees parses path + branch and detached', () => {
  const porcelain = [
    'worktree /a/os',
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    'worktree /a/lane',
    'HEAD bbb',
    'branch refs/heads/feature',
    '',
    'worktree /a/det',
    'HEAD ccc',
    'detached',
    '',
  ].join('\n');
  const parsed = parseWorktrees(porcelain);
  assert.strictEqual(parsed.length, 3);
  assert.deepStrictEqual(parsed[0], { path: '/a/os', branch: 'main' });
  assert.deepStrictEqual(parsed[1], { path: '/a/lane', branch: 'feature' });
  assert.strictEqual(parsed[2].branch, null);
});

test('a lane is flagged stale when main advances 15+ commits since cut', () => {
  const repo = makeRepo('advance');
  const lane = cutLane(repo, 'lane');
  // Advance main by STALE_MAIN_ADVANCE commits AFTER the lane was cut.
  for (let i = 0; i < STALE_MAIN_ADVANCE; i++) {
    commitAt(repo, `main-file-${i}.txt`, `m${i}\n`, `main ${i}`);
  }
  const evald = evaluateLane(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(evald.stale, true, 'lane should be stale');
  assert.strictEqual(evald.mainAdvance, STALE_MAIN_ADVANCE);
  assert.ok(
    evald.reasons.some((r) => r.includes('main advanced')),
    'reason should cite main advance'
  );
});

test('a lane is flagged stale by age (no commit in over 48h)', () => {
  const repo = makeRepo('age');
  // Commit on the lane branch with an old date, so its newest commit is stale.
  git(repo, ['checkout', '-q', '-b', 'lane']);
  commitAt(repo, 'lane.txt', 'old\n', 'old lane commit', '2020-01-01T00:00:00');
  git(repo, ['checkout', '-q', 'main']);
  const lane = { branch: 'lane', path: repo };
  const evald = evaluateLane(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(evald.stale, true);
  assert.ok(evald.reasons.some((r) => r.includes('over 48h')));
});

test('a fresh lane (recent commit, main barely moved) is NOT stale', () => {
  const repo = makeRepo('fresh');
  git(repo, ['checkout', '-q', '-b', 'lane']);
  commitAt(repo, 'lane.txt', 'new\n', 'recent lane commit');
  git(repo, ['checkout', '-q', 'main']);
  // Main advances only a couple of cosmetic commits, no sensitive path.
  commitAt(repo, 'docs/notes-1.md', 'a\n', 'main note 1');
  commitAt(repo, 'docs/notes-2.md', 'b\n', 'main note 2');
  const lane = { branch: 'lane', path: repo };
  const evald = evaluateLane(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(evald.stale, false, `unexpected reasons: ${evald.reasons.join('; ')}`);
});

test('a lane is flagged stale when a sensitive path lands on main since cut', () => {
  const repo = makeRepo('sensitive');
  const lane = cutLane(repo, 'lane');
  // A sensitive file (matches the repo sensitive-paths.txt) lands on main.
  commitAt(
    repo,
    'server/utils/pricingEngine.js',
    'module.exports = {};\n',
    'pricing change on main'
  );
  const evald = evaluateLane(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(evald.sensitiveLanded, true);
  assert.strictEqual(evald.stale, true);
  assert.ok(evald.reasons.some((r) => r.includes('sensitive')));
});

test('safe-scrap REFUSES a lane with unmerged commits (git log main..lane non-empty)', () => {
  const repo = makeRepo('unmerged');
  git(repo, ['checkout', '-q', '-b', 'lane']);
  commitAt(repo, 'lane-work.txt', 'wip\n', 'distinct lane work');
  git(repo, ['checkout', '-q', 'main']);
  const lane = { branch: 'lane', path: repo };
  const res = safeScrapCheck(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(res.safe, false);
  assert.strictEqual(res.unmergedCount, 1);
  assert.strictEqual(res.command, null, 'must not emit a branch-delete command');
  assert.ok(res.message.includes('Dallas must approve'));
});

test('safe-scrap PASSES a fully-merged lane (git log main..lane empty) and uses -d not -D', () => {
  const repo = makeRepo('merged');
  // Lane points at main HEAD with no distinct commits: fully merged.
  const lane = cutLane(repo, 'lane');
  const res = safeScrapCheck(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(res.safe, true);
  assert.strictEqual(res.unmergedCount, 0);
  assert.strictEqual(res.command, 'git branch -d lane');
  assert.ok(!/-D/.test(res.command), 'must never use the force -D delete');
});

// ---- the markers, the ship record and --session-start (step 3, lane
// session-status). Every case below runs in a throwaway repo under the OS temp
// dir, removed when the test ends; records go through shipLog and markers'
// own writers, and a hand edit appears only where the library refuses the
// state, named at the edit.

const LS = require('./lane-status');
const L = require('./lib/shipLog');
const M = require('./lib/markers');

const SCRIPT = path.join(__dirname, 'lane-status.js');
const MIN = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function shipRepo(t, label) {
  const repo = makeRepo(label);
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ['config', 'commit.gpgsign', 'false']);
  commitAt(repo, 'server/a.js', 'a\n', 'work');
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const common = path.join(repo, '.git');
  return { repo, sha, sha7: sha.slice(0, 7), dir: path.join(common, 'drb-ship'), markers: path.join(common, 'drb-markers'), common };
}

// A pid no process holds: a child that ran and exited.
function deadPid() {
  for (;;) {
    const pid = spawnSync(process.execPath, ['-e', '0']).pid;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') return pid;
    }
  }
}

// The library refuses watch_started_at outside claimWatch, so a stale claim is
// written by hand.
function editManifest(r, patch) {
  const file = path.join(r.dir, `${r.sha}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }));
}

// A ship that pushed and settled ok: the push stamps, the claim, the result.
function settledOk(r) {
  L.open(r.sha, { cwd: r.repo });
  L.setManifest(r.sha, { pid: deadPid(), push_started_at: ago(10 * MIN), pushed_at: ago(9 * MIN) }, { cwd: r.repo });
  assert.equal(L.claimWatch(r.sha, { cwd: r.repo }), 'claimed');
  L.setResult(r.sha, 'ok', 'pushed', { cwd: r.repo });
  return L.readManifest(r.sha, { cwd: r.repo });
}

function runSessionStart(cwd, script = SCRIPT) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [script, '--session-start'], { cwd, encoding: 'utf8' });
  return { ...res, ms: Date.now() - t0, lines: res.stdout.split('\n').filter(Boolean) };
}

test('markersReport with no marker files prints the absent flip line and no marker line', (t) => {
  const r = shipRepo(t, 'mk-none');
  assert.deepStrictEqual(LS.markersReport({ cwd: r.repo }), ['flip marker: absent, pushes are cue-only through npm run gate']);
});

test('markersReport with both markers prints both lines, before-flip wording while the flip is absent', (t) => {
  const r = shipRepo(t, 'mk-both');
  assert.equal(M.setGate({ sha: r.sha, reason: 'money smoke failed', gates: ['smoke'], cwd: r.repo }).written, true);
  M.setWatch({ sha: r.sha, deploy_at: ago(5 * MIN), count: 3, cwd: r.repo });
  const lines = LS.markersReport({ cwd: r.repo });
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'flip marker: absent, pushes are cue-only through npm run gate');
  assert.ok(lines[1].startsWith(`gate marker stands on ${r.sha7} (money smoke failed)`), lines[1]);
  assert.ok(lines[2].startsWith(`watch marker stands on ${r.sha7} (3 events since deploy)`), lines[2]);
  assert.ok(lines.every((l) => !l.startsWith('BLOCKED')), 'nothing binds before the flip');
});

test('markersReport with an unreadable marker file prints the unreadable marker line', (t) => {
  const r = shipRepo(t, 'mk-torn');
  fs.mkdirSync(r.markers, { recursive: true });
  fs.writeFileSync(path.join(r.markers, 'gate.json'), 'not json');
  const lines = LS.markersReport({ cwd: r.repo });
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes(`unreadable marker ${path.join(r.markers, 'gate.json')}`), lines[1]);
});

test('markersReport reads the flip through flipState: a present flip by sha7 and date, an unreadable one by standing().flip', (t) => {
  const r = shipRepo(t, 'mk-flip');
  // markers only reads the flip file (step 5 writes it), so it is written by hand.
  const flipFile = path.join(r.common, 'drb-flip.json');
  fs.writeFileSync(flipFile, JSON.stringify({ sha: r.sha, pushed_at: '2026-10-23T12:00:00.000Z', written_by: 'test' }));
  assert.deepStrictEqual(LS.markersReport({ cwd: r.repo }), [`flip marker: ${r.sha7} 2026-10-23T12:00:00.000Z`]);
  fs.writeFileSync(flipFile, '{torn');
  assert.deepStrictEqual(LS.markersReport({ cwd: r.repo }), [`BLOCKED: the flip marker ${flipFile} is unreadable; repair or remove it by hand`]);
});

test('shipReport with no drb-ship directory prints no ship yet', (t) => {
  const r = shipRepo(t, 'sh-none');
  assert.deepStrictEqual(LS.shipReport({ cwd: r.repo }), ['no ship yet']);
});

test('shipReport with a finished manifest prints the last-ship line', (t) => {
  const r = shipRepo(t, 'sh-done');
  const m = settledOk(r);
  assert.deepStrictEqual(LS.shipReport({ cwd: r.repo }), [`last ship: ${r.sha7} ok ${m.result.at}`]);
});

test('shipReport with an open manifest prints the in-flight line with its stage and log', (t) => {
  const r = shipRepo(t, 'sh-open');
  const opened = L.open(r.sha, { cwd: r.repo });
  const log = path.join(r.dir, `${r.sha}.log`);
  const m0 = L.readManifest(r.sha, { cwd: r.repo });
  assert.deepStrictEqual(LS.shipReport({ cwd: r.repo }), [`ship in flight: ${r.sha7} at stage open since ${m0.started_at}, log ${log}`]);
  L.line(r.sha, 'fetch', 'fetched origin', { cwd: r.repo });
  const m1 = L.readManifest(r.sha, { cwd: r.repo });
  assert.deepStrictEqual(LS.shipReport({ cwd: r.repo }), [`ship in flight: ${r.sha7} at stage fetch since ${m1.last_stage_at}, log ${log}`]);
  assert.ok(opened);
});

test('shipReport with push_started_at and push_unknown_at and no result prints the unknown line, not the in-flight line', (t) => {
  const r = shipRepo(t, 'sh-unknown');
  L.open(r.sha, { cwd: r.repo });
  const unknownAt = ago(2 * MIN);
  L.setManifest(r.sha, { push_started_at: ago(3 * MIN), push_unknown_at: unknownAt }, { cwd: r.repo });
  const lines = LS.shipReport({ cwd: r.repo });
  assert.deepStrictEqual(lines, [`ship ${r.sha7}: push outcome unknown since ${unknownAt}; run npm run ship again to complete it`]);
  assert.ok(!lines.some((l) => l.startsWith('ship in flight')));
});

test('shipReport with pushed_at, no result and a dead pid prints the pushed-unfinished line', (t) => {
  const r = shipRepo(t, 'sh-pushed');
  L.open(r.sha, { cwd: r.repo });
  const pushedAt = ago(4 * MIN);
  L.setManifest(r.sha, { pid: deadPid(), push_started_at: ago(5 * MIN), pushed_at: pushedAt }, { cwd: r.repo });
  assert.deepStrictEqual(LS.shipReport({ cwd: r.repo }), [`ship ${r.sha7}: pushed at ${pushedAt}, unfinished; run npm run ship again to finish it`]);
});

test('shipReport with a record whose pid is this process and no result prints the in-flight line and no unsettled line', (t) => {
  const r = shipRepo(t, 'sh-live');
  L.open(r.sha, { cwd: r.repo });
  L.setManifest(r.sha, { push_started_at: ago(MIN) }, { cwd: r.repo });
  L.line(r.sha, 'push', 'pushing', { cwd: r.repo });
  assert.equal(L.readManifest(r.sha, { cwd: r.repo }).pid, process.pid);
  const lines = LS.shipReport({ cwd: r.repo });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0].startsWith(`ship in flight: ${r.sha7} at stage push since `), lines[0]);
});

test('shipReport with an unreadable manifest prints the unreadable ship record line', (t) => {
  const r = shipRepo(t, 'sh-torn');
  fs.mkdirSync(r.dir, { recursive: true });
  fs.writeFileSync(path.join(r.dir, `${r.sha}.json`), '{not a manifest');
  assert.deepStrictEqual(LS.shipReport({ cwd: r.repo }), [`unreadable ship record ${r.sha7}; fix or move it`]);
});

test('shipReport with a settled ok record whose claim is stale and whose watch log is empty prints the never-started line', (t) => {
  const r = shipRepo(t, 'sh-never');
  const m = settledOk(r);
  const stamp = ago(10 * MIN);
  editManifest(r, { watch_started_at: stamp });
  assert.deepStrictEqual(LS.shipReport({ cwd: r.repo }), [
    `last ship: ${r.sha7} ok ${m.result.at}`,
    `ship ${r.sha7}: watch claimed at ${stamp} never started; run npm run ship again to re-watch it`,
  ]);
});

test('shipReport with a watch log whose start line was last written over an hour ago prints the died line with its last write', (t) => {
  const r = shipRepo(t, 'sh-died');
  const m = settledOk(r);
  L.watchLine(r.sha, 'start', 'watch started', { cwd: r.repo });
  const watchLog = path.join(r.dir, `${r.sha}.watch.log`);
  const old = new Date(Date.now() - 2 * 60 * MIN);
  fs.utimesSync(watchLog, old, old);
  editManifest(r, { watch_started_at: ago(3 * 60 * MIN) });
  const lastWrite = new Date(fs.statSync(watchLog).mtimeMs).toISOString();
  assert.deepStrictEqual(LS.shipReport({ cwd: r.repo }), [
    `last ship: ${r.sha7} ok ${m.result.at}`,
    `ship ${r.sha7}: watch died, last wrote at ${lastWrite}; run npm run ship again to re-watch it`,
  ]);
});

test('shipReport with a watch result that set the marker prints the events-since line', (t) => {
  const r = shipRepo(t, 'sh-events');
  const m = settledOk(r);
  const deployAt = ago(8 * MIN);
  L.setManifest(r.sha, { watch: { result: '3 events since deploy across 1 issues, 1 new', count: 3, issues: 1, new_issues: 1, deploy_at: deployAt, finished_at: ago(MIN) } }, { cwd: r.repo });
  M.setWatch({ sha: r.sha, deploy_at: deployAt, count: 3, cwd: r.repo });
  assert.deepStrictEqual(LS.shipReport({ cwd: r.repo }), [
    `last ship: ${r.sha7} ok ${m.result.at}`,
    `shipped ${r.sha7} at ${deployAt}, 3 events since`,
  ]);
});

test('formatReport puts the markers and ship lines ahead of the lanes, and is unchanged without them', () => {
  assert.equal(LS.formatReport([]), 'No open lanes (only the primary os/main worktree).');
  assert.equal(LS.formatReport([], { markers: ['m1'], ship: ['s1'] }), 'm1\ns1\n\nNo open lanes (only the primary os/main worktree).');
});

// A repo with one linked worktree lane that main has left 15 commits behind.
function staleLaneRepo(t, label) {
  const r = shipRepo(t, label);
  const lanePath = path.join(r.repo, '..', `${path.basename(r.repo)}-lane`);
  t.after(() => fs.rmSync(lanePath, { recursive: true, force: true }));
  git(r.repo, ['worktree', 'add', '-q', '-b', 'old-lane', lanePath, 'main']);
  for (let i = 0; i < STALE_MAIN_ADVANCE; i++) commitAt(r.repo, `docs/n-${i}.md`, `${i}\n`, `main ${i}`);
  return r;
}

test('--session-start exits 0 on a repo with a stale lane, within two seconds; the plain CLI still exits 1', (t) => {
  const r = staleLaneRepo(t, 'ss-stale');
  const res = runSessionStart(r.repo);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.ms < 2000, `took ${res.ms} ms`);
  assert.ok(res.lines.length <= LS.SESSION_MAX_LINES);
  assert.equal(res.lines[0], 'flip marker: absent, pushes are cue-only through npm run gate');
  assert.equal(res.lines[1], 'no ship yet');
  assert.ok(res.lines.some((l) => l.startsWith('stale lane old-lane: ') && l.includes('main advanced')), res.stdout);
  const plain = spawnSync(process.execPath, [SCRIPT], { cwd: r.repo, encoding: 'utf8' });
  assert.equal(plain.status, 1, plain.stderr);
  assert.ok(plain.stdout.includes('[STALE] old-lane'));
});

test('--session-start exits 0 on a repo with an unreadable marker, within two seconds', (t) => {
  const r = shipRepo(t, 'ss-torn');
  fs.mkdirSync(r.markers, { recursive: true });
  fs.writeFileSync(path.join(r.markers, 'watch.json'), '[]');
  fs.writeFileSync(path.join(r.common, 'drb-flip.json'), 'torn');
  const res = runSessionStart(r.repo);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.ms < 2000, `took ${res.ms} ms`);
  assert.ok(res.lines.some((l) => l.includes('the flip marker') && l.includes('unreadable')), res.stdout);
  assert.ok(res.lines.some((l) => l.includes('unreadable marker')), res.stdout);
});

test('--session-start exits 0 with one line on a cwd that is not a git repo, within two seconds', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-status-nogit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [SCRIPT, '--session-start'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) },
  });
  const ms = Date.now() - t0;
  assert.equal(res.status, 0, res.stderr);
  assert.ok(ms < 2000, `took ${ms} ms`);
  const lines = res.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, res.stdout);
  assert.ok(lines[0].includes('not inside a git repo'), lines[0]);
});

test('--session-start exits 0 with scripts/lib/markers.js moved aside, naming the failed load in one line, within two seconds', (t) => {
  const r = staleLaneRepo(t, 'ss-noload');
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-status-copy-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  const scripts = path.join(copy, 'scripts');
  fs.cpSync(__dirname, scripts, { recursive: true });
  fs.renameSync(path.join(scripts, 'lib', 'markers.js'), path.join(scripts, 'lib', 'markers.js.aside'));
  const res = runSessionStart(r.repo, path.join(scripts, 'lane-status.js'));
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.ms < 2000, `took ${res.ms} ms`);
  const named = res.lines.filter((l) => l.includes('could not load scripts/lib/markers.js'));
  assert.equal(named.length, 1, res.stdout);
  assert.ok(!res.lines.some((l) => l.startsWith('flip marker') || l === 'no ship yet'), res.stdout);
  assert.ok(res.lines.some((l) => l.startsWith('stale lane old-lane: ')), 'the lanes still report');
});
