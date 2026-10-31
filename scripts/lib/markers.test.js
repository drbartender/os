'use strict';

// Tests for scripts/lib/markers.js (instruction rewrite step 3, lane
// ship-state). Every case runs in a throwaway repo under the temp dir, removed
// when the test ends; nothing here touches the real repo's common dir.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A test run from inside a git hook inherits variables that point git at the
// hook's repo; the throwaway repos must never see them.
for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const M = require('./markers');
const R = require('./receipt');

// Makes isAncestor throw, as git does on an object it cannot read, for the
// pairs `fails` picks; every other call goes to git.
// Makes the resolve throw with exit status `status` for the shas `fails`
// picks, through the module's test-only seam.
function breakResolve(t, fails, status, stderr = '') {
  const real = M.seams.resolve;
  M.seams.resolve = (ref, cwd) => {
    if (fails(ref)) {
      const err = new Error('git failed');
      err.status = status;
      err.stderr = stderr;
      throw err;
    }
    return real(ref, cwd);
  };
  t.after(() => { M.seams.resolve = real; });
}

function breakAncestor(t, fails) {
  const real = R.isAncestor;
  R.isAncestor = (a, b, opts) => {
    if (fails(a, b)) throw new Error('git merge-base --is-ancestor failed');
    return real(a, b, opts);
  };
  t.after(() => { R.isAncestor = real; });
}

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

// main: A, B, C (C a child of B). lane: S, a sibling of B cut from A.
function makeRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'markers-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const A = commit(repo, 'seed', { 'docs/a.md': 'a\n' });
  const B = commit(repo, 'server change', { 'server/b.js': 'b\n' });
  const C = commit(repo, 'fix forward', { 'server/b.js': 'b2\n' });
  git(repo, 'switch', '-q', '-c', 'lane', A);
  const S = commit(repo, 'lane work', { 'server/s.js': 's\n' });
  git(repo, 'switch', '-q', 'main');
  const markerDir = path.join(repo, '.git', 'drb-markers');
  return {
    repo, A, B, C, S, markerDir,
    gateFile: path.join(markerDir, 'gate.json'),
    watchFile: path.join(markerDir, 'watch.json'),
    flipFile: path.join(repo, '.git', 'drb-flip.json'),
  };
}

const short = (sha) => sha.slice(0, 7);
// A full sha no repo holds, built at runtime.
const ghostSha = () => ['ab', 'cd'].join('').repeat(10);
const writeFlip = (r, sha) => fs.writeFileSync(r.flipFile, JSON.stringify({ sha, pushed_at: '2026-10-22T06:00:00.000Z', written_by: 'test' }));

test('markerPaths names the three files under the common dir', (t) => {
  const r = makeRepo(t);
  const p = M.markerPaths({ cwd: r.repo });
  assert.equal(fs.realpathSync(p.common), fs.realpathSync(path.join(r.repo, '.git')));
  assert.equal(path.relative(p.common, p.flip), 'drb-flip.json');
  assert.equal(path.relative(p.common, p.gate), path.join('drb-markers', 'gate.json'));
  assert.equal(path.relative(p.common, p.watch), path.join('drb-markers', 'watch.json'));
});

test('flip is null with no file and the parsed object with one', (t) => {
  const r = makeRepo(t);
  assert.equal(M.flip({ cwd: r.repo }), null);
  const marker = { sha: r.C, pushed_at: '2026-10-22T06:00:00.000Z', written_by: 'step 5 test' };
  fs.writeFileSync(r.flipFile, JSON.stringify(marker));
  assert.deepEqual(M.flip({ cwd: r.repo }), marker);
});

test('flipState has three shapes, and an unreadable flip has a standing line of its own', (t) => {
  const r = makeRepo(t);
  const flipPath = M.markerPaths({ cwd: r.repo }).flip;
  assert.deepEqual(M.flipState({ cwd: r.repo }), { state: 'absent', sha: null, pushed_at: null, written_by: null, path: flipPath });
  assert.equal(M.standing({ cwd: r.repo }).flip, null);
  writeFlip(r, r.C);
  assert.deepEqual(M.flipState({ cwd: r.repo }), { state: 'present', sha: r.C, pushed_at: '2026-10-22T06:00:00.000Z', written_by: 'test', path: flipPath });
  assert.equal(M.standing({ cwd: r.repo }).flip, null);
  fs.writeFileSync(r.flipFile, '{ half');
  assert.deepEqual(M.flipState({ cwd: r.repo }), { state: 'unreadable', sha: null, pushed_at: null, written_by: null, path: flipPath });
  assert.equal(M.flip({ cwd: r.repo }), null, 'a torn flip file is no flip object');
  const torn = M.standing({ cwd: r.repo }).flip;
  assert.match(torn, /^BLOCKED: the flip marker is unreadable; read it, then repair it by hand: write \S*drb-flip\.json as \{"sha": "8bf83999[0-9a-f]{32}", "pushed_at": "2026-10-30T07:12:24Z", "written_by": "<who restored it>"\}, then npm run ship$/, 'repair to the recipe is the one remedy, nothing about removing');
});

test('setGate refuses a sha not on main, and a non-commit, and writes nothing', (t) => {
  const r = makeRepo(t);
  const lane = M.setGate({ sha: r.S, reason: 'money smoke failed', gates: ['money'], cwd: r.repo });
  assert.equal(lane.written, false);
  assert.match(lane.reason, /not on main/);
  const bogus = M.setGate({ sha: 'not-a-ref', reason: 'x', gates: [], cwd: r.repo });
  assert.equal(bogus.written, false);
  assert.match(bogus.reason, /not a commit/);
  assert.equal(fs.existsSync(r.gateFile), false);
  assert.equal(M.gate({ cwd: r.repo }), null);
});

test('setGate writes for a sha on main; the line is a refusal whatever the flip state', (t) => {
  const r = makeRepo(t);
  assert.deepEqual(M.setGate({ sha: r.B, reason: 'money smoke failed', gates: ['money'], cwd: r.repo }), { written: true });
  const g = M.gate({ cwd: r.repo });
  assert.equal(g.sha, r.B);
  assert.equal(g.reason, 'money smoke failed');
  assert.deepEqual(g.gates, ['money']);
  assert.equal(g.on_main, true);
  assert.ok(Number.isFinite(Date.parse(g.at)));
  const blocked = `BLOCKED: gate marker stands on ${short(r.B)} (money smoke failed); a gate that passes on this sha again or on a descendant on main (any later sha on main once the failing sha left main) clears it when that run re-runs the checks this marker names (money; all of them once the failing sha is on origin/main or has left main, otherwise those its range still needs); last resort: remove ${r.gateFile} by hand`;
  assert.equal(M.standing({ cwd: r.repo }).gate, blocked, 'a refusal with the flip marker absent: since the flip a missing one was lost');
  assert.ok(M.standing({ cwd: r.repo }).gate.includes('re-runs the checks this marker names (money;'));
  writeFlip(r, r.A);
  const s = M.standing({ cwd: r.repo });
  assert.equal(s.gate, blocked);
  assert.equal(s.watch, null);
  assert.equal(s.flip, null);
  // Atomic writes leave no temp file and no lock behind.
  assert.deepEqual(fs.readdirSync(r.markerDir), ['gate.json']);
});

test('setGate accepts the main tip given as a short sha', (t) => {
  const r = makeRepo(t);
  assert.deepEqual(M.setGate({ sha: short(r.C), reason: 'build failed', gates: ['client'], cwd: r.repo }), { written: true });
  assert.equal(M.gate({ cwd: r.repo }).sha, r.C);
});

test('setGate writes under uncertainty: a sha git cannot resolve, and a repo with no main', (t) => {
  const r = makeRepo(t);
  const ghost = ghostSha();
  assert.deepEqual(M.setGate({ sha: ghost, reason: 'failed', gates: ['money'], cwd: r.repo }), { written: true, uncertain: true });
  const g = M.gate({ cwd: r.repo });
  assert.equal(g.sha, ghost);
  assert.equal(g.on_main, null);
  assert.equal(g.resolved, false);
  fs.rmSync(r.gateFile);
  git(r.repo, 'switch', '-q', 'lane');
  git(r.repo, 'update-ref', '-d', 'refs/heads/main');
  assert.deepEqual(M.setGate({ sha: r.C, reason: 'failed', gates: ['money'], cwd: r.repo }), { written: true, uncertain: true });
  assert.equal(M.gate({ cwd: r.repo }).on_main, null);
  assert.equal(M.gate({ cwd: r.repo }).resolved, undefined);
});

