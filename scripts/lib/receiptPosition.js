'use strict';

// The position snapshot (instruction rewrite step 2, lane receipt-lib;
// scripts/review-receipt.js `position`). A verdict holds for the content its
// lens read, so a stored report records where the lens's input was taken, not
// where the branch stood when the report came back: `position <name>` runs
// right before the input is taken (review-brief runs it when it writes the
// diff; until then the skill runs it by hand) and again before any
// re-dispatch, and writes <work dir>/position.json:
//   seq    one more than the highest of the last snapshot's seq and the
//          position of every stored report, test entry (superseded too) and
//          external, so a lost or replaced position.json never reuses a seq
//          a stored entry carries; 1 for the first
//   tip    the branch tip (lane), HEAD (quick fix), the commit (commit review)
//   tree   the staged tree, git write-tree (quick fix; null otherwise)
//   head   the checkout's HEAD (commit review only): its tests run on the
//          commit's own tree, so a test entry is stored only while HEAD,
//          at the snapshot and at the store, is the commit
//   main   refs/heads/main
//   overlap  the main commit this snapshot is the overlap pass against
//          (`position <name> --overlap <sha>`, spec 3.8; the skill declares
//          it, review-brief passes it), a commit on main; null otherwise.
//          finalize --stale-base counts a lens's report as the overlap pass
//          only when it was stored under a snapshot whose overlap is
//          --reviewed-against
//   at     when it was taken
// `position` prints `position <seq> tip <sha7>`; the skill (and review-brief)
// passes the seq through, and verdicts, verify and tests take it as the
// required --position <seq>. A report, a verify report or a test entry stored
// later carries tip, tree, main, overlap and head (when set) and position (the
// seq) from the snapshot. position replaces an unreadable position.json,
// saying so in one stderr line. The store is refused when there is no
// snapshot (or a quick fix's records no staged tree); when the seq it was read at is
// not the current snapshot's (position ran again before it was stored, so it
// would be recorded at a position its lens never read); or when the branch
// tip (a quick fix's HEAD or staged tree) is no longer the snapshot's:
// something moved under the lens, and its verdict cannot be pinned to either
// position.
//
// The lenses read files and the tests run on a checkout, so position and
// every store also refuse when that checkout holds content the snapshot does
// not record (review 3, M2; review 4, M2 and M4):
//   lane       every worktree that is the lane's checkout (git worktree list:
//              each one with the branch checked out, a second one forced on
//              it included, and a detached one whose HEAD is the tip) with
//              tracked changes against the tip, staged or not, or an
//              untracked file git does not ignore; a lane checked out in no
//              worktree, or mid-rebase in one (git's rebase-merge or
//              rebase-apply state), is refused outright
//   quick fix  at position and the lens stores, its staged paths with
//              unstaged changes (a staged change after the snapshot moves the
//              staged tree, above; other windows' files in the shared
//              checkout do not count, since the lenses read the staged diff);
//              at the tests store, any tracked file with an unstaged change
//              or any untracked file git does not ignore (review 5, M3, the
//              owner's ruling: the suites run on the working tree, so it must
//              hold exactly the staged tree)
//   commit     the checkout, for its tests, with tracked changes against HEAD
//              or an untracked file git does not ignore
// Before any of these, a checkout compared there with an index entry marked
// assume-unchanged or skip-worktree is refused while the mark is set, edited
// or not (review 5, L1): git diff never compares such an entry with the
// disk, so an edit to it is invisible to every count above.
// The refusal names the counts, never a path or its content.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const R = require('./receipt');

const FILE = 'position.json';

// Where the review stands now: {tip, tree, main}. Throws an Error naming what
// git could not read.
function current(state, cwd) {
  let tip;
  if (state.mode === 'commit') {
    tip = state.commit;
  } else {
    const ref = state.mode === 'quick-fix' ? 'HEAD' : `refs/heads/${state.name}`;
    try {
      tip = R.resolveCommit(ref, { cwd });
    } catch {
      throw new Error(state.mode === 'quick-fix' ? 'HEAD does not resolve' : `no branch ${state.name}`);
    }
  }
  let tree = null;
  if (state.mode === 'quick-fix') {
    try {
      tree = R.quickFixKey({ cwd });
    } catch (err) {
      throw new Error(`cannot read the staged tree (${err.message})`);
    }
  }
  let main;
  try {
    main = R.resolveCommit('refs/heads/main', { cwd });
  } catch {
    throw new Error('refs/heads/main does not resolve');
  }
  if (state.mode !== 'commit') return { tip, tree, main };
  let head;
  try {
    head = R.resolveCommit('HEAD', { cwd });
  } catch {
    throw new Error('HEAD does not resolve');
  }
  return { tip, tree, main, head };
}

