'use strict';

// Suite for merge-lane.sh ship's resume and its phase record (plan 2026-10-28
// step 5, lane merge-ship, fix round 1): the same ship command again for a
// lane whose squash is on main and not yet pushed resumes it from shipFlow
// on, never reading the squash's own receipt as a stale lane; and lane:status
// prints a run's phase from its manifest. Beside
// scripts/merge-lane.ship.test.js, through the same harness
// (scripts/lib/mergeShipTestkit.js: a throwaway os with a local bare origin,
// its own copy of scripts/, real receipts, the gate and the watch stubbed).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SUITE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-lane-resume-suite-'));
process.env.TMPDIR = SUITE_TMP;
process.env.MERGE_LANE_LOCK_WAIT = '2';
for (const k of Object.keys(process.env)) if (/^DRB_(SHIP|GATE)_|^MERGE_LANE_SHIP$/.test(k)) delete process.env[k];
test.after(() => fs.rmSync(SUITE_TMP, { recursive: true, force: true }));

const T = require('./lib/mergeShipTestkit');

const { git, commit, sleep, s7, setCfg, records, makeOs, flipOn, lane, review, reviewCommentOnly, ship, logFile, lines, steps, textOf, settled, head, originMain, status, exists, patchKey, BEHIND, advancer } = T;
const C_JS = "module.exports = 'c';\n";
const UNPUSHED = /; the squash [0-9a-f]{7} sits on main unpushed, and the same ship command resumes it$/;

// The resume's run: skipped the check and the squash, logged the resume of
// `squash`, pushed main's head once with its watch, removed the worktree,
// logged the three merged-lane checks as passing and deleted the branch.
function resumedAndPushed(h, res, branch, squash, { gates = 1 } = {}) {
  assert.equal(res.state, 'ok', res.lines.join('\n'));
  const top = head(h);
  assert.equal(originMain(h), top, 'main\'s head is pushed');
  assert.ok(git(h.repo, 'merge-base', '--is-ancestor', squash, top) === '' && git(h.repo, 'log', '--format=%s', 'main').split('\n').filter((l) => l.startsWith(`merge(lane ${branch}): `)).length === 1, 'one squash, on main');
  const order = steps(res.lines);
  assert.deepEqual(['check', 'squash', 'commit', 'receipt'].filter((s) => order.includes(s)), [], 'no check, squash, commit or receipt step');
  assert.deepEqual(textOf(res.lines, 'resume'), [`squash ${s7(squash)} of ${branch}, unpushed`]);
  assert.equal(records(h.rec('gate')).filter((x) => x.sha === top).length, gates, 'the gate ran on main\'s head');
  assert.deepEqual(records(h.rec('watch')).filter((x) => x.what === 'started').map((x) => x.sha), [top], 'one watch, on main\'s head');
  const record = lines(path.join(h.common, 'drb-ship', `${top}.log`));
  assert.equal(record.filter((l) => / push pushed /.test(l)).length, 1, 'pushed once');
  const merged = textOf(res.lines, 'merged');
  assert.equal(merged.length, 3);
  assert.ok(merged.every((m) => m.startsWith('pass ')), merged.join('\n'));
  assert.ok(!fs.existsSync(path.join(h.root, 'worktrees', branch)), 'the worktree is removed');
  assert.ok(!exists(h, `refs/heads/${branch}`), 'the branch is deleted');
  assert.equal(status(h), '');
}

// A ship of `branch` whose run must answer resume.
async function resume(h, branch, tip, squash) {
  const r = ship(h, branch);
  assert.equal(r.code, 0, r.all);
  assert.ok(r.stdout.startsWith(`resume ${s7(squash)} of ${branch}: started in the background, log ${logFile(h, tip)}`) && r.stdout.split('\n').length === 2, r.stdout);
  return settled(h, tip);
}