test('setGate never moves a standing marker backwards: a failure on its ancestor is recorded beside it; and it moves forward', (t) => {
  const r = makeRepo(t);
  M.setGate({ sha: r.C, reason: 'failed on C', gates: ['money'], cwd: r.repo });
  assert.deepEqual(M.setGate({ sha: r.B, reason: 'failed on B', gates: ['client'], cwd: r.repo }), { written: true, beside: r.C });
  const g = M.gate({ cwd: r.repo });
  assert.equal(g.sha, r.C, 'the standing marker stays on top');
  assert.deepEqual(g.earlier.map((e) => [e.sha, e.gates]), [[r.B, ['client']]], 'the ancestor\'s own result is recorded beside it');
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), false, 'fix forward from the older sha never lets the failing sha through');
  const D = commit(r.repo, 'another', { 'server/d.js': 'd\n' });
  assert.equal(M.isFixForward(D, { cwd: r.repo }), true);
  assert.deepEqual(M.setGate({ sha: D, reason: 'failed on D', gates: ['money'], cwd: r.repo }), { written: true });
  assert.equal(M.gate({ cwd: r.repo }).sha, D);
  assert.deepEqual(M.gate({ cwd: r.repo }).earlier.map((e) => e.sha), [r.B, r.C], 'neither was re-proved by the run on D');
});

test('a standing gate marker that is off main is kept beside a new failure, and replaced only by a run that re-proved what it names', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.markerDir, { recursive: true });
  const old = JSON.stringify({ sha: r.S, at: '2026-10-22T06:00:00.000Z', reason: 'old', gates: ['money'] });
  fs.writeFileSync(r.gateFile, old);
  assert.deepEqual(M.setGate({ sha: r.B, reason: 'failed on B', gates: ['money'], cwd: r.repo }), { written: true });
  assert.equal(M.gate({ cwd: r.repo }).sha, r.B);
  assert.deepEqual(M.gate({ cwd: r.repo }).earlier.map((e) => e.sha), [r.S], 'its money failure was never re-run');
  fs.writeFileSync(r.gateFile, old);
  assert.deepEqual(M.setGate({ sha: r.B, reason: 'failed on B', gates: ['client'], proven: ['static checks', 'money'], cwd: r.repo }), { written: true });
  assert.equal(M.gate({ cwd: r.repo }).sha, r.B);
  assert.equal(M.gate({ cwd: r.repo }).earlier, undefined, 'the run on B re-proved money');
});

test('a marker on a sha git cannot resolve is kept beside a failure on main, which is not its own fix', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.markerDir, { recursive: true });
  fs.writeFileSync(r.gateFile, JSON.stringify({ sha: ghostSha(), at: '2026-10-22T06:00:00.000Z', reason: 'ghost', gates: ['money'] }));
  assert.deepEqual(M.setGate({ sha: r.B, reason: 'failed on B', gates: ['money'], cwd: r.repo }), { written: true });
  assert.equal(M.gate({ cwd: r.repo }).sha, r.B);
  assert.deepEqual(M.gate({ cwd: r.repo }).earlier.map((e) => e.sha), [ghostSha()]);
  assert.equal(M.isFixForward(r.B, { cwd: r.repo }), false);
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), true);
});

test('placement says on, off, gone or unknown', (t) => {
  const r = makeRepo(t);
  assert.equal(M.placement(r.B, { cwd: r.repo }), 'on');
  assert.equal(M.placement(r.S, { cwd: r.repo }), 'off');
  assert.equal(M.placement(ghostSha(), { cwd: r.repo }), 'gone');
  breakAncestor(t, (a) => a === r.C);
  assert.equal(M.placement(r.C, { cwd: r.repo }), 'unknown');
});

test('an unknown placement never clears and never counts as fix forward', (t) => {
  const r = makeRepo(t);
  M.setGate({ sha: r.C, reason: 'failed on C', gates: ['money'], cwd: r.repo });
  const D = commit(r.repo, 'later', { 'server/d.js': 'd\n' });
  breakAncestor(t, () => true);
  assert.equal(M.clearGateIfDescendant(r.B, { cwd: r.repo }).cleared, false, 'a pass on its ancestor');
  assert.equal(M.clearGateIfDescendant(D, { cwd: r.repo }).cleared, false, 'a pass on a descendant git cannot place');
  assert.equal(M.isFixForward(D, { cwd: r.repo }), false);
  assert.equal(M.gate({ cwd: r.repo }).sha, r.C);
  assert.match(M.standing({ cwd: r.repo }).gate, /remove .*gate\.json by hand/);
});

test('setGate records a failure it cannot order against the standing one, keeping that one under earlier', (t) => {
  const r = makeRepo(t);
  M.setGate({ sha: r.B, reason: 'failed on B', gates: ['money'], cwd: r.repo });
  breakAncestor(t, (a, b) => (a === r.C && b === r.B) || (a === r.B && b === r.C));
  assert.deepEqual(M.setGate({ sha: r.C, reason: 'failed on C', gates: ['money'], cwd: r.repo }), { written: true, uncertain: true });
  const g = M.gate({ cwd: r.repo });
  assert.equal(g.sha, r.C);
  assert.deepEqual(g.earlier.map((e) => e.sha), [r.B]);
  assert.equal(g.earlier[0].reason, 'failed on B');
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), false, 'the failing sha is never its own fix');
  // main is C, so placing B asks the same broken pair: B reads as unknown.
  assert.ok(M.standing({ cwd: r.repo }).gate.endsWith(`1 earlier failure stands with it: ${short(r.B)} (money; git cannot place it: it waits for git or the by-hand removal)`));
});

test('placement is gone only for exit 1; any other resolve failure is unknown and clears nothing', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.markerDir, { recursive: true });
  fs.writeFileSync(r.gateFile, JSON.stringify({ sha: r.S, at: '2026-10-22T06:00:00.000Z', reason: 'off main', gates: ['money'] }));
  breakResolve(t, (ref) => ref === r.S, 128);
  assert.equal(M.placement(r.S, { cwd: r.repo }), 'unknown');
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), false);
  assert.equal(M.clearGateIfDescendant(r.C, { cwd: r.repo }).cleared, false);
  assert.equal(M.gate({ cwd: r.repo }).sha, r.S);
});

test('placement is gone for a resolve that exits 1, and such a marker clears on main', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.markerDir, { recursive: true });
  fs.writeFileSync(r.gateFile, JSON.stringify({ sha: r.S, at: '2026-10-22T06:00:00.000Z', reason: 'off main', gates: ['money'] }));
  breakResolve(t, (ref) => ref === r.S, 1);
  assert.equal(M.placement(r.S, { cwd: r.repo }), 'gone');
  assert.equal(M.placement(r.S.slice(0, 7) + 'zz', { cwd: r.repo }), 'gone', 'real git exits 1 for a ref that names nothing');
  assert.equal(M.clearGateIfDescendant(r.C, { cwd: r.repo }).cleared, true);
});

test('placement reads exit 1 with an error on stderr as unknown, and such a marker clears nothing', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.markerDir, { recursive: true });
  fs.writeFileSync(r.gateFile, JSON.stringify({ sha: r.S, at: '2026-10-22T06:00:00.000Z', reason: 'off main', gates: ['money'] }));
  breakResolve(t, (ref) => ref === r.S, 1, 'error: inflate: data stream error (incorrect header check)');
  assert.equal(M.placement(r.S, { cwd: r.repo }), 'unknown');
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), false);
  assert.equal(M.clearGateIfDescendant(r.C, { cwd: r.repo }).cleared, false);
  assert.equal(M.gate({ cwd: r.repo }).sha, r.S);
});

test('setGate throws for a short ref git fails to resolve; a full sha under the same failure gets the uncertain marker', (t) => {
  const r = makeRepo(t);
  breakResolve(t, (ref) => ref === short(r.B) || ref === r.B, 128, 'fatal: bad object');
  assert.throws(() => M.setGate({ sha: short(r.B), reason: 'failed', gates: ['money'], cwd: r.repo }),
    (err) => err.code === 'GATE_RESOLVE_FAILED' && err.message.includes('status 128') && err.message.includes(short(r.B)));
  assert.equal(fs.existsSync(r.gateFile), false, 'no marker was written');
  assert.deepEqual(M.setGate({ sha: r.B, reason: 'failed', gates: ['money'], cwd: r.repo }), { written: true, uncertain: true });
  const g = M.gate({ cwd: r.repo });
  assert.equal(g.sha, r.B);
  assert.equal(g.on_main, null);
  assert.equal(g.resolved, false);
  // No such commit (exit 1, nothing on stderr) stays a plain refusal.
  assert.equal(M.setGate({ sha: 'not-a-ref', reason: 'x', gates: [], cwd: r.repo }).written, false);
});

test('the earlier suffix states each failure\'s own exit by its placement', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.markerDir, { recursive: true });
  const entry = (sha) => ({ sha, at: '2026-10-22T06:00:00.000Z', reason: 'r', gates: ['money'] });
  const ghost = ghostSha();
  fs.writeFileSync(r.gateFile, JSON.stringify({ ...entry(r.C), earlier: [entry(r.B), entry(r.S), entry(ghost), entry(r.A)] }));
  breakResolve(t, (ref) => ref === r.A, 128);
  const line = M.standing({ cwd: r.repo }).gate;
  const strict = 'cleared only by a later sha on main whose one pass re-runs every check it names';
  assert.ok(line.includes(`4 earlier failures stand with it: ${short(r.B)} (money; on main, origin/main not read: ${strict}), `), line);
  assert.ok(line.includes(`${short(r.S)} (money; off main: ${strict})`), line);
  assert.ok(line.includes(`${short(ghost)} (money; gone: ${strict})`), line);
  assert.ok(line.endsWith(`${short(r.A)} (money; git cannot place it: it waits for git or the by-hand removal)`));
});

