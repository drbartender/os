#!/usr/bin/env node
/*
 * testdb-smoke.js: the money-path smoke (audit P2, stage 1), which the sha
 * gate runs (push-gate.js sha, inside npm run ship) and npm run test:smoke
 * runs by hand.
 *
 * Flow when a Neon API key is configured:
 *   1. Reset the isolated `ci-smoke` branch to its prod parent (Neon REST API).
 *   2. Fetch that branch's pooled connection URI.
 *   3. Run initDb against it (this also validates any schema.sql change in the
 *      push BEFORE prod boot replays it — a gap nothing else covers).
 *   4. Run the money-path smoke suites (scripts/money-smoke-list.txt) serially.
 *
 * Credential: NEON_API_KEY from process.env or ~/.secrets/neon_api_key.
 *   - No key  -> loud SKIP banner, exit 0 (with --tap-dir, a summary marked
 *     skipped), which the sha gate reads as never a pass: the gate fails,
 *     nothing pushes, and no gate marker is written.
 *   - Key set -> the smoke is HARD and FAIL-CLOSED: ANY error in reset / URI /
 *     initDb / a failing suite exits 1. In the sha gate a failing suite is a
 *     verdict on the code (the gate marker on a sha on main, cleared by a
 *     descendant that passes, a fix forward); a smoke that could not run
 *     fails the gate with no marker (fix the cause, then npm run ship again).
 *
 * The connection URI and the API key are NEVER printed (masked in every error).
 *
 * The smoke lock (instruction rewrite step 2, spec 2026-10-19 section 4.3): the
 * whole flow runs under an exclusive flock on DRB_SMOKE_LOCK_FILE (default
 * <git-common-dir>/drb-smoke.lock), taken BLOCKING through
 * scripts/lib/flockExec.js, so a review-time smoke and a gate never reset
 * ci-smoke under each other. A run that would wait prints one line saying so;
 * an override of DRB_SMOKE_LOCK_FILE is named in one stderr line. flock
 * releases on exit, kill -9 included. A signal to the smoke (Ctrl-C, SIGTERM,
 * SIGHUP) stops the whole run, a waiter and a running suite included (a
 * suite that ignores it is killed 5 s later). The locked run, and any
 * process that calls runSuite, turns SIGTERM, SIGINT and SIGHUP into an exit
 * by 128 plus the signal's number once the suite in hand has returned
 * (flockExec.exitOnStopSignals), so the gate path's temp witness (it can hold
 * failure output quoting ci-smoke rows) and the run marker never outlive a
 * signal; only a kill -9 can leave the witness. A kill -9 of the process that
 * started the smoke is noticed before the Neon reset, before initDb and
 * before each suite, and the run stops there. initDb and every suite run
 * under GNU timeout and are handed the lock's descriptor, so the lock
 * outlives a killed smoke for as long as its child still runs against
 * ci-smoke, and no longer than that child's bound (120 s for initDb, 180 s
 * for a suite). The bound KILLs the child's process group; after initDb and
 * each suite the locked run kills whatever it left in the run's session
 * outside that group (flockExec.sweepSession, one stderr line when it kills
 * any), and a child that left the session too (setsid, Node's detached)
 * survives both and runs unlocked, a stated limit. push-gate.js takes its
 * own lock first, so the order is always push-gate, then smoke.
 *
 * Flags:
 *   --dry-lock        take the smoke lock, print "smoke lock acquired", exit 0;
 *                     touches nothing else (no key, no Neon, no DB, no suites).
 *   --tap-dir <dir>   write each suite's TAP record to <dir>/<path with
 *                     slashes as dashes>.<6 hex of the path's sha1>.log
 *                     (tapSummary.logName), its own output to the sibling
 *                     .out, and <dir>/summary.json {suites, total_pass,
 *                     total_fail, skipped}, each suite entry naming its log
 *                     and out (skipped: true on the no-key path,
 *                     which is never a pass). The dir is one run's,
 *                     claimed as run-suites claims its --log-dir (a live
 *                     run's dir, or one holding anything no runner wrote, is
 *                     refused in one line and left as it was); its old
 *                     summary.json, .log and .out files go first thing, and
 *                     every refusal
 *                     after that (git failing to name the lock, no GNU
 *                     timeout, a bad smoke list, the reset or initDb
 *                     failing) writes {suites: [], total_pass: 0,
 *                     total_fail: 1, skipped: false, did_not_run: <reason>}.
 *                     Without it the console is as
 *                     before (Node's default reporter) and each suite's TAP
 *                     record goes to a temp file. Either way a suite's tick
 *                     is its verdict from that record plus its exit
 *                     (tapSummary.smokeSummary's ok), never the exit alone.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { smokeSummary, didNotRun, parse, logName, outName, suiteArgv, suiteEnv, defaultConsoleReporter, claimRunDir, joinRunDir, releaseRunDir } = require('./lib/tapSummary');
const { underLock, parentGone, looksLikeReexec, exitOnStopSignals, yieldToSignals, sweepSession, gnuTimeout, boundedNodeSync, NO_GNU_TIMEOUT } = require('./lib/flockExec');

// --- Neon target (provisioned 2026-07-13; see docs/superpowers/plans/2026-07-13-test-gate.md) ---
const API_BASE = 'https://console.neon.tech/api/v2';
const PROJECT_ID = 'round-tooth-34649976';
const BRANCH_ID = 'br-twilight-surf-adf8eghx'; // ci-smoke
const PARENT_BRANCH_ID = 'br-noisy-frog-ad99sa6l'; // production (reset source)
const DATABASE_NAME = 'neondb';
const ROLE_NAME = 'neondb_owner';

const REPO_ROOT = path.join(__dirname, '..');
const SMOKE_LIST = path.join(__dirname, 'money-smoke-list.txt');

// Timeouts (ms).
const REQUEST_TIMEOUT = 25000; // per single REST call
const OPERATIONS_TIMEOUT = 90000; // total wall-clock for the reset operations to finish
const POLL_INTERVAL = 2000;

// --- ANSI helpers (only for human-facing banners; no secrets ever pass through) ---
const RED = '\x1b[1;31m';
const YELLOW = '\x1b[1;33m';
const GREEN = '\x1b[1;32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// Values that must never reach stdout/stderr. Populated as we learn them.
const SECRETS = [];
function registerSecret(v) {
  if (v && typeof v === 'string' && v.length >= 6) SECRETS.push(v);
}
// Redact every known secret from any string before it is printed.
function mask(str) {
  let out = String(str);
  for (const s of SECRETS) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}
// The --tap-dir a die() writes its did-not-run summary to: set once this
// process has prepared it (a launcher) or proved its guard (the re-exec), so
// every refusal after that leaves a verdict, never an old summary or none.
let verdictDir = null;
function die(msg) {
  if (verdictDir) {
    try {
      writeSummary(verdictDir, didNotRun(mask(msg)));
    } catch (err) {
      console.error(`testdb-smoke: could not write summary.json (${err.code || err.message}); the BLOCKED line below still says why`);
    }
  }
  console.error('');
  console.error(`${RED}✗ money smoke BLOCKED: it could not run.${RESET}`);
  console.error(`  ${mask(msg)}`);
  console.error(`  ${DIM}Fail-closed: a configured smoke never falls through to a silent pass.${RESET}`);
  console.error(`  In the sha gate this fails the gate with no marker and nothing pushes: fix the cause, then ${YELLOW}npm run ship${RESET} again.`);
  process.exit(1);
}

// --- Credential discovery -------------------------------------------------
function discoverApiKey() {
  const fromEnv = process.env.NEON_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const keyFile = path.join(os.homedir(), '.secrets', 'neon_api_key');
  try {
    const fromFile = fs.readFileSync(keyFile, 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // missing/unreadable file is the same as "no key" — handled by caller.
  }
  return null;
}

function skipBanner() {
  const bar = '═'.repeat(66);
  console.log('');
  console.log(`${RED}${bar}${RESET}`);
  console.log(`${RED}  MONEY SMOKE SKIPPED — NEON_API_KEY not configured.${RESET}`);
  console.log(`${RED}  A skip is never a pass: the sha gate fails on it, so nothing pushes.${RESET}`);
  console.log(`${RED}  Set it up: see README > Test gate.${RESET}`);
  console.log(`${RED}${bar}${RESET}`);
  console.log('');
}

// --- Neon REST helpers ----------------------------------------------------
async function neonFetch(apiKey, method, urlPath, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let res;
  try {
    res = await fetch(`${API_BASE}${urlPath}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError or network failure — never leak the key that lived in headers.
    throw new Error(`Neon API ${method} ${urlPath} failed: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
  } finally {
    clearTimeout(timer);
  }
  const rawText = await res.text();
  if (!res.ok) {
    // Body may echo request context; mask before surfacing.
    throw new Error(`Neon API ${method} ${urlPath} -> HTTP ${res.status}: ${mask(rawText).slice(0, 300)}`);
  }
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error(`Neon API ${method} ${urlPath}: could not parse JSON response`);
  }
}

// Terminal operation states per the Neon API.
const OP_DONE = 'finished';
const OP_FAILED = new Set(['failed', 'error', 'cancelled', 'cancelling', 'skipped']);

async function pollOperation(apiKey, opId, deadline) {
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`operation ${opId} did not finish within ${Math.round(OPERATIONS_TIMEOUT / 1000)}s`);
    }
    const { operation } = await neonFetch(apiKey, 'GET', `/projects/${PROJECT_ID}/operations/${opId}`);
    const status = operation && operation.status;
    if (status === OP_DONE) return;
    if (OP_FAILED.has(status)) {
      throw new Error(`operation ${opId} ended in state "${status}"`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

async function resetBranchToParent(apiKey) {
  // POST .../branches/{id}/restore with source_branch_id = parent IS the
  // documented "reset from parent" operation (neon.com/docs/guides/reset-from-parent).
  const resp = await neonFetch(
    apiKey,
    'POST',
    `/projects/${PROJECT_ID}/branches/${BRANCH_ID}/restore`,
    { source_branch_id: PARENT_BRANCH_ID }
  );
  const ops = Array.isArray(resp.operations) ? resp.operations : [];
  const deadline = Date.now() + OPERATIONS_TIMEOUT;
  for (const op of ops) {
    if (op && op.id) await pollOperation(apiKey, op.id, deadline);
  }
}

async function fetchConnectionUri(apiKey) {
  const qs = new URLSearchParams({
    branch_id: BRANCH_ID,
    database_name: DATABASE_NAME,
    role_name: ROLE_NAME,
    pooled: 'true',
  });
  const resp = await neonFetch(apiKey, 'GET', `/projects/${PROJECT_ID}/connection_uri?${qs.toString()}`);
  const uri = resp && resp.uri;
  if (!uri || typeof uri !== 'string') {
    throw new Error('connection_uri response did not include a uri');
  }
  registerSecret(uri); // from here on the URI is masked out of all output
  return uri;
}

// --- Suite list -----------------------------------------------------------
function readSmokeList() {
  let raw;
  try {
    raw = fs.readFileSync(SMOKE_LIST, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path.relative(REPO_ROOT, SMOKE_LIST)}: ${err.message}`);
  }
  const files = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (files.length === 0) throw new Error('money-smoke-list.txt is empty — refusing to pass a no-op gate');

  // A silently-shrinking gate is worse than none: a listed file that no longer
  // exists is a HARD FAIL, not a skip.
  const missing = files.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
  if (missing.length) {
    throw new Error(`smoke-list references ${missing.length} missing file(s):\n    ${missing.join('\n    ')}`);
  }
  return files;
}

// --- Child processes ------------------------------------------------------
// initDb and every suite run through flockExec.boundedNodeSync: under GNU
// coreutils timeout --signal=KILL --kill-after=5, which KILLs the child and
// its process group at the bound (a child that traps SIGTERM included), with
// the lock's descriptor as fd 3, so the lock lives as long as the child does
// and no longer than its bound. What it left in the run's session outside
// that group is killed when it ends (sweepAfter).
function runInitDb(dbUrl, lockFd = null) {
  // Spawn a fresh node so the Pool binds to THIS dbUrl (db/index.js reads
  // process.env.DATABASE_URL at module load). initDb applies schema.sql.
  const child = boundedNodeSync(
    ['-e', "require('./server/db/index.js').initDb().then(() => process.exit(0)).catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });"],
    {
      timeoutMs: 120_000, // a wedged schema apply must fail the gate, not hang the push
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'inherit',
      lockFd,
    }
  );
  if (child.timedOut) {
    throw new Error('initDb timed out after 120s — schema apply against ci-smoke did not succeed');
  }
  if (child.status !== 0) {
    throw new Error(`initDb failed (exit ${child.status}) — schema apply against ci-smoke did not succeed`);
  }
}

const SUITE_TIMEOUT_MS = 180_000; // a hung suite becomes a hard fail, never an indefinitely-hung push

// Runs one money suite and returns its verdict (tapSummary's `ok`: a TAP
// summary found, fail 0, cancelled 0, exited 0 inside the timeout), which is
// also the tick or cross it prints. The argv is tapSummary.suiteArgv, the one
// run-suites uses: `node -r dotenv/config` (dotenv loads .env but does NOT
// override env vars already set in the process, so our DATABASE_URL wins),
// no `--test`, and always a TAP witness. With --tap-dir the witness is
// <dir>/<name>.log and the suite's own output goes to <dir>/<name>.out;
// without it the witness is a temp file (removed after the suite) and a
// second reporter, the one Node would pick by itself, prints the suite on the
// console as before. So a suite that registers no tests or calls
// process.exit(0) before its tests end prints a cross and fails the gate on
// both paths, never a tick from its exit code alone.
// The gate path's temp witness dirs that exist right now, removed on any
// exit; with exitOnStopSignals a signal is an exit too, so no signal leaves
// one behind (only a kill -9 can).
const scratchDirs = new Set();
let scratchHook = false;
function trackScratch(dir) {
  if (!scratchHook) {
    scratchHook = true;
    process.on('exit', () => {
      for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
    });
  }
  scratchDirs.add(dir);
  return dir;
}

function runSuite(file, dbUrl, tapDir = null, tapResults = [], lockFd = null, { timeoutMs = SUITE_TIMEOUT_MS } = {}) {
  exitOnStopSignals();
  const start = Date.now();
  const scratch = tapDir ? null : trackScratch(fs.mkdtempSync(path.join(os.tmpdir(), 'drb-smoke-tap-')));
  const logPath = path.join(tapDir || scratch, logName(file));
  let child;
  let text;
  try {
    fs.writeFileSync(logPath, '');
    const fd = tapDir ? fs.openSync(path.join(tapDir, outName(file)), 'w') : null;
    try {
      child = boundedNodeSync(suiteArgv(file, { tapFile: logPath, console: tapDir ? null : defaultConsoleReporter() }), {
        timeoutMs,
        cwd: REPO_ROOT,
        env: suiteEnv({ DATABASE_URL: dbUrl }),
        stdio: fd === null ? 'inherit' : ['ignore', fd, fd],
        lockFd,
      });
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    text = fs.readFileSync(logPath, 'utf8');
  } finally {
    if (scratch) {
      fs.rmSync(scratch, { recursive: true, force: true });
      scratchDirs.delete(scratch);
    }
  }
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  const { timedOut } = child;
  const exitOk = !timedOut && !child.error && !child.signal && child.status === 0;
  const [entry] = smokeSummary([{ file, text, exitOk }]).suites;
  const s = parse(text);
  let why = '';
  if (timedOut) why = ` TIMED OUT at ${Math.round(timeoutMs / 1000)}s`;
  else if (child.error) why = ` could not start: ${child.error.code || child.error.message}`;
  else if (child.signal) why = ` killed by ${child.signal}`;
  else if (child.status !== 0) why = ` exit ${child.status}`;
  else if (!s.found) why = ' no TAP summary';
  else if (!entry.ok) why = ` fail ${s.fail}${s.cancelled ? ` cancelled ${s.cancelled}` : ''}`;
  console.log(`${entry.ok ? GREEN + '  ✓' : RED + '  ✗'} ${file} ${DIM}(${secs}s)${why}${RESET}`);
  tapResults.push({ file, text, exitOk });
  return entry.ok;
}

function writeSummary(tapDir, summary) {
  fs.writeFileSync(path.join(tapDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

// After initDb or a suite has ended: kills what it left in the run's session
// outside GNU timeout's group (flockExec.sweepSession), saying so in one line.
function sweepAfter(lock, step) {
  const left = sweepSession(lock && lock.session);
  if (left.length) console.error(`testdb-smoke: ${step} left ${left.length} process(es) in the run's session, outside GNU timeout's group, after it ended; killed them`);
}

// --- Main -----------------------------------------------------------------
// Between steps: when the process that started this smoke is gone (killed -9
// while this run held the lock), stop here, which releases the lock.
function stopIfOrphaned(lock, step) {
  if (lock && lock.parentPid && parentGone(lock.parentPid)) {
    console.error(`testdb-smoke: the process that launched this smoke (pid ${lock.parentPid}) is gone; stopping before ${step}.`);
    process.exit(1);
  }
}

async function main({ tapDir }, lock) {
  const lockFd = lock ? lock.lockFd : null;
  const apiKey = discoverApiKey();
  if (!apiKey) {
    if (tapDir) writeSummary(tapDir, { suites: [], total_pass: 0, total_fail: 0, skipped: true });
    skipBanner();
    process.exit(0);
  }
  registerSecret(apiKey);
  // Every suite and initDb run under GNU timeout; without it nothing runs.
  if (!gnuTimeout()) die(NO_GNU_TIMEOUT);

  // Read & validate the list up front — fail before touching the network if
  // the gate would silently shrink.
  let files;
  try {
    files = readSmokeList();
  } catch (err) {
    die(err.message);
  }

  const totalStart = Date.now();
  let dbUrl;
  try {
    stopIfOrphaned(lock, 'the Neon reset');
    console.log(`${DIM}smoke: resetting ci-smoke branch to its parent…${RESET}`);
    await resetBranchToParent(apiKey);
    console.log(`${DIM}smoke: fetching ci-smoke connection URI…${RESET}`);
    dbUrl = await fetchConnectionUri(apiKey);
    stopIfOrphaned(lock, 'initDb');
    console.log(`${DIM}smoke: applying schema (initDb) to ci-smoke…${RESET}`);
    try {
      runInitDb(dbUrl, lockFd);
    } finally {
      sweepAfter(lock, 'initDb');
    }
  } catch (err) {
    die(err.message);
  }

  console.log('');
  console.log(`smoke: running ${files.length} money-path smoke suite(s) against ci-smoke…`);
  let anyFailed = false;
  const tapResults = [];
  for (const file of files) {
    // Run all, report all: do not short-circuit on the first failure. The
    // verdict comes from each suite's TAP witness plus its exit. A signal
    // that landed during the last suite is handled here, before the next.
    await yieldToSignals();
    stopIfOrphaned(lock, file);
    const ok = runSuite(file, dbUrl, tapDir, tapResults, lockFd);
    sweepAfter(lock, file);
    if (!ok) anyFailed = true;
  }
  if (tapDir) writeSummary(tapDir, smokeSummary(tapResults));

  const totalSecs = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log('');
  if (anyFailed) {
    console.error(`${RED}✗ money smoke FAILED: one or more money-path smoke suites failed (${totalSecs}s total).${RESET}`);
    console.error(`  Fix the failing suite(s) above. In the sha gate this is a verdict on the code: the gate marker stands on a sha on main until a descendant passes (${YELLOW}npm run ship${RESET} on the fix).`);
    process.exit(1);
  }
  console.log(`${GREEN}✓ smoke: all ${files.length} money-path smoke suites passed (${totalSecs}s total).${RESET}`);
  process.exit(0);
}

// --- Flags and the smoke lock ---------------------------------------------
const USAGE = 'usage: testdb-smoke.js [--dry-lock] [--tap-dir <dir>]';
const GUARD = 'DRB_SMOKE_LOCKED';

function parseArgs(argv) {
  const opts = { dryLock: false, tapDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-lock' && !opts.dryLock) {
      opts.dryLock = true;
    } else if (a === '--tap-dir' && opts.tapDir === null) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: '--tap-dir needs a directory' };
      opts.tapDir = path.resolve(v);
    } else {
      return { error: `unexpected argument ${a}` };
    }
  }
  return opts;
}

// The smoke lock's path. Throws (never exits) when git cannot name the common
// dir, so a caller that loads this module decides; the CLI's catch turns the
// throw into die(), the BLOCKED line.
function smokeLockFile() {
  if (process.env.DRB_SMOKE_LOCK_FILE) return path.resolve(process.env.DRB_SMOKE_LOCK_FILE);
  const r = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) throw new Error('cannot find the git common dir for the smoke lock (set DRB_SMOKE_LOCK_FILE)');
  return path.join(r.stdout.trim(), 'drb-smoke.lock');
}

async function cli() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.error(`${USAGE}\n  (${opts.error})`);
    process.exit(2);
  }
  const runDir = opts.tapDir && !opts.dryLock ? opts.tapDir : null;
  const lockArgs = (lockFile, prepare) => ({
    lockFile,
    guardVar: GUARD,
    waitLine: `testdb-smoke: waiting for the smoke lock (${lockFile}; fuser names the holder)`,
    notice: process.env.DRB_SMOKE_LOCK_FILE ? `testdb-smoke: override in effect: DRB_SMOKE_LOCK_FILE=${process.env.DRB_SMOKE_LOCK_FILE}` : null,
    prepare,
  });
  // A --tap-dir is claimed first, before any refusal and before the lock
  // wait (tapSummary.claimRunDir): a dir another live run owns, or one that
  // holds anything no runner wrote, is refused in one line and left as it
  // was; otherwise what an earlier run left there (summary.json, .log and
  // .out files) goes, so none of it can stand in for this one, and the
  // marker goes when this run ends. The re-exec under flock never touches
  // the dir before it has proved its guard: a waiter orphaned by a kill -9
  // stops in underLock, having touched nothing.
  const claim = runDir
    ? () => {
      try {
        claimRunDir(runDir);
      } catch (err) {
        console.error(`testdb-smoke: ${err.message}`);
        process.exit(1);
      }
      process.on('exit', () => releaseRunDir(runDir));
    }
    : null;
  let lock;
  if (looksLikeReexec(GUARD)) {
    let lockFile;
    try {
      lockFile = smokeLockFile();
    } catch (err) {
      die(err.message);
    }
    lock = await underLock(lockArgs(lockFile, claim));
    verdictDir = runDir;
    if (runDir) {
      // Held by the locked run too, so a kill -9 of the launcher leaves the
      // dir claimed until this run stops; then this run lets it go.
      const launcher = lock.parentPid;
      joinRunDir(runDir, launcher);
      process.on('exit', () => {
        if (parentGone(launcher)) releaseRunDir(runDir, launcher);
      });
    }
  } else {
    if (claim) {
      claim();
      verdictDir = runDir;
    }
    let lockFile;
    try {
      lockFile = smokeLockFile();
    } catch (err) {
      die(err.message);
    }
    // Resolves only in the run that holds the lock; the outer exits from inside.
    lock = await underLock(lockArgs(lockFile, null));
  }
  // The locked run: a signal becomes an exit, so the temp witness and the
  // marker still go.
  exitOnStopSignals();
  if (opts.dryLock) {
    console.log('smoke lock acquired');
    process.exit(0);
  }
  await main(opts, lock);
}

// Requiring this file runs nothing: only `node scripts/testdb-smoke.js` runs
// the smoke, so its own test can load it without touching a lock or a key.
if (require.main === module) {
  cli().catch((err) => {
    // Any unexpected throw once the key exists is still fail-closed.
    die(err && err.message ? err.message : String(err));
  });
}

module.exports = { parseArgs, smokeLockFile, runSuite, SUITE_TIMEOUT_MS };
