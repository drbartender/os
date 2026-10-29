'use strict';

// Suite for scripts/merge-lane.sh ship (plan 2026-10-28 step 5, lane
// merge-ship, acceptance checks 1 to 3), beside the three merge suites, which
// are full. Every case runs in a throwaway os through the harness in
// scripts/lib/mergeShipTestkit.js (a local bare origin, its own copy of
// scripts/, real receipts, the flip marker in its common dir); the sha gate
// and the watch are its stubs, but in the docs-only case, which runs the real
// ones.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SUITE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-lane-ship-suite-'));
process.env.TMPDIR = SUITE_TMP;
process.env.MERGE_LANE_LOCK_WAIT = '2';
for (const k of Object.keys(process.env)) if (/^DRB_(SHIP|GATE)_|^MERGE_LANE_SHIP$/.test(k)) delete process.env[k];
test.after(() => fs.rmSync(SUITE_TMP, { recursive: true, force: true }));

const T = require('./lib/mergeShipTestkit');
const { WAIT_LINE } = require('./lib/mergeCheck');

const { K, git, commit, sleep, s7, setCfg, records, makeOs, lane, review, reviewCommentOnly, ship, logFile, lines, steps, textOf, settled, head, originMain, status, exists, patchKey, hookOnce } = T;

// One run per log: the first run's log moved aside, ending in its result
// (first), and the log now holding one run, with one result line.
function oneRunEach(h, tip, first) {
  const dir = path.join(h.common, 'drb-ship');
  const prev = fs.readdirSync(dir).filter((n) => n.startsWith(`${tip}.prev-`) && n.endsWith('.log') && !n.endsWith('.stdio.log'));
  assert.equal(prev.length, 1, `one moved-aside log: ${fs.readdirSync(dir).join(', ')}`);
  const old = lines(path.join(dir, prev[0]));
  assert.match(old.at(-1).split(' ').slice(2).join(' '), first);
  assert.equal(old.filter((l) => l.split(' ')[1] === 'result').length, 1, 'the moved log holds one run');
  const now = lines(logFile(h, tip));
  assert.equal(now.filter((l) => l.split(' ')[1] === 'result').length, 1, 'the new log holds one result line');
  assert.equal(now.at(-1).split(' ')[1], 'result');
  assert.equal(now[0].split(' ')[1], 'start', 'the new log starts with its own run');
}

test('the real run, detached: one squash with the 3.7 block, its squash receipt, one push, one watch, the worktree removed, the three checks logged, the branch deleted', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-real', { 'server/a.js': 'a v2\n' });
  const laneKey = review(t, h, 'lane-real');
  // The copy's worktree-rm.js, wrapped to record whether the ship lock is free when the cleanup starts.
  const rm = path.join(h.repo, 'scripts', 'worktree-rm.js');
  fs.renameSync(rm, path.join(h.repo, 'scripts', 'worktree-rm.real.js'));
  fs.writeFileSync(rm, `const { spawnSync } = require('child_process');\nrequire('fs').appendFileSync(${JSON.stringify(h.rec('rm'))}, String(spawnSync('flock', ['-n', ${JSON.stringify(h.lock)}, 'true']).status) + '\\n');\nrequire('./worktree-rm.real.js');\n`);
  const r = ship(h, 'lane-real');
  assert.equal(r.code, 0, r.all);
  assert.equal(r.stdout, `ready ${s7(tip)}: started in the background, log ${logFile(h, tip)}\n`, 'one stdout line naming the judged tip and the log');
  const res = await settled(h, tip);
  assert.equal(res.state, 'ok', res.lines.join('\n'));
  const squash = head(h);
  assert.equal(git(h.repo, 'rev-parse', 'HEAD~1'), h.seed, 'one squash commit on the pinned main');
  assert.equal(originMain(h), squash, 'pushed');
  const msg = git(h.repo, 'log', '-1', '--format=%B');
  assert.match(msg, /^merge\(lane lane-real\): docs\/plan\.md\n\nReview: tier B\n {2}lenses: {3}seams\n {2}files: {4}1\/1 verdicts\n {2}findings: 0 raised, 0 confirmed, 0 fixed and re-reviewed, 0 rejected\n {2}tests: {4}server\/a\.test\.js 4\/4\n {2}receipt: {2}patch [0-9a-f]{7}, reviewed against main [0-9a-f]{7}, /);
  assert.deepEqual(records(h.rec('gate')).map((x) => x.sha), [squash], 'the gate ran once, on the squash');
  const watched = records(h.rec('watch'));
  assert.deepEqual(watched.filter((x) => x.what === 'started').map((x) => [x.sha, x.holds]), [[squash, false]], 'one watch, holding no descriptor on the ship lock');
  const key = patchKey(h, squash);
  assert.equal(key, laneKey, 'main did not move: the squash key is the lane key');
  const rec = JSON.parse(fs.readFileSync(path.join(h.common, 'drb-review', key, 'receipt.json'), 'utf8'));
  assert.deepEqual([rec.kind, rec.key, rec.tip, rec.base, rec.source.key, rec.written_by], ['squash', key, squash, h.seed, laneKey, 'merge-lane.sh ship']);
  assert.equal(fs.readdirSync(path.join(h.common, 'drb-review', '_superseded')).filter((d) => d.startsWith(`${key}.`)).length, 1, 'the lane receipt moved aside');
  assert.deepEqual(steps(res.lines).filter((s, i, a) => a.indexOf(s) === i), ['start', 'lock', 'check', 'commit', 'receipt', 'ship', 'release', 'worktree', 'merged', 'branch', 'result']);
  const merged = textOf(res.lines, 'merged');
  assert.equal(merged.length, 3);
  assert.match(merged[0], new RegExp(`^pass squash on main: ${s7(head(h))} merge\\(lane lane-real\\): docs/plan\\.md$`));
  assert.match(merged[1], /^pass lane files on main: all 1 byte-identical \(README\.md and ARCHITECTURE\.md compared outside their generated sections\)$/);
  assert.match(merged[2], /^pass worktree: gone \(no worktree has lane-real checked out\)$/);
  assert.ok(!fs.existsSync(path.join(h.root, 'worktrees', 'lane-real')), 'the worktree is removed');
  assert.equal(fs.readFileSync(h.rec('rm'), 'utf8'), '0\n', 'the ship lock was already free when the cleanup started');
  assert.ok(!exists(h, 'refs/heads/lane-real'), 'the branch is deleted');
  assert.match(res.text, /^pushed [0-9a-f]{7}, 1 commits; the worktree removed, the three merged-lane checks passed, the branch lane-real deleted$/);
  assert.equal(status(h), '');
  const record = path.join(h.common, 'drb-ship', `${squash}.log`);
  assert.match(lines(record).at(-1), / result ok pushed /, "shipFlow's own record of the squash ends ok");
});