test('an ack whose record cannot be appended throws with the marker intact, and a later ack clears', (t) => {
  const r = makeRepo(t);
  M.setWatch({ sha: r.C, count: 2, cwd: r.repo });
  const acks = path.join(r.markerDir, 'acks.jsonl');
  fs.mkdirSync(acks);
  assert.throws(() => M.clearWatch(r.C, { note: 'seen', cwd: r.repo }), /EISDIR|illegal operation/);
  assert.equal(M.watch({ cwd: r.repo }).sha, r.C, 'nothing was cleared');
  fs.rmSync(acks, { recursive: true });
  assert.equal(M.clearWatch(r.C, { note: 'seen', cwd: r.repo }), true);
  assert.equal(M.watch({ cwd: r.repo }), null);
  assert.equal(JSON.parse(fs.readFileSync(acks, 'utf8').trim()).sha, r.C);
});

test('a fix must descend from every failure under earlier', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.markerDir, { recursive: true });
  const D = commit(r.repo, 'later', { 'server/d.js': 'd\n' });
  const entry = (sha) => ({ sha, at: '2026-10-22T06:00:00.000Z', reason: 'r', gates: ['money'] });
  fs.writeFileSync(r.gateFile, JSON.stringify({ ...entry(r.B), earlier: [entry(r.C)] }));
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), false, 'C fixes B but is the earlier failure itself');
  assert.equal(M.isFixForward(D, { cwd: r.repo }), true);
  assert.equal(M.clearGateIfDescendant(r.C, { cwd: r.repo }).cleared, false);
  assert.equal(M.clearGateIfDescendant(D, { cwd: r.repo }).cleared, true);
});

test('main reset to its parent: the marker that left main stays beside the gate failing there, never on top of it', (t) => {
  const r = makeRepo(t);
  M.setGate({ sha: r.C, reason: 'failed on C', gates: ['money'], cwd: r.repo });
  git(r.repo, 'update-ref', 'refs/heads/main', r.B);
  assert.deepEqual(M.setGate({ sha: r.B, reason: 'failed on B', gates: ['money'], cwd: r.repo }), { written: true });
  assert.equal(M.gate({ cwd: r.repo }).sha, r.B);
  assert.deepEqual(M.gate({ cwd: r.repo }).earlier.map((e) => e.sha), [r.C]);
});

test('the gate reason is masked on write and when the line is built, and cut after masking', (t) => {
  const r = makeRepo(t);
  const run = ['gh', 'p_'].join('') + 'Zq7'.repeat(12);
  M.setGate({ sha: r.B, reason: `suite printed ${run}\nthen stopped`, gates: ['money'], cwd: r.repo });
  assert.equal(fs.readFileSync(r.gateFile, 'utf8').includes(run), false);
  assert.match(M.gate({ cwd: r.repo }).reason, /^suite printed <TOKEN> then stopped$/);
  assert.equal(M.standing({ cwd: r.repo }).gate.includes(run), false);
  // A shape straddling the cap is masked whole, never cut in half and leaked.
  const tail = ['na', 'pi_'].join('') + 'k3Q'.repeat(15);
  const straddle = `${'w '.repeat(140)}${tail}`;
  assert.ok(straddle.length > 300);
  assert.equal(M.clean(straddle), `${'w '.repeat(140)}<TOKEN>`);
  const long = M.clean('x'.repeat(400));
  assert.equal(long, `${'x'.repeat(300)}...`);
  fs.rmSync(r.gateFile);
  M.setGate({ sha: r.B, reason: 'y'.repeat(400), gates: ['money'], cwd: r.repo });
  assert.equal(M.gate({ cwd: r.repo }).reason, `${'y'.repeat(300)}...`);
});

test('clean flattens control characters and the Unicode line separators', () => {
  const seps = [0x0a, 0x0d, 0x85, 0x2028, 0x2029].map((c) => String.fromCharCode(c));
  assert.equal(M.clean(`a${seps.join('b')}c`), 'a b b b b c');
});

test('clearGateIfDescendant clears for a child on main, never for a sibling, a lane tip or the failing sha', (t) => {
  const r = makeRepo(t);
  assert.deepEqual(M.clearGateIfDescendant(r.C, { cwd: r.repo }), { cleared: false, marker: null });
  M.setGate({ sha: r.B, reason: 'money smoke failed', gates: ['money'], cwd: r.repo });
  const sib = M.clearGateIfDescendant(r.S, { cwd: r.repo });
  assert.equal(sib.cleared, false);
  assert.equal(sib.marker.sha, r.B);
  assert.equal(M.clearGateIfDescendant(r.B, { cwd: r.repo }).cleared, false);
  assert.equal(M.clearGateIfDescendant(r.A, { cwd: r.repo }).cleared, false);
  // A lane tip that descends from the marker but is not on main clears nothing.
  git(r.repo, 'switch', '-q', '-c', 'fix-lane', r.C);
  const laneTip = commit(r.repo, 'lane fix', { 'server/f.js': 'f\n' });
  git(r.repo, 'switch', '-q', 'main');
  assert.equal(M.isFixForward(laneTip, { cwd: r.repo }), true);
  assert.equal(M.clearGateIfDescendant(laneTip, { cwd: r.repo }).cleared, false);
  assert.equal(M.gate({ cwd: r.repo }).sha, r.B);
  const child = M.clearGateIfDescendant(r.C, { cwd: r.repo });
  assert.equal(child.cleared, true);
  assert.equal(child.marker.sha, r.B);
  assert.equal(M.gate({ cwd: r.repo }), null);
  assert.equal(M.standing({ cwd: r.repo }).gate, null);
});

test('isFixForward is true for a descendant and false otherwise', (t) => {
  const r = makeRepo(t);
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), false, 'no marker stands');
  M.setGate({ sha: r.B, reason: 'money smoke failed', gates: ['money'], cwd: r.repo });
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), true);
  assert.equal(M.isFixForward(short(r.C), { cwd: r.repo }), true);
  assert.equal(M.isFixForward(r.S, { cwd: r.repo }), false, 'a sibling');
  assert.equal(M.isFixForward(r.B, { cwd: r.repo }), false, 'the failing sha itself');
  assert.equal(M.isFixForward(r.A, { cwd: r.repo }), false, 'an ancestor');
  assert.equal(M.isFixForward('not-a-ref', { cwd: r.repo }), false);
});

test('a marker whose sha left main, or cannot be resolved, is fixed by any gate that passes on main', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.markerDir, { recursive: true });
  fs.writeFileSync(r.gateFile, JSON.stringify({ sha: r.S, at: '2026-10-22T06:00:00.000Z', reason: 'off main', gates: ['money'] }));
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), true);
  assert.equal(M.isFixForward(r.A, { cwd: r.repo }), true);
  assert.equal(M.isFixForward(r.S, { cwd: r.repo }), false, 'still never its own fix');
  git(r.repo, 'switch', '-q', '-c', 'other', r.S);
  const laneTip = commit(r.repo, 'lane', { 'server/o.js': 'o\n' });
  git(r.repo, 'switch', '-q', 'main');
  assert.equal(M.clearGateIfDescendant(laneTip, { cwd: r.repo }).cleared, false, 'a lane tip is not on main');
  assert.equal(M.clearGateIfDescendant(r.C, { cwd: r.repo }).cleared, true);
  fs.writeFileSync(r.gateFile, JSON.stringify({ sha: ghostSha(), at: '2026-10-22T06:00:00.000Z', reason: 'ghost', gates: ['money'] }));
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), true);
  assert.equal(M.clearGateIfDescendant(r.C, { cwd: r.repo }).cleared, true);
});

