'use strict';

// Suite for scripts/lib/mergeShipSquash.js (plan 2026-10-28 step 5, lane
// merge-ship): the shell's first REFUSED line, verifyResolved, the squash
// receipt (its key, the supersede, a comment-only lane's kind, a failure that
// moves nothing) and findSquash. Every case runs in a throwaway os under the
// temp dir with the real sensitive list on its main, where check reads it;
// receipts are written through the review-receipt CLI
// (scripts/lib/receiptTestkit.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SUITE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-ship-squash-suite-'));
process.env.TMPDIR = SUITE_TMP;
for (const k of Object.keys(process.env)) if (/^DRB_(SHIP|GATE)_|^MERGE_LANE_SHIP$/.test(k)) delete process.env[k];
test.after(() => fs.rmSync(SUITE_TMP, { recursive: true, force: true }));

const K = require('./receiptTestkit');
const SM = require('../sensitive-match');
const R = require('./receipt');
const RC = require('./rangeCheck');
const MC = require('./mergeCheck');
const MS = require('./mergeShipSquash');

const { git, commit, tmpDir } = K;

function makeOs(t) {
  const repo = K.makeRepo(t);
  commit(repo, 'the sensitive list', { 'scripts/sensitive-paths.txt': fs.readFileSync(path.join(__dirname, '..', 'sensitive-paths.txt'), 'utf8') });
  return repo;
}

function lane(t, repo, branch, files) {
  const wt = path.join(tmpDir(t, 'wt'), branch);
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  return { wt, tip: commit(wt, `${branch} work`, files) };
}

let selects = 0;
function review(t, repo, branch) {
  K.ok(K.cli(repo, 'init', '--branch', branch));
  const base = git(repo, 'merge-base', 'main', branch);
  const files = git(repo, 'diff', '--name-only', base, branch).split('\n').filter((f) => f && f !== 'README.md' && f !== 'ARCHITECTURE.md');
  K.prepare(t, repo, branch, files, { tier: 'B' });
  const select = path.join(repo, '.git', `select-mss-${++selects}.json`);
  fs.writeFileSync(select, JSON.stringify({ tier: 'B', tiers_by_file: SM.tierFromGit({ base, tip: branch }, { cwd: repo }).tiersByFile }));
  K.ok(K.cli(repo, 'finalize', branch, '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', 'B', '--select', select, '--not-a-fix', 'a test lane'));
}

// A squash committed by hand, as the shell would land it.
function squashByHand(repo, branch, subject = `merge(lane ${branch}): docs/plan.md`) {
  git(repo, 'merge', '--squash', '-q', branch);
  git(repo, 'commit', '-q', '-m', subject);
  return git(repo, 'rev-parse', 'HEAD');
}

const patchKey = (repo, sha) => execFileSync('git', ['patch-id', '--stable'], { cwd: repo, encoding: 'utf8',
  input: execFileSync('git', ['diff', `${sha}^`, sha, '--', '.', ':!README.md', ':!ARCHITECTURE.md'], { cwd: repo }) }).trim().split(/\s+/)[0];

test('refusalOf: the shell\'s first REFUSED line, with the paths it lists under it', () => {
  const said = ['merge-lane: unstaged x', "REFUSED: squash-merge of 'lane-1' hit a conflict in:", '    a.js', '    b/c.js', '  Resolve per the rule.', 'REFUSED: a later one'].join('\n');
  assert.equal(MS.refusalOf(said), "squash-merge of 'lane-1' hit a conflict in: a.js, b/c.js");
  assert.equal(MS.refusalOf('REFUSED: main moved during the merge; nothing is committed.\n  Reset to HEAD: a.js.'), 'main moved during the merge; nothing is committed.');
  assert.equal(MS.refusalOf('all fine\n'), null);
});