test('a dry run, then the same ship command: it resumes the unpushed squash and pushes it once, the worktree removed, the three checks logged, the branch deleted', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-dr', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-dr');
  assert.equal(ship(h, 'lane-dr', ['--no-push']).code, 0);
  const dry = await settled(h, tip);
  assert.equal(dry.state, 'ok-no-push', dry.lines.join('\n'));
  assert.match(dry.text, UNPUSHED);
  const squash = head(h);
  resumedAndPushed(h, await resume(h, 'lane-dr', tip, squash), 'lane-dr', squash, { gates: 2 });
});

test('a commit on the lane after a dry run: the same ship command refuses before any push, naming the squash, the recorded lane tip and the commits since, main and the worktree untouched; with the squash receipt gone it refuses toward a review --commit', async (t) => {
  const h = makeOs(t);
  const { wt, tip } = lane(h, 'lane-lt', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-lt');
  assert.equal(ship(h, 'lane-lt', ['--no-push']).code, 0);
  assert.equal((await settled(h, tip)).state, 'ok-no-push');
  const squash = head(h);
  const later = commit(wt, 'one more lane commit', { 'server/b.js': 'b v2\n' });
  const r = ship(h, 'lane-lt');
  assert.equal(r.code, 1, r.all);
  assert.equal(r.stdout, `refused lane-lt is at ${s7(later)}, not the lane tip ${s7(tip)} its squash ${s7(squash)} records, with 1 commit since it, which a resume would strand; the way through is to push the squash, then a new review of the branch, never a resume; nothing was pushed\n`);
  assert.equal(head(h), squash, 'main untouched');
  assert.equal(originMain(h), h.seed, 'nothing pushed');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), later, 'the worktree untouched');
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(records(h.rec('gate')).length, 1, 'only the dry run gated');
  fs.rmSync(path.join(h.common, 'drb-review', patchKey(h, squash)), { recursive: true, force: true });
  const gone = ship(h, 'lane-lt');
  assert.equal(gone.code, 1, gone.all);
  assert.equal(gone.stdout, `refused the squash ${s7(squash)} on main has no receipt; a review --commit of it is the way through; nothing was pushed\n`);
  assert.equal(head(h), squash);
  assert.equal(originMain(h), h.seed);
});

test('a dry run, then the flip marker lost: the same ship command refuses the resume before any push with CUE_ONLY and the restore recipe, in the background and foreground forms (exit 1, the squash untouched, nothing more gated or pushed); restored, it resumes and pushes the squash', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-cq', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-cq');
  assert.equal(ship(h, 'lane-cq', ['--no-push']).code, 0);
  assert.equal((await settled(h, tip)).state, 'ok-no-push');
  const squash = head(h);
  const flip = path.join(h.common, 'drb-flip.json');
  fs.rmSync(flip);
  const recipe = require(path.join(h.repo, 'scripts', 'lib', 'markers.js')).flipRestore(flip);
  for (const flags of [[], ['--foreground']]) {
    const r = ship(h, 'lane-cq', flags);
    assert.deepEqual([r.code, r.stdout], [1, `refused no flip marker (lost since the flip of 2026-10-30); every push refuses until it is restored (npm run ship says how); ${recipe}; nothing was pushed\n`], `${flags.join(' ') || 'background'}: ${r.all}`);
  }
  assert.deepEqual([head(h), originMain(h), records(h.rec('gate')).length], [squash, h.seed, 1], 'the squash untouched, nothing more gated or pushed');
  flipOn(h);
  resumedAndPushed(h, await resume(h, 'lane-cq', tip, squash), 'lane-cq', squash, { gates: 2 });
});