test('setWatch, watch, standing and clearWatch; clearWatch refuses another sha', (t) => {
  const r = makeRepo(t);
  assert.equal(M.clearWatch(r.B, { cwd: r.repo }), false, 'none stands');
  const w = M.setWatch({ sha: r.B, deploy_at: '2026-10-22T01:00:00-05:00', count: 3, by_issue: { 'issue-a': 3 }, cwd: r.repo });
  assert.deepEqual(w, { written: true });
  const m = M.watch({ cwd: r.repo });
  assert.equal(m.sha, r.B);
  assert.equal(m.count, 3);
  assert.deepEqual(m.by_issue, { 'issue-a': 3 });
  assert.equal(m.deploy_at, '2026-10-22T06:00:00.000Z', 'stored normalized');
  const ack = `npm run ship -- --ack-watch ${short(r.B)} --note <what you saw and decided>`;
  const blocked = `BLOCKED: watch marker stands on ${short(r.B)} (3 events since deploy); read them, then ${ack}`;
  assert.equal(M.standing({ cwd: r.repo }).watch, blocked, 'a refusal with the flip marker absent: since the flip a missing one was lost');
  writeFlip(r, r.A);
  assert.equal(M.standing({ cwd: r.repo }).watch, blocked);
  assert.equal(M.clearWatch(r.C, { cwd: r.repo }), false);
  assert.equal(M.clearWatch('not-a-ref', { cwd: r.repo }), false);
  assert.equal(M.watch({ cwd: r.repo }).sha, r.B);
  assert.equal(M.clearWatch(short(r.B), { note: 'read them\nall known', cwd: r.repo }), true);
  assert.equal(M.watch({ cwd: r.repo }), null);
  assert.equal(M.standing({ cwd: r.repo }).watch, null);
  assert.deepEqual(fs.readdirSync(r.markerDir), ['acks.jsonl'], 'only the ack record is left');
  const acks = fs.readFileSync(path.join(r.markerDir, 'acks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(acks.length, 1);
  assert.equal(acks[0].sha, r.B);
  assert.equal(acks[0].note, 'read them all known');
  assert.ok(Number.isFinite(Date.parse(acks[0].at)));
});

test('setWatch refuses a zoneless or bare deploy_at, a by_issue that is not an object, and a bad count', (t) => {
  const r = makeRepo(t);
  for (const bad of ['2026-10-22T06:00:00', '2026-10-22', 'later', '2026-13-45T99:99:99Z', '2026-02-30T06:00:00Z', '2026-04-31T06:00:00Z', '2026-10-22T24:00:00Z', '2026-10-22T06:00:00+25:00']) {
    assert.throws(() => M.setWatch({ sha: r.C, count: 1, deploy_at: bad, cwd: r.repo }), /deploy_at/, bad);
  }
  for (const bad of ['issue-a', ['issue-a'], 3]) {
    assert.throws(() => M.setWatch({ sha: r.C, count: 1, by_issue: bad, cwd: r.repo }), /by_issue/);
  }
  assert.throws(() => M.setWatch({ sha: r.C, count: -1, cwd: r.repo }), /count/);
  assert.throws(() => M.setWatch({ sha: 'not-a-ref', count: 1, cwd: r.repo }), /names no commit/);
  assert.equal(M.watch({ cwd: r.repo }), null);
});

test('a real calendar day is accepted for deploy_at, a leap day included', (t) => {
  const r = makeRepo(t);
  assert.deepEqual(M.setWatch({ sha: r.C, count: 1, deploy_at: '2028-02-29T23:30:00-05:00', cwd: r.repo }), { written: true });
  assert.equal(M.watch({ cwd: r.repo }).deploy_at, '2028-03-01T04:30:00.000Z');
  assert.equal(M.isZonedTime('2026-02-29T00:00:00Z'), false, 'not a leap year');
  assert.equal(M.isZonedTime('2026-10-22T06:00Z'), true);
  assert.equal(M.isZonedTime('2026-10-22T06:00:00.5+05:30'), true);
});

test('a short ref git fails to resolve throws from setWatch and clearWatch, the marker intact', (t) => {
  const r = makeRepo(t);
  M.setWatch({ sha: r.C, count: 2, cwd: r.repo });
  breakResolve(t, (ref) => ref === short(r.B) || ref === short(r.C), 128, 'fatal: bad object');
  assert.throws(() => M.setWatch({ sha: short(r.B), count: 1, cwd: r.repo }), (err) => err.code === 'WATCH_RESOLVE_FAILED' && err.message.includes('status 128'));
  assert.throws(() => M.clearWatch(short(r.C), { note: 'seen', cwd: r.repo }), (err) => err.code === 'WATCH_RESOLVE_FAILED');
  const w = M.watch({ cwd: r.repo });
  assert.equal(w.sha, r.C);
  assert.equal(w.earlier, undefined);
  assert.equal(fs.existsSync(path.join(r.markerDir, 'acks.jsonl')), false);
  // A short ref with a clean miss still names no commit.
  assert.throws(() => M.setWatch({ sha: 'zzzzzzz', count: 1, cwd: r.repo }), /names no commit/);
  assert.equal(M.clearWatch('zzzzzzz', { cwd: r.repo }), false);
});

test('an empty loose commit object (git exits 1 with an error line) reads unknown, and setGate on its short sha throws', (t) => {
  const r = makeRepo(t);
  const obj = path.join(r.repo, '.git', 'objects', r.S.slice(0, 2), r.S.slice(2));
  fs.chmodSync(obj, 0o644);
  fs.truncateSync(obj, 0);
  fs.mkdirSync(r.markerDir, { recursive: true });
  fs.writeFileSync(r.gateFile, JSON.stringify({ sha: r.S, at: '2026-10-22T06:00:00.000Z', reason: 'r', gates: ['money'] }));
  assert.equal(M.placement(r.S, { cwd: r.repo }), 'unknown');
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), false);
  assert.equal(M.clearGateIfDescendant(r.C, { cwd: r.repo }).cleared, false);
  fs.rmSync(r.gateFile);
  assert.throws(() => M.setGate({ sha: short(r.S), reason: 'failed', gates: ['money'], cwd: r.repo }), (err) => err.code === 'GATE_RESOLVE_FAILED' && err.message.includes('status 1'));
  assert.equal(fs.existsSync(r.gateFile), false);
});

test('trace output on stderr does not turn a clean miss into unknown', (t) => {
  const r = makeRepo(t);
  const had = Object.prototype.hasOwnProperty.call(process.env, 'GIT_TRACE');
  const before = process.env.GIT_TRACE;
  process.env.GIT_TRACE = '1';
  t.after(() => { if (had) process.env.GIT_TRACE = before; else delete process.env.GIT_TRACE; });
  assert.equal(M.placement(ghostSha(), { cwd: r.repo }), 'gone');
  const opts = { cwd: r.repo };
  assert.equal(M.cleanMiss({ status: 1, stderr: '12:00:00.000000 git.c:463 trace: built-in: git rev-parse' }, opts), true);
  assert.equal(M.cleanMiss({ status: 1, stderr: 'trace line\nerror: object file x is empty' }, opts), false);
  assert.equal(M.cleanMiss({ status: 1, stderr: 'fatal: not a git repository' }, opts), false);
  assert.equal(M.cleanMiss({ status: 128, stderr: '' }, opts), false);
});

test('a silent miss with an unreadable pack, here or in an alternate, reads unknown', (t) => {
  const r = makeRepo(t);
  git(r.repo, 'repack', '-q', '-a', '-d');
  const packDir = path.join(r.repo, '.git', 'objects', 'pack');
  const pack = fs.readdirSync(packDir).find((n) => n.endsWith('.pack'));
  assert.equal(M.placement(ghostSha(), { cwd: r.repo }), 'gone', 'readable packs: a clean miss is gone');
  fs.chmodSync(path.join(packDir, pack), 0o000); // the repo's own cleanup unlinks it, whatever its mode
  assert.equal(M.placement(ghostSha(), { cwd: r.repo }), 'unknown');
  assert.equal(M.placement(r.C, { cwd: r.repo }), 'unknown', 'git misses even a sha it holds when its pack is unreadable');

  const other = makeRepo(t);
  git(other.repo, 'repack', '-q', '-a', '-d');
  const otherPackDir = path.join(other.repo, '.git', 'objects', 'pack');
  const otherPack = fs.readdirSync(otherPackDir).find((n) => n.endsWith('.pack'));
  const fresh = makeRepo(t);
  fs.mkdirSync(path.join(fresh.repo, '.git', 'objects', 'info'), { recursive: true });
  fs.writeFileSync(path.join(fresh.repo, '.git', 'objects', 'info', 'alternates'), `${path.join(other.repo, '.git', 'objects')}\n`);
  assert.equal(M.placement(ghostSha(), { cwd: fresh.repo }), 'gone');
  fs.chmodSync(path.join(otherPackDir, otherPack), 0o000);
  assert.equal(M.placement(ghostSha(), { cwd: fresh.repo }), 'unknown');
});

// A repacked throwaway whose one pack is made unreadable: git then misses
// every sha silently, exit 1 with nothing on stderr.
function unreadablePack(r) {
  git(r.repo, 'repack', '-q', '-a', '-d');
  const dir = path.join(r.repo, '.git', 'objects', 'pack');
  fs.chmodSync(path.join(dir, fs.readdirSync(dir).find((n) => n.endsWith('.pack'))), 0o000);
}

const objectsOf = (r) => path.join(r.repo, '.git', 'objects');
const writeAlternates = (r, text) => {
  fs.mkdirSync(path.join(objectsOf(r), 'info'), { recursive: true });
  fs.writeFileSync(path.join(objectsOf(r), 'info', 'alternates'), text);
};