function gitNames(args, cwd) {
  const out = execFileSync('git', args, { cwd, env: R.gitEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split('\0').filter(Boolean);
}

const NAME_ONLY = Object.freeze(['--name-only', '-z', '--no-renames', '--no-relative', '--no-ext-diff', '--ignore-submodules=none']);

// The worktrees git lists: [{dir, head, branch, detached, bare}].
function worktrees(cwd) {
  const out = [];
  for (const attr of gitNames(['worktree', 'list', '--porcelain', '-z'], cwd)) {
    if (attr.startsWith('worktree ')) out.push({ dir: attr.slice('worktree '.length), head: null, branch: null, detached: false, bare: false });
    else if (!out.length) continue;
    else if (attr.startsWith('HEAD ')) out[out.length - 1].head = attr.slice('HEAD '.length);
    else if (attr.startsWith('branch ')) out[out.length - 1].branch = attr.slice('branch '.length);
    else if (attr === 'detached') out[out.length - 1].detached = true;
    else if (attr === 'bare') out[out.length - 1].bare = true;
  }
  return out;
}

const REBASE_DIRS = Object.freeze(['rebase-merge', 'rebase-apply']);

// The rebase git has under way in an admin dir (a worktree's git dir):
// {rebasing, headName} (headName the branch the rebase rewrites, or null).
function rebaseState(gitDir) {
  for (const d of REBASE_DIRS) {
    const at = path.join(gitDir, d);
    if (!fs.existsSync(at)) continue;
    let headName = null;
    try {
      headName = fs.readFileSync(path.join(at, 'head-name'), 'utf8').trim();
    } catch {
      headName = null;
    }
    return { rebasing: true, headName };
  }
  return { rebasing: false, headName: null };
}

// Every worktree that is the lane's checkout (review 4, M4): the ones that
// have refs/heads/<branch> checked out, and a detached one whose HEAD is the
// lane tip; {dirs, rebasing} where rebasing says the lane is mid-rebase: in
// any worktree's git dir, git's rebase-merge or rebase-apply state for the
// branch, or any rebase under way in one of its checkouts. The main
// worktree's git dir is the common dir, a linked one's is under worktrees/.
function checkoutsOf(branch, tip, cwd) {
  const ref = `refs/heads/${branch}`;
  const dirs = worktrees(cwd).filter((w) => !w.bare && (w.branch === ref || (w.detached && w.head === tip))).map((w) => w.dir);
  const common = R.commonDir({ cwd });
  const linked = path.join(common, 'worktrees');
  const admin = [common, ...(fs.existsSync(linked) ? fs.readdirSync(linked).map((d) => path.join(linked, d)) : [])];
  let rebasing = admin.some((d) => rebaseState(d).headName === ref);
  for (const dir of dirs) {
    if (rebaseState(gitNames(['rev-parse', '--path-format=absolute', '--git-dir'], dir)[0].trim()).rebasing) rebasing = true;
  }
  return { dirs, rebasing };
}

// The files a checkout changed against its HEAD, staged or not.
function trackedChanges(dir) {
  return new Set([...gitNames(['diff', ...NAME_ONLY, 'HEAD', '--'], dir), ...gitNames(['diff', '--cached', ...NAME_ONLY, 'HEAD', '--'], dir)]);
}

// The untracked files git does not ignore, in the whole worktree (:/).
function untracked(dir) {
  return gitNames(['ls-files', '--others', '--exclude-standard', '-z', '--', ':/'], dir).length;
}

// What a checkout holds beyond its HEAD: {tracked} files changed against it,
// staged or not, and {untracked} files git does not ignore (review 4, M2: a
// helper a changed file requires, never added, would let the suites pass on
// a tip that crashes on require).
function dirt(dir) {
  return { tracked: trackedChanges(dir).size, untracked: untracked(dir) };
}

// The index entries git diff never compares with the disk (review 5, L1):
// marked assume-unchanged (git ls-files -v prints the tag in lowercase) or
// skip-worktree (S).
function flagged(dir) {
  return gitNames(['ls-files', '-v', '-z', '--', ':/'], dir).filter((e) => /^[a-zS] /.test(e)).length;
}

const hidden = (who, n) => `${who} ${n} index entr${n === 1 ? 'y' : 'ies'} marked assume-unchanged or skip-worktree, which git diff never compares with the disk; clear them (git update-index --no-assume-unchanged --no-skip-worktree), then run position`;

const counts = (d, against) => `${d.tracked} tracked file(s) changed against the ${against} (staged or not) and ${d.untracked} untracked file(s) git does not ignore`;

// Why the checkout holds content the snapshot does not record, or null.
// `tests`: a test entry (a commit review's lenses read parent..commit, a quick
// fix's the staged diff; their tests run on the checkout).
function dirty(state, cwd, { tests = false } = {}) {
  const tail = 'the lenses and the tests would read content';
  try {
    if (state.mode === 'lane') {
      const { dirs, rebasing } = checkoutsOf(state.name, R.resolveCommit(`refs/heads/${state.name}`, { cwd }), cwd);
      if (rebasing) return `${state.name} is mid-rebase in a worktree (git's rebase-merge or rebase-apply state); the checkout holds content no commit records: finish or abort the rebase, then run position`;
      if (!dirs.length) return `${state.name} is checked out in no worktree; the lenses and the tests read a checkout: check the lane out in a worktree first, then run position`;
      const which = dirs.length === 1 ? `the checkout of ${state.name} has` : `the ${dirs.length} checkouts of ${state.name} have`;
      const laneMarks = dirs.reduce((n, dir) => n + flagged(dir), 0);
      if (laneMarks) return hidden(which, laneMarks);
      const d = dirs.map(dirt).reduce((x, y) => ({ tracked: x.tracked + y.tracked, untracked: x.untracked + y.untracked }));
      if (!d.tracked && !d.untracked) return null;
      return `${which} ${counts(d, 'tip')}; ${tail} the snapshot does not record: commit, restore or remove them, then run position`;
    }
    const marked = state.mode === 'quick-fix' || tests ? flagged(cwd) : 0;
    if (marked) return hidden('the checkout has', marked);
    if (state.mode === 'quick-fix') {
      const unstaged = gitNames(['diff', ...NAME_ONLY, '--'], cwd);
      if (tests) {
        const d = { tracked: unstaged.length, untracked: untracked(cwd) };
        return d.tracked + d.untracked ? `the checkout has ${d.tracked} tracked file(s) with unstaged changes and ${d.untracked} untracked file(s) git does not ignore; a quick fix's tests run on the working tree, which must hold exactly the staged tree: stage, restore or remove them, then run position` : null;
      }
      const staged = new Set(gitNames(['diff', '--cached', ...NAME_ONLY, '--'], cwd));
      const n = unstaged.filter((f) => staged.has(f)).length;
      return n ? `${n} staged path(s) have unstaged changes; ${tail} the staged tree does not hold: stage or restore them, then run position` : null;
    }
    const d = tests ? dirt(cwd) : { tracked: 0, untracked: 0 };
    return d.tracked + d.untracked ? `the checkout has ${counts(d, 'commit')}; the tests would run content the commit does not hold: commit, restore or remove them, then run position` : null;
  } catch {
    return `git could not read the checkout of ${state.name} to compare it with the snapshot`;
  }
}

function read(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let snap;
  try {
    snap = JSON.parse(raw);
  } catch {
    throw new Error(`${path.join(dir, FILE)} is not valid JSON; run position again`);
  }
  const sha = (v) => v === null || v === undefined || R.KEY_RE.test(String(v));
  if (!snap || !Number.isInteger(snap.seq) || !R.KEY_RE.test(String(snap.tip)) || !R.KEY_RE.test(String(snap.main)) || !sha(snap.overlap) || !sha(snap.head)) {
    throw new Error(`${path.join(dir, FILE)} is not a position snapshot; run position again`);
  }
  return snap;
}

// The --overlap commit: a commit on main (refs/heads/main `main`), resolved.
function overlapOf(ref, main, cwd) {
  let sha;
  try {
    sha = R.resolveCommit(ref, { cwd });
  } catch {
    throw new Error(`--overlap ${ref} is not a commit`);
  }
  let onMain;
  try {
    onMain = R.isAncestor(sha, main, { cwd });
  } catch {
    onMain = null;
  }
  if (onMain !== true) throw new Error(`--overlap ${R.short(sha)} is not on main (refs/heads/main ${R.short(main)})`);
  return sha;
}

// The highest seq a snapshot or a stored entry carries.
function lastSeq(prev, state) {
  const entries = [...(state.reports || []), ...(state.tests || []), ...(state.tests_superseded || []), ...Object.values(state.externals || {})];
  return Math.max(prev ? prev.seq : 0, ...entries.map((e) => (e && Number.isInteger(e.position) ? e.position : 0)));
}

// Takes a snapshot and writes it; returns it. `overlap` (a ref) declares the
// overlap pass against main at that commit. An unreadable position.json is
// replaced, and `onReplace(file)` says so.
function take(dir, state, cwd, { overlap, onReplace = () => {} } = {}) {
  let prev = null;
  let unreadable = false;
  try {
    prev = read(dir);
  } catch {
    unreadable = true;
  }
  const now = current(state, cwd);
  const why = dirty(state, cwd);
  if (why) throw new Error(why);
  const snap = { seq: lastSeq(prev, state) + 1, ...now, overlap: overlap === undefined ? null : overlapOf(overlap, now.main, cwd), at: new Date().toISOString() };
  R.writeJsonAtomic(path.join(dir, FILE), snap);
  if (unreadable) onReplace(path.join(dir, FILE));
  return snap;
}

// The fields a store records, from the snapshot, after checking that the
// report was read at it (`seq`, the caller's --position) and that nothing
// moved since; throws an Error naming what to do. `what` names what must be
// run again (the lens, the tests); `tests` marks a test entry, which in a
// commit review needs HEAD at the commit.
function forStore(dir, state, cwd, what, seq, { tests = false } = {}) {
  const snap = read(dir);
  if (!snap) throw new Error(`no position snapshot for ${state.name}; run position ${state.name} right before the lens's input is taken`);
  if (state.mode === 'quick-fix' && !R.KEY_RE.test(String(snap.tree))) throw new Error(`${path.join(dir, FILE)} records no staged tree; run position again`);
  if (seq !== snap.seq) {
    throw new Error(`this report was read at position ${seq}; the current snapshot is ${snap.seq}: store it before running position again, or re-run ${what}`);
  }
  const now = current(state, cwd);
  if (now.tip !== snap.tip) {
    throw new Error(`the tip is ${R.short(now.tip)}, the snapshot's is ${R.short(snap.tip)}; re-run position and ${what}: the branch moved under it`);
  }
  if (state.mode === 'quick-fix' && now.tree !== snap.tree) {
    throw new Error(`the staged tree is ${R.short(now.tree)}, the snapshot's is ${R.short(snap.tree)}; re-run position and ${what}: the staged tree moved under it`);
  }
  if (state.mode === 'commit' && tests && (now.head !== state.commit || snap.head !== state.commit)) {
    const head = now.head !== state.commit ? now.head : snap.head;
    throw new Error(`a commit review's tests run on the commit's own tree: HEAD is ${head ? R.short(head) : '(none)'}, not the commit ${R.short(state.commit)}; check out the commit, then run position and the tests`);
  }
  const why = dirty(state, cwd, { tests });
  if (why) throw new Error(`${why} and ${what}`);
  const fields = { tip: snap.tip, main: snap.main, position: snap.seq };
  if (state.mode === 'quick-fix') fields.tree = snap.tree;
  if (state.mode === 'commit') fields.head = snap.head;
  if (snap.overlap) fields.overlap = snap.overlap;
  return fields;
}

module.exports = { current, read, take, forStore, dirty, FILE };