test('verifyResolved: a dropped lane change, unmerged entries, an extra staged path and a clean squash are refused; the staged resolution is proved and named', (t) => {
  const repo = makeOs(t);
  const { tip } = lane(t, repo, 'lane-v', { 'README.md': 'readme\nlane prose\n', 'server/c.js': 'c\n' });
  commit(repo, 'main prose', { 'README.md': 'readme\nmain prose\n' });
  const r = { main: git(repo, 'rev-parse', 'HEAD'), tip, base: git(repo, 'merge-base', 'main', 'lane-v') };
  assert.match(MS.verifyResolved(repo, r).problem, /^the index holds server\/c\.js other than the squash merges it; only the conflicted paths \(README\.md\) may differ$/);
  spawnSync('git', ['merge', '--squash', 'lane-v'], { cwd: repo });
  assert.match(MS.verifyResolved(repo, r).problem, /unmerged entries/);
  fs.writeFileSync(path.join(repo, 'README.md'), 'readme\nlane prose\nmain prose\n');
  git(repo, 'add', '--', 'README.md');
  const v = MS.verifyResolved(repo, r);
  assert.deepEqual(v.conflicted, ['README.md']);
  assert.equal(git(repo, 'show', `${v.tree}:README.md`), 'readme\nlane prose\nmain prose');
  assert.equal(git(repo, 'show', `${v.tree}:server/c.js`), 'c');
  fs.writeFileSync(path.join(repo, 'extra.txt'), 'x\n');
  git(repo, 'add', '--', 'extra.txt');
  assert.match(MS.verifyResolved(repo, r).problem, /^the index stages extra\.txt, not the squash's own/);
  const { tip: clean } = lane(t, repo, 'lane-c', { 'server/d.js': 'd\n' });
  assert.match(MS.verifyResolved(repo, { ...r, tip: clean, base: r.main }).problem, /without a conflict; ship it without --resolved/);
});

test('writeSquashReceipt: under the patch id of parent..commit, the lane receipt superseded under the same key, the push check accepting it; a comment-only lane keeps its kind; a failure moves nothing', (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-w', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-w');
  const check = MC.checkLane({ cwd: repo, branch: 'lane-w' });
  assert.equal(check.state, 'ready', check.reason);
  // A failure: a symlink in the lane receipt's directory stops the copy, and nothing moves.
  fs.symlinkSync('/dev/null', path.join(check.dir, 'stray'));
  const squash = squashByHand(repo, 'lane-w');
  assert.throws(() => MS.writeSquashReceipt({ cwd: repo, squash, check, branch: 'lane-w' }), /not a file or a directory/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(check.dir, 'receipt.json'), 'utf8')).kind, 'lane', 'the lane receipt stands');
  assert.deepEqual(fs.readdirSync(R.reviewRoot({ cwd: repo })).filter((d) => d.startsWith('.squash-') || d === '_superseded'), []);
  fs.rmSync(path.join(check.dir, 'stray'));
  const w = MS.writeSquashReceipt({ cwd: repo, squash, check, branch: 'lane-w' });
  assert.equal(w.key, patchKey(repo, squash));
  assert.equal(w.key, check.laneKey, 'main did not move: the squash carries the lane key');
  const rec = JSON.parse(fs.readFileSync(path.join(w.dir, 'receipt.json'), 'utf8'));
  assert.deepEqual([rec.kind, rec.state, rec.tip, rec.base, rec.branch, rec.source.key, rec.source.kind, rec.squash.lane_tip], ['squash', 'final', squash, check.main, 'lane-w', check.key, 'lane', check.tip]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.superseded, 'receipt.json'), 'utf8')).kind, 'lane', 'the lane receipt is kept under _superseded');
  const rc = RC.checkRange({ base: check.main, tip: squash, cwd: repo });
  assert.equal(rc.ok, true, rc.problems.join('\n'));
  // A comment-only lane (its receipt's kind and proof file set by hand here).
  const repo2 = makeOs(t);
  lane(t, repo2, 'lane-o', { 'server/a.js': 'a v2\n' });
  review(t, repo2, 'lane-o');
  const c2 = MC.checkLane({ cwd: repo2, branch: 'lane-o' });
  const recFile = path.join(c2.dir, 'receipt.json');
  fs.writeFileSync(path.join(c2.dir, 'proof.json'), '{}\n');
  fs.writeFileSync(recFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(recFile, 'utf8')), kind: 'comment-only', proof: 'proof.json' }));
  const c2o = { ...c2, receipt: JSON.parse(fs.readFileSync(recFile, 'utf8')) };
  const sq2 = squashByHand(repo2, 'lane-o');
  assert.throws(() => MS.writeSquashReceipt({ cwd: repo2, squash: sq2, check: { ...c2o, laneKey: 'f'.repeat(40) }, branch: 'lane-o' }), /its proof does not cover the squash/);
  assert.equal(JSON.parse(fs.readFileSync(recFile, 'utf8')).kind, 'comment-only', 'nothing moved');
  const w2 = MS.writeSquashReceipt({ cwd: repo2, squash: sq2, check: c2o, branch: 'lane-o' });
  assert.equal(w2.kind, 'comment-only');
  assert.equal(RC.checkRange({ base: c2.main, tip: sq2, cwd: repo2 }).ok, true);
});

test('findSquash: the sha the shell handed back, else the first-parent commit on the pin with the merge(lane) subject, else none', (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-f', { 'server/a.js': 'a v2\n' });
  const main = git(repo, 'rev-parse', 'HEAD');
  const dir = tmpDir(t, 'run');
  const at = { main, branch: 'lane-f', plan: 'docs/plan.md' };
  assert.equal(MS.findSquash(repo, dir, at), null, 'main at the pin');
  const other = squashByHand(repo, 'lane-f', 'another window');
  assert.equal(MS.findSquash(repo, dir, at), null, 'another subject, no sha handed back');
  fs.writeFileSync(path.join(dir, 'commit'), `${other}\n`);
  assert.equal(MS.findSquash(repo, dir, at), other, 'the sha the shell wrote, on the pin');
  fs.rmSync(path.join(dir, 'commit'));
  git(repo, 'reset', '-q', '--hard', main);
  const squash = squashByHand(repo, 'lane-f');
  commit(repo, 'a later window', { 'docs/later.md': 'later\n' });
  assert.equal(MS.findSquash(repo, dir, at), squash, 'found by subject on the first-parent line');
});