test('a cleanup error after the push: the worktree removal made to fail ends the log with the pushed result and a cleanup line naming it, never a failed result for a live sha', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-cf', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-cf');
  // The copy's worktree-rm.js fails, and from then on a git on PATH refuses git worktree list.
  const flag = path.join(h.root, 'rm-failed');
  fs.writeFileSync(path.join(h.repo, 'scripts', 'worktree-rm.js'), `require('fs').writeFileSync(${JSON.stringify(flag)}, '');\nprocess.exit(1);\n`);
  const shim = path.join(h.root, 'shim');
  fs.mkdirSync(shim);
  const real = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(shim, 'git'), `#!/usr/bin/env bash\nif [ "$1" = worktree ] && [ "$2" = list ] && [ -e '${flag}' ]; then echo 'fatal: a shim refuses worktree list' >&2; exit 128; fi\nexec '${real}' "$@"\n`, { mode: 0o755 });
  assert.equal(ship(h, 'lane-cf', [], { PATH: `${shim}:${process.env.PATH}` }).code, 0);
  const res = await settled(h, tip);
  assert.equal(res.state, 'ok', res.lines.join('\n'));
  assert.equal(originMain(h), head(h), 'pushed');
  assert.deepEqual(textOf(res.lines, 'cleanup'), ['the worktree step failed (git worktree failed (exit 128: fatal: a shim refuses worktree list)); the push stands']);
  assert.match(res.text, /^pushed [0-9a-f]{7}, 1 commits; the cleanup's worktree step failed \(git worktree failed \(exit 128: fatal: a shim refuses worktree list\)\); the branch lane-cf is kept \(the worktree merged-lane check failed\)$/);
  assert.equal(res.lines.at(-1).split(' ')[1], 'result', 'the log ends in the result');
  assert.ok(exists(h, 'refs/heads/lane-cf'), 'the branch is kept');
});

test('with no flip marker: the squash and its receipt land, the cue-only line ends it, nothing is gated or pushed, the worktree stays', async (t) => {
  const h = makeOs(t, { flip: false });
  const { tip } = lane(h, 'lane-cue', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-cue');
  const r = ship(h, 'lane-cue', ['--foreground']);
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, new RegExp(`^ready ${s7(tip)}: shipping in the foreground, log \\S+; no flip marker, so it stops after the squash receipt \\(cue-only\\)\\n`));
  const res = await settled(h, tip);
  assert.equal(res.state, 'cue-only');
  assert.match(res.text, /^no flip marker; pushes stay cue-only through npm run gate; the squash receipt is written, and the worktree and the branch stay until it is pushed; the squash [0-9a-f]{7} sits on main unpushed, and the same ship command resumes it$/);
  const squash = head(h);
  assert.match(git(h.repo, 'log', '-1', '--format=%s'), /^merge\(lane lane-cue\): docs\/plan\.md$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.common, 'drb-review', patchKey(h, squash), 'receipt.json'), 'utf8')).kind, 'squash');
  assert.equal(originMain(h), h.seed);
  assert.deepEqual(records(h.rec('gate')), []);
  assert.ok(fs.existsSync(path.join(h.root, 'worktrees', 'lane-cue')) && exists(h, 'refs/heads/lane-cue'), 'the worktree and the branch stay');
});

test('--no-push with the flip marker: the gate runs on the squash, nothing is pushed or watched, the result is ok-no-push', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-dry', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-dry');
  assert.equal(ship(h, 'lane-dry', ['--no-push']).code, 0);
  const res = await settled(h, tip);
  assert.equal(res.state, 'ok-no-push', res.lines.join('\n'));
  assert.deepEqual(records(h.rec('gate')).map((x) => x.sha), [head(h)]);
  assert.equal(originMain(h), h.seed, 'nothing pushed');
  assert.deepEqual(records(h.rec('watch')), []);
  assert.ok(exists(h, 'refs/heads/lane-dry'), 'the branch stays');
  assert.match(textOf(res.lines, 'release')[0], /released/);
});