test('a --resolved dry run, then the same ship command: the branch at the lane tip its squash records, the resume compares nothing and pushes the squash once; the worktree is removed and merged\'s docs check keeps the branch, the hand resolution of the prose not being the lane\'s own text', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-rd', { 'README.md': 'readme\nlane prose\n', 'server/c.js': 'c\n' });
  review(t, h, 'lane-rd');
  commit(h.repo, 'main prose', { 'README.md': 'readme\nmain prose\n' });
  git(h.repo, 'push', '-q', 'origin', 'main');
  spawnSync('git', ['merge', '--squash', 'lane-rd'], { cwd: h.repo });
  fs.writeFileSync(path.join(h.repo, 'README.md'), 'readme\nlane prose\nmain prose\n');
  git(h.repo, 'add', '--', 'README.md');
  const dry = ship(h, 'lane-rd', ['--resolved', '--no-push', '--foreground']);
  assert.equal(dry.code, 0, dry.all);
  const first = await settled(h, tip);
  assert.equal(first.state, 'ok-no-push', first.lines.join('\n'));
  assert.match(first.text, UNPUSHED);
  const squash = head(h);
  const res = await resume(h, 'lane-rd', tip, squash);
  assert.equal(res.state, 'ok', res.lines.join('\n'));
  assert.equal(originMain(h), squash, 'the squash is pushed');
  assert.deepEqual(textOf(res.lines, 'resume'), [`squash ${s7(squash)} of lane-rd, unpushed`]);
  assert.equal(records(h.rec('watch')).filter((x) => x.what === 'started').length, 1, 'one watch');
  assert.deepEqual(textOf(res.lines, 'worktree'), ['removed lane-rd (scripts/worktree-rm.js)']);
  assert.equal(textOf(res.lines, 'merged')[1], 'fail lane files on main: README.md differs from the branch outside its generated sections');
  assert.match(res.text, /; the branch lane-rd is kept \(the files merged-lane check failed\)$/);
  assert.ok(exists(h, 'refs/heads/lane-rd'), 'the branch is kept');
});

test('a comment-only lane: a dry run, then the same ship command resumes and pushes its squash', async (t) => {
  const h = makeOs(t, { seed: { 'server/c.js': C_JS } });
  const { tip } = lane(h, 'lane-co', { 'server/c.js': `// what c holds\n${C_JS}` });
  reviewCommentOnly(t, h, 'lane-co');
  assert.equal(ship(h, 'lane-co', ['--no-push']).code, 0);
  const first = await settled(h, tip);
  assert.equal(first.state, 'ok-no-push', first.lines.join('\n'));
  const squash = head(h);
  assert.match(textOf(first.lines, 'receipt')[0], /, kind comment-only, /);
  resumedAndPushed(h, await resume(h, 'lane-co', tip, squash), 'lane-co', squash, { gates: 2 });
});

test('a resume when main moved past the squash by a plain docs commit: main\'s head ships whole, both commits in the range', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-mv', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-mv');
  assert.equal(ship(h, 'lane-mv', ['--no-push']).code, 0);
  assert.equal((await settled(h, tip)).state, 'ok-no-push');
  const squash = head(h);
  const later = commit(h.repo, 'a plain docs commit', { 'docs/later.md': 'later\n' });
  const res = await resume(h, 'lane-mv', tip, squash);
  resumedAndPushed(h, res, 'lane-mv', squash);
  assert.equal(originMain(h), later);
  assert.match(textOf(res.lines, 'ship').find((l) => l.startsWith('range ')), new RegExp(`^range 2 commits: ${s7(squash)} merge\\(lane lane-mv\\)`));
});

