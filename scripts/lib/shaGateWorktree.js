'use strict';

// shaGateWorktree: the sha gate's worktree and child half, a leaf module
// (instruction rewrite step 3, lane gate-sha; plan 2026-10-22 decision 11).
// shaGate.js requires it for the paths, the gate worktree's removal and
// sweep, the smoke logs it keeps, and the children it runs and stops. This
// file requires only receipt.js and Node's own modules.
//
// What it guarantees:
//   - The gate worktree is <worktrees dir>/.gate-<sha7>, the worktrees dir
//     beside the primary root (the directory holding the common dir), the
//     rule worktree-new.js uses.
//   - removeWorktree removes a gate worktree whatever state an add or a crash
//     left it in: git worktree remove --force when git has it registered, the
//     directory otherwise (or when git refuses), then a prune. fs.rmSync never
//     follows a link, so the shared node_modules a link points at is never
//     touched. It says whether anything was there to remove.
//   - sweepGateWorktrees removes every .gate-* directory a crash left, keeping
//     its smoke logs first under drb-gate/<name>.smoke-swept-<epoch ms>/.
//   - keepSmoke moves <wt>/.gate-smoke to drb-gate/<sha>.smoke/ in the common
//     dir, replacing an earlier one whole (a rename, or a copy then a removal
//     across filesystems), so the smoke's logs outlive the worktree.
//   - runChild runs each child as the leader of a process group of its own,
//     so stopChild can reach everything it started: SIGTERM to the group,
//     SIGKILL after a grace.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const R = require('./receipt');

const KILL_GRACE_MS = 10_000;
const TAIL_BYTES = 256 * 1024;
const MAX_BUFFER = 64 * 1024 * 1024;

// ---- git and paths -----------------------------------------------------------

function git(cwd, args, env = R.gitEnv()) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

function describe(r) {
  if (r.error) return `could not start: ${r.error.code || r.error.message}`;
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status}`;
}

// The common dir, the primary root (the directory holding it) and the
// worktrees dir beside the primary root.
function gateRoots({ cwd } = {}) {
  const common = R.commonDir({ cwd });
  const primary = path.dirname(common);
  return { common, primary, worktrees: path.join(path.dirname(primary), 'worktrees') };
}

function gateWorktreePath(sha, { cwd } = {}) {
  return path.join(gateRoots({ cwd }).worktrees, `.gate-${R.short(sha)}`);
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return path.resolve(p);
    throw err;
  }
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

// ---- worktrees -------------------------------------------------------------------

// Every worktree git has registered, by real path.
function registeredWorktrees(primary) {
  const r = git(primary, ['worktree', 'list', '--porcelain', '-z']);
  if (r.status !== 0) throw new Error(`git worktree list failed (${describe(r)})`);
  return new Set(r.stdout.split('\0').filter((f) => f.startsWith('worktree ')).map((f) => realOrSelf(f.slice('worktree '.length))));
}

// Removes one gate worktree and prunes; true when a registration or a
// directory was there to remove.
function removeWorktree(primary, wt) {
  const registered = registeredWorktrees(primary).has(realOrSelf(wt));
  if (registered) git(primary, ['worktree', 'remove', '--force', '--force', wt]);
  const present = Boolean(lstatOrNull(wt));
  if (present) fs.rmSync(wt, { recursive: true, force: true });
  git(primary, ['worktree', 'prune']);
  return registered || present;
}

// Moves directory src to dest, replacing dest whole: a rename, or on EXDEV a
// recursive copy then a removal.
function moveDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err;
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
  return dest;
}

// <wt>/.gate-smoke moved to <common dir>/drb-gate/<sha>.smoke/; the kept
// directory, or null when the smoke left none.
function keepSmoke({ wt, sha, cwd }) {
  if (!wt) return null;
  const src = path.join(wt, '.gate-smoke');
  if (!lstatOrNull(src)) return null;
  return moveDir(src, path.join(R.commonDir({ cwd }), 'drb-gate', `${sha}.smoke`));
}

// Removes every .gate-* directory under the worktrees dir (a crash left it),
// its smoke logs kept first (the name holds a sha7 only and is not resolved),
// then prunes; one log line per directory swept. Returns the names swept.
function sweepGateWorktrees({ cwd, log = console.log } = {}) {
  const { common, primary, worktrees } = gateRoots({ cwd });
  let names;
  try {
    names = fs.readdirSync(worktrees);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) names = [];
    else throw err;
  }
  const swept = [];
  for (const name of names.filter((n) => n.startsWith('.gate-'))) {
    const wt = path.join(worktrees, name);
    const smoke = path.join(wt, '.gate-smoke');
    const kept = lstatOrNull(smoke) ? moveDir(smoke, path.join(common, 'drb-gate', `${name}.smoke-swept-${Date.now()}`)) : null;
    removeWorktree(primary, wt);
    log(`gate: swept ${name}, a gate worktree an earlier run left${kept ? ` (its smoke logs kept in ${kept})` : ''}`);
    swept.push(name);
  }
  git(primary, ['worktree', 'prune']);
  return swept;
}

// ---- children ----------------------------------------------------------------------

// Runs one child as the leader of a process group of its own and resolves
// with how it ended: {status, signal, error, out}. `keep` is 'none' (stdout
// and stderr go to this process's stderr, so stdout stays the gate's own
// lines), 'stdout' (stdout kept whole, stderr to this stderr) or 'tail' (both
// kept, the last TAIL_BYTES).
function runChild(state, cmd, args, { cwd, env, keep = 'none' }) {
  return new Promise((resolve) => {
    const out = keep === 'none' ? [2, 2] : keep === 'stdout' ? ['pipe', 2] : ['pipe', 'pipe'];
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', ...out] });
    state.child = child;
    let text = '';
    const add = (d) => {
      text += d;
      if (keep === 'tail' && text.length > TAIL_BYTES) text = text.slice(-TAIL_BYTES);
    };
    if (child.stdout) child.stdout.on('data', add);
    if (child.stderr) child.stderr.on('data', add);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (state.child === child) state.child = null;
      resolve({ ...v, out: text });
    };
    child.on('error', (error) => done({ status: null, signal: null, error }));
    child.on('close', (status, signal) => done({ status, signal, error: null }));
  });
}

function killGroup(child, sig) {
  try {
    process.kill(-child.pid, sig);
  } catch (err) {
    if (err && err.code === 'ESRCH') return;
    throw err;
  }
}

// Stops the running child's group: SIGTERM, then SIGKILL after the grace, and
// resolves once it closed (or a second grace later, whatever it did).
function stopChild(state) {
  const child = state.child;
  if (!child || !child.pid) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
    const give = setTimeout(resolve, 2 * KILL_GRACE_MS);
    child.once('close', () => {
      clearTimeout(kill);
      clearTimeout(give);
      resolve();
    });
    killGroup(child, 'SIGTERM');
    if (child.exitCode !== null || child.signalCode !== null) {
      clearTimeout(kill);
      clearTimeout(give);
      resolve();
    }
  });
}

module.exports = {
  git,
  describe,
  gateRoots,
  gateWorktreePath,
  lstatOrNull,
  removeWorktree,
  keepSmoke,
  sweepGateWorktrees,
  runChild,
  stopChild,
};
