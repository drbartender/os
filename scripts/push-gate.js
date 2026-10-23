#!/usr/bin/env node
'use strict';

/**
 * push-gate — the two mechanical pre-push gates, plus a receipt so they are
 * never run twice for the same code.
 *
 * WHY THIS EXISTS (2026-08-14). `git push` opens the SSH connection and pulls
 * the ref advertisement BEFORE it runs the pre-push hook. The hook then took
 * ~8 minutes (431s of money suites + ~60s client build), the connection sat
 * idle that whole time, and GitHub closed it; git then wrote the packfile into
 * a dead socket and the push failed AFTER passing every gate, silently. The
 * hook was fast until ~2026-08-11, when NEON_API_KEY was configured and the
 * money smoke went from a SKIP banner to a real 431s run, which is exactly
 * when the hangs started. SSH keepalives do not help: it is the remote closing
 * an idle git-receive-pack session, not a NAT dropping a TCP flow.
 *
 * The fix is not to weaken the gate, it is to stop DUPLICATING it. The review
 * pass already runs these same checks against this same tree; the hook then ran
 * them again and that second run is what broke the push. So: `npm run gate`
 * runs them once and writes a receipt, and the hook skips instantly when the
 * receipt matches. No receipt, or a receipt that does not cover this push, and
 * the hook runs the full gate exactly as before. Fail-closed is preserved.
 *
 * ── THE SAFETY PROPERTY ───────────────────────────────────────────────────
 * Skip ONLY when the exact bytes now on disk were already gated AND the commit
 * being pushed is the commit those bytes belong to. The 2026-08-14 push-gate
 * review (Claude fleet + codex + gemini, all three independently) broke the
 * first draft of this file on five distinct paths; each guard below exists
 * because one of them shipped ungated code in a scratch repo:
 *
 *   1. CONTENT, not status. `git status --porcelain` reports a path and a
 *      status letter, never bytes, so re-editing an ALREADY-modified file left
 *      the fingerprint identical and the receipt valid. The fingerprint now
 *      hashes the CONTENT of every modified and untracked path.
 *   2. THE PUSHED COMMIT MUST BE HEAD. Both gates execute against the WORKING
 *      TREE (testdb-smoke runs the on-disk suites, the build builds the
 *      checkout), so they only describe HEAD. `git push origin <sha>:main` with
 *      a sha that is not HEAD ships code the gates never looked at. A receipt
 *      is now only valid when every pushed sha IS HEAD.
 *   3. EVERY ref, not the first. A multi-ref push feeds one line per ref and
 *      the old loop returned on the first, so `git push origin docs-branch main`
 *      gated the docs branch and skipped the money gate for main.
 *   4. MALFORMED stdin is unknown, not empty. A truncated line with no second
 *      field used to read as "deletions only" and skip everything.
 *   5. A SKIPPED money gate is not a PASSED money gate. testdb-smoke exits 0
 *      with a red banner when no NEON_API_KEY resolves; recording that as a
 *      pass laundered it into a green checkmark for 12 hours.
 *
 * KNOWN AND ACCEPTED LIMITS, stated because overstating them is how the first
 * draft went wrong:
 *   - GITIGNORED files are outside the fingerprint (`.env`, `client/.env*`,
 *     `~/.secrets/*`, node_modules). They can change what the gates do. The
 *     12h expiry is the only backstop, and the money-skip guard above closes
 *     the one case that actually mattered.
 *   - The receipt is a plain local file. Anything that can write it can also
 *     run `git push --no-verify`, so it is not a privilege boundary and is not
 *     treated as one.
 *
 * SHA MODE AND THE FLIP (instruction rewrite step 3, lane gate-sha; spec
 * 2026-10-19 sections 4.3, 4.4 and 8; plan 2026-10-22 decisions 2, 10, 11, 14
 * and 16). Dormant until the flip marker (<git-common-dir>/drb-flip.json)
 * exists; before it nothing above changes, and the flip push itself goes
 * through the legacy path.
 *   - `sha <sha>` gates ONE commit in a throwaway worktree of its own
 *     (<worktrees dir>/.gate-<sha7>, detached), with its own env file and no
 *     live key, the gates picked from everything in origin/main..sha after a
 *     fetch, never from the tip alone. It writes a receipt keyed on the sha to
 *     <git-common-dir>/drb-gate/<sha>.json, sets the gate marker for a verdict
 *     about the code at a sha on main (never for a failure of the gate
 *     itself; it names the verdict checks that run did not prove), and on a
 *     pass clears a standing marker the sha fixes forward or is the sha of,
 *     when the run re-ran every check it names once the failing sha is on
 *     origin/main, or the ones the range still needs before that. The
 *     machinery is scripts/lib/shaGate.js; this file holds the lock and the
 *     CLI. It takes the push-gate lock non-blocking as `run` does (a second
 *     gate refuses with the same lines), held by flock -n on a descriptor of
 *     this process rather than a re-exec, so a stop signal reaches the gate
 *     itself and its cleanup removes the worktree.
 *   - `receipt <sha>` prints that receipt, or `none`.
 *   - `verify`, the hook, branches on markers.flipState. Absent: the legacy
 *     path above, exactly, its lock included and the markers unread.
 *     Unreadable: refuse. Present: validate only and take no lock, since the
 *     hook runs inside git's SSH window and must never wait or run a gate: a
 *     push to refs/heads/main alone, no standing marker, a sha receipt good
 *     for each pushed sha against the local origin/main (ship fetched moments
 *     before; a stale ref can only make git reject the push), and review
 *     receipts over origin/main..sha (rangeCheck). No receipt means refuse
 *     with "run npm run ship".
 *   - MONEY_PATHS and CLIENT_PATHS come from scripts/lib/gatePaths.js, the one
 *     classifier, so the legacy `run` gates on its wider list too, which only
 *     adds gating.
 */

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RECEIPT_VERSION = 2;
// Generous: the fingerprint pins the bytes exactly, so age only guards drift in
// EXTERNAL state the gates also depend on (the ci-smoke branch resets from
// prod; gitignored env files are invisible here). Twelve hours keeps a normal
// review-then-push cycle instant while expiring a receipt from yesterday.
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