test('a docs-only lane through the real gate and the real watch: nothing to run, pushed, no deploy expected', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-docs', { 'docs/notes.md': 'notes v2\n' });
  review(t, h, 'lane-docs', 'docs');
  const env = { DRB_SHIP_GATE_CMD: '', DRB_SHIP_WATCH_CMD: '' };
  assert.equal(ship(h, 'lane-docs', [], env).code, 0);
  const res = await settled(h, tip);
  assert.equal(res.state, 'ok', res.lines.join('\n'));
  const squash = head(h);
  assert.equal(originMain(h), squash);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.common, 'drb-gate', `${squash}.json`), 'utf8')).nothing_to_run, true);
  for (let i = 0; i < 100 && !lines(path.join(h.common, 'drb-ship', `${squash}.watch.log`)).some((l) => / result /.test(l)); i++) await sleep(100);
  assert.match(lines(path.join(h.common, 'drb-ship', `${squash}.watch.log`)).join('\n'), / result no deploy expected/);
});

test('a conflict stops the ship with a clean index naming the file; --resolved then ships the session\'s resolution', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-x', { 'README.md': 'readme\nlane prose\n', 'server/c.js': 'c\n' });
  review(t, h, 'lane-x');
  const moved = commit(h.repo, 'main prose', { 'README.md': 'readme\nmain prose\n' });
  git(h.repo, 'push', '-q', 'origin', 'main');
  assert.equal(ship(h, 'lane-x', ['--foreground']).code, 1);
  const res = await settled(h, tip);
  assert.equal(res.state, 'refused');
  assert.match(res.text, /^the squash refused: squash-merge of 'lane-x' hit a conflict in: README\.md/);
  assert.equal(head(h), moved);
  assert.equal(status(h), '', 'the index is clean');
  // The session's resolution (spec 4.1), and one more path staged by mistake.
  spawnSync('git', ['merge', '--squash', 'lane-x'], { cwd: h.repo });
  fs.writeFileSync(path.join(h.repo, 'README.md'), 'readme\nlane prose\nmain prose\n');
  fs.writeFileSync(path.join(h.repo, 'notes.txt'), 'not the lane\n');
  git(h.repo, 'add', '--', 'README.md', 'notes.txt');
  const extra = ship(h, 'lane-x', ['--resolved', '--foreground']);
  assert.equal(extra.code, 1);
  assert.match(extra.stdout, /^refused --resolved: the index stages notes\.txt, not the squash's own/);
  git(h.repo, 'restore', '--staged', '--', 'notes.txt');
  fs.rmSync(path.join(h.repo, 'notes.txt'));
  const ok = ship(h, 'lane-x', ['--resolved', '--foreground']);
  assert.equal(ok.code, 0, ok.all);
  const done = (await settled(h, tip)).lines;
  assert.match(done.at(-1), / result ok pushed /);
  oneRunEach(h, tip, /^refused the squash refused: squash-merge of 'lane-x' hit a conflict/);
  assert.equal(git(h.repo, 'show', 'HEAD:README.md'), 'readme\nlane prose\nmain prose');
  assert.equal(git(h.repo, 'show', 'HEAD:server/c.js'), 'c');
  assert.equal(git(h.repo, 'rev-parse', 'HEAD~1'), moved);
  const rec = JSON.parse(fs.readFileSync(path.join(h.common, 'drb-review', patchKey(h, head(h)), 'receipt.json'), 'utf8'));
  assert.equal(rec.kind, 'squash');
  assert.equal(status(h), '');
});