test('findUnpushed: the newest commit of origin/main..main whose subject opens merge(lane <branch>): , else none; none without origin/main or once pushed', (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-u', { 'server/a.js': 'a v2\n' });
  assert.equal(MS.findUnpushed(repo, 'lane-u'), null, 'no origin/main');
  const origin = path.join(tmpDir(t, 'origin'), 'origin.git');
  git(repo, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  assert.equal(MS.findUnpushed(repo, 'lane-u'), null, 'main at origin/main');
  const squash = squashByHand(repo, 'lane-u');
  commit(repo, 'merge(lane lane-u2): docs/plan.md, another lane', { 'docs/other.md': 'x\n' });
  commit(repo, 'a later commit that names merge(lane lane-u): past its start', { 'docs/later.md': 'y\n' });
  assert.equal(MS.findUnpushed(repo, 'lane-u'), squash, 'found under later commits, by a subject that opens with it');
  assert.equal(MS.findUnpushed(repo, 'lane'), null, 'a prefix of the name is another lane');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  assert.equal(MS.findUnpushed(repo, 'lane-u'), null, 'pushed');
});

test('--resolved before the check: unmerged entries refuse, a staged path edited after git add refuses naming it and git add, a staged resolution passes; a conflict in a lane file is never resolved by hand', (t) => {
  const repo = makeOs(t);
  const { tip } = lane(t, repo, 'lane-k', { 'README.md': 'readme\nlane prose\n', 'server/a.js': 'a lane\n' });
  commit(repo, 'main edits both', { 'README.md': 'readme\nmain prose\n', 'server/a.js': 'a main\n' });
  const r = { main: git(repo, 'rev-parse', 'HEAD'), tip, base: git(repo, 'merge-base', 'main', 'lane-k') };
  assert.equal(MS.resolvedIndexProblem(repo), null, 'nothing staged, nothing edited');
  spawnSync('git', ['merge', '--squash', 'lane-k'], { cwd: repo });
  assert.match(MS.resolvedIndexProblem(repo), /^the index still holds unmerged entries/);
  fs.writeFileSync(path.join(repo, 'README.md'), 'readme\nlane prose\nmain prose\n');
  fs.writeFileSync(path.join(repo, 'server', 'a.js'), 'a both\n');
  git(repo, 'add', '--', 'README.md', 'server/a.js');
  assert.equal(MS.resolvedIndexProblem(repo), null);
  assert.equal(MS.verifyResolved(repo, r).problem, 'a conflict in server/a.js needs the rebase and the stale-base review, never a hand resolution');
  fs.appendFileSync(path.join(repo, 'README.md'), 'an edit after git add\n');
  assert.equal(MS.resolvedIndexProblem(repo), 'README.md was edited after git add (the working file is not the staged resolution): git add -- README.md stages the edit, then ship --resolved again; nothing was reset');
});

test('resumeProblem: a squash whose receipt is missing (or another commit\'s) refuses toward a review --commit; at the recorded lane tip it resumes; a branch past it names the squash, the tip and the commits since; a receipt with no lane tip resumes only while every lane file is on main', (t) => {
  const repo = makeOs(t);
  const { wt, tip } = lane(t, repo, 'lane-p', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-p');
  const check = MC.checkLane({ cwd: repo, branch: 'lane-p' });
  assert.equal(check.state, 'ready', check.reason);
  const squash = squashByHand(repo, 'lane-p');
  const s7 = (sha) => sha.slice(0, 7);
  const none = `the squash ${s7(squash)} on main has no receipt; a review --commit of it is the way through`;
  assert.equal(MS.resumeProblem(repo, 'lane-p', squash), none, 'the receipt under its key is the lane\'s, of another commit');
  const w = MS.writeSquashReceipt({ cwd: repo, squash, check, branch: 'lane-p' });
  assert.equal(MS.resumeProblem(repo, 'lane-p', squash), null, 'the branch is at the lane tip the receipt records');
  const later = commit(wt, 'one more lane commit', { 'server/b.js': 'b v2\n' });
  const moved = `lane-p is at ${s7(later)}, not the lane tip ${s7(tip)} its squash ${s7(squash)} records, with 1 commit since it, which a resume would strand; the way through is a new review of the branch once the squash is pushed or reverted, never a resume`;
  assert.equal(MS.resumeProblem(repo, 'lane-p', squash), moved);
  // A receipt a review --commit wrote: no lane tip, so merged's files check decides.
  const recFile = path.join(w.dir, 'receipt.json');
  const plain = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  delete plain.squash;
  fs.writeFileSync(recFile, JSON.stringify({ ...plain, kind: 'commit' }));
  assert.equal(MS.resumeProblem(repo, 'lane-p', squash), `the receipt of the squash ${s7(squash)} records no lane tip, and merged's files check names lane files main does not hold, which a resume would strand; the way through is a new review of the branch once the squash is pushed or reverted, never a resume`);
  git(wt, 'reset', '-q', '--hard', tip);
  assert.equal(MS.resumeProblem(repo, 'lane-p', squash), null, 'every lane file on main');
  fs.rmSync(w.dir, { recursive: true, force: true });
  assert.equal(MS.resumeProblem(repo, 'lane-p', squash), none);
});