// The gate's path lists live in scripts/lib/gatePaths.js (the one classifier
// the sha gate, rangeCheck and ship share); they are re-exported below so the
// tests and neededGates keep their names.
const { MONEY_PATHS, CLIENT_PATHS } = require('./lib/gatePaths');
const M = require('./lib/markers');
const R = require('./lib/receipt');
const SG = require('./lib/shaGate');
const { checkRange } = require('./lib/rangeCheck');

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
}

function gitQuiet(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Exclusive lock for the whole gate run.
 *
 * WHY (learned the hard way, 2026-08-14): the money gate RESETS the shared Neon
 * `ci-smoke` branch to its parent and then runs suites against it. Two gate runs
 * at once therefore delete each other's rows mid-test. Observed exactly that
 * with two overlapping runs: one died on payrollClawback, the other on
 * balanceInvoiceMonitor with `proposal_activity_log_proposal_id_fkey`
 * violations, i.e. its own seeded proposal vanished underneath it. Different
 * suites failing in each run is the tell: a real regression fails the same one.
 *
 * A false FAILURE is the mild outcome; the bad one is a reset landing between a
 * suite's setup and its assertions in a way that passes. So the gate serializes.
 *
 * It REFUSES rather than waits: this runs inside pre-push, and waiting is what
 * leaves git's connection idle until GitHub closes it, which is the whole bug
 * this file exists to fix. Refusing exits non-zero, so the push is BLOCKED, not
 * allowed. Same posture as scripts/merge-lane.sh, which flocks the merge.
 *
 * WHY flock AND NOT A PIDFILE (rewritten after the 2026-08-14 delta review took
 * the pidfile version apart): the stale-reclaim unlink was blind, so two
 * starters could both reclaim and BOTH run — reproduced 4 times in 25 trials,
 * once with three concurrent gates. Every signal leaked the file, so a plain
 * Ctrl-C on an 8-minute run made "stale lock present" the routine state, and
 * recovery then ran straight back through the racy reclaim. A reused pid could
 * wedge every future push with no recovery path. flock has none of those
 * failure modes because the KERNEL drops it when the fd closes, kill -9
 * included: nothing to leak, no liveness check, no TTL, no reclaim, no race.
 * merge-lane.sh already does exactly this and its header says why; this file
 * had reimplemented a strictly weaker version of the lock it cites as
 * precedent.
 */
function reexecUnderFlock() {
  if (process.env.DRB_GATE_LOCKED === '1') return; // already holding it
  // The COMMON git dir, deliberately: the protected resource is the ONE shared
  // Neon ci-smoke branch, while every lane is a linked worktree with its own
  // --absolute-git-dir. Scoping there let an os gate and a lane gate run at
  // once. The RECEIPT stays per-worktree, since each has its own tree and HEAD.
  const lockFile = path.join(
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'drb-push-gate.lock');
  const r = spawnSync('flock', ['-n', lockFile, process.execPath, __filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, DRB_GATE_LOCKED: '1' },
  });
  if (r.error) {
    // flock missing or unstartable: fail CLOSED. Running unlocked risks two
    // gates resetting ci-smoke under each other, which can bank a receipt for
    // a gate that never coherently ran.
    lockNotStarted(r.error);
    process.exit(1);
  }
  if (r.status === 1 && !r.signal) lockHeldElsewhere(lockFile);
  process.exit(r.status === null ? 1 : r.status);
}

