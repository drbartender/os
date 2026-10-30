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

test('unpushedOf and findUnpushed: a squash a later unpushed commit reverts (git revert\'s line for it) is named with its revert and is not resumable; a message naming its sha in passing is no revert; a newer squash of the lane is resumable again', (t) => {
  const repo = makeOs(t);
  const { wt } = lane(t, repo, 'lane-r', { 'server/a.js': 'a v2\n' });
  const origin = path.join(tmpDir(t, 'origin'), 'origin.git');
  git(repo, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const squash = squashByHand(repo, 'lane-r');
  commit(repo, `a note: This reverts commit ${squash} is a line git revert writes`, { 'docs/note.md': 'note\n' });
  assert.deepEqual(MS.unpushedOf(repo, 'lane-r'), { squash, revert: null }, 'the sha named in passing');
  assert.equal(MS.findUnpushed(repo, 'lane-r'), squash);
  git(repo, 'revert', '--no-edit', squash);
  const revert = git(repo, 'rev-parse', 'HEAD');
  assert.deepEqual(MS.unpushedOf(repo, 'lane-r'), { squash, revert });
  assert.equal(MS.findUnpushed(repo, 'lane-r'), null, 'a reverted squash is not resumable');
  assert.equal(MS.revertedLine('lane-r', { squash, revert }), `the squash ${squash.slice(0, 7)} of lane-r sits on main unpushed with its revert ${revert.slice(0, 7)}; push the two (the revert needs a receipt of its own, a review --commit, its squash never having shipped), then a new review of the branch`);
  commit(wt, 'more lane work', { 'server/b.js': 'b v2\n' });
  const again = squashByHand(repo, 'lane-r');
  assert.deepEqual(MS.unpushedOf(repo, 'lane-r'), { squash: again, revert: null }, 'the newer squash');
  assert.equal(MS.findUnpushed(repo, 'lane-r'), again);
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

test('resumeProblem: a squash whose receipt is missing (or another commit\'s) refuses toward a review --commit; at the recorded lane tip it resumes; a branch past it names the squash, the tip and the commits since; a receipt with no lane tip resumes only while the branch holds nothing the squash does not', (t) => {
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
  const moved = `lane-p is at ${s7(later)}, not the lane tip ${s7(tip)} its squash ${s7(squash)} records, with 1 commit since it, which a resume would strand; the way through is to push the squash, then a new review of the branch, never a resume`;
  assert.equal(MS.resumeProblem(repo, 'lane-p', squash), moved);
  // A receipt a review --commit wrote: no lane tip, so the trees decide.
  const recFile = path.join(w.dir, 'receipt.json');
  const plain = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  delete plain.squash;
  fs.writeFileSync(recFile, JSON.stringify({ ...plain, kind: 'commit' }));
  assert.equal(MS.resumeProblem(repo, 'lane-p', squash), `lane-p at ${s7(later)} holds what its squash ${s7(squash)} does not (its tree differs outside README.md and ARCHITECTURE.md), which a resume would strand; the way through is to push the squash, then a new review of the branch, never a resume`);
  git(wt, 'reset', '-q', '--hard', tip);
  assert.equal(MS.resumeProblem(repo, 'lane-p', squash), null, 'the branch holds nothing the squash does not');
  fs.rmSync(w.dir, { recursive: true, force: true });
  assert.equal(MS.resumeProblem(repo, 'lane-p', squash), none);
});

test('a receipt with no lane tip, and the branch against its squash: a lane commit putting a file back to its base content, or dropping a file the lane added, refuses the resume on the line the cleanup keeps the branch with; the trees agreeing, it resumes; a squash made on a moved main is held against the squash the branch would make there', (t) => {
  const repo = makeOs(t);
  const { wt, tip } = lane(t, repo, 'lane-t', { 'server/a.js': 'a v2\n', 'server/new.js': 'new\n' });
  review(t, repo, 'lane-t');
  commit(repo, 'main moves', { 'docs/other.md': 'other\n' });
  const check = MC.checkLane({ cwd: repo, branch: 'lane-t' });
  assert.equal(check.state, 'ready-moved', check.reason);
  const squash = squashByHand(repo, 'lane-t');
  const w = MS.writeSquashReceipt({ cwd: repo, squash, check, branch: 'lane-t' });
  const s7 = (sha) => sha.slice(0, 7);
  // A receipt a review --commit wrote: no lane tip.
  const recFile = path.join(w.dir, 'receipt.json');
  const plain = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  delete plain.squash;
  fs.writeFileSync(recFile, JSON.stringify({ ...plain, kind: 'commit' }));
  assert.equal(MS.resumeProblem(repo, 'lane-t', squash), null, 'the branch at the tip its squash was made of, on a moved main: it resumes');
  const way = 'which a resume would strand; the way through is to push the squash, then a new review of the branch, never a resume';
  const holds = (at) => `lane-t at ${s7(at)} holds what its squash ${s7(squash)} does not (its tree differs outside README.md and ARCHITECTURE.md)`;
  const back = commit(wt, 'a back to its base content', { 'server/a.js': 'a v1\n' });
  assert.equal(MS.resumeProblem(repo, 'lane-t', squash), `${holds(back)}, ${way}`, 'a revert to the base content');
  git(wt, 'reset', '-q', '--hard', tip);
  git(wt, 'rm', '-q', '--', 'server/new.js');
  git(wt, 'commit', '-q', '-m', 'drop the file the lane added');
  const drop = git(wt, 'rev-parse', 'HEAD');
  assert.equal(MS.resumeProblem(repo, 'lane-t', squash), `${holds(drop)}, ${way}`, 'a dropped file');
  // The cleanup's read: named with the commits since the lane tip the run squashed.
  assert.equal(MS.strandLine(repo, 'lane-t', squash, tip), `lane-t is at ${s7(drop)}, not the lane tip ${s7(tip)} its squash ${s7(squash)} records, with 1 commit since it`);
  assert.equal(MS.strandLine(repo, 'lane-t', squash), holds(drop));
  git(wt, 'reset', '-q', '--hard', tip);
  assert.equal(MS.resumeProblem(repo, 'lane-t', squash), null, 'the trees agree again');
  assert.equal(MS.strandLine(repo, 'lane-t', squash, tip), null);
  assert.equal(MS.strandLine(repo, 'no-such-lane', squash), null, 'no branch, nothing to strand');
});

test('squashRecord and resumeProblem over a replayed squash (the same hunks on a new parent): the earlier squash\'s receipt under the same key stands for it at the lane tip it records; a branch past that tip refuses; a receipt that records no squash stands for no replay', (t) => {
  const repo = makeOs(t);
  const { wt, tip } = lane(t, repo, 'lane-y', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-y');
  const check = MC.checkLane({ cwd: repo, branch: 'lane-y' });
  assert.equal(check.state, 'ready', check.reason);
  const pin = git(repo, 'rev-parse', 'HEAD');
  const squash = squashByHand(repo, 'lane-y');
  const w = MS.writeSquashReceipt({ cwd: repo, squash, check, branch: 'lane-y' });
  // The replay: main back at the pin, another commit on it, the squash picked onto that.
  git(repo, 'reset', '-q', '--hard', pin);
  commit(repo, 'elsewhere', { 'docs/elsewhere.md': 'x\n' });
  git(repo, 'cherry-pick', squash);
  const replayed = git(repo, 'rev-parse', 'HEAD');
  assert.notEqual(replayed, squash);
  assert.deepEqual(MS.squashRecord(repo, squash), { laneTip: tip, replayOf: null });
  assert.deepEqual(MS.squashRecord(repo, replayed), { laneTip: tip, replayOf: squash });
  assert.equal(MS.resumeProblem(repo, 'lane-y', replayed), null, 'at the recorded lane tip');
  const later = commit(wt, 'more lane work', { 'server/b.js': 'b v2\n' });
  const s7 = (sha) => sha.slice(0, 7);
  assert.match(MS.resumeProblem(repo, 'lane-y', replayed), new RegExp(`^lane-y is at ${s7(later)}, not the lane tip ${s7(tip)} its squash ${s7(replayed)} records, with 1 commit since it, which a resume would strand; `));
  git(wt, 'reset', '-q', '--hard', tip);
  const recFile = path.join(w.dir, 'receipt.json');
  const plain = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  delete plain.squash;
  fs.writeFileSync(recFile, JSON.stringify({ ...plain, kind: 'commit' }));
  assert.deepEqual(MS.squashRecord(repo, replayed), { problem: `the squash ${s7(replayed)} on main has no receipt; a review --commit of it is the way through` });
});

// A README.md with the generator's three sections (scripts/lib/genDocs/markers.js), its prose and its tree body as given.
const DOC = (prose, tree = 'tree v1') => ['# readme', '', prose, '', '<!-- gen:tree -->', tree, '<!-- /gen:tree -->', '', '<!-- gen:scripts -->', '<!-- /gen:scripts -->', '', '<!-- gen:env -->', '<!-- /gen:env -->', ''].join('\n');

test('the two docs by their prose: a lane commit putting README.md prose back to its base text is held against the squash, refusing the resume with a recorded lane tip and without; a change inside the generated sections, and a docs-only conflict there, is not', (t) => {
  const repo = makeOs(t);
  commit(repo, 'the readme sections', { 'README.md': DOC('base prose') });
  const { wt, tip } = lane(t, repo, 'lane-d', { 'server/a.js': 'a v2\n', 'README.md': DOC('lane prose') });
  review(t, repo, 'lane-d');
  const check = MC.checkLane({ cwd: repo, branch: 'lane-d' });
  assert.equal(check.state, 'ready', check.reason);
  const squash = squashByHand(repo, 'lane-d');
  const w = MS.writeSquashReceipt({ cwd: repo, squash, check, branch: 'lane-d' });
  const s7 = (sha) => sha.slice(0, 7);
  assert.equal(MS.strandLine(repo, 'lane-d', squash, tip), null, 'the branch at the lane tip its squash carries');
  const back = commit(wt, 'the readme prose back to its base text', { 'README.md': DOC('base prose') });
  const way = 'which a resume would strand; the way through is to push the squash, then a new review of the branch, never a resume';
  const holds = `lane-d at ${s7(back)} holds what its squash ${s7(squash)} does not (README.md differs outside its generated sections)`;
  assert.equal(MS.strandLine(repo, 'lane-d', squash, tip), `lane-d is at ${s7(back)}, not the lane tip ${s7(tip)} its squash ${s7(squash)} records, with 1 commit since it`, 'the cleanup\'s read');
  assert.equal(MS.strandLine(repo, 'lane-d', squash), holds);
  assert.equal(MS.resumeProblem(repo, 'lane-d', squash), `lane-d is at ${s7(back)}, not the lane tip ${s7(tip)} its squash ${s7(squash)} records, with 1 commit since it, ${way}`, 'with a recorded lane tip');
  const recFile = path.join(w.dir, 'receipt.json');
  const plain = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  delete plain.squash;
  fs.writeFileSync(recFile, JSON.stringify({ ...plain, kind: 'commit' }));
  assert.equal(MS.resumeProblem(repo, 'lane-d', squash), `${holds}, ${way}`, 'with no lane tip recorded (a review --commit receipt)');
  // A lane commit inside a generated section only: the squash carries all the lane's prose.
  git(wt, 'reset', '-q', '--hard', tip);
  commit(wt, 'a tree body the generator would rewrite', { 'README.md': DOC('lane prose', 'tree by hand') });
  assert.equal(MS.resumeProblem(repo, 'lane-d', squash), null, 'a change inside the sections is the generator\'s');
  // A docs-only conflict inside a section, the squash taking main's side and a render, as the shell's step 5 does.
  const g = lane(t, repo, 'lane-g', { 'server/b.js': 'b v2\n', 'README.md': DOC('lane prose', 'tree lane') });
  commit(repo, 'main renders the tree', { 'README.md': DOC('lane prose', 'tree main') });
  assert.equal(spawnSync('git', ['merge', '--squash', 'lane-g'], { cwd: repo }).status, 1, 'README.md conflicts inside the tree section');
  git(repo, 'checkout', '--ours', '--', 'README.md');
  fs.writeFileSync(path.join(repo, 'README.md'), DOC('lane prose', 'tree rendered'));
  git(repo, 'add', '--', 'README.md');
  git(repo, 'commit', '-q', '-m', 'merge(lane lane-g): docs/plan.md');
  const docsOnly = git(repo, 'rev-parse', 'HEAD');
  assert.equal(MS.strandLine(repo, 'lane-g', docsOnly, g.tip), null, 'the conflict markers sit inside the section and blank away');
  assert.equal(MS.strandLine(repo, 'lane-g', docsOnly), null);
});

test('a comparison that cannot be made is never the strand advice: a branch whose merge onto the squash\'s parent conflicts in a lane path (a replay resolved by hand, its review --commit receipt naming no lane tip), which no retry clears, refuses the resume with the hand way through and the cleanup keeps it to be compared by hand; a git fault (a squash with no parent) takes "run the same command again" and is kept to be compared again by hand', (t) => {
  const repo = makeOs(t);
  const { tip } = lane(t, repo, 'lane-q', { 'server/a.js': 'a lane\n' });
  review(t, repo, 'lane-q');
  const check = MC.checkLane({ cwd: repo, branch: 'lane-q' });
  assert.equal(check.state, 'ready', check.reason);
  const parent = commit(repo, 'origin edits the same line', { 'server/a.js': 'a main\n' });
  assert.equal(spawnSync('git', ['merge', '--squash', 'lane-q'], { cwd: repo }).status, 1, 'the replay conflicts');
  fs.writeFileSync(path.join(repo, 'server', 'a.js'), 'a both\n');
  git(repo, 'add', '--', 'server/a.js');
  git(repo, 'commit', '-q', '-m', 'merge(lane lane-q): docs/plan.md');
  const squash = git(repo, 'rev-parse', 'HEAD');
  const w = MS.writeSquashReceipt({ cwd: repo, squash, check, branch: 'lane-q' });
  const recFile = path.join(w.dir, 'receipt.json');
  const plain = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  delete plain.squash;
  fs.writeFileSync(recFile, JSON.stringify({ ...plain, kind: 'commit' }));
  const s7 = (sha) => sha.slice(0, 7);
  const line = `lane-q at ${s7(tip)} could not be compared with its squash ${s7(squash)} (merged onto ${s7(parent)} it conflicts in server/a.js)`;
  assert.equal(MS.resumeProblem(repo, 'lane-q', squash), `${line}; the squash is pushed by hand (npm run ship after the flip), then a new review of the branch`);
  const conflict = MS.strandOf(repo, 'lane-q', squash);
  assert.deepEqual(conflict, { tip, line, retry: false, hand: true });
  assert.deepEqual(MS.branchOutcome(repo, 'lane-q', null, conflict, tip), { said: `lane-q is kept: ${line}`, text: `the branch lane-q is kept to be compared by hand (${line})`, shown: true });
  // A git fault: the squash named is a root commit, with no parent to merge onto.
  const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD');
  const fault = MS.strandOf(repo, 'lane-q', root);
  assert.deepEqual(fault, { tip, line: `lane-q at ${s7(tip)} could not be compared with its squash ${s7(root)} (${s7(root)} has no parent)`, retry: true, hand: false });
  assert.equal(MS.branchOutcome(repo, 'lane-q', null, fault, tip).text, `the branch lane-q is kept to be compared again by hand (${fault.line})`);
  assert.ok(git(repo, 'rev-parse', 'refs/heads/lane-q') === tip, 'kept');
});

test('the branch delete and a worktree holding the lane branch: a lane window\'s git rebase stopped at a conflict, its HEAD detached and the branch at the tip compared, keeps the branch, named in the result and shown, as git branch -D refuses it, and its rebase --continue then lands on the branch; a rebase-apply or a bisect the same, dropAt asking right before the delete; the plain state deletes', (t) => {
  const repo = makeOs(t);
  const base = git(repo, 'rev-parse', 'main');
  const { wt, tip } = lane(t, repo, 'lane-ru', { 'server/a.js': 'a lane\n' });
  squashByHand(repo, 'lane-ru');
  const passed = { ok: true, checks: ['squash', 'files', 'worktree'].map((name) => ({ name, ok: true, text: name })) };
  // The lane window rebases onto a commit that edits the lane's line its own way, and the rebase stops at the conflict.
  const sideWt = path.join(tmpDir(t, 'side'), 'side');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', sideWt, base);
  commit(sideWt, 'a side', { 'server/a.js': 'a side\n' });
  const editor = { ...process.env, GIT_EDITOR: 'true' };
  assert.notEqual(spawnSync('git', ['rebase', 'side'], { cwd: wt, env: editor }).status, 0, 'the rebase stops at the conflict');
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: wt }).status, 1, 'its HEAD detached');
  assert.equal(git(repo, 'rev-parse', 'refs/heads/lane-ru'), tip, 'the branch where it was');
  assert.equal(MS.worktreeOf(repo, 'lane-ru'), null, 'no worktree has it checked out');
  const held = `${wt} is rebasing lane-ru`;
  assert.deepEqual(MS.branchOutcome(repo, 'lane-ru', passed, null, tip), { said: `lane-ru is kept: ${held}`, text: `the branch lane-ru is kept (${held})`, shown: true });
  assert.equal(git(repo, 'rev-parse', 'refs/heads/lane-ru'), tip, 'kept');
  assert.match(spawnSync('git', ['branch', '-D', 'lane-ru'], { cwd: repo, encoding: 'utf8' }).stderr, /used by worktree/, 'git branch -D refuses the same state');
  // The resolution lands on the branch, which is there to take it.
  fs.writeFileSync(path.join(wt, 'server', 'a.js'), 'a both\n');
  git(wt, 'add', '--', 'server/a.js');
  execFileSync('git', ['rebase', '--continue'], { cwd: wt, env: editor, stdio: 'ignore' });
  const landed = git(repo, 'rev-parse', 'refs/heads/lane-ru');
  assert.notEqual(landed, tip, 'the rebased commit is on the branch');
  assert.equal(git(wt, 'symbolic-ref', 'HEAD'), 'refs/heads/lane-ru');
  // A rebase-apply or a bisect, as git leaves them in the worktree's git dir, HEAD detached at the branch tip.
  const dir = git(wt, 'rev-parse', '--absolute-git-dir');
  for (const [file, text, op] of [['rebase-apply/head-name', 'refs/heads/lane-ru', 'rebasing'], ['BISECT_START', 'lane-ru', 'bisecting']]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${text}\n`);
    git(wt, 'update-ref', '--no-deref', 'HEAD', landed);
    assert.deepEqual(MS.dropAt(repo, 'lane-ru', landed), { deleted: false, now: landed, inUse: { path: wt, op, text: `${wt} is ${op} lane-ru` } }, file);
    assert.equal(git(repo, 'rev-parse', 'refs/heads/lane-ru'), landed, `${file}: kept`);
    fs.rmSync(path.join(dir, file.split('/')[0]), { recursive: true, force: true });
  }
  // The plain detached state, where git branch -D deletes too.
  assert.deepEqual(MS.dropAt(repo, 'lane-ru', landed), { deleted: true });
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/lane-ru'], { cwd: repo }).status, 1, 'deleted');
});
