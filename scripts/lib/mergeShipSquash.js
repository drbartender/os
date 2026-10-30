'use strict';

// The squash's proofs and records for the ship phase (instruction rewrite step
// 5, lane merge-ship), split from scripts/lib/mergeShip.js, whose header is
// the contract these serve (the run's steps 1 to 5, the resume and
// --resolved): the refusals before anything is merged (preRefusal, with the
// comment-only lane's squash keyed ahead, squashKeyAhead; and markerRefusal,
// shipFlow's precheck and the marker refusals, which a resume shares),
// --resolved's index rules and proof (resolvedIndexProblem, verifyResolved,
// indexTree, differsOutsideDocs, wasReset), the run directory and the shell's
// squash (writeRunDir, squashShell, with the shell's first REFUSED line,
// refusalOf), the squash on main (findSquash), a lane's squash on main and
// not yet pushed (unpushedOf and findUnpushed: merged's first check, the
// subject opening merge(lane <branch>): , over origin/main..main, a squash a
// later commit reverts not resumable; resumeProblem, the squash
// receipt's lane tip against the branch's before a resume, and strandLine,
// the branch's tree against the squash's, the two docs by their prose
// (proseDiffers), before a resume and before the branch delete, which the
// cleanup ties to the tip it read, dropAt; the cleanup's branch step,
// branchOutcome; and removeLaneWorktree), the squash
// receipt (writeSquashReceipt) and the ready-moved re-run of the receipt's
// suites on the merged tree (suitesStep, the shell's callback through
// mergeShip.js suites), with the git reads the run shares (worktreeOf;
// branchInUse, a worktree holding the branch in a rebase or a bisect, which
// mergeCheck's merged-lane worktree check reads too; wedged). No CLI of its
// own.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const R = require('./receipt');
const M = require('./markers');
const MC = require('./mergeCheck');
const RP = require('./receiptPublish');
const SL = require('./mergeShipLog');
const { precheck } = require('./shipFlow');

const DOCS = R.GENERATED_DOCS;
const RUN_SUITES = path.join(path.resolve(__dirname, '..'), 'run-suites.js');
const SHELL = path.join(path.resolve(__dirname, '..'), 'merge-lane.sh');
const WORKTREE_RM = path.join(path.resolve(__dirname, '..'), 'worktree-rm.js');
// What the suites step drops from a re-run suite's environment (mergeShip's header, step 4).
const SHIP_ENV = Object.freeze(['MERGE_LANE_SHIP', 'MERGE_LANE_LOCKED', 'DRB_SHIP_LOCK', 'DRB_SHIP_LOCK_PID', 'DRB_DEVDB_LOCK_FILE']);
const MAX_BUFFER = 64 * 1024 * 1024;
const S = (x) => (typeof x === 'string' && x ? R.short(x) : '(none)');
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
const nul = (out) => out.split('\0').filter(Boolean);
// The one commit the comment-only key check writes (no ref): fixed, so the
// same squash makes the same object.
const AS_ONE = Object.freeze({
  GIT_AUTHOR_NAME: 'merge-lane ship', GIT_AUTHOR_EMAIL: '', GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'merge-lane ship', GIT_COMMITTER_EMAIL: '', GIT_COMMITTER_DATE: '@0 +0000',
});
const listed = (xs, max = 8) => `${xs.slice(0, max).join(', ')}${xs.length > max ? `, and ${xs.length - max} more` : ''}`;