test('a reverted squash refuses in ship as in check: after a dry run and a revert of its squash on main, the same ship command answers the revert line check prints (exit 1, no lane check, nothing merged past the revert, nothing gated or pushed), for a lane and for a comment-only lane, whose lane check would read ready-moved', async (t) => {
  for (const kind of ['lane', 'comment-only']) {
    const h = makeOs(t, { seed: { 'server/c.js': C_JS } });
    const { tip } = lane(h, 'lane-rv', kind === 'lane' ? { 'server/a.js': 'a v2\n' } : { 'server/c.js': `// what c holds\n${C_JS}` });
    if (kind === 'lane') review(t, h, 'lane-rv');
    else reviewCommentOnly(t, h, 'lane-rv');
    assert.equal(ship(h, 'lane-rv', ['--no-push']).code, 0);
    assert.equal((await settled(h, tip)).state, 'ok-no-push', kind);
    const squash = head(h);
    git(h.repo, 'revert', '--no-edit', squash);
    const revert = head(h);
    const way = `the squash ${s7(squash)} of lane-rv sits on main unpushed with its revert ${s7(revert)}; push the two (the revert needs a receipt of its own, a review --commit, its squash never having shipped), then a new review of the branch`;
    const r = ship(h, 'lane-rv');
    assert.deepEqual([r.code, r.stdout], [1, `refused ${way}\n`], `${kind}: ${r.all}`);
    assert.doesNotMatch(r.stderr, /check: receipt /, `${kind}: no lane check ran`);
    assert.deepEqual([head(h), originMain(h), records(h.rec('gate')).length], [revert, h.seed, 1], `${kind}: nothing merged past the revert, nothing more gated or pushed`);
    const c = spawnSync('bash', [h.shell, 'check', 'lane-rv'], { cwd: h.repo, env: h.env, encoding: 'utf8' });
    assert.deepEqual([c.status, c.stdout], [1, `refused ${way}\n`], c.stderr);
  }
});

test('a push rejection, then main\'s unpushed squash replayed onto origin\'s head (the way through the ending names): the same ship command resumes the replayed squash by its patch-id key and pushes it, the lane cleaned up; a merge of origin into main instead refuses with the squashes-only line and the same way through', async (t) => {
  for (const way of ['replay', 'merge']) {
    const h = makeOs(t);
    const { tip } = lane(h, 'lane-rp', { 'server/a.js': 'a v2\n' });
    review(t, h, 'lane-rp');
    advancer(h);
    assert.equal(ship(h, 'lane-rp').code, 0);
    const res = await settled(h, tip);
    assert.equal(res.state, 'failed', res.lines.join('\n'));
    assert.match(res.text, BEHIND, 'the rejection names the replay');
    setCfg(h.gate, { advance: null });
    const squash = head(h);
    git(h.repo, 'fetch', '-q', 'origin');
    const elsewhere = git(h.repo, 'rev-parse', 'refs/remotes/origin/main');
    if (way === 'replay') git(h.repo, 'rebase', '-q', elsewhere);
    else git(h.repo, 'merge', '-q', '--no-edit', 'origin/main'); // as a pull merges, by name
    if (way === 'replay') {
      const replayed = head(h);
      assert.notEqual(replayed, squash);
      assert.equal(git(h.repo, 'rev-parse', `${replayed}^`), elsewhere, 'the same hunks on origin\'s head');
      const r = ship(h, 'lane-rp');
      assert.equal(r.code, 0, r.all);
      assert.ok(r.stdout.startsWith(`resume ${s7(replayed)} of lane-rp: started in the background`), r.stdout);
      const done = await settled(h, tip);
      assert.equal(done.state, 'ok', done.lines.join('\n'));
      assert.deepEqual(textOf(done.lines, 'resume'), [`squash ${s7(replayed)} of lane-rp, unpushed, a replay of ${s7(squash)} (its receipt under the same patch-id key)`]);
      assert.equal(originMain(h), replayed, 'the replayed squash is pushed');
      assert.ok(!exists(h, 'refs/heads/lane-rp') && !fs.existsSync(path.join(h.root, 'worktrees', 'lane-rp')), 'the lane is cleaned up');
      continue;
    }
    const merge = head(h);
    const r = ship(h, 'lane-rp');
    assert.equal(r.code, 0, r.all);
    assert.ok(r.stdout.startsWith(`resume ${s7(squash)} of lane-rp: started in the background`), r.stdout);
    const done = await settled(h, tip);
    assert.equal(done.state, 'refused', done.lines.join('\n'));
    assert.match(done.text, new RegExp(`^${s7(merge)}: a merge commit; main holds squashes only; replay `));
    assert.match(done.text, BEHIND);
    assert.equal(originMain(h), elsewhere, 'nothing pushed');
  }
});