test('with an unreadable pack, a short ref never reads as no such commit anywhere', (t) => {
  const r = makeRepo(t);
  M.setWatch({ sha: r.C, count: 1, cwd: r.repo });
  unreadablePack(r);
  assert.equal(M.cleanMiss({ status: 1, stderr: '' }, { cwd: r.repo }), false);
  assert.throws(() => M.setGate({ sha: short(r.B), reason: 'failed', gates: ['money'], cwd: r.repo }), (err) => err.code === 'GATE_RESOLVE_FAILED');
  assert.equal(fs.existsSync(r.gateFile), false);
  assert.throws(() => M.setWatch({ sha: short(r.B), count: 1, cwd: r.repo }), (err) => err.code === 'WATCH_RESOLVE_FAILED');
  assert.throws(() => M.clearWatch(short(r.C), { note: 'seen', cwd: r.repo }), (err) => err.code === 'WATCH_RESOLVE_FAILED');
  assert.equal(M.watch({ cwd: r.repo }).sha, r.C, 'the marker is intact');
});

test('a quoted alternates line is unquoted as git does, and its unreadable pack reads unknown', (t) => {
  const front = makeRepo(t);
  const other = makeRepo(t);
  const objects = objectsOf(other);
  // The last letter of "objects" written as an octal escape, and a quote.
  writeAlternates(front, `"${objects.slice(0, -1)}\\163"\n`);
  assert.equal(M.placement(ghostSha(), { cwd: front.repo }), 'gone');
  unreadablePack(other);
  assert.equal(M.placement(ghostSha(), { cwd: front.repo }), 'unknown');
});

test('alternates of alternates are followed: front, mid, deep with deep\'s pack unreadable reads unknown', (t) => {
  const front = makeRepo(t);
  const mid = makeRepo(t);
  const deep = makeRepo(t);
  writeAlternates(front, `${objectsOf(mid)}\n`);
  writeAlternates(mid, `# a comment\n\n${objectsOf(deep)}\n${objectsOf(front)}\n`);
  assert.equal(M.placement(ghostSha(), { cwd: front.repo }), 'gone', 'a cycle back to front is ignored');
  unreadablePack(deep);
  assert.equal(M.placement(ghostSha(), { cwd: front.repo }), 'unknown');
});

test('an unreadable alternates file reads unknown', (t) => {
  const front = makeRepo(t);
  const other = makeRepo(t);
  writeAlternates(front, `${objectsOf(other)}\n`);
  assert.equal(M.placement(ghostSha(), { cwd: front.repo }), 'gone');
  fs.chmodSync(path.join(objectsOf(front), 'info', 'alternates'), 0o000);
  assert.equal(M.placement(ghostSha(), { cwd: front.repo }), 'unknown');
});

test('a relative alternates line resolves against the objects directory, not the cwd', (t) => {
  const front = makeRepo(t);
  const other = makeRepo(t);
  writeAlternates(front, `${path.relative(objectsOf(front), objectsOf(other))}\n`);
  unreadablePack(other);
  assert.equal(M.placement(ghostSha(), { cwd: front.repo }), 'unknown');
});

// A temp root for a store layout of its own. lockOut makes a file (never a
// directory) mode 000; the one cleanup hook gives each its mode back, then
// removes the root.
function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'markers-alt-'));
  const locked = [];
  t.after(() => {
    for (const file of locked) if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const lockOut = (file) => {
    fs.chmodSync(file, 0o000);
    locked.push(file);
  };
  return { root, lockOut };
}

// A packed repo at `dir` whose one commit no other repo holds (its file names
// the dir); returns {repo, sha, pack}.
function storeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const sha = commit(dir, 'held only here', { 'only.md': `${dir}\n` });
  git(dir, 'repack', '-q', '-a', '-d');
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  return { repo: dir, sha, pack: path.join(packDir, fs.readdirSync(packDir).find((n) => n.endsWith('.pack'))) };
}

// The real miss: git exits 1 with nothing on stderr, and cleanMiss does not
// trust it.
function assertSilentMiss(repo, sha) {
  const err = (() => {
    try {
      M.resolveStrict(sha, repo);
    } catch (e) {
      return e;
    }
    return null;
  })();
  assert.ok(err, 'git misses the sha');
  assert.deepEqual([err.status, err.stderr], [1, '']);
  assert.equal(M.cleanMiss(err, { cwd: repo }), false);
}

test('an objects directory that is a link: a relative alternate with .. resolves from the link target', (t) => {
  const front = makeRepo(t);
  const { root, lockOut } = tempRoot(t);
  const objs = path.join(root, 'store', 'objs');
  fs.mkdirSync(path.dirname(objs), { recursive: true });
  fs.renameSync(objectsOf(front), objs);
  fs.symlinkSync(objs, objectsOf(front));
  const other = storeRepo(path.join(root, 'store', 'other'));
  writeAlternates(front, '../other/.git/objects\n');
  assert.equal(M.placement(other.sha, { cwd: front.repo }), 'off', 'git reads the commit through the alternate');
  lockOut(other.pack);
  assertSilentMiss(front.repo, other.sha);
  assert.equal(M.placement(other.sha, { cwd: front.repo }), 'unknown');
});

test('an alternate named through a link, whose own alternate climbs with .., is read where git reads it', (t) => {
  const front = makeRepo(t);
  const { root, lockOut } = tempRoot(t);
  const mid = storeRepo(path.join(root, 'a', 'b', 'mid'));
  const deep = storeRepo(path.join(root, 'a', 'b', 'deep'));
  fs.symlinkSync(mid.repo, path.join(root, 'link'));
  writeAlternates(front, `${path.join(root, 'link', '.git', 'objects')}\n`);
  writeAlternates(mid, '../../../deep/.git/objects\n');
  assert.equal(M.placement(deep.sha, { cwd: front.repo }), 'off', 'git reads deep through mid');
  lockOut(deep.pack);
  assertSilentMiss(front.repo, deep.sha);
  assert.equal(M.placement(deep.sha, { cwd: front.repo }), 'unknown');
});

test('an entry that passes a link and then climbs with .. follows the link first (a native realpath)', (t) => {
  const front = makeRepo(t);
  const { root, lockOut } = tempRoot(t);
  const far = storeRepo(path.join(root, 'far', 'store'));
  fs.mkdirSync(path.join(root, 'far', 'near'));
  fs.symlinkSync(path.join(root, 'far', 'near'), path.join(objectsOf(front), 'hop'));
  writeAlternates(front, 'hop/../store/.git/objects\n');
  assert.equal(M.placement(far.sha, { cwd: front.repo }), 'off', 'git follows hop, then climbs from its target');
  lockOut(far.pack);
  assertSilentMiss(front.repo, far.sha);
  assert.equal(M.placement(far.sha, { cwd: front.repo }), 'unknown');
});

test('text after a closing quote is read as git reads it: another entry, or a comment', (t) => {
  const front = makeRepo(t);
  const { root, lockOut } = tempRoot(t);
  const a = storeRepo(path.join(root, 'a'));
  const b = storeRepo(path.join(root, 'b'));
  writeAlternates(front, `"${objectsOf(a)}" ${objectsOf(b)}\n`);
  assert.equal(M.placement(b.sha, { cwd: front.repo }), 'off', 'git reads B, the entry after the quoted one');
  lockOut(b.pack);
  assertSilentMiss(front.repo, b.sha);
  assert.equal(M.placement(b.sha, { cwd: front.repo }), 'unknown');
  // A comment after the quote names A alone: a store at <objects>/#comment
  // with an unreadable pack is never read.
  writeAlternates(front, `"${objectsOf(a)}" #comment\n`);
  const decoy = path.join(objectsOf(front), '#comment', 'pack', 'decoy.pack');
  fs.mkdirSync(path.dirname(decoy), { recursive: true });
  fs.writeFileSync(decoy, '');
  lockOut(decoy);
  assert.equal(M.placement(ghostSha(), { cwd: front.repo }), 'gone', 'the comment names no store');
  lockOut(a.pack);
  assert.equal(M.placement(ghostSha(), { cwd: front.repo }), 'unknown', 'A is read');
});

test('a quoted entry may hold a raw newline: git reads the file as one stream', (t) => {
  const front = makeRepo(t);
  const { root, lockOut } = tempRoot(t);
  const odd = storeRepo(path.join(root, `odd${String.fromCharCode(10)}name`));
  writeAlternates(front, `"${objectsOf(odd)}"\n`);
  assert.equal(M.placement(odd.sha, { cwd: front.repo }), 'off', 'git reads the store through the quoted entry');
  lockOut(odd.pack);
  assertSilentMiss(front.repo, odd.sha);
  assert.equal(M.placement(odd.sha, { cwd: front.repo }), 'unknown');
});