test('--resolved hardening: a resolution edited after git add refuses on its own line with nothing reset; a hook refusal resets nothing and prints no recovery line; red suites reset it and print the git restore that puts it back', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-rh', { 'README.md': 'readme\nlane prose\n', 'server/c.js': 'c\n' });
  review(t, h, 'lane-rh');
  commit(h.repo, 'main prose', { 'README.md': 'readme\nmain prose\n' });
  git(h.repo, 'push', '-q', 'origin', 'main');
  spawnSync('git', ['merge', '--squash', 'lane-rh'], { cwd: h.repo });
  fs.writeFileSync(path.join(h.repo, 'README.md'), 'readme\nlane prose\nmain prose\n');
  git(h.repo, 'add', '--', 'README.md');
  const staged = () => git(h.repo, 'diff', '--cached', '--name-only');
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'one more line\n');
  const mm = ship(h, 'lane-rh', ['--resolved', '--foreground']);
  assert.equal(mm.code, 1, mm.all);
  assert.equal(mm.stdout, 'refused --resolved: README.md was edited after git add (the working file is not the staged resolution): git add -- README.md stages the edit, then ship --resolved again; nothing was reset\n');
  assert.equal(staged(), 'README.md\nserver/c.js', 'the resolution stays staged');
  git(h.repo, 'restore', '--', 'README.md');
  hookOnce(h, ['exit 1']);
  const hooked = ship(h, 'lane-rh', ['--resolved', '--foreground']);
  assert.equal(hooked.code, 1, hooked.all);
  const one = await settled(h, tip);
  assert.match(one.text, /^the squash refused: the pre-commit hook refused the squash commit/);
  assert.doesNotMatch(hooked.stderr, /puts it back/, 'nothing was reset, so no recovery line');
  assert.equal(staged(), 'README.md\nserver/c.js');
  for (const f of ['hook-done', 'hooks/pre-commit']) fs.rmSync(path.join(h.common, f));
  fs.writeFileSync(path.join(h.repo, 'docs', 'flag.md'), 'bad\n');
  git(h.repo, 'commit', '-q', '-m', 'the flag goes bad', '--', 'docs/flag.md');
  git(h.repo, 'push', '-q', 'origin', 'main');
  const red = ship(h, 'lane-rh', ['--resolved', '--foreground']);
  assert.equal(red.code, 1, red.all);
  assert.match((await settled(h, tip)).text, /the receipt's suites failed on the merged tree/);
  const restore = /^ {2}(git restore --source=[0-9a-f]+ --staged --worktree -- .+)$/m.exec(red.stderr);
  assert.ok(restore, red.stderr);
  assert.equal(staged(), '', 'the refusal reset the resolution');
  assert.equal(spawnSync('bash', ['-c', restore[1]], { cwd: h.repo }).status, 0);
  assert.equal(staged(), 'README.md\nserver/c.js', 'the printed git restore puts it back');
});

test('--resolved after the regeneration: a hook refusal once step 7 rewrote README.md in the index prints no recovery line, the resolution and the render still staged', async (t) => {
  const h = makeOs(t, { genDocs: true });
  const { tip } = lane(h, 'lane-gd', { 'README.md': 'readme\nlane prose\n', 'server/c.js': 'c\n' });
  review(t, h, 'lane-gd');
  commit(h.repo, 'main prose', { 'README.md': 'readme\nmain prose\n' });
  git(h.repo, 'push', '-q', 'origin', 'main');
  spawnSync('git', ['merge', '--squash', 'lane-gd'], { cwd: h.repo });
  fs.writeFileSync(path.join(h.repo, 'README.md'), 'readme\nlane prose\nmain prose\n');
  git(h.repo, 'add', '--', 'README.md');
  hookOnce(h, ['exit 1']);
  const r = ship(h, 'lane-gd', ['--resolved', '--foreground']);
  assert.equal(r.code, 1, r.all);
  const res = await settled(h, tip);
  assert.match(res.text, /^the squash refused: the pre-commit hook refused the squash commit/);
  assert.match(git(h.repo, 'show', ':README.md'), /^readme\nlane prose\nmain prose\n<!-- the generated sections, rendered -->$/, 'step 7 rendered README.md into the index');
  assert.doesNotMatch(r.stderr, /puts it back/, 'only the docs moved, so no recovery line');
  assert.deepEqual(textOf(res.lines, 'squash').filter((l) => /reset the resolution/.test(l)), []);
  assert.equal(git(h.repo, 'diff', '--cached', '--name-only'), 'README.md\nserver/c.js', 'the resolution stays staged');
});