// The two lock refusals, shared by the re-exec above and sha mode's lock
// below, so a second gate refuses with the same lines either way.
function lockNotStarted(err) {
  console.error('');
  console.error(`✗ BLOCKED — could not acquire the gate lock (${err.code || err.message}).`);
  console.error('  flock (util-linux) is required so two gate runs cannot reset the shared');
  console.error('  Neon ci-smoke branch under each other. Emergencies only: git push --no-verify');
}

function lockHeldElsewhere(lockFile) {
  console.error('');
  console.error('✗ BLOCKED — another push gate is already running.');
  console.error('  They share one Neon ci-smoke branch, so running both corrupts each other.');
  console.error(`  Check: fuser ${lockFile}   (lists the holding PID, if any)`);
  console.error('  Wait for it to finish, then retry. Emergencies only: git push --no-verify');
}

// Sha mode's hold on the same lock file, non-blocking like the re-exec, but
// on a descriptor of this process: `flock -n 3` locks the open file
// description this process shares with the child, so the lock lasts until
// this process exits (kill -9 included) and no re-exec stands between a stop
// signal and the gate's own cleanup. Node opens files close-on-exec, so the
// gate's children never hold it. DRB_GATE_LOCKED is not honoured here: it is
// the re-exec's guard, and sha mode never re-execs.
function holdGateLock() {
  const lockFile = path.join(
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'drb-push-gate.lock');
  const fd = fs.openSync(lockFile, 'a');
  const r = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'inherit', 'inherit', fd] });
  if (r.error) {
    lockNotStarted(r.error);
    process.exit(1);
  }
  if (r.status !== 0) {
    if (r.status === 1 && !r.signal) lockHeldElsewhere(lockFile);
    process.exit(1);
  }
  return fd;
}

// testdb-smoke.js takes the smoke lock (drb-smoke.lock) itself, so a gate run
// holds this lock and then the smoke lock, never the reverse, and a smoke
// started any other way (npm run test:smoke, a review-time smoke) waits on the
// smoke lock instead of resetting ci-smoke under a gate. No file lock can
// cover a second clone or machine (that would need a Neon-side lock).


function receiptPath() {
  // --absolute-git-dir resolves correctly inside a linked worktree, where .git
  // is a file, so each worktree keeps its own receipt.
  return path.join(git(['rev-parse', '--absolute-git-dir']), 'drb-push-gate-receipt.json');
}

/**
 * Every path git considers modified or untracked, with its status code.
 * Uses -z so paths containing spaces, quotes or newlines survive; rename and
 * copy entries carry a second NUL-terminated path that must be consumed.
 */
function dirtyEntries() {
  const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const parts = raw.split('\0').filter((p) => p.length > 0);
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (/^[RC]/.test(code)) i += 1; // consume the origin path of a rename/copy
    out.push({ code, file });
  }
  return out;
}

/**
 * Fingerprint of exactly what the gates would test: HEAD, plus the CONTENT of
 * every modified and untracked file. Content, not just the status line: the
 * review proved that hashing the porcelain text alone let a re-edit of an
 * already-dirty file keep a valid receipt.
 */