// A packed store (storeRepo) moved to <root>/st<0xE9>re, a name that is not
// valid UTF-8: git runs only under a string cwd, so the repo is built at an
// ASCII path and renamed by Buffer. Returns {sha, dir, objects, pack}, the
// paths as Buffers.
function badByteStore(root) {
  const store = storeRepo(path.join(root, 'plain'));
  const dir = Buffer.concat([Buffer.from(`${root}/st`), Buffer.from([0xe9]), Buffer.from('re')]);
  fs.renameSync(store.repo, dir);
  const objects = Buffer.concat([dir, Buffer.from('/.git/objects')]);
  return { sha: store.sha, dir, objects, pack: Buffer.concat([objects, Buffer.from(`/pack/${path.basename(store.pack)}`)]) };
}

test('a store path that is not valid UTF-8, named raw or as an octal escape, is never followed: unknown', (t) => {
  const { root, lockOut } = tempRoot(t);
  const odd = badByteStore(root);
  const fronts = [Buffer.concat([odd.objects, Buffer.from('\n')]), `"${root}/st\\351re/.git/objects"\n`].map((text) => {
    const front = makeRepo(t);
    writeAlternates(front, text);
    assert.equal(M.placement(odd.sha, { cwd: front.repo }), 'off', 'git reads the commit through the entry, by its bytes');
    assert.equal(M.placement(ghostSha(), { cwd: front.repo }), 'unknown', 'the walk does not try, so no miss is clean');
    return front;
  });
  lockOut(odd.pack);
  for (const front of fronts) {
    assertSilentMiss(front.repo, odd.sha);
    assert.equal(M.placement(odd.sha, { cwd: front.repo }), 'unknown', 'round 8 read gone');
  }
});

test('an ASCII link to a store whose real path is not valid UTF-8 is caught at the realpath', (t) => {
  const front = makeRepo(t);
  const { root, lockOut } = tempRoot(t);
  const odd = badByteStore(root);
  fs.symlinkSync(odd.dir, path.join(root, 'link'));
  writeAlternates(front, `${path.join(root, 'link', '.git', 'objects')}\n`);
  assert.equal(M.placement(odd.sha, { cwd: front.repo }), 'off');
  lockOut(odd.pack);
  assertSilentMiss(front.repo, odd.sha);
  assert.equal(M.placement(odd.sha, { cwd: front.repo }), 'unknown');
});

test('a repo whose real common dir is not valid UTF-8, run through an ASCII link, reads unknown on a silent miss', (t) => {
  const { root, lockOut } = tempRoot(t);
  const odd = badByteStore(root);
  const link = path.join(root, 'link');
  fs.symlinkSync(odd.dir, link);
  assert.ok(R.commonDir({ cwd: link }).includes(String.fromCharCode(0xfffd)), 'git prints the real path; its bad byte decodes to U+FFFD');
  assert.equal(M.placement(odd.sha, { cwd: link }), 'on');
  lockOut(odd.pack);
  assertSilentMiss(link, odd.sha);
  assert.equal(M.placement(odd.sha, { cwd: link }), 'unknown');
});

// Renames every file of the pack `pack` names to pack-<0xE9>.<ext>, a name
// that is not valid UTF-8 (git loads a pack by the bytes of its name).
// Returns the renamed .pack as a Buffer path.
function badBytePack(pack) {
  const dir = path.dirname(pack);
  const stem = path.basename(pack, '.pack');
  let renamed = null;
  for (const name of fs.readdirSync(dir).filter((n) => n.startsWith(`${stem}.`))) {
    const ext = name.slice(stem.length + 1);
    const to = Buffer.concat([Buffer.from(`${dir}/pack-`), Buffer.from([0xe9]), Buffer.from(`.${ext}`)]);
    fs.renameSync(path.join(dir, name), to);
    if (ext === 'pack') renamed = to;
  }
  assert.ok(renamed, 'the pack was renamed');
  return renamed;
}

test('a pack file whose name is not valid UTF-8, here or in an alternate, is never checked: unknown', (t) => {
  const { root, lockOut } = tempRoot(t);
  const own = storeRepo(path.join(root, 'own'));
  const ownPack = badBytePack(own.pack);
  assert.equal(M.placement(own.sha, { cwd: own.repo }), 'on', 'git loads the pack by the bytes of its name');
  assert.equal(M.placement(ghostSha(), { cwd: own.repo }), 'unknown', 'the walk does not check the name, so no miss is clean');
  lockOut(ownPack);
  assertSilentMiss(own.repo, own.sha);
  assert.equal(M.placement(own.sha, { cwd: own.repo }), 'unknown', 'round 9 read gone');

  const alt = storeRepo(path.join(root, 'alt'));
  const altPack = badBytePack(alt.pack);
  const front = makeRepo(t);
  writeAlternates(front, `${path.join(alt.repo, '.git', 'objects')}\n`);
  assert.equal(M.placement(alt.sha, { cwd: front.repo }), 'off', 'git reads the commit through the alternate');
  assert.equal(M.placement(ghostSha(), { cwd: front.repo }), 'unknown');
  lockOut(altPack);
  assertSilentMiss(front.repo, alt.sha);
  assert.equal(M.placement(alt.sha, { cwd: front.repo }), 'unknown', 'round 9 read gone');
});

test('a bare repo whose directory name ends in a space: the root store the walk cannot find is never no store', (t) => {
  const { root, lockOut } = tempRoot(t);
  const src = storeRepo(path.join(root, 'src'));
  const bare = path.join(root, 'bare ');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(src.repo, 'push', '-q', bare, 'main');
  git(bare, 'repack', '-q', '-a', '-d');
  assert.equal(fs.existsSync(R.commonDir({ cwd: bare })), false, 'the trimmed common dir names a path that does not exist');
  assert.equal(M.placement(src.sha, { cwd: bare }), 'on');
  assert.equal(M.placement(ghostSha(), { cwd: bare }), 'unknown', 'the walk cannot find the store, so no miss is clean');
  const packDir = path.join(bare, 'objects', 'pack');
  lockOut(path.join(packDir, fs.readdirSync(packDir).find((n) => n.endsWith('.pack'))));
  assertSilentMiss(bare, src.sha);
  assert.equal(M.placement(src.sha, { cwd: bare }), 'unknown', 'round 9 read gone');
});

test('a pack file listed and then gone (a concurrent repack) reads as readable', (t) => {
  const r = makeRepo(t);
  git(r.repo, 'repack', '-q', '-a', '-d');
  // A dangling link: readdirSync lists it, and reading it answers ENOENT,
  // the same answer as a pack unlinked between the listing and the check.
  fs.symlinkSync(path.join(r.repo, 'no-such-pack'), path.join(objectsOf(r), 'pack', 'tmp_pack_gone'));
  assert.equal(M.placement(ghostSha(), { cwd: r.repo }), 'gone');
  assert.equal(M.placement(r.C, { cwd: r.repo }), 'on', 'git still reads the real pack');
});

test('a watch marker with a null count stands and says the count is unknown', (t) => {
  const r = makeRepo(t);
  M.setWatch({ sha: r.C, deploy_at: null, count: null, by_issue: null, cwd: r.repo });
  assert.match(M.standing({ cwd: r.repo }).watch, new RegExp(`^BLOCKED: watch marker stands on ${short(r.C)} \\(unknown events since deploy\\);`));
});

test('setWatch writes a full sha git cannot resolve, its line names the full sha, and that sha acks it with a record', (t) => {
  const r = makeRepo(t);
  const ghost = ghostSha();
  assert.deepEqual(M.setWatch({ sha: ghost, count: 2, cwd: r.repo }), { written: true });
  assert.equal(M.watch({ cwd: r.repo }).resolved, false);
  M.setWatch({ sha: r.C, count: 1, cwd: r.repo });
  writeFlip(r, r.A);
  const line = M.standing({ cwd: r.repo }).watch;
  assert.match(line, new RegExp(`--ack-watch ${short(r.C)} --note`));
  assert.ok(line.includes(`behind it (${ghost})`), 'the earlier unresolved entry is named in full');
  assert.equal(M.clearWatch(r.C, { note: 'seen', cwd: r.repo }), true);
  assert.ok(M.standing({ cwd: r.repo }).watch.includes(`--ack-watch ${ghost} --note`));
  assert.equal(M.clearWatch(short(ghost), { cwd: r.repo }), false, 'a short form of an unresolved sha names nothing');
  const run = ['gh', 'p_'].join('') + 'Zq7'.repeat(12);
  assert.equal(M.clearWatch(ghost, { note: `checked ${run}`, cwd: r.repo }), true);
  assert.equal(M.watch({ cwd: r.repo }), null);
  const raw = fs.readFileSync(path.join(r.markerDir, 'acks.jsonl'), 'utf8');
  assert.equal(raw.includes(run), false, 'the note is masked');
  const acks = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(acks.map((a) => a.sha), [r.C, ghost]);
  assert.equal(acks[1].note, 'checked <TOKEN>');
});