test('ready-moved re-runs the receipt\'s suites on the merged tree before the commit: a red run refuses with the reset, a green one ships through the gate', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-rm', { 'server/b.js': 'b v2\n' });
  review(t, h, 'lane-rm');
  const bad = commit(h.repo, 'the flag goes bad', { 'docs/flag.md': 'bad\n' });
  git(h.repo, 'push', '-q', 'origin', 'main');
  assert.equal(ship(h, 'lane-rm', ['--foreground']).code, 1);
  const red = await settled(h, tip);
  assert.equal(red.state, 'refused');
  assert.match(red.text, /the receipt's suites failed on the merged tree \(the run is above, or in the stdio log for a background run\); nothing is committed/);
  assert.match(textOf(red.lines, 'suites').join('\n'), /failed on the merged tree \(exit 1; not green: server\/a\.test\.js\)/);
  assert.equal(head(h), bad, 'nothing committed');
  assert.equal(status(h), '', 'the squash is reset');
  assert.deepEqual(records(h.rec('gate')), [], 'no gate ran');
  commit(h.repo, 'the flag is ok again', { 'docs/flag.md': 'ok\n' });
  git(h.repo, 'push', '-q', 'origin', 'main');
  const r = ship(h, 'lane-rm');
  assert.match(r.stdout, new RegExp(`^ready-moved ${s7(tip)}: started`));
  const green = await settled(h, tip);
  assert.equal(green.state, 'ok', green.lines.join('\n'));
  oneRunEach(h, tip, /^refused the squash refused: the receipt's suites failed/);
  const order = steps(green.lines);
  assert.ok(order.lastIndexOf('suites') < order.indexOf('commit') && order.indexOf('commit') < order.indexOf('ship'), 'the suites ran before the commit, the commit before the gate');
  assert.match(textOf(green.lines, 'suites').at(-1), /^the receipt's 1 suite\(s\) green on the merged tree, pass 1$/);
  const rec = JSON.parse(fs.readFileSync(path.join(h.common, 'drb-review', patchKey(h, head(h)), 'receipt.json'), 'utf8'));
  assert.deepEqual([rec.squash.suites.total_pass, rec.squash.suites.total_fail], [1, 0]);
  assert.ok(fs.existsSync(path.join(h.common, 'drb-review', rec.key, rec.squash.suites.log)), 'the re-run is in the squash receipt');
});

// A suite that runs a positional merge of its own, in a throwaway repo under
// its own temp dir, through the throwaway os's copy of merge-lane.sh.
const NESTED = ["'use strict';", "const test = require('node:test');", "const assert = require('node:assert');",
  "const { execFileSync, spawnSync } = require('node:child_process');", "const fs = require('node:fs');", "const os = require('node:os');", "const path = require('node:path');",
  "test('a positional merge in a throwaway repo of its own', () => {",
  "  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-merge-'));",
  "  const repo = path.join(root, 'os');",
  "  const wt = path.join(root, 'worktrees', 'lane');",
  "  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();",
  '  try {',
  "    fs.mkdirSync(repo);",
  "    g(repo, 'init', '-q', '-b', 'main');",
  "    g(repo, 'config', 'user.email', ['test', 'example.com'].join('@'));",
  "    g(repo, 'config', 'user.name', 'Test User');",
  "    g(repo, 'config', 'commit.gpgsign', 'false');",
  "    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\\n');",
  "    g(repo, 'add', 'a.txt');",
  "    g(repo, 'commit', '-q', '-m', 'seed');",
  "    g(repo, 'worktree', 'add', '-q', '-b', 'lane', wt, 'main');",
  "    fs.writeFileSync(path.join(wt, 'a.txt'), 'b\\n');",
  "    g(wt, 'commit', '-q', '-am', 'lane');",
  "    const r = spawnSync('bash', [path.join(__dirname, '..', 'scripts', 'merge-lane.sh'), 'lane', 'docs/plan.md'], { cwd: repo, encoding: 'utf8' });",
  "    assert.equal(r.status, 0, r.stdout + r.stderr);",
  "    assert.equal(g(repo, 'log', '-1', '--format=%s'), 'merge(lane lane): docs/plan.md');",
  '  } finally {',
  "    fs.rmSync(root, { recursive: true, force: true });",
  '  }',
  '});', ''].join('\n');

// A suite that records, beside the throwaway os, the environment it runs in.
const ENV_SUITE = ["'use strict';", "const test = require('node:test');", "const fs = require('node:fs');", "const path = require('node:path');",
  "const KEYS = ['MERGE_LANE_SHIP', 'MERGE_LANE_LOCKED', 'DRB_SHIP_LOCK', 'DRB_SHIP_LOCK_PID', 'DRB_DEVDB_LOCK_FILE'];",
  "test('records its environment', () => fs.writeFileSync(path.join(__dirname, '..', '..', 'suite-env.json'), JSON.stringify({ set: KEYS.filter((k) => k in process.env), root: process.env.RUN_SUITES_ROOT || null })));",
  ''].join('\n');

// A ready-moved ship with no flip marker: main moves by a docs commit after
// the review, so the receipt's suite (server/a.test.js) re-runs on the merged
// tree before the commit, and the run ends cue-only.
async function readyMovedSuite(t, suite, env = {}) {
  const h = makeOs(t, { flip: false, seed: { 'server/a.test.js': suite } });
  const { tip } = lane(h, 'lane-env', { 'server/b.js': 'b v2\n' });
  review(t, h, 'lane-env');
  commit(h.repo, 'main moves', { 'docs/other.md': 'other\n' });
  const r = ship(h, 'lane-env', [], env);
  assert.match(r.stdout, new RegExp(`^ready-moved ${s7(tip)}: started in the background`), r.all);
  return { h, res: await settled(h, tip) };
}

test('ready-moved re-runs a suite that runs a merge-lane.sh of its own: the nested merge is never taken for the ship\'s (no MERGE_LANE_SHIP or MERGE_LANE_LOCKED reaches it), and it runs green', async (t) => {
  const { h, res } = await readyMovedSuite(t, NESTED);
  assert.equal(res.state, 'cue-only', res.lines.join('\n'));
  assert.match(textOf(res.lines, 'suites').at(-1), /^the receipt's 1 suite\(s\) green on the merged tree, pass 1$/);
  assert.match(git(h.repo, 'log', '-1', '--format=%s'), /^merge\(lane lane-env\): docs\/plan\.md$/);
});

test('the re-run\'s environment: with the ship\'s four variables, RUN_SUITES_ROOT and DRB_DEVDB_LOCK_FILE exported first, the suite sees none of the four nor the lock file, and RUN_SUITES_ROOT is the repo top', async (t) => {
  const other = K.tmpDir(t, 'elsewhere');
  const env = { MERGE_LANE_SHIP: other, MERGE_LANE_LOCKED: '1', DRB_SHIP_LOCK: path.join(other, 'x.lock'), DRB_SHIP_LOCK_PID: '1', RUN_SUITES_ROOT: other, DRB_DEVDB_LOCK_FILE: path.join(other, 'devdb.lock') };
  const { h, res } = await readyMovedSuite(t, ENV_SUITE, env);
  assert.equal(res.state, 'cue-only', res.lines.join('\n'));
  const seen = JSON.parse(fs.readFileSync(path.join(h.root, 'suite-env.json'), 'utf8'));
  assert.deepEqual(seen, { set: [], root: fs.realpathSync(h.repo) });
});

// The way through when origin/main holds a commit main does not (the push-failure rule).
const BEHIND = /; bring origin's new commit into main first \(the owner's call by the push-failure rule, never an auto-pull or a force\), then the same ship command resumes the unpushed squash [0-9a-f]{7}$/;

test('a push rejection stops and reports: the bare remote advanced while the gate ran, nothing retried, the worktree stays, the ending and the resume\'s range refusal both naming the way through', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-rj', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-rj');
  const other = path.join(h.root, 'other');
  git(h.root, 'clone', '-q', h.origin, other);
  git(other, 'config', 'user.email', ['test', 'example.com'].join('@'));
  git(other, 'config', 'user.name', 'Test User');
  commit(other, 'elsewhere', { 'docs/elsewhere.md': 'x\n' });
  setCfg(h.gate, { advance: other });
  ship(h, 'lane-rj');
  const res = await settled(h, tip);
  assert.equal(res.state, 'failed', res.lines.join('\n'));
  assert.match(res.text, /^push rejected \(fetch first\): origin\/main moved since the fetch; nothing was pushed and nothing is retried; bring /);
  assert.match(res.text, BEHIND);
  assert.notEqual(originMain(h), head(h));
  assert.ok(exists(h, 'refs/heads/lane-rj'));
  assert.match(textOf(res.lines, 'release')[0], /released/);
  // The same ship command resumes into shipFlow's range refusal until main holds origin's commit.
  const again = ship(h, 'lane-rj');
  assert.equal(again.code, 0, again.all);
  assert.match(again.stdout, /^resume [0-9a-f]{7} of lane-rj: started in the background/);
  const range = await settled(h, tip);
  assert.equal(range.state, 'refused', range.lines.join('\n'));
  assert.match(range.text, /^[0-9a-f]{7} is not an ancestor of [0-9a-f]{7}; the range is not a push onto it; bring /);
  assert.match(range.text, BEHIND);
  assert.notEqual(originMain(h), head(h), 'nothing pushed');
});