// A background ship held at its gate while `during` runs; its result once
// the gate goes on.
async function heldAtGate(h, branch, tip, during) {
  setCfg(h.gate, { hold: true });
  try {
    assert.equal(ship(h, branch).code, 0);
    for (let i = 0; i < 600 && !fs.existsSync(path.join(h.root, 'gate-held')); i++) await sleep(50);
    assert.ok(fs.existsSync(path.join(h.root, 'gate-held')), 'the run holds at its gate');
    during();
  } finally {
    fs.writeFileSync(path.join(h.root, 'gate-go'), '');
  }
  return settled(h, tip);
}

test('a lane commit landed while the background ship gated, putting a lane file back to its base content or dropping a file the lane added: the push stands, and the worktree and the branch are kept, named with the commit since the lane tip; lane:status shows the kept branch of that ok run, once more when the branch is gone, then no more', async (t) => {
  for (const shape of ['back to base', 'a dropped file']) {
    const h = makeOs(t);
    const files = shape === 'back to base' ? { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n' } : { 'server/a.js': 'a v2\n', 'server/new.js': 'new\n' };
    const { wt, tip } = lane(h, 'lane-sb', files);
    review(t, h, 'lane-sb');
    let later = null;
    const res = await heldAtGate(h, 'lane-sb', tip, () => {
      if (shape === 'back to base') later = commit(wt, 'a back to its base content', { 'server/a.js': 'a v1\n' });
      else {
        git(wt, 'rm', '-q', '--', 'server/new.js');
        git(wt, 'commit', '-q', '-m', 'drop the file the lane added');
        later = git(wt, 'rev-parse', 'HEAD');
      }
    });
    assert.equal(res.state, 'ok', `${shape}: ${res.lines.join('\n')}`);
    const squash = head(h);
    assert.equal(originMain(h), squash, `${shape}: the push stands`);
    const line = `lane-sb is at ${s7(later)}, not the lane tip ${s7(tip)} its squash ${s7(squash)} records, with 1 commit since it`;
    assert.equal(res.text, `pushed ${s7(squash)}, 1 commits; the branch lane-sb is kept for a new review (${line})`, shape);
    assert.deepEqual(textOf(res.lines, 'worktree'), [`kept: ${line}`], shape);
    assert.ok(exists(h, 'refs/heads/lane-sb') && git(h.repo, 'rev-parse', 'refs/heads/lane-sb') === later, `${shape}: the branch keeps the commit`);
    assert.ok(fs.existsSync(wt) && git(wt, 'status', '--porcelain') === '', `${shape}: the worktree stays`);
    const kept = `ship phase: lane-sb at ${s7(tip)} ended ok at ${endedAt(h, tip)}: the branch lane-sb is kept for a new review (${line})`;
    assert.deepEqual(phaseOf(h), [kept], `${shape}: the kept branch at the next read`);
    git(h.repo, 'worktree', 'remove', wt);
    git(h.repo, 'branch', '-D', 'lane-sb');
    assert.deepEqual(phaseOf(h), [kept], `${shape}: shown once more with the branch gone`);
    assert.deepEqual(phaseOf(h), [], `${shape}: then retired`);
  }
});

// A README.md with the generator's three sections (scripts/lib/genDocs/markers.js), its prose and its tree body as given.
const DOC = (prose, tree = 'tree v1') => ['# readme', '', prose, '', '<!-- gen:tree -->', tree, '<!-- /gen:tree -->', '', '<!-- gen:scripts -->', '<!-- /gen:scripts -->', '', '<!-- gen:env -->', '<!-- /gen:env -->', ''].join('\n');

test('a lane commit landed while the background ship gated that puts README.md prose back to its base text: the push stands, the worktree and the branch kept, named with the commit since the lane tip; a ship whose only conflict sits inside a generated section still deletes the branch', async (t) => {
  const h = makeOs(t, { seed: { 'README.md': DOC('base prose') } });
  const { wt, tip } = lane(h, 'lane-pr', { 'server/a.js': 'a v2\n', 'README.md': DOC('lane prose') });
  review(t, h, 'lane-pr');
  let later = null;
  const res = await heldAtGate(h, 'lane-pr', tip, () => {
    later = commit(wt, 'the readme prose back to its base text', { 'README.md': DOC('base prose') });
  });
  assert.equal(res.state, 'ok', res.lines.join('\n'));
  const squash = head(h);
  assert.equal(originMain(h), squash, 'the push stands');
  assert.deepEqual(textOf(res.lines, 'worktree'), [`kept: lane-pr is at ${s7(later)}, not the lane tip ${s7(tip)} its squash ${s7(squash)} records, with 1 commit since it`]);
  assert.ok(exists(h, 'refs/heads/lane-pr') && git(h.repo, 'rev-parse', 'refs/heads/lane-pr') === later, 'the branch keeps the commit');
  assert.ok(fs.existsSync(wt) && git(wt, 'status', '--porcelain') === '', 'the worktree stays');
  // The lane's change inside the tree section meets main's there: the shell takes main's side and renders it.
  const g = makeOs(t, { genDocs: true, seed: { 'README.md': DOC('base prose') } });
  const d = lane(g, 'lane-dd', { 'server/a.js': 'a v2\n', 'README.md': DOC('base prose', 'tree lane') });
  review(t, g, 'lane-dd');
  commit(g.repo, 'main renders the tree', { 'README.md': DOC('base prose', 'tree main') });
  git(g.repo, 'push', '-q', 'origin', 'main');
  assert.equal(ship(g, 'lane-dd').code, 0);
  const done = await settled(g, d.tip);
  assert.equal(done.state, 'ok', done.lines.join('\n'));
  assert.match(git(g.repo, 'show', 'HEAD:README.md'), /^# readme\n\nbase prose\n\n<!-- gen:tree -->\ntree main\n<!-- the generated sections, rendered -->\n<!-- \/gen:tree -->\n/, 'main\'s side, rendered inside the section');
  assert.match(done.text, /; the worktree removed, the three merged-lane checks passed, the branch lane-dd deleted$/);
  assert.ok(!exists(g, 'refs/heads/lane-dd'), 'the branch is deleted');
});

// The ship phase lines the throwaway's lane:status prints (its plain CLI).
function phaseOf(h) {
  const r = spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'lane-status.js')], { cwd: h.repo, env: h.env, encoding: 'utf8' });
  return r.stdout.split('\n').filter((l) => l.startsWith('ship phase: '));
}
const endedAt = (h, tip) => JSON.parse(fs.readFileSync(path.join(h.common, 'drb-ship', 'phase', `${tip}.json`), 'utf8')).ended_at;