test('a second watch on another sha stacks; a re-run on the same sha does not; each ack clears its own sha', (t) => {
  const r = makeRepo(t);
  M.setWatch({ sha: r.B, count: 2, cwd: r.repo });
  M.setWatch({ sha: r.C, count: 5, cwd: r.repo });
  const m = M.watch({ cwd: r.repo });
  assert.equal(m.sha, r.C);
  assert.deepEqual(m.earlier.map((e) => e.sha), [r.B]);
  assert.match(M.standing({ cwd: r.repo }).watch, new RegExp(`1 earlier watch marker stands behind it \\(${short(r.B)}\\)`));
  assert.equal(M.clearWatch(r.C, { cwd: r.repo }), true);
  const left = M.watch({ cwd: r.repo });
  assert.equal(left.sha, r.B);
  assert.equal(left.count, 2);
  assert.equal(left.earlier, undefined);
  assert.equal(M.clearWatch(r.B, { cwd: r.repo }), true);
  assert.equal(M.watch({ cwd: r.repo }), null);
  // An ack of an earlier sha clears that one and leaves the top standing.
  M.setWatch({ sha: r.B, count: 1, cwd: r.repo });
  M.setWatch({ sha: r.C, count: 1, cwd: r.repo });
  assert.equal(M.clearWatch(r.B, { cwd: r.repo }), true);
  assert.equal(M.watch({ cwd: r.repo }).sha, r.C);
  assert.equal(M.watch({ cwd: r.repo }).earlier, undefined);
  // A re-run on the same sha replaces its own entry; one ack clears it.
  M.setWatch({ sha: r.C, count: 4, cwd: r.repo });
  const again = M.watch({ cwd: r.repo });
  assert.equal(again.count, 4);
  assert.equal(again.earlier, undefined);
  assert.equal(M.clearWatch(r.C, { cwd: r.repo }), true);
  assert.equal(M.watch({ cwd: r.repo }), null);
});

test('an unreadable marker file reads as standing with the unreadable marker reason', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.markerDir, { recursive: true });
  for (const body of ['not json at all', 'null', '[]', '{}', JSON.stringify({ sha: 'abc1234' })]) {
    fs.writeFileSync(r.gateFile, body);
    fs.writeFileSync(r.watchFile, body);
    assert.deepEqual(M.gate({ cwd: r.repo }), { unreadable: true, path: r.gateFile }, body);
    assert.deepEqual(M.watch({ cwd: r.repo }), { unreadable: true, path: r.watchFile }, body);
    const s = M.standing({ cwd: r.repo });
    assert.equal(s.gate, `BLOCKED: gate marker stands (unreadable marker ${r.gateFile}); read it, then repair or remove the file by hand`, 'a refusal with the flip marker absent (lost)');
    assert.equal(s.watch, `BLOCKED: watch marker stands (unreadable marker ${r.watchFile}); read it, then repair or remove the file by hand`);
  }
  // With the flip file unreadable too, the lines are the same refusals.
  fs.writeFileSync(r.flipFile, 'torn');
  const s = M.standing({ cwd: r.repo });
  assert.equal(s.gate, `BLOCKED: gate marker stands (unreadable marker ${r.gateFile}); read it, then repair or remove the file by hand`);
  assert.equal(s.watch, `BLOCKED: watch marker stands (unreadable marker ${r.watchFile}); read it, then repair or remove the file by hand`);
  assert.match(s.flip, /^BLOCKED: the flip marker is unreadable; read it, then repair it by hand: write /);
  // Nothing clears, overwrites or passes an unreadable marker.
  assert.equal(M.clearGateIfDescendant(r.C, { cwd: r.repo }).cleared, false);
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), false);
  assert.deepEqual(M.setGate({ sha: r.C, reason: 'x', gates: [], cwd: r.repo }), { written: false, reason: `unreadable marker ${r.gateFile}` });
  assert.deepEqual(M.setWatch({ sha: r.C, count: 1, cwd: r.repo }), { written: false, reason: `unreadable marker ${r.watchFile}` });
  assert.equal(M.clearWatch(r.C, { cwd: r.repo }), false);
  assert.equal(fs.readFileSync(r.gateFile, 'utf8'), JSON.stringify({ sha: 'abc1234' }));
  // A watch file whose stack is malformed is unreadable too.
  fs.writeFileSync(r.watchFile, JSON.stringify({ sha: r.C, count: 1, earlier: [{ sha: 'nope' }] }));
  assert.equal(M.watch({ cwd: r.repo }).unreadable, true);
});

test('a marker path that cannot be read (a directory) stands as unreadable', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.gateFile, { recursive: true });
  assert.deepEqual(M.gate({ cwd: r.repo }), { unreadable: true, path: r.gateFile });
  assert.match(M.standing({ cwd: r.repo }).gate, /unreadable marker/);
});

// ---- the lock ------------------------------------------------------------------

function lockDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markers-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, lock: path.join(dir, '.lock') };
}

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

const holderFile = (lock, pid, at) => fs.writeFileSync(lock, JSON.stringify({ pid, at: new Date(at).toISOString(), token: 'held' }));

test('a live holder is never broken inside the bound; past the bound it is', (t) => {
  const { lock } = lockDir(t);
  holderFile(lock, process.pid, Date.now() - 2000);
  const before = fs.readFileSync(lock, 'utf8');
  let ran = false;
  assert.throws(() => M.withLock(lock, () => { ran = true; }, { waitMs: 300 }), /held by another writer/);
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(lock, 'utf8'), before, 'the holder is untouched');
  holderFile(lock, process.pid, Date.now() - 60_000);
  assert.equal(M.withLock(lock, () => 'in', { waitMs: 300 }), 'in');
  assert.equal(fs.existsSync(lock), false);
});

test('a dead holder is broken at once; an empty lock file is judged by its age', (t) => {
  const { dir, lock } = lockDir(t);
  holderFile(lock, deadPid(), Date.now());
  assert.equal(M.withLock(lock, () => 'in', { waitMs: 300 }), 'in');
  fs.writeFileSync(lock, '');
  assert.throws(() => M.withLock(lock, () => 1, { waitMs: 200 }), /held by another writer \(pid unknown\)/);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(M.withLock(lock, () => 'in', { waitMs: 300 }), 'in');
  assert.deepEqual(fs.readdirSync(dir), [], 'no lock and no broken file is left');
});

test('a breaker that finds a fresh lock where the dead one was links it back and waits', (t) => {
  const { dir, lock } = lockDir(t);
  holderFile(lock, deadPid(), Date.now());
  let swapped = 0;
  let ran = false;
  // Between the judgment and the rename, another waiter broke the dead lock
  // and took a fresh one of its own (a new file, a live pid).
  const beforeBreak = (file) => {
    swapped++;
    fs.rmSync(file);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'other' }));
  };
  assert.throws(() => M.withLock(lock, () => { ran = true; }, { waitMs: 300, beforeBreak }), /held by another writer/);
  assert.equal(swapped, 1, 'judged dead once; the fresh lock is never judged breakable');
  assert.equal(ran, false);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'other', 'the other waiter\'s lock is back in place');
  assert.deepEqual(fs.readdirSync(dir), ['.lock'], 'no broken file is left');

  // The same file overwritten in place (same inode, other bytes): the bytes
  // half of the identity check is what links it back.
  holderFile(lock, deadPid(), Date.now());
  const ino = fs.statSync(lock).ino;
  let inPlace = 0;
  const overwrite = (file) => {
    inPlace++;
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'in-place' }));
    assert.equal(fs.statSync(file).ino, ino, 'the swap kept the inode');
  };
  assert.throws(() => M.withLock(lock, () => { ran = true; }, { waitMs: 300, beforeBreak: overwrite }), /held by another writer/);
  assert.equal(inPlace, 1);
  assert.equal(ran, false);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'in-place');
  assert.deepEqual(fs.readdirSync(dir), ['.lock']);
});

test('the release never removes another holder\'s lock', (t) => {
  const { lock } = lockDir(t);
  M.withLock(lock, () => {
    const mine = JSON.parse(fs.readFileSync(lock, 'utf8'));
    assert.equal(mine.pid, process.pid);
    // Another holder took the path while this one ran.
    holderFile(lock, process.pid, Date.now());
  });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'held');
});

test('two breakers on one dead lock: exactly one enters, the other waits for it', async (t) => {
  const { dir, lock } = lockDir(t);
  const log = path.join(dir, 'order.log');
  const go = path.join(dir, 'go');
  holderFile(lock, deadPid(), Date.now());
  const code = [
    `const M = require(${JSON.stringify(path.join(__dirname, 'markers.js'))});`,
    "const fs = require('fs');",
    'const [lock, log, go] = process.argv.slice(1);',
    'while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);',
    'M.withLock(lock, () => {',
    "  fs.appendFileSync(log, 'enter ' + process.pid + '\\n');",
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);',
    "  fs.appendFileSync(log, 'exit ' + process.pid + '\\n');",
    '}, { waitMs: 5000 });',
  ].join('\n');
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code, lock, log, go], { stdio: 'ignore' });
    child.on('exit', (status) => resolve(status));
  });
  const both = Promise.all([run(), run()]);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  fs.writeFileSync(go, '');
  assert.deepEqual(await both, [0, 0]);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  const [e1, x1, e2, x2] = lines.map((l) => l.split(' '));
  assert.deepEqual([e1[0], x1[0], e2[0], x2[0]], ['enter', 'exit', 'enter', 'exit']);
  assert.equal(e1[1], x1[1]);
  assert.equal(e2[1], x2[1]);
  assert.notEqual(e1[1], e2[1]);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.lock')), [], 'no lock and no broken file is left');
});