test('the marker refusals of spec 4.4, before anything is merged: a standing watch marker, an unreadable gate marker, an unreadable flip marker', (t) => {
  const h = makeOs(t);
  lane(h, 'lane-m', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-m');
  const M = require(path.join(h.repo, 'scripts', 'lib', 'markers.js'));
  M.setWatch({ sha: h.seed, deploy_at: new Date().toISOString(), count: 3, by_issue: null, cwd: h.repo });
  const watch = ship(h, 'lane-m');
  assert.equal(watch.code, 1);
  assert.match(watch.stdout, /^refused BLOCKED[^\n]*watch[^\n]*\n$/i);
  M.clearWatch(h.seed, { note: 'read', cwd: h.repo });
  fs.mkdirSync(path.join(h.common, 'drb-markers'), { recursive: true });
  fs.writeFileSync(path.join(h.common, 'drb-markers', 'gate.json'), 'not json');
  assert.match(ship(h, 'lane-m').stdout, /^refused [^\n]*gate[^\n]*\n$/i);
  fs.rmSync(path.join(h.common, 'drb-markers', 'gate.json'));
  fs.writeFileSync(path.join(h.common, 'drb-flip.json'), 'not json');
  assert.match(ship(h, 'lane-m').stdout, /^refused BLOCKED: the flip marker \S+ is unreadable; repair or remove it by hand\n$/);
  assert.equal(head(h), h.seed, 'nothing merged');
  assert.equal(status(h), '');
  assert.deepEqual(records(h.rec('gate')), []);
});

test('a leaked test override refuses before the squash: DRB_SHIP_GATE_CMD without DRB_SHIP_ALLOW_STUBS=1 stops at the answer, main unmoved, the lane receipt in place', (t) => {
  const h = makeOs(t);
  lane(h, 'lane-lk', { 'server/a.js': 'a v2\n' });
  const key = review(t, h, 'lane-lk');
  const r = ship(h, 'lane-lk', [], { DRB_SHIP_ALLOW_STUBS: '' });
  assert.equal(r.code, 1, r.all);
  assert.match(r.stdout, /^refused DRB_SHIP_GATE_CMD is set; the test overrides run only with DRB_SHIP_ALLOW_STUBS=1, never in a real ship; DRB_SHIP_WATCH_CMD is set; [^\n]*\n$/);
  assert.equal(head(h), h.seed, 'nothing merged');
  assert.equal(status(h), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.common, 'drb-review', key, 'receipt.json'), 'utf8')).kind, 'lane', 'the lane receipt stands');
  assert.deepEqual(records(h.rec('gate')), []);
});

// Code the comment-only proof parses, a comment going in above line 5.
const C_JS = ["'use strict';", 'const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;', 'module.exports = { a, b, c, d, e };', ''].join('\n');

