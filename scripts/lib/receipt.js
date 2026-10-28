'use strict';

// The review receipt (instruction rewrite step 2, lane receipt-lib; spec
// 2026-10-19 sections 3.5 and 3.7). The keys, the verdict-table parser
// (receiptVerdicts.js, re-exported), the receipt directory and its index, and
// the commit-message block. The review
// skill writes receipts through scripts/review-receipt.js; steps 3 and 5 read
// them through this module, so the parser merge-lane.sh and ship trust is the
// one the skill wrote with.
//
// A receipt is a local file, not a privilege boundary: anything that can forge
// one can already run --no-verify (spec 3.7).
//
// The keys (plan, "The keys"):
//   lane      the stable patch id of `git diff <base> <tip>` over every path
//             but the generated docs (README.md, ARCHITECTURE.md at the root).
//             A content-identical rebase keeps it; a rebase whose new base
//             edited within three lines of a lane hunk changes the hunk's
//             context and so the key (inherent to a patch id), and the index
//             fallback by branch (indexLookup) finds the receipt then.
//   quick-fix the tree of the staged index (`git write-tree`); the commit must
//             carry exactly that tree (HEAD^{tree}).
//   commit    the patch id of `<sha>^..<sha>`, the same exclusions. A squash
//             and a revert are keyed the same way, so a squash of a lane whose
//             main did not move carries the lane's key.
// The diff is pinned, never left to config: no colour, no external driver or
// textconv, full binary content (an abbreviated blob id would make the key
// depend on core.abbrev), no renames, a/ and b/ prefixes, three lines of
// context, myers, from the top of the worktree, path quoting on, and
// patch-id's whitespace stripping on. Attributes are pinned too: git reads
// them from the checkout, which a lane and os need not share, and a -diff or
// binary attribute turns a text change into a binary patch with another id.
// So every key diff reads attributes from the empty tree (--attr-source, git
// 2.42 or later), with core.attributesFile=/dev/null and GIT_ATTR_NOSYSTEM.
// The caveat: $GIT_COMMON_DIR/info/attributes is still read; every worktree
// of the repo shares it, so it cannot make two checkouts disagree, but a
// line written there changes the key everywhere. --text would not serve:
// patch-id ends a line at its first NUL byte, so two binaries that differ
// after one would share a key. Every git call in this lane's modules gets
// one env copy, gitEnv below: without GIT_DIFF_OPTS and GIT_EXTERNAL_DIFF
// (sensitive-match.gitEnv), and without the variables that point git at
// another repository, worktree, index or object store (REPO_VARS, review 4,
// L3), so a call made from a hook, or under any inherited GIT_DIR, reads the
// repo its cwd names. Every ref is checked with `rev-parse --verify --quiet
// --end-of-options <ref>^{commit}` and passed as the full sha after
// --end-of-options, and paths follow `--`.
//
// The verdict-table parser lives in scripts/lib/receiptVerdicts.js and is
// re-exported here, so steps 3 and 5 read every part through this module.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const SM = require('../sensitive-match');
const V = require('./receiptVerdicts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const GENERATED_DOCS = Object.freeze(['README.md', 'ARCHITECTURE.md']);
const KEY_PATHSPEC = Object.freeze(['.', ...GENERATED_DOCS.map((p) => `:!${p}`)]);
const KEY_CONFIG = Object.freeze(['-c', 'core.quotePath=true', '-c', 'patchid.verbatim=false']);
const KEY_DIFF_FLAGS = Object.freeze([
  '--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames',
  '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '--unified=3', '--inter-hunk-context=0',
  '--diff-algorithm=myers', '--indent-heuristic', '--ignore-submodules=none',
]);

const KINDS = Object.freeze(['lane', 'quick-fix', 'commit', 'squash', 'revert', 'comment-only']);
const { LENSES } = V;
const KEY_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_BUFFER = 256 * 1024 * 1024;

// ---- git ----------------------------------------------------------------------

const REPO_VARS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR']);

// The env copy every git call in the lane's modules runs with.
function gitEnv(env = process.env) {
  const out = SM.gitEnv(env);
  for (const k of REPO_VARS) delete out[k];
  return out;
}

// Runs fn with REPO_VARS out of process.env and puts them back after: for a
// sensitive-match call (tierFromGit) that takes no env of its own.
function withGitEnv(fn) {
  const saved = {};
  for (const k of REPO_VARS) {
    if (Object.prototype.hasOwnProperty.call(process.env, k)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  try {
    return fn();
  } finally {
    Object.assign(process.env, saved);
  }
}

function runGit(args, { cwd = REPO_ROOT, input, env = gitEnv() } = {}) {
  return execFileSync('git', args, {
    cwd,
    env,
    input,
    maxBuffer: MAX_BUFFER,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

function gitText(args, opts) {
  return runGit(args, opts).toString('utf8');
}

function toplevel(cwd = REPO_ROOT) {
  return gitText(['rev-parse', '--show-toplevel'], { cwd }).trim();
}

function commonDir({ cwd = REPO_ROOT } = {}) {
  return gitText(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }).trim();
}

// The full sha of a commit, or an Error naming the ref. A value git would read
// as an option never reaches git as one.
function resolveCommit(ref, { cwd = REPO_ROOT } = {}) {
  if (typeof ref !== 'string' || ref === '' || /[\0\n]/.test(ref)) throw new Error(`not a commit: ${JSON.stringify(String(ref))}`);
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { cwd, env: gitEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`not a commit: ${ref}`);
  return r.stdout.trim();
}

function isAncestor(a, b, { cwd = REPO_ROOT } = {}) {
  const r = spawnSync('git', ['merge-base', '--is-ancestor', '--end-of-options', a, b], { cwd, env: gitEnv(), stdio: 'ignore' });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed for ${a.slice(0, 7)} and ${b.slice(0, 7)}`);
}

function mergeBase(a, b, { cwd = REPO_ROOT } = {}) {
  const x = resolveCommit(a, { cwd });
  const y = resolveCommit(b, { cwd });
  return gitText(['merge-base', '--end-of-options', x, y], { cwd }).trim();
}

function short(sha) {
  return String(sha).slice(0, 7);
}

// The env and leading options of a key diff: the system attributes off, the
// attribute source the empty tree (computed, so a SHA-256 repo gets its own).
function keyGit(top) {
  const env = { ...gitEnv(), GIT_ATTR_NOSYSTEM: '1' };
  delete env.GIT_ATTR_SOURCE;
  const empty = gitText(['hash-object', '-t', 'tree', '--stdin'], { cwd: top, input: '' }).trim();
  if (!KEY_RE.test(empty)) throw new Error('git hash-object returned no empty tree');
  return { env, opts: ['-c', 'core.attributesFile=/dev/null', `--attr-source=${empty}`] };
}

// The stable patch id of the diff between two resolved commits, generated docs
// excluded. Throws when that diff is empty: there is nothing to key.
function patchId(from, to, cwd) {
  const top = toplevel(cwd);
  const { env, opts } = keyGit(top);
  const diff = runGit([...KEY_CONFIG, ...opts, 'diff', ...KEY_DIFF_FLAGS, '--end-of-options', from, to, '--', ...KEY_PATHSPEC], { cwd: top, env });
  if (diff.length === 0) throw new Error(`no change outside ${GENERATED_DOCS.join(' and ')} between ${short(from)} and ${short(to)}; nothing to key`);
  const id = gitText([...KEY_CONFIG, 'patch-id', '--stable'], { cwd: top, input: diff }).trim().split(/\s+/)[0] || '';
  if (!KEY_RE.test(id)) throw new Error('git patch-id returned no id');
  return id;
}

function laneKey(base, tip, { cwd = REPO_ROOT } = {}) {
  return patchId(resolveCommit(base, { cwd }), resolveCommit(tip, { cwd }), cwd);
}

function parentOf(sha, { cwd = REPO_ROOT } = {}) {
  try {
    return resolveCommit(`${sha}^`, { cwd });
  } catch {
    throw new Error(`${short(sha)} has no parent; a root commit has no commit key`);
  }
}

function commitKey(sha, { cwd = REPO_ROOT } = {}) {
  const c = resolveCommit(sha, { cwd });
  return patchId(parentOf(c, { cwd }), c, cwd);
}

function quickFixKey({ cwd = REPO_ROOT } = {}) {
  const tree = gitText(['write-tree'], { cwd: toplevel(cwd) }).trim();
  if (!KEY_RE.test(tree)) throw new Error('git write-tree returned no tree');
  return tree;
}

// The full id of a tree (a tree id, or a commit's tree), or an Error naming
// the ref; the same guards as resolveCommit.
function resolveTree(ref, { cwd = REPO_ROOT } = {}) {
  if (typeof ref !== 'string' || ref === '' || /[\0\n]/.test(ref)) throw new Error(`not a tree: ${JSON.stringify(String(ref))}`);
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{tree}`], { cwd, env: gitEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`not a tree: ${ref}`);
  return r.stdout.trim();
}

function namesBetween(a, b, cwd) {
  const out = gitText(['diff', '--name-only', '-z', '--no-renames', '--no-relative', '--no-ext-diff', '--ignore-submodules=none', '--end-of-options', a, b, '--', ...KEY_PATHSPEC], { cwd: toplevel(cwd) });
  return out.split('\0').filter(Boolean);
}

// The files a key covers: the same diff, by name, generated docs excluded.
function filesBetween(from, to, { cwd = REPO_ROOT } = {}) {
  return namesBetween(resolveCommit(from, { cwd }), resolveCommit(to, { cwd }), cwd);
}

// The same between two trees (a quick fix's staged trees).
function filesBetweenTrees(from, to, { cwd = REPO_ROOT } = {}) {
  return namesBetween(resolveTree(from, { cwd }), resolveTree(to, { cwd }), cwd);
}

function stagedFiles({ cwd = REPO_ROOT } = {}) {
  const out = gitText(['diff', '--cached', '--name-only', '-z', '--no-renames', '--no-relative', '--no-ext-diff', '--ignore-submodules=none', '--', ...KEY_PATHSPEC], { cwd: toplevel(cwd) });
  return out.split('\0').filter(Boolean);
}

// ---- directories, the receipt and the index ------------------------------------

// A working name: a branch name or quick-fix-<timestamp>. Slashes are allowed
// (feature/x) and stored as %2F, so a name is always one directory.
function checkName(name) {
  const s = String(name == null ? '' : name);
  const ok = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) && !s.includes('..') && !s.includes('//') && !s.endsWith('/') && !s.endsWith('.lock') && !s.includes('/.');
  if (!ok) throw new Error(`${JSON.stringify(s)} is not a usable name (a branch name: letters, digits, . _ - /)`);
  return s;
}

function reviewRoot({ cwd = REPO_ROOT } = {}) {
  return path.join(commonDir({ cwd }), 'drb-review');
}

function workDir(name, { cwd = REPO_ROOT } = {}) {
  return path.join(reviewRoot({ cwd }), '_work', checkName(name).replace(/\//g, '%2F'));
}

function receiptDir(key, { cwd = REPO_ROOT } = {}) {
  if (!KEY_RE.test(String(key))) throw new Error(`${JSON.stringify(String(key))} is not a receipt key`);
  return path.join(reviewRoot({ cwd }), key);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function writeReceipt(dir, receipt) {
  writeJsonAtomic(path.join(dir, 'receipt.json'), receipt);
}

// A receipt.json, or null when there is none. A file that is not JSON is
// named by its path, never quoted (a parse error would quote the file); one
// that is not a version 1 receipt is refused.
function readReceipt(dir) {
  const file = path.join(dir, 'receipt.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON; fix or move it`);
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec) || rec.version !== 1) throw new Error(`${file} is not a version 1 receipt`);
  return rec;
}

function indexPath(cwd) {
  return path.join(reviewRoot({ cwd }), 'index.json');
}

function readIndex(cwd) {
  const file = indexPath(cwd);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  let idx;
  try {
    idx = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON; fix or move it (nothing was changed)`);
  }
  if (!idx || typeof idx !== 'object' || Array.isArray(idx)) throw new Error(`${file} is not an object; fix or move it (nothing was changed)`);
  return idx;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// An exclusive lock file around a read-modify-write of the index. A lock older
// than STALE_LOCK_MS is a crashed writer's and is broken; one held longer than
// `waitMs` by a live writer is an error.
const STALE_LOCK_MS = 30_000;

function withLock(lockFile, waitMs, fn) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age;
      try {
        age = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        continue;
      }
      if (age > STALE_LOCK_MS) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`${lockFile} is held by another writer; try again`);
      sleepMs(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

function indexSet(branch, { key, tip, reviewedAgainst }, { cwd = REPO_ROOT, lockWaitMs = 10_000 } = {}) {
  checkName(branch);
  if (!KEY_RE.test(String(key))) throw new Error(`${JSON.stringify(String(key))} is not a receipt key`);
  const file = indexPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withLock(`${file}.lock`, lockWaitMs, () => {
    const idx = readIndex(cwd);
    idx[branch] = { key, tip, reviewed_against: reviewedAgainst, at: new Date().toISOString() };
    writeJsonAtomic(file, idx);
  });
}

// {key, dir, via} for a key whose receipt exists, else for the branch the index
// maps to an existing receipt; null when neither finds one.
function indexLookup(branchOrKey, { cwd = REPO_ROOT } = {}) {
  const s = String(branchOrKey == null ? '' : branchOrKey);
  const exists = (k) => fs.existsSync(path.join(receiptDir(k, { cwd }), 'receipt.json'));
  if (KEY_RE.test(s) && exists(s)) return { key: s, dir: receiptDir(s, { cwd }), via: 'key' };
  const idx = readIndex(cwd);
  const entry = Object.prototype.hasOwnProperty.call(idx, s) ? idx[s] : null;
  if (entry && KEY_RE.test(String(entry.key)) && exists(entry.key)) return { key: entry.key, dir: receiptDir(entry.key, { cwd }), via: 'branch', entry };
  return null;
}

// ---- the commit block (spec 3.7) -------------------------------------------------

const CHICAGO = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// A field the block cannot read prints a placeholder; the block never throws.
function blockTime(iso) {
  const d = new Date(typeof iso === 'string' ? iso : NaN);
  if (Number.isNaN(d.getTime())) return '(no timestamp)';
  const parts = Object.fromEntries(CHICAGO.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function sha7(x) {
  return typeof x === 'string' && x ? short(x) : '(none)';
}

function frac(pass, fail) {
  const n = (x) => Number.isInteger(x) && x >= 0;
  return `${n(pass) ? pass : '?'}/${n(pass) && n(fail) ? pass + fail : '?'}`;
}

function uniq(list) {
  return [...new Set(list)];
}

function sum(list, field) {
  return list.reduce((n, x) => n + (Number(x && x[field]) || 0), 0);
}

// The tests line's items, in the order run, the smoke first; a suite run
// again shows its latest run. The smoke counts suites green over suites run
// (spec 3.7's 79/79 is the money suite count); every other suite is named by
// its path in the repo, .test.js kept, so two suites that share a basename
// are both shown; a --log entry by the suite its command named, else its log
// name; the client build by its latest run, 1/1 green or 0/1 failed.
function testItems(tests) {
  const items = new Map();
  const put = (name, text) => {
    items.delete(name);
    items.set(name, text);
  };
  const ordered = [...(tests || []).filter((t) => t.type === 'smoke'), ...(tests || []).filter((t) => t.type !== 'smoke')];
  for (const t of ordered) {
    if (t.type === 'smoke') {
      const suites = Array.isArray(t.suites) ? t.suites : null;
      put('money-smoke', `money-smoke ${suites ? `${suites.filter((x) => x && x.fail === 0).length}/${suites.length}` : '?/?'}`);
    } else if (t.type === 'suites') {
      if (!t.suites || t.suites.length === 0) put('(none reached)', 'no suites reached');
      for (const x of t.suites || []) put(`suite ${x.file}`, `${x.file} ${frac(x.pass, x.fail)}`);
    } else if (t.type === 'build') {
      put('client-build', `client-build ${t.ok === true ? '1/1' : '0/1'}`);
    } else {
      const name = t.file || t.name;
      put(`suite ${name}`, `${name} ${frac(t.pass, t.fail)}`);
    }
  }
  return [...items.values()];
}

// The squash-message block of spec 3.7, from "Review:" to the receipt line.
// It prints names, paths and counts only, never a finding, a note, a reason or
// a line of a log.
function commitBlock(r) {
  const paren = [];
  const sensitive = uniq((r.matched_paths || []).map((m) => m.pattern || m.path).filter(Boolean));
  if (sensitive.length) paren.push(`sensitive: ${sensitive.join(', ')}`);
  const hits = uniq((r.content_rule_hits || []).map((h) => h.file).filter(Boolean));
  if (hits.length) paren.push(`content rule: ${hits.join(', ')}`);
  if (r.kind === 'comment-only') paren.push('comment-only proof');
  const head = `Review: tier ${r.tier}${paren.length ? ` (${paren.join('; ')})` : ''}`;

  const names = (r.lenses || []).map((l) => l.name);
  const lensList = [...LENSES.filter((n) => names.includes(n)), ...names.filter((n) => !LENSES.includes(n))];
  let lenses = lensList.length ? lensList.join(', ') : 'none';
  const ext = r.externals || {};
  const ran = ['codex', 'gemini'].filter((n) => ext[n] && ext[n].state === 'run');
  const notRun = ['codex', 'gemini'].filter((n) => !ran.includes(n));
  if (r.tier === 'A' || ran.length) {
    if (ran.length === 0) lenses += '; second opinion not run';
    else lenses += `; second opinion (${ran.join(', ')}${notRun.length ? `; ${notRun.map((n) => `${n} not run`).join(', ')}` : ''})`;
  }
  if (r.verify && r.verify.run) lenses += '; verify';

  const cov = r.coverage || {};
  const total = (cov.files_in_diff || []).length;
  const covered = (cov.files_with_verdicts || []).length;
  const missing = uniq((cov.not_reached || []).map((x) => (typeof x === 'string' ? x : x.file))).length;
  const files = `${covered}/${total} verdicts${cov.allowed_not_reached && missing ? `, ${missing} not reached (allowed)` : ''}`;

  const counted = [...(r.lenses || []), ...(r.verify ? [r.verify] : [])];
  const findings = `${sum(counted, 'raised')} raised, ${sum(counted, 'confirmed')} confirmed, ${sum(counted, 'fixed')} fixed and re-reviewed, ${sum(counted, 'rejected')} rejected`;

  const items = testItems(r.tests);
  const tests = items.length ? items.join(', ') : 'none recorded';
  // A quick fix's key is a tree, not a patch id, and its line says so on
  // purpose: `tree <key7>` is what HEAD^{tree} of its commit must show. The
  // review's recorded mode says it too, so a comment-only receipt of a quick
  // fix (keyed by its staged tree) prints a tree.
  const what = r.kind === 'quick-fix' || r.mode === 'quick-fix' ? 'tree' : 'patch';
  const rec = `${what} ${sha7(r.key)}, reviewed against main ${sha7(r.reviewed_against)}, ${blockTime(r.timestamp)}`;

  return [
    head,
    `  lenses:   ${lenses}`,
    `  files:    ${files}`,
    `  findings: ${findings}`,
    `  tests:    ${tests}`,
    `  receipt:  ${rec}`,
  ].join('\n');
}

module.exports = {
  laneKey,
  quickFixKey,
  commitKey,
  parseVerdictTable: V.parseVerdictTable,
  lensHeadings: V.lensHeadings,
  mergeVerdicts: V.mergeVerdicts,
  coverage: V.coverage,
  workDir,
  receiptDir,
  reviewRoot,
  commonDir,
  writeReceipt,
  readReceipt,
  indexSet,
  indexLookup,
  commitBlock,
  resolveCommit,
  parentOf,
  isAncestor,
  mergeBase,
  short,
  filesBetween,
  filesBetweenTrees,
  stagedFiles,
  checkName,
  writeJsonAtomic,
  gitEnv,
  withGitEnv,
  REPO_VARS,
  GENERATED_DOCS,
  KINDS,
  VERDICTS: V.VERDICTS,
  LENSES,
  KEY_RE,
};