// The gate's same-sha re-run (the gate-sha lane's ruling amending decision
// 16): with self the marker's own sha clears it, without self it never does,
// and a strict ancestor never clears it either way.
test('clearGateIfDescendant with self: the marker\'s own sha clears it; without self it does not', (t) => {
  const r = makeRepo(t);
  assert.equal(M.setGate({ sha: r.C, reason: 'money smoke: 1 failing', gates: ['money'], cwd: r.repo }).written, true);
  assert.equal(M.isFixForward(r.C, { cwd: r.repo }), false);
  assert.equal(M.isFixForward(r.C, { cwd: r.repo, self: true }), true);
  assert.equal(M.clearGateIfDescendant(r.C, { cwd: r.repo }).cleared, false, 'the failing sha is never its own fix by default');
  assert.equal(M.gate({ cwd: r.repo }).sha, r.C);
  assert.equal(M.clearGateIfDescendant(r.C, { cwd: r.repo, self: true }).cleared, true);
  assert.equal(M.gate({ cwd: r.repo }), null);
});

test('clearGateIfDescendant with self: a strict ancestor of the marker still never clears it', (t) => {
  const r = makeRepo(t);
  assert.equal(M.setGate({ sha: r.C, reason: 'money smoke: 1 failing', gates: ['money'], cwd: r.repo }).written, true);
  assert.equal(M.isFixForward(r.B, { cwd: r.repo, self: true }), false);
  assert.equal(M.clearGateIfDescendant(r.B, { cwd: r.repo, self: true }).cleared, false);
  assert.equal(M.gate({ cwd: r.repo }).sha, r.C);
});

test('the gate line names every check the marker names and the clearing rule, a refusal with the flip marker absent and present', (t) => {
  const r = makeRepo(t);
  M.setGate({ sha: r.B, reason: 'money smoke: 1 failing', gates: ['money', 'client'], cwd: r.repo });
  for (const flipped of [false, true]) {
    if (flipped) writeFlip(r, r.A);
    const line = M.standing({ cwd: r.repo }).gate;
    assert.ok(line.startsWith('BLOCKED: '), `flipped ${flipped}: ${line}`);
    assert.ok(line.includes('re-runs the checks this marker names (money, client; all of them once the failing sha is on origin/main or has left main, otherwise those its range still needs)'), line);
    assert.ok(line.includes('passes on this sha again or on a descendant on main'), line);
    assert.ok(line.endsWith(`last resort: remove ${r.gateFile} by hand`), line);
  }
});

// Step 5, lane gate-markers, item 3: a gates field that is missing or is not
// a list of names reads as naming every check, never as naming none.
test('a marker with no gates list, or one that is not a list of names, reads as naming every check', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.markerDir, { recursive: true });
  const base = { sha: r.B, at: '2026-10-22T06:00:00.000Z', reason: 'r' };
  for (const gates of [undefined, 'money', null, [], ['money', 3]]) {
    fs.writeFileSync(r.gateFile, JSON.stringify(gates === undefined ? base : { ...base, gates }));
    const line = M.standing({ cwd: r.repo }).gate;
    assert.ok(line.includes('the checks this marker names (no list recorded, so every check: static checks, money, client'), `${JSON.stringify(gates)}: ${line}`);
    assert.deepEqual(M.namedChecks(M.gate({ cwd: r.repo })), [...M.GATE_CHECKS], JSON.stringify(gates));
  }
  fs.writeFileSync(r.gateFile, JSON.stringify({ ...base, gates: ['client'] }));
  assert.deepEqual(M.namedChecks(M.gate({ cwd: r.repo })), ['client']);
  assert.ok(M.standing({ cwd: r.repo }).gate.includes('the checks this marker names (client;'));
});

// Step 5, lane gate-markers, item 1: a superseded failure (one a later
// failure on a descendant stands over) is kept under earlier until a failing
// run on a descendant re-proves every check it names; the gate hands setGate
// the checks it proved.
test('a superseded failure stays under earlier until a failing run on a descendant re-proves every check it names', (t) => {
  const r = makeRepo(t);
  M.setGate({ sha: r.B, reason: 'failed on B', gates: ['money'], cwd: r.repo });
  assert.deepEqual(M.setGate({ sha: r.C, reason: 'failed on C', gates: ['client'], proven: ['static checks'], cwd: r.repo }), { written: true });
  let g = M.gate({ cwd: r.repo });
  assert.equal(g.sha, r.C);
  assert.deepEqual(g.earlier.map((e) => [e.sha, e.gates]), [[r.B, ['money']]], 'the run on C never re-ran money');
  const D = commit(r.repo, 'later', { 'server/d.js': 'd\n' });
  M.setGate({ sha: D, reason: 'failed on D', gates: ['client'], proven: ['static checks', 'money'], cwd: r.repo });
  g = M.gate({ cwd: r.repo });
  assert.equal(g.sha, D);
  assert.deepEqual(g.earlier.map((e) => e.sha), [r.C], 'B is dropped once money passed on its descendant; C\'s client failure is not re-proved');
  assert.throws(() => M.setGate({ sha: D, gates: [], proven: 'money', cwd: r.repo }), /gates and proven must be lists/);
});

test('a failure on the standing sha again carries forward what that run left unproven', (t) => {
  const r = makeRepo(t);
  M.setGate({ sha: r.B, reason: 'first', gates: ['money', 'client'], cwd: r.repo });
  M.setGate({ sha: r.B, reason: 'again', gates: ['money'], proven: ['static checks'], cwd: r.repo });
  assert.deepEqual(M.gate({ cwd: r.repo }).gates, ['money', 'client'], 'client was never re-run');
  M.setGate({ sha: r.B, reason: 'third', gates: ['client'], proven: ['static checks', 'money'], cwd: r.repo });
  const g = M.gate({ cwd: r.repo });
  assert.deepEqual([g.reason, g.gates, g.earlier], ['third', ['client'], undefined]);
});

// Fix round 1, item 1: each earlier failure is named with its own checks and
// the exit that really clears it (the sha gate's rule), at most five of them.
test('the earlier suffix names each failure\'s checks and the exit that clears it, at most five then a count', (t) => {
  const r = makeRepo(t);
  fs.mkdirSync(r.markerDir, { recursive: true });
  const D = commit(r.repo, 'd', { 'server/d.js': 'd\n' });
  const E = commit(r.repo, 'e', { 'server/e.js': 'e\n' });
  const F = commit(r.repo, 'f', { 'server/f.js': 'f\n' });
  git(r.repo, 'update-ref', 'refs/remotes/origin/main', r.B);
  const entry = (sha, gates) => ({ sha, at: '2026-10-22T06:00:00.000Z', reason: 'r', ...(gates ? { gates } : {}) });
  const ghost = ghostSha();
  fs.writeFileSync(r.gateFile, JSON.stringify({ ...entry(F, ['client']), earlier: [entry(r.B, ['money']), entry(r.C, ['client', 'docs']), entry(r.S), entry(ghost, ['money']), entry(D, ['docs']), entry(E, ['money']), entry(r.A, ['client'])] }));
  const strict = 'cleared only by a later sha on main whose one pass re-runs every check it names';
  let line = M.standing({ cwd: r.repo }).gate;
  assert.ok(line.includes(`7 earlier failures stand with it: ${short(r.B)} (money; on main and origin/main, shipped untested: ${strict}), `), line);
  assert.ok(line.includes(`${short(r.C)} (client, docs; on main, not yet on origin/main: cleared by a descendant on main whose pass re-runs those of them its range still needs), `), line);
  assert.ok(line.includes(`${short(r.S)} (no list recorded, so every check: static checks, money, client, docs; off main: ${strict}), `), line);
  assert.ok(line.includes(`${short(ghost)} (money; gone: ${strict}), `), line);
  assert.ok(line.endsWith(`${short(D)} (docs; on main, not yet on origin/main: cleared by a descendant on main whose pass re-runs those of them its range still needs), and 2 more`), line);
  assert.equal(line.includes(short(E)), false, 'only the first five are named');
  assert.equal(line.split('\n').length, 1, 'one line');
  git(r.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
  line = M.standing({ cwd: r.repo }).gate;
  assert.ok(line.includes(`${short(r.C)} (client, docs; on main, origin/main not read: ${strict}), `), 'with no origin/main the stricter exit is named');
});