test('a comment-only lane whose squash would key other than its lane key refuses before the squash (main edited a line two above its hunk, the check reading ready), and ships once rebased and reviewed again', async (t) => {
  const h = makeOs(t, { seed: { 'server/c.js': C_JS } });
  const { wt } = lane(h, 'lane-cn', { 'server/c.js': C_JS.replace('const d = 4;', '// d is the fourth\nconst d = 4;') });
  const near = commit(h.repo, 'main edits a line beside the hunk', { 'server/c.js': C_JS.replace('const b = 2;', 'const b = 20;') });
  git(h.repo, 'push', '-q', 'origin', 'main');
  const key = reviewCommentOnly(t, h, 'lane-cn');
  // finalize keeps reviewed_against at the lane's base, so a real receipt reads
  // stale here (server/c.js moved on main); one that reads ready is edited by
  // hand, as the check's suite tampers a field.
  const recFile = path.join(h.common, 'drb-review', key, 'receipt.json');
  fs.writeFileSync(recFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(recFile, 'utf8')), reviewed_against: near }));
  assert.match(spawnSync('bash', [h.shell, 'check', 'lane-cn'], { cwd: h.repo, env: h.env, encoding: 'utf8' }).stdout, /^ready\n$/, 'the check reads it ready');
  const r = ship(h, 'lane-cn');
  assert.equal(r.code, 1, r.all);
  assert.match(r.stdout, /^refused the comment-only lane's squash would key as [0-9a-f]{7}, not its lane key [0-9a-f]{7} \(main changed the lines beside its hunks since the review's base\), so its proof would not cover the squash: rebase the lane onto main and review it again in stale-base mode\n$/);
  assert.equal(head(h), near, 'nothing merged');
  assert.equal(status(h), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.common, 'drb-review', key, 'receipt.json'), 'utf8')).kind, 'comment-only', 'the lane receipt stands');
  git(wt, 'rebase', '-q', 'main');
  const tip = git(wt, 'rev-parse', 'HEAD');
  reviewCommentOnly(t, h, 'lane-cn');
  const again = ship(h, 'lane-cn');
  assert.equal(again.code, 0, again.all);
  const res = await settled(h, tip);
  assert.equal(res.state, 'ok', res.lines.join('\n'));
  assert.match(textOf(res.lines, 'receipt')[0], /, kind comment-only, /);
  assert.equal(originMain(h), head(h));
});

test('a comment-only lane whose only conflict is README.md, with main\'s edit beside its hunk, refuses before the squash: its key is read from the tree merge-tree writes, the two docs set aside', async (t) => {
  const h = makeOs(t, { seed: { 'server/c.js': C_JS }, genDocs: true });
  lane(h, 'lane-cd', { 'server/c.js': C_JS.replace('const d = 4;', '// d is the fourth\nconst d = 4;'), 'README.md': 'readme\nlane prose\n' });
  const near = commit(h.repo, 'main edits beside the hunk and the readme', { 'server/c.js': C_JS.replace('const b = 2;', 'const b = 20;'), 'README.md': 'readme\nmain prose\n' });
  git(h.repo, 'push', '-q', 'origin', 'main');
  const key = reviewCommentOnly(t, h, 'lane-cd');
  const recFile = path.join(h.common, 'drb-review', key, 'receipt.json');
  fs.writeFileSync(recFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(recFile, 'utf8')), reviewed_against: near }));
  assert.match(spawnSync('bash', [h.shell, 'check', 'lane-cd'], { cwd: h.repo, env: h.env, encoding: 'utf8' }).stdout, /^ready\n$/, 'the check reads it ready');
  const r = ship(h, 'lane-cd');
  assert.equal(r.code, 1, r.all);
  assert.match(r.stdout, /^refused the comment-only lane's squash would key as [0-9a-f]{7}, not its lane key [0-9a-f]{7} \(main changed the lines beside its hunks since the review's base\)/);
  assert.equal(head(h), near, 'nothing merged');
  assert.equal(status(h), '');
  assert.equal(JSON.parse(fs.readFileSync(recFile, 'utf8')).kind, 'comment-only', 'the lane receipt stands');
  // Without the edit beside the hunk the key read ahead is the squash's: it ships.
  const g = makeOs(t, { seed: { 'server/c.js': C_JS }, genDocs: true });
  const { tip } = lane(g, 'lane-ce', { 'server/c.js': C_JS.replace('const d = 4;', '// d is the fourth\nconst d = 4;'), 'README.md': 'readme\nlane prose\n' });
  commit(g.repo, 'main edits the readme', { 'README.md': 'readme\nmain prose\n' });
  git(g.repo, 'push', '-q', 'origin', 'main');
  reviewCommentOnly(t, g, 'lane-ce');
  assert.equal(ship(g, 'lane-ce').code, 0);
  const res = await settled(g, tip);
  assert.equal(res.state, 'ok', res.lines.join('\n'));
  assert.match(textOf(res.lines, 'receipt')[0], /, kind comment-only, /);
});

