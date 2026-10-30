#!/usr/bin/env node
'use strict';

/**
 * push-gate: the push gate's CLI. `sha <sha>` gates one commit in a throwaway
 * worktree and writes its receipt, `receipt <sha>` prints that receipt, and
 * `verify`, the pre-push hook, validates the receipts and never runs a gate.
 *
 *   node scripts/push-gate.js sha <sha>
 *   node scripts/push-gate.js receipt <sha>
 *   node scripts/push-gate.js verify      (the hook; reads git's stdin)
 *
 * The contract (instruction rewrite step 3, lane gate-sha, and step 5, lane
 * legacy-removal; spec 2026-10-19 sections 4.3, 4.4 and 8; plan 2026-10-22
 * decisions 2, 10, 11, 14 and 16; plan 2026-10-28 decisions 17 and 18):
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
 *     CLI. It takes the push-gate lock non-blocking (a second gate refuses),
 *     held by flock -n on a descriptor of this process rather than a re-exec,
 *     so a stop signal reaches the gate itself and its cleanup removes the
 *     worktree.
 *   - `receipt <sha>` prints that receipt, or `none`; no lock.
 *   - `verify`, the hook, takes no lock and runs no gate whatever the flip
 *     marker (<git-common-dir>/drb-flip.json) says, because git opens its SSH
 *     connection before the hook runs and a slow hook lets GitHub close it
 *     (the 2026-08-14 hang). It branches on markers.flipState. Present:
 *     validate only: a push to refs/heads/main alone, no standing marker, a
 *     sha receipt good for each pushed sha against the local origin/main
 *     (ship fetched moments before; a stale ref can only make git reject the
 *     push), and review receipts over origin/main..sha (rangeCheck). No
 *     receipt means refuse with "run npm run ship". Unreadable: refuse with
 *     the marker's own line. Absent: refuse with missingMarkerLine before
 *     stdin is read: the flip happened on 2026-10-30, so a missing marker was
 *     lost, never not yet written, and nothing pushes until it is restored
 *     (the line ends with markers.flipRestore's recipe).
 *   - The legacy path is gone. From 2026-08-14 to 2026-10-30 `run` (npm run
 *     gate) gated the working tree and banked a working-tree fingerprint
 *     receipt that the hook honoured while no flip marker existed; the first
 *     tier A ship after the flip removed it (spec 4.3), since the sha gate
 *     and ship had taken its place. `run`, no word and any other word refuse
 *     with the usage.
 *   - The stdin parse fails closed: a line the hook cannot read refuses,
 *     never reads as nothing to push.
 *   - MONEY_PATHS and CLIENT_PATHS are re-exported from scripts/lib/gatePaths.js,
 *     the one classifier the sha gate reads.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { MONEY_PATHS, CLIENT_PATHS } = require('./lib/gatePaths');
const M = require('./lib/markers');
const R = require('./lib/receipt');
const SG = require('./lib/shaGate');
const { checkRange } = require('./lib/rangeCheck');

const USAGE = 'usage: node scripts/push-gate.js sha <sha> | receipt <sha> | verify';

/**
 * The refusal for a missing flip marker, one line: the hook's, and the board
 * writer's (scripts/board-write.sh prints it through a node call). The flip's
 * date and the restore recipe are markers.js's, their one copy.
 */
function missingMarkerLine(file) {
  return `BLOCKED: the flip marker is missing; the flip happened on ${M.FLIP_DATE} and the legacy push path is gone, so every push refuses until it is restored: ${M.flipRestore(file)}`;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
}