test('lane:status shows the ship phase per lane: a refused background run with its result and end time, a run held at the gate with its step beside it, and the refused line still there once the other lane ends ok', async (t) => {
  const h = makeOs(t);
  const x = lane(h, 'lane-px', { 'README.md': 'readme\nlane prose\n', 'server/c.js': 'c\n' });
  review(t, h, 'lane-px');
  commit(h.repo, 'main prose', { 'README.md': 'readme\nmain prose\n' });
  git(h.repo, 'push', '-q', 'origin', 'main');
  assert.equal(ship(h, 'lane-px').code, 0, 'it starts in the background');
  assert.equal((await settled(h, x.tip)).state, 'refused');
  const refused = `ship phase: lane-px at ${s7(x.tip)} ended refused at ${endedAt(h, x.tip)}: the squash refused: squash-merge of 'lane-px' hit a conflict in: README.md`;
  assert.deepEqual(phaseOf(h), [refused]);
  const y = lane(h, 'lane-py', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-py');
  setCfg(h.gate, { hold: true });
  try {
    assert.equal(ship(h, 'lane-py').code, 0);
    for (let i = 0; i < 600 && !fs.existsSync(path.join(h.root, 'gate-held')); i++) await sleep(50);
    const held = phaseOf(h);
    assert.equal(held.length, 2, held.join('\n'));
    assert.match(held[0], new RegExp(`^ship phase: lane-py at ${s7(y.tip)}, ship since \\d{4}-\\d\\d-\\d\\dT\\S+Z$`));
    assert.equal(held[1], refused, 'the other lane\'s refused run');
  } finally {
    fs.writeFileSync(path.join(h.root, 'gate-go'), '');
  }
  assert.equal((await settled(h, y.tip)).state, 'ok');
  assert.deepEqual(phaseOf(h), [refused], 'a later lane\'s ok run hides no other lane\'s refused one');
});

test('a dry run\'s phase line says the squash sits unpushed until it reaches origin, then that it is on origin; check on the dry-run lane answers merged, unpushed, ship resumes it', async (t) => {
  const h = makeOs(t);
  const { tip } = lane(h, 'lane-oc', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-oc');
  assert.equal(ship(h, 'lane-oc', ['--no-push']).code, 0);
  const dry = await settled(h, tip);
  assert.equal(dry.state, 'ok-no-push', dry.lines.join('\n'));
  assert.match(dry.text, UNPUSHED);
  const squash = head(h);
  assert.deepEqual(phaseOf(h), [`ship phase: lane-oc at ${s7(tip)} ended ok-no-push at ${endedAt(h, tip)}: ${dry.text}`]);
  const c = spawnSync('bash', [h.shell, 'check', 'lane-oc'], { cwd: h.repo, env: h.env, encoding: 'utf8' });
  assert.deepEqual([c.status, c.stdout], [0, `merged ${s7(squash)} of lane-oc, unpushed; ship resumes it\n`], c.stderr);
  git(h.repo, 'push', '-q', 'origin', 'main');
  assert.deepEqual(phaseOf(h), [`ship phase: lane-oc at ${s7(tip)} ended ok-no-push at ${endedAt(h, tip)}: the squash ${s7(squash)} has since reached origin`]);
});

test('a dry run pushed by hand: its phase line says the squash has since reached origin while the branch stands, and once the worktree and the branch are gone it prints that once more and retires', async (t) => {
  const h = makeOs(t);
  const { wt, tip } = lane(h, 'lane-rt', { 'server/a.js': 'a v2\n' });
  review(t, h, 'lane-rt');
  assert.equal(ship(h, 'lane-rt', ['--no-push']).code, 0);
  assert.equal((await settled(h, tip)).state, 'ok-no-push');
  const squash = head(h);
  git(h.repo, 'push', '-q', 'origin', 'main');
  const line = `ship phase: lane-rt at ${s7(tip)} ended ok-no-push at ${endedAt(h, tip)}: the squash ${s7(squash)} has since reached origin`;
  assert.deepEqual(phaseOf(h), [line]);
  assert.deepEqual(phaseOf(h), [line], 'the branch stands, so the line stays');
  git(h.repo, 'worktree', 'remove', wt);
  git(h.repo, 'branch', '-D', 'lane-rt');
  assert.deepEqual(phaseOf(h), [line], 'printed once more');
  assert.deepEqual(phaseOf(h), [], 'then retired');
  const phaseDir = path.join(h.common, 'drb-ship', 'phase');
  const mine = fs.readdirSync(phaseDir).filter((n) => n.startsWith(`${tip}.`));
  assert.equal(mine.length, 1, mine.join(', '));
  assert.match(mine[0], new RegExp(`^${tip}\\.done-\\d+\\.json$`), 'moved to its .done- file');
});