test('the step 4 race cases through ship: a foreign stage during the hook stays staged for its window, and a commit from another window refuses the squash with nothing lost', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-r1', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-r1');
  hookOnce(h, ["printf 'other\\n' > other.txt", 'env -u GIT_INDEX_FILE git add -- other.txt']);
  assert.equal(ship(h, 'lane-r1', ['--foreground']).code, 0);
  const one = await settled(h, tip);
  assert.equal(one.state, 'ok', one.lines.join('\n'));
  assert.equal(status(h), 'A  other.txt', "the other window's file is still staged for it");
  assert.equal(git(h.repo, 'diff', '--name-only', 'HEAD~1', 'HEAD'), 'server/a.js', 'the squash carries the lane alone');
  git(h.repo, 'restore', '--staged', '--', 'other.txt');
  fs.rmSync(path.join(h.repo, 'other.txt'));
  for (const f of ['hook-done', 'hooks/pre-commit']) fs.rmSync(path.join(h.common, f));
  const { tip: tip2 } = lane(h, 'lane-r2', { 'server/b.js': 'b v2\n' });
  review(t, h, 'lane-r2');
  hookOnce(h, ["printf 'theirs\\n' > theirs.txt", 'env -u GIT_INDEX_FILE git add -- theirs.txt', "env -u GIT_INDEX_FILE git commit -q -m 'another window' -- theirs.txt"]);
  const before = head(h);
  assert.equal(ship(h, 'lane-r2', ['--foreground']).code, 1);
  const two = await settled(h, tip2);
  assert.equal(two.state, 'refused');
  assert.match(two.text, /^the squash refused: main moved under the commit/);
  assert.equal(git(h.repo, 'log', '-1', '--format=%s'), 'another window', "that window's commit is main's head");
  assert.equal(git(h.repo, 'rev-parse', 'HEAD~1'), before);
  assert.equal(git(h.repo, 'show', 'HEAD:theirs.txt'), 'theirs');
  assert.equal(status(h), '', 'the lane is reset');
  assert.ok(exists(h, 'refs/heads/lane-r2') && fs.existsSync(path.join(h.root, 'worktrees', 'lane-r2')), 'the lane stays');
});

test('serialization: a second ship queued behind the first waits for the lock, and takes it while the first ship\'s watch still runs', async (t) => {
  const h = makeOs(t);
  const one = lane(h, 'lane-s1', { 'server/a.js': 'a v2\n' });
  const two = lane(h, 'lane-s2', { 'server/b.js': 'b v2\n' });
  review(t, h, 'lane-s1');
  review(t, h, 'lane-s2');
  setCfg(h.gate, { hold: true });
  setCfg(h.watch, { hold: true });
  try {
    assert.equal(ship(h, 'lane-s1').code, 0);
    for (let i = 0; i < 600 && !fs.existsSync(path.join(h.root, 'gate-held')); i++) await sleep(50);
    assert.ok(fs.existsSync(path.join(h.root, 'gate-held')), 'the first ship holds the lock in its gate');
    const child = spawn('bash', [h.shell, 'ship', 'lane-s2', 'docs/plan.md'], { cwd: h.repo, env: h.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const second = { stdout: '', stderr: '' };
    child.stdout.on('data', (d) => { second.stdout += d; });
    child.stderr.on('data', (d) => { second.stderr += d; });
    const exited = new Promise((resolve) => child.on('close', resolve));
    for (let i = 0; i < 600 && !second.stderr.includes(WAIT_LINE); i++) await sleep(50);
    assert.ok(second.stderr.includes(WAIT_LINE), `the second ship waits: ${second.stderr}`);
    assert.equal(second.stdout, '', 'and answers nothing while the lock is held');
    fs.writeFileSync(path.join(h.root, 'gate-go'), '');
    assert.equal((await settled(h, one.tip)).state, 'ok');
    assert.equal(await exited, 0, second.stderr);
    assert.match(second.stdout, new RegExp(`^ready-moved ${s7(two.tip)}: started`));
    const res = await settled(h, two.tip);
    assert.equal(res.state, 'ok', res.lines.join('\n'));
    const first = records(h.rec('watch')).filter((x) => x.sha === git(h.repo, 'rev-parse', 'HEAD~1'));
    assert.deepEqual(first.map((x) => x.what), ['started', 'lock'], "the first ship's watch outlived its ship and the second ship, still waiting");
    assert.deepEqual([first[0].holds, first[1].free], [false, true], 'it held no descriptor on the ship lock and saw the lock free');
    assert.equal(originMain(h), head(h));
  } finally {
    fs.writeFileSync(path.join(h.root, 'gate-go'), '');
    fs.writeFileSync(path.join(h.root, 'watch-go'), '');
  }
  for (let i = 0; i < 200 && records(h.rec('watch')).filter((x) => x.what === 'done').length < 2; i++) await sleep(50);
});

test('the usage line names check, merged and ship only; a dirty os refuses before anything is merged', (t) => {
  const h = makeOs(t);
  for (const args of [['check'], ['ship'], ['ship', 'x'], ['ship', 'x', 'p', '--bogus'], ['merged', 'a', 'b']]) {
    const r = spawnSync('bash', [h.shell, ...args], { cwd: h.repo, env: h.env, encoding: 'utf8' });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^usage: /m);
    assert.doesNotMatch(r.stderr, /lock|locked|suites|\brun\b/, `${args.join(' ')} names no internal step`);
  }
  lane(h, 'lane-d', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-d');
  fs.writeFileSync(path.join(h.repo, 'loose.txt'), 'mine\n');
  const dirty = ship(h, 'lane-d');
  assert.equal(dirty.code, 1);
  assert.match(dirty.stdout, /^refused os has uncommitted changes \(loose\.txt\); the squash never merges into a dirty tree/);
  assert.equal(head(h), h.seed);
});