function gitQuiet(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

// The two lock refusals for sha mode's lock below.
function lockNotStarted(err) {
  console.error('');
  console.error(`✗ BLOCKED: could not acquire the gate lock (${err.code || err.message}).`);
  console.error('  flock (util-linux) is required so two gate runs cannot reset the shared');
  console.error('  Neon ci-smoke branch under each other. Emergencies only: git push --no-verify');
}

function lockHeldElsewhere(lockFile) {
  console.error('');
  console.error('✗ BLOCKED: another push gate is already running.');
  console.error('  They share one Neon ci-smoke branch, so running both corrupts each other.');
  console.error(`  Check: fuser ${lockFile}   (lists the holding PID, if any)`);
  console.error('  Wait for it to finish, then retry. Emergencies only: git push --no-verify');
}

/**
 * The gate lock, held for the whole sha run.
 *
 * WHY (2026-08-14): the money gate RESETS the shared Neon ci-smoke branch to
 * its parent and then runs suites against it, so two gate runs at once delete
 * each other's rows mid-test (seen: two overlapping runs failing on different
 * suites with foreign-key violations). It REFUSES rather than waits, so a
 * second gate exits non-zero and nothing is banked for it. The lock file is in
 * the COMMON git dir, since every lane is a linked worktree and the protected
 * resource is the one Neon branch. flock, not a pidfile: the kernel drops it
 * when the descriptor closes, kill -9 included, so there is nothing to leak,
 * no liveness check and no reclaim race.
 *
 * `flock -n 3` locks the open file description this process shares with the
 * child, so the lock lasts until this process exits and no re-exec stands
 * between a stop signal and the gate's own cleanup. Node opens files
 * close-on-exec, so the gate's children never hold it. testdb-smoke.js takes
 * the smoke lock (drb-smoke.lock) itself, so a gate holds this lock and then
 * the smoke lock, never the reverse. No file lock can cover a second clone or
 * machine (that would need a Neon-side lock).
 */
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

/**
 * Every sha being pushed, from the hook's stdin, which git feeds as
 * `<local ref> <local sha> <remote ref> <remote sha>` per updated ref.
 *
 *   {kind:'shas', shas:[...]}  real refs are shipping; check ALL of them
 *   {kind:'deletes'}           every line was an all-zero local sha, so no
 *                              code ships and there is nothing to check
 *   {kind:'empty'}             no line at all: no ref is being updated
 *   {kind:'unknown'}           a TTY, unreadable, or MALFORMED. Never a free
 *                              pass: "I cannot tell what is being pushed"
 *                              must fail closed.
 */
function parsePushedShas(input) {
  if (input === null || input === undefined) return { kind: 'unknown' };
  const lines = String(input).split('\n').map((l) => l.trim()).filter(Boolean);
  // EMPTY is different from MALFORMED and must not be conflated. git feeds no
  // lines only when no ref is being updated (verified across ten push forms:
  // --all/--tags with everything already up to date), so nothing ships and
  // there is nothing to check. Malformed input, by contrast, means we cannot
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

// The three stdin shapes that end the hook before any receipt is read;
// returns for 'shas'.
function stdinVerdict(parsed) {
  if (parsed.kind === 'deletes') {
    console.log('pre-push: deletions only; nothing to gate.');
    process.exit(0);
  }
  if (parsed.kind === 'empty') {
    console.log('pre-push: git listed no updated refs; nothing ships, nothing to gate.');
    process.exit(0);
  }
  if (parsed.kind === 'unknown') {
    // We could not read WHAT is being pushed. Checking a guess and allowing
    // would let a commit nobody gated reach prod. Refuse; the push is
    // blocked, never silently allowed.
    console.error('');
    console.error('✗ BLOCKED: could not read the refs being pushed from the hook\'s stdin.');
    console.error('  The gates can only vouch for code they can identify, so this fails closed');
    console.error('  rather than gating a guess. If you know what you are doing:');
    console.error('  git push --no-verify');
    process.exit(1);
  }
}

/**
 * Every pushed (not deleted) line of the hook's stdin as {sha, remote}: git's
 * second field (the local sha) and third (the remote ref). null when any line
 * has no remote ref or a sha that is not hex, which the caller refuses as
 * malformed. parsePushedShas reads the same stdin for its shape; this is the
 * parallel reading that sees where each sha is going.
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
 * The hook with the flip marker present: validate, never gate, never lock.
 * Refuses unless every pushed line goes to refs/heads/main, no marker stands,
 * and each pushed sha has a sha receipt good against the local origin/main
 * and review receipts over origin/main..sha.
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

/**
 * `verify`: the flip marker first, before stdin is read and with no lock.
 * Unreadable refuses with its own line, absent with missingMarkerLine;
 * present validates.
 */
function verify() {
  const cwd = process.cwd();
  const flip = M.flipState({ cwd });
  if (flip.state === 'unreadable') blocked([M.standing({ cwd }).flip]);
  if (flip.state !== 'present') blocked([missingMarkerLine(flip.path), '  Emergencies only: git push --no-verify']);
  return verifyAfterFlip();
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
 * The mode is read before any lock: `sha` takes the lock on a descriptor;
 * `verify` and `receipt` take none; `run`, no word and any other word refuse
 * with the usage, taking no lock and writing nothing.
 */
function main() {
  const mode = process.argv[2];
  if (mode === 'sha') return shaMode(process.argv[3]);
  if (mode === 'receipt') return receiptMode(process.argv[3]);
  if (mode === 'verify') return verify();
  const gone = mode === undefined || mode === 'run'
    ? [`push-gate: the run command is gone since ${M.FLIP_DATE}; a push goes through npm run ship, whose gate is push-gate.js sha`]
    : [];
  blocked([...gone, USAGE]);
}

if (require.main === module) main();

module.exports = {
  parsePushedShas, parsePushedRefs, missingMarkerLine,
  MONEY_PATHS, CLIENT_PATHS,
  classifyRange: SG.classifyRange,
  checkShaReceipt: SG.checkShaReceipt,
  gateEnvFile: SG.gateEnvFile,
  gateWorktreePath: SG.gateWorktreePath,
};
