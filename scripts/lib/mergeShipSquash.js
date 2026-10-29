'use strict';

// The squash's proofs and records for the ship phase (instruction rewrite step
// 5, lane merge-ship), split from scripts/lib/mergeShip.js, whose header is
// the contract these serve (the run's steps 1 to 5, the resume and
// --resolved): the refusals before anything is merged (preRefusal, with the
// comment-only lane's squash keyed ahead, squashKeyAhead; and markerRefusal,
// shipFlow's precheck and the marker refusals, which a resume shares),
// --resolved's index rules and proof (resolvedIndexProblem, verifyResolved,
// indexTree, differsOutsideDocs), the shell's first REFUSED line
// (refusalOf), the squash on main (findSquash), a lane's squash on main and
// not yet pushed (findUnpushed: merged's first check, the subject opening
// merge(lane <branch>): , over origin/main..main; resumeProblem, the squash
// receipt's lane tip against the branch's before a resume), the squash
// receipt (writeSquashReceipt) and the ready-moved re-run of the receipt's
// suites on the merged tree (suitesStep, the shell's callback through
// mergeShip.js suites), with two git reads the run shares (worktreeOf,
// originAhead). No CLI of its own.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('./receipt');
const M = require('./markers');
const MC = require('./mergeCheck');
const RP = require('./receiptPublish');
const SL = require('./mergeShipLog');
const { precheck } = require('./shipFlow');

const DOCS = R.GENERATED_DOCS;
const RUN_SUITES = path.join(path.resolve(__dirname, '..'), 'run-suites.js');
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

// Whether origin/main, as last fetched, is not in main's history (false when
// either is missing or git cannot say): mergeShip's behind ending.
function originAhead(cwd) {
  const [origin, main] = ['refs/remotes/origin/main', 'refs/heads/main'].map((ref) => commitOf(cwd, ref));
  try {
    return Boolean(origin && main) && !R.isAncestor(origin, main, { cwd });
  } catch {
    return false;
  }
}

// ---- the refusals before anything is merged ---------------------------------------

// The refusals shipFlow would make, made before anything is merged
// (mergeShip's header, step 1), for a ship of `sha` or of a child of it: an
// unreadable flip marker; and with the flip marker present, shipFlow's own
// precheck (a test override set without DRB_SHIP_ALLOW_STUBS=1, then the
// primary worktree on main), a standing watch marker, and a gate marker
// `sha` does not fix forward (spec 4.4).
function markerRefusal(cwd, sha) {
  const flip = M.flipState({ cwd });
  const st = M.standing({ cwd });
  if (flip.state === 'unreadable') return st.flip;
  const pre = flip.state === 'present' ? precheck(cwd) : {};
  if (pre.refusal) return pre.refusal.split('\n').map((l) => l.replace(/^ship: /, '')).join('; ');
  if (flip.state === 'present' && st.watch) return st.watch;
  if (flip.state === 'present' && st.gate && !M.isFixForward(sha, { cwd, self: true })) return st.gate;
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

// The newest commit of origin/main..main whose subject opens
// merge(lane <branch>): (header), or null, and null with no origin/main.
function findUnpushed(cwd, branch) {
  const origin = commitOf(cwd, 'refs/remotes/origin/main');
  const main = commitOf(cwd, 'refs/heads/main');
  if (!origin || !main || origin === main) return null;
  const needle = `merge(lane ${branch}): `;
  const out = gitOut(cwd, ['log', '-F', `--grep=${needle}`, '--format=%H%x09%s', `${origin}..${main}`, '--']);
  const hit = out.split('\n').map((l) => l.split('\t')).find(([h, sub]) => R.KEY_RE.test(h) && typeof sub === 'string' && sub.startsWith(needle));
  return hit ? hit[0] : null;
}

// Why a resume of the unpushed `squash` stops before any push (mergeShip's
// header, a resume), or null. The squash receipt (the receipt under the
// squash's commit key whose tip is the squash) records the lane tip it
// squashed (squash.lane_tip, writeSquashReceipt's); a branch tip other than
// that holds what the squash does not, which a resume would strand (it
// pushes the old squash and removes the clean worktree). A receipt of the
// squash that records no lane tip (one a review --commit wrote) lets the
// resume go on only while merged's files check passes, every lane file
// byte-identical on main.
function resumeProblem(cwd, branch, squash) {
  const tip = commitOf(cwd, `refs/heads/${branch}`);
  if (!tip) return `no branch ${branch}; a resume needs the branch to resolve`;
  let rec;
  try {
    rec = R.readReceipt(R.receiptDir(R.commitKey(squash, { cwd }), { cwd }));
  } catch (err) {
    return `the receipt of the squash ${S(squash)} cannot be read (${firstLine(err && err.message ? err.message : String(err))}); fix or move it`;
  }
  if (!rec || rec.tip !== squash) return `the squash ${S(squash)} on main has no receipt; a review --commit of it is the way through`;
  const way = 'the way through is a new review of the branch once the squash is pushed or reverted, never a resume';
  const recorded = rec.squash && rec.squash.commit === squash ? rec.squash.lane_tip : null;
  if (!R.KEY_RE.test(String(recorded))) {
    const files = MC.mergedLane({ cwd, branch }).checks.find((c) => c.name === 'files');
    if (files && files.ok) return null;
    return `the receipt of the squash ${S(squash)} records no lane tip, and merged's files check ${files ? 'names lane files main does not hold' : 'did not run'}, which a resume would strand; ${way}`;
  }
  if (recorded === tip) return null;
  const n = git(cwd, ['rev-list', '--count', '--end-of-options', `${recorded}..${tip}`]);
  const count = n.status === 0 ? Number(n.stdout.trim()) : null;
  const since = count === null ? 'the recorded tip not in this repository' : `${count} commit${count === 1 ? '' : 's'} since it`;
  // Bounded (no file list), so the run's log line, 300 characters, holds it whole.
  return `${branch} is at ${S(tip)}, not the lane tip ${S(recorded)} its squash ${S(squash)} records, with ${since}, which a resume would strand; ${way}`;
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

module.exports = { markerRefusal, preRefusal, resolvedIndexProblem, indexTree, differsOutsideDocs, verifyResolved, refusalOf, findSquash, findUnpushed, writeSquashReceipt, resumeProblem, suitesStep, originAhead, worktreeOf, git, gitOut, commitOf };