function treeFingerprint() {
  const head = git(['rev-parse', 'HEAD']);
  const rows = dirtyEntries().map(({ code, file }) => {
    let contentHash;
    try {
      const st = fs.lstatSync(file);
      // NOTE isSymbolicLink(), not isSymlink() — the latter does not exist, and
      // writing it threw a TypeError that the catch below swallowed into a
      // constant, so the fingerprint silently stopped depending on content at
      // all. Caught only because a test asserted the hash MOVES on an edit.
      // That is why this catch is now narrow: a programming error here disables
      // the safety property while still looking like it works.
      if (st.isSymbolicLink()) contentHash = `symlink:${sha256(fs.readlinkSync(file))}`;
      else if (st.isFile()) contentHash = sha256(fs.readFileSync(file));
      else if (st.isDirectory()) contentHash = 'dir';
      else contentHash = 'special';
    } catch (err) {
      // A vanished or unreadable file is expected (a staged deletion, a
      // permissions problem) and is legitimately "not the bytes we gated".
      // Anything else is a bug in this function and must be loud.
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM')) contentHash = `missing:${err.code}`;
      else throw err;
    }
    return `${code}|${file}|${contentHash}`;
  });
  rows.sort();
  const fingerprint = sha256(`${head}\n${rows.join("\n")}`);
  return { head, fingerprint, dirty: rows.length > 0, dirtyCount: rows.length };
}

/** origin/main when it exists; null on a first push. */
function diffBase() {
  const r = gitQuiet(['rev-parse', '--verify', '--quiet', 'origin/main']);
  return r.ok && r.out ? 'origin/main' : null;
}

/**
 * Which gates these pushed refs need, unioned over ALL of them. A multi-ref
 * push must gate every ref, not the first one git happened to list.
 */
function neededGates(refs) {
  const list = Array.isArray(refs) ? refs : [refs];
  const base = diffBase();
  if (!base) return { gates: ['money', 'client'], base: null, reason: 'no origin/main yet, gating everything' };
  const gates = new Set();
  for (const ref of list) {
    if (!gitQuiet(['diff', '--quiet', base, ref, '--', ...MONEY_PATHS]).ok) gates.add('money');
    if (!gitQuiet(['diff', '--quiet', base, ref, '--', ...CLIENT_PATHS]).ok) gates.add('client');
  }
  return { gates: [...gates], base, reason: null };
}