function git(cwd, args, extra = {}) {
  return spawnSync('git', args, { cwd, env: { ...R.gitEnv(), ...extra }, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitOut(cwd, args, extra) {
  const r = git(cwd, args, extra);
  if (r.error || r.status !== 0) throw new Error(`git ${args.find((a) => !a.startsWith('-'))} failed (${r.error ? r.error.code : `exit ${r.status}`}${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ''})`);
  return r.stdout;
}

// The full sha a ref names, or null.
function commitOf(cwd, ref) {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const out = r.status === 0 ? r.stdout.trim() : '';
  return R.KEY_RE.test(out) ? out : null;
}

// The path of the worktree that has `branch` checked out, or null.
function worktreeOf(cwd, branch) {
  for (const rec of gitOut(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0\0')) {
    const attrs = nul(rec);
    if (attrs.includes(`branch refs/heads/${branch}`)) return (attrs.find((x) => x.startsWith('worktree ')) || 'worktree ').slice('worktree '.length);
  }
  return null;
}

// The worktree holding `branch` in a rebase or a bisect, which git branch -D
// refuses as used by worktree (git's find_shared_symref) though no worktree
// lists the branch: a rebase stopped at a conflict, or a bisect, detaches the
// worktree's HEAD and leaves refs/heads/<branch> where it was, for the
// operation to write back. Read as git reads it, from each worktree's git dir
// (the common dir for the primary, worktrees/<id> for a linked one, a
// prunable one included, its path from the gitdir file there): a
// rebase-merge/head-name or rebase-apply/head-name naming refs/heads/<branch>,
// or a BISECT_START naming the branch. {path, op, text} (op rebasing or
// bisecting, text `<path> is rebasing <branch>`), or null. Never throws: a
// file or directory it cannot read answers in use (op unreadable), the safe
// direction. mergeCheck's merged-lane worktree check and dropAt ask it.
function branchInUse(cwd, branch) {
  let at = 'the worktrees';
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      throw Object.assign(err, { file });
    }
  };
  try {
    const common = R.commonDir({ cwd });
    const admin = path.join(common, 'worktrees');
    const dirs = [[common, path.dirname(common)]];
    for (const id of fs.existsSync(admin) ? fs.readdirSync(admin).sort() : []) {
      const dotGit = read(path.join(admin, id, 'gitdir'));
      if (dotGit !== null) dirs.push([path.join(admin, id), path.dirname(path.resolve(admin, id, dotGit.trim()))]);
    }
    for (const [dir, wt] of dirs) {
      at = wt;
      for (const [file, op] of [['rebase-merge/head-name', 'rebasing'], ['rebase-apply/head-name', 'rebasing'], ['BISECT_START', 'bisecting']]) {
        const text = read(path.join(dir, file));
        if (text !== null && text.trim().replace(/^refs\/heads\//, '') === branch) return { path: wt, op, text: `${wt} is ${op} ${branch}` };
      }
    }
    return null;
  } catch (err) {
    const why = `${err && err.code ? err.code : firstLine(err && err.message ? err.message : String(err))}${err && err.file ? ` at ${path.basename(err.file)}` : ''}`;
    return { path: at, op: 'unreadable', text: `${at} could not be read (${why}); ${branch} counts as in use` };
  }
}

// Whether the push check refuses main's head until main's unpushed squashes
// are replayed onto origin's head (mergeShip's behind ending): origin/main,
// as last fetched, is not in main's history, or origin/main..main holds a
// merge commit (main holds squashes only); false when either ref is missing
// or git cannot say.
function wedged(cwd) {
  const [origin, main] = ['refs/remotes/origin/main', 'refs/heads/main'].map((ref) => commitOf(cwd, ref));
  if (!origin || !main) return false;
  try {
    if (!R.isAncestor(origin, main, { cwd })) return true;
  } catch {
    return false;
  }
  const n = git(cwd, ['rev-list', '--merges', '--count', `${origin}..${main}`, '--']);
  return n.status === 0 && Number(n.stdout.trim()) > 0;
}

// ---- the refusals before anything is merged ---------------------------------------

// The refusals shipFlow would make, made before anything is merged
// (mergeShip's header, step 1), for a ship of `sha` or of a child of it: an
// unreadable flip marker; shipFlow's own precheck (a test override set
// without DRB_SHIP_ALLOW_STUBS=1, a missing flip marker with CUE_ONLY and
// the restore recipe, as npm run ship refuses, then the primary worktree on
// main); a standing watch marker; and a gate marker `sha` does not fix
// forward (spec 4.4).
function markerRefusal(cwd, sha) {
  const st = M.standing({ cwd });
  if (M.flipState({ cwd }).state === 'unreadable') return st.flip;
  const pre = precheck(cwd);
  if (pre.refusal) return pre.refusal.split('\n').map((l) => l.replace(/^ship: /, '')).join('; ');
  if (st.watch) return st.watch;
  if (st.gate && !M.isFixForward(sha, { cwd, self: true })) return st.gate;
  return null;
}

function preRefusal(cwd, r, { resolved }) {
  const marker = markerRefusal(cwd, r.main);
  if (marker) return marker;
  if (r.state === 'ready-moved' && r.unnamed_logs.length) {
    return `the receipt records a log entry with no single-suite command (${listed(r.unnamed_logs)}); a ready-moved ship re-runs only suites named by path, so review the lane again on main`;
  }
  const bad = r.suites.filter((f) => /[\n\r]/.test(f) || f.startsWith('-'));
  if (bad.length) return `the receipt names a suite path ship will not pass to the runner (${listed(bad)})`;
  if (resolved && r.receipt && r.receipt.kind === 'comment-only') return '--resolved takes the lane receipt a review of the resolution writes; a comment-only proof covers no resolution';
  if (!resolved && r.receipt && r.receipt.kind === 'comment-only') {
    const k = squashKeyAhead(cwd, r.main, r.tip);
    if (k.problem) return k.problem;
    if (k.key && k.key !== r.laneKey) return `the comment-only lane's squash would key as ${S(k.key)}, not its lane key ${S(r.laneKey)} (main changed the lines beside its hunks since the review's base), so its proof would not cover the squash: rebase the lane onto main and review it again in stale-base mode`;
  }
  if (!resolved) {
    const st2 = MC.osStatus(cwd);
    const dirty = [...new Set([...st2.staged, ...st2.loose])];
    if (dirty.length) return `os has uncommitted changes (${listed(dirty)}); the squash never merges into a dirty tree: commit or stash them first`;
  }
  return null;
}

// The key the squash of `tip` onto `main` will carry (receipt.commitKey of
// the squash: the patch id of main..its tree, the two docs excluded), from
// the tree git merge-tree writes, the merge verifyResolved reads: {key}, or
// {key: null} when the squash will refuse anyway (a conflict in a lane file,
// nothing outside the two docs to merge), or {problem}. A conflict confined
// to README.md and ARCHITECTURE.md is keyed too: the shell resolves one
// inside the generated sections itself, and the tree merge-tree wrote holds
// the docs with conflict markers, which the key leaves out, so its key is
// the squash's.
function squashKeyAhead(cwd, main, tip) {
  const mt = git(cwd, ['merge-tree', '--write-tree', '-z', '--no-messages', '--end-of-options', main, tip]);
  if (mt.error || (mt.status !== 0 && mt.status !== 1)) return { problem: `git merge-tree failed (${firstLine(mt.stderr) || `exit ${mt.status}`})` };
  if (mt.status === 1 && conflictedOf(mt.stdout).some((p) => !DOCS.includes(p))) return { key: null };
  const tree = mt.stdout.split('\0')[0];
  const changed = nul(gitOut(cwd, ['diff', '--name-only', '-z', '--no-renames', '--end-of-options', main, tree, '--'])).filter((p) => !DOCS.includes(p));
  if (!changed.length) return { key: null };
  const one = gitOut(cwd, ['commit-tree', '--no-gpg-sign', '-p', main, '-m', 'merge-lane ship: the squash as merge-tree writes it', tree], AS_ONE).trim();
  return { key: R.laneKey(main, one, { cwd }) };
}

// The entries of `paths` in `tree` as path -> "mode oid".
function entriesOf(cwd, tree, paths) {
  const m = new Map();
  if (!paths.length) return m;
  for (const rec of nul(gitOut(cwd, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', tree, '--', ...paths]))) {
    const tab = rec.indexOf('\t');
    const [mode, , oid] = rec.slice(0, tab).split(' ');
    m.set(rec.slice(tab + 1), `${mode} ${oid}`);
  }
  return m;
}

// The tree the shared index holds, written from a private copy of it (so
// another git's index.lock cannot stop it and nothing is written to it).
function indexTree(cwd) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-ship-index-'));
  try {
    const index = path.join(tmp, 'index');
    fs.copyFileSync(path.resolve(cwd, gitOut(cwd, ['rev-parse', '--git-path', 'index']).trim()), index);
    return gitOut(cwd, ['write-tree'], { GIT_INDEX_FILE: index }).trim();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// What stops a --resolved ship before its check reads the index (header):
// unmerged entries, then a staged path whose working file was edited after
// git add (an MM or AM row), which check would otherwise refuse as a loose
// edit with advice a resolution cannot follow. A problem, or null.
function resolvedIndexProblem(cwd) {
  if (gitOut(cwd, ['ls-files', '-u', '-z'])) return 'the index still holds unmerged entries; resolve and stage each conflicted file first';
  const st = MC.osStatus(cwd);
  const edited = st.loose.filter((p) => st.staged.includes(p));
  if (!edited.length) return null;
  const one = edited.length === 1;
  return `${listed(edited)} ${one ? 'was' : 'were'} edited after git add (the working ${one ? 'file is' : 'files are'} not the staged resolution): git add -- ${edited.join(' ')} stages the edit, then ship --resolved again; nothing was reset`;
}

// Whether trees a and b differ at a path other than the two docs.
function differsOutsideDocs(cwd, a, b) {
  return a !== b && nul(gitOut(cwd, ['diff-tree', '-r', '--name-only', '-z', '--no-renames', '--end-of-options', a, b])).some((p) => !DOCS.includes(p));
}

// Whether the shared index no longer holds the verified resolution `tree`
// outside the two docs, which step 7's regeneration rewrites on purpose (a
// refusal reset some of it); true when the index cannot be read.
function wasReset(cwd, tree) {
  try {
    return differsOutsideDocs(cwd, indexTree(cwd), tree);
  } catch {
    return true;
  }
}

// The paths git merge-tree --write-tree -z reports conflicted, after the
// tree's line: one record per stage, `<mode> <oid> <stage>\t<path>`, up to
// the empty record.
function conflictedOf(out) {
  const paths = new Set();
  for (const rec of out.split('\0').slice(1)) {
    if (!rec) break;
    paths.add(rec.slice(rec.indexOf('\t') + 1));
  }
  return [...paths];
}

// --resolved's proof (header): {tree, conflicted} or {problem}.
function verifyResolved(cwd, { main, tip, base }) {
  if (gitOut(cwd, ['ls-files', '-u', '-z'])) return { problem: 'the index still holds unmerged entries; resolve and stage each conflicted file first' };
  const tree = indexTree(cwd);
  const mt = git(cwd, ['merge-tree', '--write-tree', '-z', '--no-messages', '--end-of-options', main, tip]);
  if (mt.status === 0) return { problem: 'the lane squashes onto main without a conflict; ship it without --resolved' };
  if (mt.error || mt.status !== 1) return { problem: `git merge-tree failed (${firstLine(mt.stderr) || `exit ${mt.status}`})` };
  // merge-tree names HEAD's side of a file/directory conflict <path>~<main>,
  // where git merge --squash, which staged the resolution, says <path>~HEAD.
  const named = (p) => (p.endsWith(`~${main}`) ? `${p.slice(0, -main.length)}HEAD` : p);
  const parts = mt.stdout.split('\0');
  const conflicted = new Set(conflictedOf(mt.stdout).map(named));
  // A conflict in a lane file is overlap, which check reads as stale, so only
  // the two docs, outside every key, are resolved by hand.
  const lanePaths = [...conflicted].filter((p) => !DOCS.includes(p));
  if (lanePaths.length) return { problem: `a conflict in ${listed(lanePaths)} needs the rebase and the stale-base review, never a hand resolution` };
  const names = (a, b) => nul(gitOut(cwd, ['diff', '--name-only', '-z', '--no-renames', '--no-relative', '--end-of-options', a, b, '--'])).map(named);
  const own = new Set([...DOCS, ...conflicted, ...names(main, parts[0]), ...names(base, tip)]);
  const extra = names(main, tree).filter((p) => !own.has(p));
  if (extra.length) return { problem: `the index stages ${listed(extra)}, not the squash's own (only the lane's paths and the resolution may be staged)` };
  const plain = [...own].filter((p) => !conflicted.has(p) && !p.includes('~'));
  const [want, have] = [parts[0], tree].map((t) => entriesOf(cwd, t, plain));
  const off = plain.filter((p) => want.get(p) !== have.get(p));
  if (off.length) return { problem: `the index holds ${listed(off)} other than the squash merges ${off.length === 1 ? 'it' : 'them'}; only the conflicted paths (${listed([...conflicted])}) may differ` };
  return { tree, conflicted: [...conflicted] };
}

// ---- the squash, its commit and its receipt ----------------------------------------

// The run directory the shell reads (mergeShip's header, step 2), under the
// temp dir.
function writeRunDir(r, tree, log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-ship-'));
  const put = (name, text) => fs.writeFileSync(path.join(dir, name), `${text}\n`);
  put('pid', process.pid);
  put('tip', r.tip);
  put('main', r.main);
  put('body', R.commitBlock(r.receipt));
  put('log', log);
  if (r.state === 'ready-moved' && r.suites.length) put('suites', r.suites.join('\n'));
  if (tree) put('resolved', tree);
  return dir;
}

// The shell's squash (step 2), its stderr passed on: {code, signal, refusal}.
function squashShell({ cwd, branch, plan, runDir, lockFd }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) resolve(v);
      done = true;
    };
    const stdio = ['ignore', 'inherit', 'pipe', ...(lockFd === null ? [] : [lockFd])];
    const child = spawn('bash', [SHELL, branch, plan], { cwd, env: { ...R.gitEnv(), MERGE_LANE_LOCKED: String(process.pid), MERGE_LANE_SHIP: runDir }, stdio });
    let err = '';
    child.stderr.on('data', (b) => {
      process.stderr.write(b);
      err = (err + b.toString('utf8')).slice(-262144);
    });
    child.on('error', (e) => finish({ code: null, signal: null, refusal: `bash could not start (${e.code || 'error'})` }));
    child.on('close', (code, signal) => finish({ code, signal, refusal: refusalOf(err) }));
  });
}

// The shell's first REFUSED line, with the paths it lists under it.
function refusalOf(text) {
  const lines = String(text).split('\n');
  const i = lines.findIndex((l) => l.startsWith('REFUSED: '));
  if (i < 0) return null;
  const more = [];
  for (let j = i + 1; j < lines.length && /^ {4}\S/.test(lines[j]) && more.length < 20; j++) more.push(lines[j].trim());
  return `${lines[i].slice('REFUSED: '.length)}${more.length ? ` ${more.join(', ')}` : ''}`;
}

// The squash on main (step 3), or null.
function findSquash(cwd, runDir, { main, branch, plan }) {
  const head = commitOf(cwd, 'refs/heads/main');
  if (!head || head === main) return null;
  const fits = (c) => commitOf(cwd, `${c}^`) === main && R.isAncestor(c, head, { cwd });
  let named = null;
  try {
    named = fs.readFileSync(path.join(runDir, 'commit'), 'utf8').trim();
  } catch {
    named = null;
  }
  if (named && R.KEY_RE.test(named) && commitOf(cwd, named) === named && fits(named)) return named;
  const subject = `merge(lane ${branch}): ${plan}`;
  for (const c of gitOut(cwd, ['rev-list', '--first-parent', `${main}..${head}`, '--']).split('\n').filter(Boolean)) {
    if (fits(c) && gitOut(cwd, ['log', '-1', '--format=%s', c, '--']).trim() === subject) return c;
  }
  return null;
}

// The lane's squash on main and not yet pushed (header): {squash, revert},
// squash the newest commit of origin/main..main whose subject opens
// merge(lane <branch>): , revert a later commit of that range whose message
// holds git revert's line for it (This reverts commit <squash>), or null; null
// when there is no such squash, and with no origin/main.
function unpushedOf(cwd, branch) {
  const origin = commitOf(cwd, 'refs/remotes/origin/main');
  const main = commitOf(cwd, 'refs/heads/main');
  if (!origin || !main || origin === main) return null;
  const needle = `merge(lane ${branch}): `;
  const out = gitOut(cwd, ['log', '-F', `--grep=${needle}`, '--format=%H%x09%s', `${origin}..${main}`, '--']);
  const hit = out.split('\n').map((l) => l.split('\t')).find(([h, sub]) => R.KEY_RE.test(h) && typeof sub === 'string' && sub.startsWith(needle));
  if (!hit) return null;
  const squash = hit[0];
  const line = new RegExp(`^This reverts commit ${squash}\\b`, 'm');
  const named = gitOut(cwd, ['log', '-F', `--grep=This reverts commit ${squash}`, '--format=%H', main, `^${squash}`, `^${origin}`, '--']).split('\n').filter((c) => R.KEY_RE.test(c));
  const revert = named.find((c) => line.test(gitOut(cwd, ['log', '-1', '--format=%B', c, '--']))) || null;
  return { squash, revert };
}

// The squash a resume ships (header), or null: unpushedOf's squash unless a
// later commit reverts it, which no resume can push (the push check takes no
// revert receipt for a squash that never shipped), so a ship of the lane
// refuses with revertedLine, as check does.
function findUnpushed(cwd, branch) {
  const u = unpushedOf(cwd, branch);
  return u && !u.revert ? u.squash : null;
}

// The way through for a lane whose squash was made of another tip: push the
// squash, then review the branch anew; never a resume.
const PUSH_FIRST = 'the way through is to push the squash, then a new review of the branch, never a resume';
// The way through when the comparison meets a conflict in a lane path.
const BY_HAND = 'the squash is pushed by hand (npm run ship), then a new review of the branch';

// The answer check and ship both give for an unpushed squash with its revert
// (mergeShip's header, a resume).
function revertedLine(branch, { squash, revert }) {
  return `the squash ${S(squash)} of ${branch} sits on main unpushed with its revert ${S(revert)}; push the two (the revert needs a receipt of its own, a review --commit, its squash never having shipped), then a new review of the branch`;
}

// The squash's receipt and the lane tip it records: {laneTip, replayOf}
// (laneTip null when it records none, as one a review --commit wrote), or
// {problem}. The squash receipt is the receipt under the squash's commit key
// whose tip is the squash, and it records the lane tip the squash was made of
// (squash.lane_tip, writeSquashReceipt's). A replayed squash (mergeShip's
// header, a resume: the same hunks on a new parent) is found under the same
// key, its receipt the earlier squash's (replayOf): final, kind squash or
// comment-only, its key the one it sits under, recording that commit as its
// tip and its squash, and a lane tip.
function squashRecord(cwd, squash) {
  let rec;
  let key;
  try {
    key = R.commitKey(squash, { cwd });
    rec = R.readReceipt(R.receiptDir(key, { cwd }));
  } catch (err) {
    return { problem: `the receipt of the squash ${S(squash)} cannot be read (${firstLine(err && err.message ? err.message : String(err))}); fix or move it` };
  }
  const sq = rec && rec.squash && typeof rec.squash === 'object' ? rec.squash : null;
  const replayOf = rec && rec.tip !== squash && sq && R.KEY_RE.test(String(rec.tip)) && sq.commit === rec.tip && rec.key === key && rec.state === 'final'
    && ['squash', 'comment-only'].includes(rec.kind) && R.KEY_RE.test(String(sq.lane_tip)) ? rec.tip : null;
  if (!rec || (rec.tip !== squash && !replayOf)) return { problem: `the squash ${S(squash)} on main has no receipt; a review --commit of it is the way through` };
  const recorded = sq && sq.commit === rec.tip ? sq.lane_tip : null;
  return { laneTip: R.KEY_RE.test(String(recorded)) ? recorded : null, replayOf };
}

// The branch named against its squash, the one line a resume refuses with and
// the cleanup keeps the branch with: the commits since the lane tip the squash
// records, or, with none recorded or the branch at it, what differs (why).
// Bounded (no file list), so the run's log line, 300 characters, holds it.
function movedLine(cwd, branch, tip, squash, laneTip, why = `its tree differs outside ${DOCS.join(' and ')}`) {
  if (!R.KEY_RE.test(String(laneTip)) || laneTip === tip) return `${branch} at ${S(tip)} holds what its squash ${S(squash)} does not (${why})`;
  const n = git(cwd, ['rev-list', '--count', '--end-of-options', `${laneTip}..${tip}`]);
  const count = n.status === 0 ? Number(n.stdout.trim()) : null;
  const since = count === null ? 'the recorded tip not in this repository' : `${count} commit${count === 1 ? '' : 's'} since it`;
  return `${branch} is at ${S(tip)}, not the lane tip ${S(laneTip)} its squash ${S(squash)} records, with ${since}`;
}

// The two docs whose prose differs between trees (or commits) a and b: each
// doc's text with every generated section's body emptied (mergeCheck.proseOf,
// the generator's own markers), so a render, and a conflict merge-tree leaves
// inside a section, blank away. A doc on one side only, or one whose markers
// cannot be read on either side, differs; one byte-identical on both does not.
function proseDiffers(cwd, a, b) {
  const [ea, eb] = [a, b].map((t) => entriesOf(cwd, t, DOCS));
  const text = (e, d) => (e.has(d) ? gitOut(cwd, ['cat-file', 'blob', e.get(d).split(' ')[1]]) : null);
  return DOCS.filter((d) => {
    if (ea.get(d) === eb.get(d)) return false;
    const [x, y] = [text(ea, d), text(eb, d)];
    if (x === y) return false;
    const [px, py] = [MC.proseOf(x, d), MC.proseOf(y, d)];
    return px === null || py === null || px !== py;
  });
}

// What the branch holds that its squash does not (mergeShip's header, step 9
// and a resume), as movedLine names it, or null when the squash carries all
// of it (or there is no branch, or the branch is at the lane tip the squash
// records: the squash was made of that very tip and nothing landed since, so
// nothing is compared, which a hand resolution's squash could never match).
// Else the comparison: the tree git merge-tree writes for the
// squash's parent and the branch tip, the squash the branch as it stands now
// would make on that main (the branch tip's own tree when the parent is its
// merge base), against the squash's tree outside the two docs, and the two
// docs by their prose (proseDiffers; a conflict merge-tree leaves in either is
// read the same way, and one the blanking cannot clear differs). A lane commit
// that puts a file, or a doc's prose, back to its base content, or drops a
// file the lane added, is outside the net diff merged's files check reads, and
// inside this. Never throws: a comparison that cannot be made is a line
// saying so, never the strand advice. A git fault (no parent, merge-tree or a
// diff failing) sets retry, whose advice is to compare again; a conflict in a
// lane path when the branch is merged onto the squash's parent (a replay
// resolved by hand there) says nothing of what the branch holds and no retry
// clears it, so it sets hand, whose way through is by hand. strandOf: {tip,
// line, retry, hand}, tip the branch tip the comparison read (null with no
// branch), which the cleanup's delete is tied to (dropAt).
function strandOf(cwd, branch, squash, laneTip = null) {
  const tip = commitOf(cwd, `refs/heads/${branch}`);
  if (!tip || (R.KEY_RE.test(String(laneTip)) && laneTip === tip)) return { tip, line: null, retry: false, hand: false };
  const s = strandAt(cwd, branch, tip, squash, laneTip);
  return { tip, line: s.line, retry: s.retry === true, hand: s.hand === true };
}
const strandLine = (cwd, branch, squash, laneTip = null) => strandOf(cwd, branch, squash, laneTip).line;

function strandAt(cwd, branch, tip, squash, laneTip) {
  const unmade = (why, retry = true) => ({ line: `${branch} at ${S(tip)} could not be compared with its squash ${S(squash)} (${why})`, retry, hand: !retry });
  try {
    const parent = commitOf(cwd, `${squash}^`);
    if (!parent) return unmade(`${S(squash)} has no parent`);
    const mt = git(cwd, ['merge-tree', '--write-tree', '-z', '--no-messages', '--end-of-options', parent, tip]);
    if (mt.error || (mt.status !== 0 && mt.status !== 1)) return unmade(`git merge-tree failed (${firstLine(mt.stderr) || `exit ${mt.status}`})`);
    const lane = mt.status === 1 ? conflictedOf(mt.stdout).filter((p) => !DOCS.includes(p)) : [];
    if (lane.length) return unmade(`merged onto ${S(parent)} it conflicts in ${listed(lane, 3)}`, false);
    const tree = mt.stdout.split('\0')[0];
    let why;
    if (!differsOutsideDocs(cwd, tree, squash)) {
      const docs = proseDiffers(cwd, tree, squash);
      if (!docs.length) return { line: null, retry: false };
      const one = docs.length === 1;
      why = `${docs.join(' and ')} ${one ? 'differs' : 'differ'} outside ${one ? 'its' : 'their'} generated sections`;
    }
    return { line: movedLine(cwd, branch, tip, squash, laneTip, why), retry: false };
  } catch (err) {
    return unmade(firstLine(err && err.message ? err.message : String(err)));
  }
}

// The lane branch deleted only while it is at `tip`, the tip the comparison
// read (git update-ref -d with that old value refuses a ref that moved), and
// only while no worktree holds it in a rebase or a bisect (branchInUse, asked
// right before the delete: update-ref has no notion of it, where git branch
// -D refused it), its config section cleared as git branch -D clears it (a
// failure, as for a branch with none, ignored): {deleted: true}, or {deleted:
// false, now, inUse} or {deleted: false, now, error}, now where the branch is
// (null when gone).
function dropAt(cwd, branch, tip) {
  const inUse = branchInUse(cwd, branch);
  if (inUse) return { deleted: false, now: commitOf(cwd, `refs/heads/${branch}`), inUse };
  const d = git(cwd, ['update-ref', '-d', `refs/heads/${branch}`, tip]);
  if (d.status === 0) {
    git(cwd, ['config', '--remove-section', `branch.${branch}`]);
    return { deleted: true };
  }
  return { deleted: false, now: commitOf(cwd, `refs/heads/${branch}`), error: firstLine(d.stderr) || `exit ${d.status}` };
}

// The cleanup's branch step (mergeShip's header, step 9): {said, text,
// shown}, the log line, the result's words, and shown when the branch is kept
// for what the squash may not hold (kept, strandOf's {line, retry, hand}, a
// branch that moved since the comparison read `tip`, or one a worktree holds
// in a rebase or a bisect, dropAt's inUse), which the phase lines surface.
// The branch goes only with no kept line, m passed, the branch still at tip
// and no worktree holding it; the deleted result says the worktree was
// removed only when removed (removeLaneWorktree removed one), else that there
// was none. "for a new review" comes before the reason, which a 300 character
// log line may cut (the worktree and branch lines hold it whole).
function branchOutcome(cwd, branch, m, kept, tip, removed = false) {
  const keep = (why, text, shown = false) => ({ said: `${branch} is kept: ${why}`, text, shown });
  if (kept) return keep(kept.line, `the branch ${branch} is kept ${kept.retry ? 'to be compared again by hand' : kept.hand ? 'to be compared by hand' : 'for a new review'} (${kept.line})`, true);
  if (!m || !m.ok) {
    const bad = m ? m.checks.filter((c) => !c.ok).map((c) => c.name) : [];
    const named = bad.length > 1 ? `${bad.slice(0, -1).join(', ')} and ${bad.at(-1)}` : bad[0];
    const why = !m ? 'the merged-lane checks could not run' : bad.length ? `the ${named} merged-lane check${bad.length > 1 ? 's' : ''} failed` : 'the merged-lane checks did not all pass';
    return keep(why, `the branch ${branch} is kept (${why})`);
  }
  const d = tip ? dropAt(cwd, branch, tip) : { deleted: false, now: null };
  if (d.deleted) return { said: `deleted ${branch} at ${S(tip)} (git update-ref -d from the tip compared, after all three merged-lane checks passed)`, text: `${removed ? 'the worktree removed' : 'no worktree'}, the three merged-lane checks passed, the branch ${branch} deleted`, shown: false };
  if (!d.now) return { said: `${branch} is already gone`, text: `the three merged-lane checks passed; the branch ${branch} was already gone`, shown: false };
  if (d.inUse) return keep(d.inUse.text, `the branch ${branch} is kept (${d.inUse.text})`, true);
  if (d.now === tip) return keep(`git update-ref -d failed: ${d.error}`, `the branch ${branch} is kept (git update-ref -d failed)`);
  const why = `it moved after the comparison read ${S(tip)}, now at ${S(d.now)}`;
  return keep(why, `the branch ${branch} is kept for a new review (${why})`, true);
}

// The lane's worktree at ../worktrees/<name> removed through
// scripts/worktree-rm.js (step 9): {line, removed}, the line the run logs for
// it and whether this removed one (the deleted result names it only then).
function removeLaneWorktree(cwd, branch) {
  const wt = worktreeOf(cwd, branch);
  if (!wt) return { line: `no worktree has ${branch} checked out`, removed: false };
  const top = gitOut(cwd, ['rev-parse', '--show-toplevel']).trim();
  const name = path.basename(wt);
  if (path.resolve(wt) !== path.resolve(path.dirname(top), 'worktrees', name)) return { line: `${wt} is not a lane under ../worktrees/; it is left for removal by hand`, removed: false };
  const rm = spawnSync(process.execPath, [WORKTREE_RM, name], { cwd: top, env: R.gitEnv(), encoding: 'utf8' });
  if (worktreeOf(cwd, branch)) return { line: `scripts/worktree-rm.js ${name} left it (exit ${rm.status}: ${firstLine(rm.stderr)})`, removed: false };
  return { line: `removed ${name} (scripts/worktree-rm.js)`, removed: true };
}

// Why a resume of the unpushed `squash` stops before any push (mergeShip's
// header, a resume), or null: the squash with no receipt (a replayed one's
// is the earlier squash's, squashRecord); a branch tip other
// than the lane tip the receipt records (the commits since it, which a
// resume would strand: it pushes the old squash and removes the clean
// worktree); and a branch that holds what the squash does not (strandOf),
// the one check when the receipt records no lane tip, a git fault answered
// with "run the same command again" and a lane-path conflict with BY_HAND.
function resumeProblem(cwd, branch, squash) {
  const tip = commitOf(cwd, `refs/heads/${branch}`);
  if (!tip) return `no branch ${branch}; a resume needs the branch to resolve`;
  const { problem, laneTip } = squashRecord(cwd, squash);
  if (problem) return problem;
  const moved = laneTip && laneTip !== tip ? { line: movedLine(cwd, branch, tip, squash, laneTip) } : strandOf(cwd, branch, squash, laneTip);
  if (!moved.line) return null;
  if (moved.retry) return `${moved.line}; run the same command again`;
  return moved.hand ? `${moved.line}; ${BY_HAND}` : `${moved.line}, which a resume would strand; ${PUSH_FIRST}`;
}

// The squash receipt (header, step 5): {key, dir, kind, superseded}; throws
// with nothing moved, or the lane receipt put back, when it cannot be written.
function writeSquashReceipt({ cwd, squash, check, branch, suitesDir = null }) {
  const key = R.commitKey(squash, { cwd });
  const lane = check.receipt;
  const kind = lane.kind === 'comment-only' ? 'comment-only' : 'squash';
  if (kind === 'comment-only' && key !== check.laneKey) throw new Error(`the squash's key ${S(key)} is not the comment-only lane's ${S(check.laneKey)}, so its proof does not cover the squash`);
  const root = R.reviewRoot({ cwd });
  const dest = R.receiptDir(key, { cwd });
  const tmp = path.join(root, `.squash-${key}-${process.pid}-${RP.stamp(true)}`);
  const squashed = { commit: squash, parent: check.main, lane_tip: check.tip, written_at: new Date().toISOString(), suites: null };
  let superseded = null;
  try {
    RP.copyTree(check.dir, tmp);
    if (suitesDir && fs.existsSync(path.join(suitesDir, 'summary.json'))) {
      const rel = path.join('tests', `merged-tree-${RP.stamp(true)}`);
      fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
      RP.copyTree(suitesDir, path.join(tmp, rel));
      const sum = JSON.parse(fs.readFileSync(path.join(suitesDir, 'summary.json'), 'utf8'));
      squashed.suites = { log: path.join(rel, 'summary.json'), total_pass: sum.total_pass, total_fail: sum.total_fail };
    }
    R.writeReceipt(tmp, {
      ...lane, key, kind, state: 'final', branch, tip: squash, base: check.main,
      source: { key: check.key, kind: lane.kind, tip: lane.tip, base: lane.base }, squash: squashed, written_by: 'merge-lane.sh ship',
    });
    if (fs.existsSync(dest)) {
      fs.mkdirSync(path.join(root, '_superseded'), { recursive: true });
      superseded = path.join(root, '_superseded', `${key}.${RP.stamp(true)}`);
      fs.renameSync(dest, superseded);
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (superseded && !fs.existsSync(dest)) fs.renameSync(superseded, dest);
    throw err;
  }
  return { key, dir: dest, kind, superseded };
}

// ---- the ready-moved re-run -------------------------------------------------------

// suites, the shell's callback (mergeShip's header, step 4): exit 0 only
// when every suite the receipt names ran green on the merged tree.
function suitesStep(runDir) {
  const read = (name) => fs.readFileSync(path.join(runDir, name), 'utf8');
  const log = read('log').trim();
  const list = read('suites').split('\n').filter(Boolean);
  const say = (text) => SL.appendLine(log, 'suites', text);
  if (!list.length || list.some((f) => f.startsWith('-') || path.isAbsolute(f) || f.split('/').includes('..'))) {
    say('the run directory names no suite the runner may take; refused');
    return 1;
  }
  const top = gitOut(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const env = { ...process.env, RUN_SUITES_ROOT: top };
  for (const k of [...R.REPO_VARS, ...SHIP_ENV]) delete env[k];
  const dir = path.join(runDir, 'suites-run');
  const r = spawnSync(process.execPath, [RUN_SUITES, '--log-dir', dir, ...list], { cwd: top, env, stdio: ['ignore', 'inherit', 'inherit'] });
  let sum = null;
  try {
    sum = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  } catch {
    sum = null;
  }
  const suites = sum && Array.isArray(sum.suites) ? sum.suites : [];
  const ok = r.status === 0 && sum && sum.total_fail === 0 && suites.length > 0 && suites.every((s) => s && s.ok === true);
  const failed = suites.filter((s) => !s || s.ok !== true).map((s) => (s && s.file) || '(a suite)');
  say(ok
    ? `the receipt's ${suites.length} suite(s) green on the merged tree, pass ${sum.total_pass}`
    : `the receipt's suites failed on the merged tree (exit ${r.status}${failed.length ? `; not green: ${listed(failed)}` : ''}${sum ? '' : '; no summary'})`);
  return ok ? 0 : 1;
}

module.exports = { markerRefusal, preRefusal, resolvedIndexProblem, indexTree, differsOutsideDocs, wasReset, verifyResolved, refusalOf, writeRunDir, squashShell, findSquash, unpushedOf, findUnpushed, revertedLine, writeSquashReceipt, squashRecord, strandOf, strandLine, dropAt, branchOutcome, removeLaneWorktree, resumeProblem, suitesStep, wedged, worktreeOf, branchInUse, git, gitOut, commitOf };