function readReceipt() {
  try {
    const raw = JSON.parse(fs.readFileSync(receiptPath(), 'utf8'));
    if (!raw || raw.version !== RECEIPT_VERSION) return null;
    if (!Array.isArray(raw.gates)) return null; // malformed must never reach the accept branch
    if (typeof raw.fingerprint !== 'string' || typeof raw.head !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

function writeReceipt({ fingerprint, head, gates }) {
  const receipt = { version: RECEIPT_VERSION, fingerprint, head, gates, at: new Date().toISOString() };
  fs.writeFileSync(receiptPath(), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/**
 * Is the receipt good for this push? Returns a reason string when it is NOT,
 * so the hook can say plainly why it is about to spend eight minutes.
 *
 * `pushedShas` must all equal HEAD: the gates only ever describe the working
 * tree, so a receipt cannot vouch for a commit the tree is not sitting on.
 */
function checkReceipt(receipt, { fingerprint, head, needed, pushedShas = [], now = Date.now() }) {
  if (!receipt) return 'no receipt (run: npm run gate)';
  if (receipt.fingerprint !== fingerprint) return 'the working tree changed since the gate ran';
  if (receipt.head !== head) return 'HEAD moved since the gate ran';
  const foreign = pushedShas.filter((s) => s !== head);
  if (foreign.length) {
    return `pushing ${foreign[0].slice(0, 8)}, which is not HEAD (the gates only ever test the working tree)`;
  }
  const age = now - Date.parse(receipt.at);
  if (!Number.isFinite(age)) return 'receipt timestamp is unreadable';
  if (age < 0) return 'receipt is dated in the future';
  if (age > MAX_AGE_MS) return `receipt is ${Math.floor(age / 3600000)}h old (max ${MAX_AGE_MS / 3600000}h)`;
  const missing = needed.filter((g) => !receipt.gates.includes(g));
  if (missing.length) return `receipt does not cover: ${missing.join(', ')}`;
  return null;
}

/** The same key discovery testdb-smoke.js does, so we can tell run from skip. */
function neonKeyResolves() {
  if (process.env.NEON_API_KEY && process.env.NEON_API_KEY.trim()) return true;
  try {
    return fs.readFileSync(path.join(os.homedir(), '.secrets', 'neon_api_key'), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

function describeSpawn(r) {
  if (r.error) return `could not start: ${r.error.code || r.error.message}`;
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status}`;
}

/** @returns {{ok: boolean, ran: boolean}} ran=false means it SKIPPED, which is not a pass. */
function runMoneyGate() {
  if (!neonKeyResolves()) {
    // testdb-smoke would print its red SKIP banner and exit 0. Letting that
    // write a 'money' receipt turns a loud never-ran into a green checkmark
    // for 12 hours, so run it for the banner but refuse to bank it.
    console.log('gate: server/ changed — running the money-path smoke gate…');
    const skipRun = spawnSync(process.execPath, ['scripts/testdb-smoke.js'], { stdio: 'inherit' });
    // Still honour a NONZERO exit here. Today this branch is only reached when
    // testdb-smoke would print its banner and exit 0, because both files
    // discover the key from the same two sources in the same order. That
    // equivalence is duplicated code, though, and if either side ever gains
    // dotenv or the key moves into .env, the branches diverge — at which point
    // ignoring the status would turn a real failure into a pass.
    if (skipRun.status !== 0) {
      console.error(`✗ BLOCKED — money smoke did not pass (${describeSpawn(skipRun)}).`);
      console.error('  Emergencies only: git push --no-verify');
      return { ok: false, ran: false };
    }
    console.log('gate: money smoke SKIPPED (no NEON_API_KEY) — NOT recorded as passed.');
    return { ok: true, ran: false };
  }
  console.log('gate: server/ changed — running the money-path smoke gate…');
  const r = spawnSync(process.execPath, ['scripts/testdb-smoke.js'], { stdio: 'inherit' });
  if (r.status === 0) return { ok: true, ran: true };
  console.error(`✗ BLOCKED — money smoke did not pass (${describeSpawn(r)}).`);
  console.error('  Emergencies only: git push --no-verify');
  return { ok: false, ran: false };
}

function runClientGate() {
  console.log('gate: client/ changed — running the Vercel-equivalent gate (CI=true react-scripts build, ~1 min)…');
  const r = spawnSync('npx', ['react-scripts', 'build'], {
    cwd: path.join(process.cwd(), 'client'),
    env: { ...process.env, CI: 'true' },
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: Infinity, // a truncated log would make "last 25 lines" show the cut, not the error
  });
  if (r.status === 0) {
    console.log('✓ gate: client build passed — the Vercel client deploy will not fail-compile.');
    return { ok: true, ran: true };
  }
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  console.error('');
  console.error(`✗ BLOCKED — the client build failed (${describeSpawn(r)}). This WOULD fail the Vercel deploy.`);
  console.error('  ── last 25 lines ──────────────────────────────────────────');
  console.error(out.slice(-25).join('\n') || '  (no output: the build never started)');
  console.error('  ───────────────────────────────────────────────────────────');
  console.error('  Fix the errors above. Emergencies only: git push --no-verify');
  return { ok: false, ran: false };
}

/**
 * Run the needed gates against the tree, then write a receipt recording only
 * what genuinely RAN and passed. Re-fingerprints afterwards: an 8-minute run in
 * a shared checkout can finish against a different tree than it started on, and
 * banking that would vouch for bytes nothing ever gated.
 */
// Serialization happens in reexecUnderFlock() before legacyMain() dispatches, so by
// the time anything here runs we already hold the lock for the whole process.
function runGates(needed, fpBefore) {
  const passed = [];
  if (needed.includes('money')) {
    const r = runMoneyGate();
    if (!r.ok) return false;
    if (r.ran) passed.push('money');
  }
  if (needed.includes('client')) {
    const r = runClientGate();
    if (!r.ok) return false;
    if (r.ran) passed.push('client');
  }
  if (!needed.length) console.log('gate: no gated paths changed — nothing to run.');

  const fpAfter = treeFingerprint();
  if (fpAfter.fingerprint !== fpBefore.fingerprint) {
    console.log('');
    console.log('gate: the working tree changed WHILE the gates ran, so no receipt was written.');
    console.log('      (another window edited files mid-run; the gates passed for the tree as it');
    console.log('       was, not as it is now). Re-run `npm run gate` when the tree is settled.');
    return true; // the gates themselves passed; we simply refuse to vouch for the new tree
  }
  writeReceipt({ fingerprint: fpAfter.fingerprint, head: fpAfter.head, gates: passed });
  return true;
}

/**
 * Every sha being pushed, from the hook's stdin, which git feeds as
 * `<local ref> <local sha> <remote ref> <remote sha>` per updated ref.
 *
 *   {kind:'shas', shas:[...]}  real refs are shipping; gate ALL of them
 *   {kind:'deletes'}           every line was an all-zero local sha, so no
 *                              code ships and there is nothing to gate
 *   {kind:'unknown'}           empty, a TTY, unreadable, or MALFORMED. Never a
 *                              free pass: the caller falls back to gating HEAD,
 *                              because "I cannot tell what is being pushed"
 *                              must fail closed.
 */
function parsePushedShas(input) {
  if (input === null || input === undefined) return { kind: 'unknown' };
  const lines = String(input).split('\n').map((l) => l.trim()).filter(Boolean);
  // EMPTY is different from MALFORMED and must not be conflated. git feeds no
  // lines only when no ref is being updated (verified across ten push forms:
  // --all/--tags with everything already up to date), so nothing ships and
  // there is nothing to gate. Malformed input, by contrast, means we cannot
  // tell what ships, which has to block.
  if (!lines.length) return { kind: 'empty' };
  const shas = [];
  for (const line of lines) {
    const fields = line.split(/\s+/);
    // A well-formed line has 4 fields. Anything shorter means we cannot read
    // this push, which is unknown, NOT "nothing to do".
    if (fields.length < 2) return { kind: 'unknown' };
    const localSha = fields[1];
    if (!/^[0-9a-fA-F]{7,64}$/.test(localSha)) return { kind: 'unknown' };
    if (!/^0+$/.test(localSha)) shas.push(localSha);
  }
  return shas.length ? { kind: 'shas', shas } : { kind: 'deletes' };
}

function readStdin() {
  if (process.stdin.isTTY) return { kind: 'unknown' };
  try {
    return parsePushedShas(fs.readFileSync(0, 'utf8'));
  } catch {
    return { kind: 'unknown' };
  }
}

// The three stdin shapes that end the hook before any receipt is read, the
// same lines on the legacy path and after the flip; returns for 'shas'.
function stdinVerdict(parsed) {
  if (parsed.kind === 'deletes') {
    console.log('pre-push: deletions only — nothing to gate.');
    process.exit(0);
  }
  if (parsed.kind === 'empty') {
    console.log('pre-push: git listed no updated refs — nothing ships, nothing to gate.');
    process.exit(0);
  }
  if (parsed.kind === 'unknown') {
    // We could not read WHAT is being pushed. Gating HEAD and allowing would
    // be a guess, and if git is pushing anything else that commit reaches
    // prod ungated — the precise condition this parsing exists to prevent.
    // Refuse; the push is blocked, never silently allowed.
    console.error('');
    console.error('✗ BLOCKED — could not read the refs being pushed from the hook\'s stdin.');
    console.error('  The gates can only vouch for code they can identify, so this fails closed');
    console.error('  rather than gating a guess. If you know what you are doing:');
    console.error('  git push --no-verify');
    process.exit(1);
  }
}

function legacyMain() {
  reexecUnderFlock(); // does not return unless we hold the gate lock
  const mode = process.argv[2] || 'run';
  const fp = treeFingerprint();

  if (mode === 'verify') {
    const parsed = readStdin();
    stdinVerdict(parsed);
    const pushedShas = parsed.kind === 'shas' ? parsed.shas : [];
    const refs = pushedShas.length ? pushedShas : ['HEAD'];
    const { gates: needed } = neededGates(refs);
    const receipt = readReceipt(); // read ONCE: a parallel `npm run gate` between
                                   // two reads could validate one and print another
    // An unreadable stdin must invalidate the receipt too, not just fall back to
    // gating HEAD. Otherwise pushedShas is empty, the foreign-sha check is
    // vacuous, and a valid HEAD receipt is honoured without ever confirming what
    // is shipping — which contradicts invariant 4 in the header.
    // Reaching here means kind === 'shas': deletes, empty and unknown all
    // returned above, so pushedShas is non-empty and the foreign-sha check in
    // checkReceipt can never be satisfied by vacuity.
    const why = checkReceipt(receipt, { fingerprint: fp.fingerprint, head: fp.head, needed, pushedShas });
    if (!why) {
      const covered = receipt.gates.length ? receipt.gates.join(' + ') : 'nothing to run';
      console.log(`✓ pre-push: gate receipt valid for this exact tree (${covered}) — skipping the re-run.`);
      process.exit(0);
    }
    console.log(`pre-push: running the full gate — ${why}.`);
    const foreign = pushedShas.filter((s) => s !== fp.head);
    if (foreign.length) {
      console.log('');
      console.log(`pre-push: WARNING — you are pushing ${foreign[0].slice(0, 12)} but the working tree is at`);
      console.log(`          ${fp.head.slice(0, 12)}. Both gates test the WORKING TREE, so they describe`);
      console.log('          your checkout, NOT the commit being pushed. Check that commit out first if');
      console.log('          you want it gated.');
      console.log('');
    }
    process.exit(runGates(needed, fp) ? 0 : 1);
  }

  // `npm run gate` — validate the tree now, so the push itself is instant.
  const { gates: needed } = neededGates([process.argv[3] || 'HEAD']);
  if (fp.dirty) {
    console.log(`gate: NOTE ${fp.dirtyCount} uncommitted/untracked file(s) present. The gates test the tree`);
    console.log('      as it stands, and editing any of them invalidates the receipt.');
  }
  const ok = runGates(needed, fp);
  if (ok) {
    // Report what was actually BANKED, not a blanket pass: a money gate that
    // skipped for want of a key must not read as green here either.
    const banked = readReceipt();
    const shortfall = needed.filter((g) => !banked || !banked.gates.includes(g));
    console.log('');
    if (!banked) {
      // No receipt at all: either nothing could be banked, or the tree moved
      // mid-run. Never print a pass here, even when `needed` was empty.
      console.log('gate finished, but NO receipt was written — the next push runs the full gate.');
    } else if (shortfall.length) {
      console.log(`gate finished, but ${shortfall.join(' + ')} was NOT banked — the hook will re-run it.`);
    } else {
      const covered = banked.gates.length ? banked.gates.join(' + ') : 'nothing to run';
      console.log(`✓ gate PASSED (${covered}). The next push of this exact tree, at this HEAD, skips the hook.`);
    }
    console.log(`  Receipt: ${receiptPath()}`);
  }
  process.exit(ok ? 0 : 1);
}

// ---- after the flip, and the sha gate's CLI ------------------------------------

/**
 * Every pushed (not deleted) line of the hook's stdin as {sha, remote}: git's
 * second field (the local sha) and third (the remote ref). null when any line
 * has no remote ref or a sha that is not hex, which the caller refuses as
 * malformed. parsePushedShas stays as it was; this is the parallel reading
 * the post-flip path needs to see where each sha is going.
 */
function parsePushedRefs(input) {
  if (input === null || input === undefined) return null;
  const out = [];
  for (const line of String(input).split('\n').map((l) => l.trim()).filter(Boolean)) {
    const fields = line.split(/\s+/);
    if (fields.length < 3 || !/^[0-9a-fA-F]{7,64}$/.test(fields[1])) return null;
    if (!/^0+$/.test(fields[1])) out.push({ sha: fields[1], remote: fields[2] });
  }
  return out;
}

/** The hook's stdin as text, or null when it is a TTY or cannot be read. */
function readStdinText() {
  if (process.stdin.isTTY) return null;
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    if (err && ['EAGAIN', 'EBADF', 'EINVAL', 'EISDIR', 'ENXIO'].includes(err.code)) return null;
    throw err;
  }
}

/** The full sha a ref names as a commit, or null. */
function commitOrNull(ref) {
  if (typeof ref !== 'string' || ref === '' || /[\0\n]/.test(ref)) return null;
  const r = gitQuiet(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  return r.ok && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(r.out) ? r.out : null;
}

function blocked(lines) {
  console.error('');
  for (const l of lines) console.error(l);
  process.exit(1);
}

/**
 * The hook after the flip: validate, never gate, never lock. Refuses unless
 * every pushed line goes to refs/heads/main, no marker stands, and each pushed
 * sha has a sha receipt good against the local origin/main and review
 * receipts over origin/main..sha.
 */
function verifyAfterFlip() {
  const cwd = process.cwd();
  const text = readStdinText();
  stdinVerdict(parsePushedShas(text));
  const refs = parsePushedRefs(text);
  if (!refs) stdinVerdict({ kind: 'unknown' });
  const elsewhere = refs.filter((r) => r.remote !== 'refs/heads/main');
  if (elsewhere.length) {
    blocked([
      `BLOCKED: this push updates ${elsewhere.map((r) => M.clean(r.remote)).join(', ')}; after the flip the hook passes pushes to refs/heads/main only.`,
      '  Lanes never push branches. Emergencies only: git push --no-verify',
    ]);
  }
  const base = commitOrNull('refs/remotes/origin/main');
  if (!base) blocked(['BLOCKED: there is no refs/remotes/origin/main here to check the push against (run: npm run ship).']);
  // Throwaway tests only: a receipt written with stub gates vouches only when
  // this is set, and the pass line then names the stubs.
  const stubbedOk = process.env.DRB_GATE_ALLOW_STUBBED === '1';
  if (stubbedOk) console.error('pre-push: DRB_GATE_ALLOW_STUBBED=1 is set; a sha receipt written with stub gates is accepted (throwaway tests only)');
  const st = M.standing({ cwd });
  const standing = [st.gate, st.watch, st.flip].filter(Boolean);
  if (standing.length) blocked(standing);
  const stubs = new Set();
  for (const { sha } of refs) {
    const full = commitOrNull(sha);
    if (!full) blocked([`BLOCKED: the pushed sha ${M.clean(sha)} names no commit here.`]);
    const s7 = R.short(full);
    const { needed } = SG.classifyRange(base, full, { cwd });
    const rec = SG.readShaReceipt(full, { cwd });
    const why = SG.checkShaReceipt(rec, { sha: full, base, needed, stubbedOk });
    if (why) blocked([`BLOCKED: ${s7}: ${why}.`, '  The hook validates only and never runs a gate. Emergencies only: git push --no-verify']);
    for (const s of rec.stubbed) stubs.add(s);
    const range = checkRange({ base, tip: full, cwd });
    if (!range.ok) {
      blocked([
        `BLOCKED: the review receipts over origin/main..${s7} do not stand (run: npm run ship once they do):`,
        ...range.problems.map((p) => `  - ${p}`),
        '  Emergencies only: git push --no-verify',
      ]);
    }
  }
  const shas = refs.map((r) => R.short(r.sha)).join(', ');
  const stubbed = stubs.size ? ` (stubbed: ${[...stubs].join(', ')})` : '';
  console.log(`pre-push: ${shas}: the sha receipt and the review receipts over origin/main are valid${stubbed}; nothing runs here.`);
  process.exit(0);
}

/** `sha <sha>`: the gate under the push-gate lock; exit 0 on a pass, 1 otherwise. */
function shaMode(ref) {
  if (!ref) {
    console.error('usage: node scripts/push-gate.js sha <sha>');
    process.exit(1);
  }
  holdGateLock();
  SG.runShaGate({ sha: ref, cwd: process.cwd() }).then(
    (res) => process.exit(res.ok ? 0 : 1),
    (err) => {
      console.error(`gate: the sha gate stopped on an error: ${M.clean(err && err.message ? err.message : String(err))}`);
      process.exit(1);
    },
  );
}

/** `receipt <sha>`: the sha receipt as JSON, or `none`; no lock. */
function receiptMode(ref) {
  const full = commitOrNull(ref);
  if (!full) {
    console.error(`push-gate: ${ref ? M.clean(ref) : '(no sha given)'} names no commit`);
    process.exit(1);
  }
  const rec = SG.readShaReceipt(full, { cwd: process.cwd() });
  console.log(rec ? JSON.stringify(rec, null, 2) : 'none');
  process.exit(0);
}

/**
 * The mode is read before any lock: `run` (and any other word, as before)
 * and `verify` with no flip marker take the legacy path with its re-exec under
 * the lock; `sha` takes the lock on a descriptor; `verify` with the flip
 * marker present takes none, and with it unreadable refuses; `receipt` takes
 * none.
 */
function main() {
  const mode = process.argv[2] || 'run';
  if (mode === 'sha') return shaMode(process.argv[3]);
  if (mode === 'receipt') return receiptMode(process.argv[3]);
  if (mode === 'verify') {
    const flip = M.flipState({ cwd: process.cwd() });
    if (flip.state === 'unreadable') blocked([M.standing({ cwd: process.cwd() }).flip]);
    if (flip.state === 'present') return verifyAfterFlip();
  }
  return legacyMain();
}

if (require.main === module) main();

module.exports = {
  checkReceipt, neededGates, treeFingerprint, parsePushedShas,
  RECEIPT_VERSION, MAX_AGE_MS, MONEY_PATHS, CLIENT_PATHS,
  parsePushedRefs,
  classifyRange: SG.classifyRange,
  checkShaReceipt: SG.checkShaReceipt,
  gateEnvFile: SG.gateEnvFile,
  gateWorktreePath: SG.gateWorktreePath,
};
