#!/usr/bin/env node
'use strict';

/*
 * run-suites.js: the ordinary suites, behind the dev-suite lock (instruction
 * rewrite step 2, lane suite-runner; spec 2026-10-19 section 4.3).
 *
 *   node scripts/run-suites.js --changed <base>..<tip> [--log-dir <dir>]
 *   node scripts/run-suites.js --staged [--log-dir <dir>]
 *   node scripts/run-suites.js <file> ... [--log-dir <dir>]
 *
 * The server suites share one Neon dev database with every window, so every run
 * takes the dev-suite lock (env DRB_DEVDB_LOCK_FILE, default
 * <git-common-dir>/drb-devdb.lock) BLOCKING through scripts/lib/flockExec.js:
 * the run re-execs under flock in a session of its own, prints one line when
 * it would wait, and holds the lock until it exits (kill -9 included, so a
 * crash leaves nothing to clean up). A signal to the runner (Ctrl-C, SIGTERM,
 * SIGHUP) stops the whole run, a waiter and a running suite included (a suite
 * that ignores it is killed 5 s later), and frees the lock. The locked run
 * turns SIGTERM, SIGINT and SIGHUP into an exit by 128 plus the signal's
 * number once the suite in hand has returned (flockExec.exitOnStopSignals),
 * so its exit cleanup (the run marker) still runs. A kill -9 of the
 * runner itself is noticed between suites, and the run stops there. Each
 * suite is handed the lock's descriptor, so a kill -9 of the locked run
 * cannot free the lock while its suite still runs, and a hung suite still
 * dies at its bound. An override of RUN_SUITES_ROOT or DRB_DEVDB_LOCK_FILE is
 * named in one stderr line.
 *
 * Parallel workers (2026-11-08): a run reaching two or more server/ suites
 * forks up to 4 workers (--workers <n>, RUN_SUITES_WORKERS; 1 under a
 * RUN_SUITES_ROOT override), each with DATABASE_URL set to its own
 * ci-suites-<n> Neon branch, reset to dev and given initDb
 * (scripts/lib/neonBranches.js, scripts/lib/suiteWorker.js;
 * RUN_SUITES_DB_URLS names the databases instead, for a test or by hand). The
 * workers pull suites from one queue, slowest first by the durations the last
 * runs recorded in <git-common-dir>/drb-review/_suite-durations.json, and each
 * suite runs exactly as below. The session is swept once after every worker
 * ends, not between suites. No Neon key, a failed Neon step or initDb, or one
 * worker runs the serial path below on the dev database.
 *
 * Two slots (2026-11-19): the lock above is slot 1 and guards the dev
 * database and ci-suites-1..4; drb-devdb-2.lock (beside it) is slot 2 and
 * guards ci-suites-5..8. A run that will go parallel on Neon branches (two or
 * more workers and server suites, a Neon key, no RUN_SUITES_ROOT,
 * DRB_DEVDB_LOCK_FILE or RUN_SUITES_DB_URLS) takes whichever slot is free, or
 * waits on the slot with the shorter line (slot 1 on a tie); every other run
 * takes slot 1. The launcher names its slot to the re-exec in RUN_SUITES_SLOT.
 * A slot-2 run whose branches or initDb fail refuses (did_not_run) instead of
 * going serial, since slot 1 may be on the dev database at that moment. The
 * slot-1 holder writes drb-devdb-slot1.json beside the locks ({pid, mode}:
 * "no-dev" on its ci-suites branches or a serial run of no server suite,
 * "dev" before a serial server suite),
 * and a slot-2 run resets its branches from dev only while slot 1 is free or
 * its live holder said "no-dev", so a branch never starts with a serial
 * run's half-written fixtures. Anything else on slot 1 (an older lane's
 * runner, which writes no marker, a run still preparing) makes slot 2 wait.
 * A stated limit: slot 1 changing hands in the second between that check and
 * the reset is not seen.
 *
 * Each suite runs as `node -r dotenv/config --test-reporter=tap
 * --test-reporter-destination=<log> <file>` (tapSummary.suiteArgv, the argv
 * testdb-smoke uses too) with cwd at the repo root. Its log,
 * <log-dir>/<path with slashes as dashes>.<6 hex of the path's sha1>.log
 * (tapSummary.logName; default dir <git-common-dir>/drb-review/_runs/
 * <timestamp>/), is the TAP record that
 * Node's reporter alone writes; what the suite itself prints to stdout and
 * stderr goes to the sibling .out. A suite runs under GNU coreutils timeout
 * (flockExec.boundedNodeSync), which at 300 s KILLs the suite and every
 * process in its process group, even after a kill -9 of the runner; a
 * timed-out suite reads as a failure, and without a GNU timeout the runner
 * refuses to run (one line, exit 1). After each suite the locked run kills
 * whatever the suite left in the run's session outside that group
 * (flockExec.sweepSession, one stderr line when it kills any); a child that
 * left the session too (setsid, Node's detached) survives the bound, the
 * sweep and a signal to the runner and runs unlocked, a stated limit.
 * Counts come from the TAP summary in the log
 * through scripts/lib/tapSummary.js, never the exit code alone, and the exit
 * is a second witness: a suite whose log has no summary, that had a
 * cancelled test (a test's own timeout), that exited non-zero or that timed out
 * is a failure, never a zero. The verdicts go to <log-dir>/summary.json in the
 * shape testdb-smoke writes ({suites: [{file, log, out, pass, fail, found,
 * ok, exit_ok}], total_pass, total_fail, skipped: false}; log and out are the
 * suite's two file names, so a reader never recomputes them; ok is the
 * verdict, exit_ok the raw exit witness, see tapSummary.smokeSummary). A run
 * that reaches nothing takes
 * no lock and writes the empty summary ({suites: [], total_pass: 0,
 * total_fail: 0, skipped: false}). A --log-dir is one run's: the run claims
 * it first thing, before any refusal and the lock wait, with a .drb-run
 * marker naming the launcher (and the locked run, once it has proved its
 * guard), and lets it go when it ends; a dir whose marker names a live
 * process, or that holds anything no runner wrote, is refused in one line and
 * left as it was, and a marker whose processes are gone is cleared
 * (tapSummary.claimRunDir). A reused dir loses its old summary.json, .log and
 * .out files then, so none of them can stand in for this run; a refusal after
 * that
 * (a missing named file, git failing, no GNU timeout) is one line and writes
 * {suites: [], total_pass: 0, total_fail: 1, skipped: false, did_not_run:
 * <reason>}. The re-exec under flock proves its guard before it touches the
 * dir. A run stopped because its launcher is gone writes no summary: its
 * reader is gone, and a missing summary is never a pass.
 *
 * WHY no `--test` (the plan's command had it): under `--test`, Node wraps a file
 * that registers no tests as one PASSING test named after the file, so a dead
 * suite logs "# pass 1". Run directly, node:test prints no TAP at all for such a
 * file. The counts are NOT always the same as a `--test` run: under `--test` a
 * file that exits non-zero after its tests pass gains a failing file-level
 * entry, while run directly its log says fail 0. That is why the exit is read
 * as a second witness and recorded in summary.json, so a reader of the log
 * directory sees the failure either way.
 *
 * Reach (`reachedSuites(paths, {root})`, root defaulting to this repo): for
 * each changed file under server/ or scripts/, its .test.js sibling when one
 * exists, plus every .test.js under those roots whose direct relative
 * require() resolves to a changed file, plus every .test.js under those roots
 * whose source names a changed file's basename inside quotes (single, double
 * or backtick), for a changed file of any extension. Then one more hop, once,
 * through non-test modules: a .js module under the roots that requires or
 * quotes a changed file counts as changed too, so its sibling, its importers
 * and the tests that quote it are reached. So scripts/sensitive-paths.txt
 * reaches sensitive-match.test.js and push-gate.test.js through
 * sensitive-match.js, and scripts/lib/flockExec.js reaches run-suites.test.js
 * and testdb-smoke.test.js through the two runners. A test that sits two
 * modules away is not reached, a stated limit: sensitive-paths.txt does not
 * reach lane-status.test.js (sensitive-paths.txt, sensitive-match.js,
 * lane-status.js, lane-status.test.js). Over-reach is harmless (a suite that
 * runs without need costs time, never a false green), so the basename rule is
 * deliberately loose. A changed .test.js runs itself. Paths outside server/
 * and scripts/ reach nothing.
 *
 * --changed <base>..<tip>: both ends must be non-empty and each must pass
 * `git rev-parse --verify --end-of-options <end>^{commit}`, and the range
 * reaches git diff after --end-of-options, so a value that is really an option
 * (-S..., --output=...) is a usage error (exit 2), never "no suites reached".
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync, spawn, fork } = require('child_process');
// git runs under sensitive-match's env: no replace refs, no diff driver, no
// diff options from the environment (review-tooling security, run-suites L4).
const SM = require('./sensitive-match');
const { parse, logName, outName, suiteArgv, suiteEnv, smokeSummary, didNotRun, claimRunDir, joinRunDir, releaseRunDir } = require('./lib/tapSummary');
const { underLock, parentGone, flockHolders, looksLikeReexec, exitOnStopSignals, yieldToSignals, sweepSession, gnuTimeout, boundedNodeSync, NO_GNU_TIMEOUT } = require('./lib/flockExec');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOTS = ['server/', 'scripts/'];
const REQUIRE_RE = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
const GUARD = 'DRB_DEVDB_LOCKED';
// 300 s, raised from 180 s on 2026-11-04: the bound only stops a hung suite from
// holding the dev-suite lock, and menuDrafts.test.js runs about 164 s on a quiet
// shared dev database and past 180 s on a loaded one.
const SUITE_TIMEOUT_MS = 300_000;
// Parallel workers (2026-11-08): each runs on its own ci-suites-<n> Neon
// branch reset to dev, so the suites of one run cannot collide and no run
// touches the dev database the local server uses. The default is 4; --workers
// 1, RUN_SUITES_WORKERS=1, no Neon key, fewer than two server suites, or a
// Neon step that fails runs the serial path on the dev database, as before.
// At most 4 (one slot's branches, neonBranches.SLOT_WIDTH) since 2026-11-19.
const DEFAULT_WORKERS = 4;
const MAX_WORKERS = 4;
const SLOT_ENV = 'RUN_SUITES_SLOT';
const INITDB_TIMEOUT_MS = 180_000;

function norm(root, p) {
  return path.relative(root, path.resolve(root, p)).split(path.sep).join('/');
}

function exists(root, rel) {
  try {
    return fs.statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
}

// Every file under the roots that `keep` accepts (node_modules and dot
// directories skipped), as repo-relative paths.
function listFiles(root, keep) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (e.isFile() && keep(e.name)) out.push(child);
    }
  };
  for (const r of ROOTS) walk(r.replace(/\/$/, ''));
  return out;
}

function listTests(root) {
  return listFiles(root, (name) => name.endsWith('.test.js'));
}

function listModules(root) {
  return listFiles(root, (name) => name.endsWith('.js') && !name.endsWith('.test.js'));
}

// Any of `basenames` inside a quoted literal: the basename as a whole path
// segment (not inside a longer name), anywhere between two matching quotes on
// one line. One regex for the whole set; null for an empty set.
function quotedMention(basenames) {
  const alt = [...new Set(basenames)].map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!alt) return null;
  return new RegExp(`(['"\`])[^'"\`\\n]*(?<![\\w.-])(?:${alt})(?![\\w.-])[^'"\`\\n]*\\1`);
}

// True when `file` (its source `src`) has a direct relative require() that
// resolves into `set`, or quotes the basename of a file in `set` (mention).
function refersTo(file, src, set, mention) {
  const requires = [...src.matchAll(REQUIRE_RE)].some((m) => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]));
    return [target, `${target}.js`, `${target}.json`, `${target}/index.js`].some((c) => set.has(c));
  });
  return requires || (mention !== null && mention.test(src));
}

function reachedSuites(paths, { root = REPO_ROOT } = {}) {
  const changed = new Set();
  const out = new Set();
  const addSibling = (p) => {
    const sibling = `${p.replace(/\.[^./]+$/, '')}.test.js`;
    if (exists(root, sibling)) out.add(sibling);
  };
  for (const p of paths.map((x) => norm(root, x))) {
    if (!ROOTS.some((r) => p.startsWith(r))) continue;
    changed.add(p);
    if (p.endsWith('.test.js')) {
      if (exists(root, p)) out.add(p);
      continue;
    }
    addSibling(p);
  }
  if (!changed.size) return [];
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  // One more hop, once: a non-test module under the roots that requires or
  // quotes a changed file counts as changed too. Its sibling, its importers
  // and the tests that quote it are reached; a module that refers only to
  // such a module is not followed further.
  const firstMention = quotedMention([...changed].map((c) => path.posix.basename(c)));
  const hop = new Set();
  for (const m of listModules(root)) {
    if (!changed.has(m) && refersTo(m, read(m), changed, firstMention)) hop.add(m);
  }
  for (const m of hop) addSibling(m);
  const all = new Set([...changed, ...hop]);
  const mention = quotedMention([...all].map((c) => path.posix.basename(c)));
  for (const t of listTests(root)) {
    if (!out.has(t) && refersTo(t, read(t), all, mention)) out.add(t);
  }
  return [...out].sort();
}

function gitLines(root, args) {
  const raw = execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: SM.gitEnv() });
  return raw.split('\0').filter(Boolean);
}

// The staged paths. Outside a repo `git diff --cached` would fall back to
// --no-index and print its usage, so the repo is checked first and the error
// says what is wrong.
function stagedPaths({ root = REPO_ROOT } = {}) {
  gitLines(root, ['rev-parse', '--git-dir']);
  return gitLines(root, ['diff', '--cached', '--name-only', '--no-renames', '-z']);
}

function gitCommonDir(root) {
  return execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: SM.gitEnv(),
  }).trim();
}

const USAGE = 'usage: run-suites.js --changed <base>..<tip> | --staged | <file>... [--log-dir <dir>]';

function usage(why) {
  return new Error(`${USAGE}\n  (${why})`);
}

// <base>..<tip> split at the first '..'; an end is '' when missing.
function splitRange(range) {
  const i = range.indexOf('..');
  return i < 0 ? ['', ''] : [range.slice(0, i), range.slice(i + 2)];
}

// Each end of a --changed range must be a commit git can verify; a value git
// would read as an option, or one that names no commit, is a usage error.
function verifyRange(root, range) {
  for (const end of splitRange(range)) {
    const r = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${end}^{commit}`], { stdio: 'ignore', env: SM.gitEnv() });
    if (r.status !== 0) throw usage(`--changed: ${JSON.stringify(end)} is not a commit`);
  }
}

// Exactly one mode (a range, the staged set, or named files) and an optional
// --log-dir. Anything else is a usage error, so a typo never runs a narrower
// set than was asked for.
function parseArgs(argv) {
  const opts = { mode: null, range: null, files: [], logDir: null, workers: null };
  const setMode = (m) => {
    if (opts.mode && opts.mode !== m) throw usage('one mode only: --changed, --staged or files');
    if (opts.mode === m && m !== 'files') throw usage(`${m} given twice`);
    opts.mode = m;
  };
  const value = (flag, v) => {
    if (v === undefined || v.startsWith('--')) throw usage(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workers') {
      if (opts.workers !== null) throw usage('--workers given twice');
      const n = Number(value(a, argv[++i]));
      if (!Number.isInteger(n) || n < 1 || n > MAX_WORKERS) throw usage(`--workers takes a whole number from 1 to ${MAX_WORKERS}`);
      opts.workers = n;
    } else if (a === '--log-dir') {
      if (opts.logDir !== null) throw usage('--log-dir given twice');
      opts.logDir = value(a, argv[++i]);
    } else if (a === '--changed') {
      setMode('changed');
      opts.range = value(a, argv[++i]);
      const [base, tip] = splitRange(opts.range);
      if (!base || !tip) throw usage('--changed takes <base>..<tip>, both ends given');
    } else if (a === '--staged') {
      setMode('staged');
    } else if (a.startsWith('--')) {
      throw usage(`unknown flag ${a}`);
    } else {
      setMode('files');
      opts.files.push(a);
    }
  }
  if (!opts.mode) throw usage('nothing to run');
  return opts;
}

// Named files: a .test.js runs as named, wherever it lives; any other file
// expands to what it reaches. A named file that does not exist is an error,
// never an empty run.
function resolveSuites(opts, root) {
  if (opts.mode === 'changed') {
    return reachedSuites(gitLines(root, ['diff', '--name-only', '--no-renames', '-z', '--end-of-options', opts.range, '--']), { root });
  }
  if (opts.mode === 'staged') return reachedSuites(stagedPaths({ root }), { root });
  const missing = opts.files.filter((f) => !exists(root, norm(root, f)));
  if (missing.length) throw new Error(`no such file: ${missing.map((f) => norm(root, f)).join(', ')}`);
  const named = opts.files.map((f) => norm(root, f));
  const tests = named.filter((f) => f.endsWith('.test.js'));
  const others = named.filter((f) => !f.endsWith('.test.js'));
  return [...new Set([...tests, ...reachedSuites(others, { root })])].sort();
}

// Runs one suite into its log and returns its verdict. `exitOk` is the exit
// witness (exit 0, no signal, inside the timeout); the failure verdict and the
// summary.json entry both come from smokeSummary, so they cannot disagree.
function runSuite(root, file, logDir, { timeoutMs = SUITE_TIMEOUT_MS, quiet = false, lockFd = null } = {}) {
  // <name>.log is the TAP witness (Node's reporter alone writes it; created
  // empty first, so a suite that dies before its reporter starts leaves an
  // empty record, never an old one); <name>.out takes the suite's own output.
  const logPath = path.join(logDir, logName(file));
  const outPath = path.join(logDir, outName(file));
  fs.writeFileSync(logPath, '');
  const fd = fs.openSync(outPath, 'w');
  let r;
  try {
    // Under GNU timeout, which KILLs the suite and its process group at the
    // bound; the lock's descriptor rides along as fd 3, so the suite
    // holds the lock for as long as it runs, even if the locked run above it
    // is killed.
    r = boundedNodeSync(suiteArgv(file, { tapFile: logPath }), {
      timeoutMs,
      cwd: root,
      env: runnerFreeEnv(suiteEnv()),
      stdio: ['ignore', fd, fd],
      lockFd,
    });
  } finally {
    fs.closeSync(fd);
  }
  const text = fs.readFileSync(logPath, 'utf8');
  let exit = '';
  if (r.timedOut) exit = ` (timed out at ${Math.round(timeoutMs / 1000)}s)`;
  else if (r.error) exit = ` (could not start: ${r.error.code || r.error.message})`;
  else if (r.signal) exit = ` (killed by ${r.signal})`;
  else if (r.status !== 0) exit = ` (exit ${r.status})`;
  const exitOk = exit === '';
  const [entry] = smokeSummary([{ file, text, exitOk }]).suites;
  const failed = !entry.ok;
  const s = parse(text);
  const counts = s.found ? `pass ${s.pass} fail ${s.fail}${s.cancelled ? ` cancelled ${s.cancelled}` : ''}` : 'no TAP summary';
  const line = `${file} ${counts}${exit}`;
  if (!quiet) console.log(failed ? `${line}  (log: ${logPath}; output: ${outPath})` : line);
  return { file, text, exitOk, failed, line };
}

// ---- Parallel workers (2026-11-08) -------------------------------------------

// A suite's environment never carries the runner's own worker knobs: a fixture
// run nested inside a suite (run-suites.test.js) would otherwise inherit them
// and reset the shared ci-suites branches under the outer run's workers.
function runnerFreeEnv(env) {
  delete env.RUN_SUITES_WORKERS;
  delete env.RUN_SUITES_DB_URLS;
  delete env.RUN_SUITES_WORKER_LOCK_FD;
  delete env[SLOT_ENV];
  return env;
}

// Suite durations from earlier runs, <git-common-dir>/drb-review/_suite-durations.json
// ({file: ms}), so the queue starts with the slowest suites; an unknown suite
// counts as slow. A file that cannot be read is an empty record.
// null when the root has no git dir (a fixture repo): nowhere to record.
function durationsFile(root) {
  try {
    return path.join(gitCommonDir(root), 'drb-review', '_suite-durations.json');
  } catch {
    return null;
  }
}
function readDurations(root) {
  const file = durationsFile(root);
  if (!file) return {};
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}
function writeDurations(root, results) {
  const file = durationsFile(root);
  if (!file) return;
  const d = readDurations(root);
  for (const r of results) {
    const m = /^# duration_ms ([\d.]+)/m.exec(r.text || '');
    if (m) d[r.file] = Math.round(Number(m[1]));
  }
  // Written aside and renamed in, since two slots' runs can end together: a
  // reader sees the old record or the new one, never half of one.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (rmErr) {
      console.error(`run-suites: could not remove ${tmp} (${rmErr.code || rmErr.message})`);
    }
    // a record we cannot write only costs ordering next time
    console.error(`run-suites: could not record suite durations (${err.code || err.message}); the next run orders its queue without them`);
  }
}
function queueOrder(suites, durations) {
  const slow = Number.MAX_SAFE_INTEGER;
  return [...suites].sort((a, b) => (durations[b] ?? slow) - (durations[a] ?? slow) || a.localeCompare(b));
}

// The worker count: --workers, else 1 under a RUN_SUITES_ROOT override (a
// test's fixture repo, the old-code proof, the merge re-run), so no
// environment knob makes such a run create Neon branches, else
// RUN_SUITES_WORKERS, else the default.
function workerCount(opts, env = process.env) {
  if (opts.workers !== null) return opts.workers;
  if (env.RUN_SUITES_ROOT) return 1;
  const n = Number(env.RUN_SUITES_WORKERS);
  return Number.isInteger(n) && n >= 1 && n <= MAX_WORKERS ? n : DEFAULT_WORKERS;
}

// The worker databases: RUN_SUITES_DB_URLS (comma-separated, a test and a
// hand override) or n fresh ci-suites branches of `slot`; null with one stderr
// line when there is no Neon key or a Neon step fails, so the run goes serial
// (a slot-2 run refuses instead, in cli).
async function workerDbUrls(n, slot = 1, why = {}) {
  // Slot 2 never goes serial (cli refuses), so its lines say so and the
  // reason is handed back in why.reason for the refusal to carry.
  const tail = slot === 2 ? 'the second slot refuses rather than run serially on the dev database' : 'running serially on the dev database';
  const say = (line) => {
    why.reason = line;
    console.error(`run-suites: ${line}; ${tail}`);
  };
  if (process.env.RUN_SUITES_DB_URLS) {
    const urls = process.env.RUN_SUITES_DB_URLS.split(',').filter(Boolean).slice(0, n);
    if (urls.length < 2) {
      say(`RUN_SUITES_DB_URLS names ${urls.length} database(s), and a parallel run needs two or more`);
      return null;
    }
    return urls;
  }
  const NB = require('./lib/neonBranches');
  const key = NB.discoverApiKey();
  if (!key) {
    say('no Neon key (NEON_API_KEY or ~/.secrets/neon_api_key)');
    return null;
  }
  try {
    if (slot === 2) await waitForSlot1Quiet(REPO_ROOT);
    return await NB.workerDatabases(key, n, slot);
  } catch (err) {
    say(`the worker branches could not be prepared (${NB.mask(err.message)})`);
    return null;
  }
}

// initDb on one worker database, bounded like a suite, its output to
// <outDir>/initdb-<n>.out (a temp dir, never the run dir: a run dir holds only
// the runner's own files, or the next run on it refuses). Resolves to
// { failed } (no connection, a crash, the bound: the run goes serial) or
// { unexpected } (initDb resolves after logging a schema statement it could
// not apply, so a branch would run half-built: the run refuses), else {}.
function initWorkerDb(root, dbUrl, n, outDir, lockFd) {
  return new Promise((resolve) => {
    const outPath = path.join(outDir, `initdb-${n}.out`);
    const out = fs.openSync(outPath, 'w');
    const argv = ['--signal=KILL', '--kill-after=5', String(INITDB_TIMEOUT_MS / 1000), process.execPath, '-r', require.resolve('dotenv/config'), '-e',
      "require('./server/db/index.js').initDb().then(() => process.exit(0)).catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });"];
    const child = spawn(gnuTimeout(), argv, {
      cwd: root,
      env: suiteEnv({ DATABASE_URL: dbUrl }),
      stdio: ['ignore', out, out, ...(lockFd === null || lockFd === undefined ? [] : [lockFd])],
    });
    child.on('error', (err) => { fs.closeSync(out); resolve({ failed: `initDb ${n} could not start: ${err.code || err.message}` }); });
    child.on('exit', (code, signal) => {
      fs.closeSync(out);
      if (code !== 0) return resolve({ failed: `initDb on worker ${n} failed (${signal || `exit ${code}`}; see ${outPath})` });
      let text = '';
      try {
        text = fs.readFileSync(outPath, 'utf8');
      } catch (err) {
        return resolve({ failed: `initDb on worker ${n}: its output could not be read (${err.code || err.message})` });
      }
      if (/UNEXPECTED failure/.test(text)) return resolve({ unexpected: `initDb on worker ${n} could not apply part of schema.sql (see ${outPath}); a half-built database runs no suite` });
      return resolve({});
    });
  });
}

// Runs `suites` across one worker per URL, slowest first, printing each
// result line as it lands. Resolves to the results in the order of `suites`.
function runParallel(root, suites, urls, logDir, lockFd, launcherGone = () => false) {
  const queue = queueOrder(suites, readDurations(root));
  const results = new Map();
  return new Promise((resolve, reject) => {
    let live = urls.length;
    const workers = urls.map((url) => {
      const w = fork(path.join(__dirname, 'lib', 'suiteWorker.js'), [root, logDir], {
        cwd: root,
        env: { ...runnerFreeEnv(suiteEnv({ DATABASE_URL: url })), RUN_SUITES_WORKER_LOCK_FD: lockFd === null || lockFd === undefined ? '' : '3' },
        stdio: ['ignore', 'inherit', 'inherit', lockFd === null || lockFd === undefined ? 'ignore' : lockFd, 'ipc'],
      });
      // A launcher gone (kill -9) hands out no further suite, as the serial
      // loop stops before its next one.
      const next = () => {
        const file = launcherGone() ? null : queue.shift();
        try {
          w.send(file ? { file } : { done: true });
        } catch {
          // the worker is gone; its exit settles the run below
          if (file) queue.unshift(file);
        }
      };
      w.on('error', () => {
        // a send to a worker that has gone; its exit settles the run below
      });
      w.on('message', (msg) => {
        if (msg && msg.result) {
          const r = msg.result;
          results.set(r.file, r);
          console.log(r.failed ? `${r.line}  (log: ${path.join(logDir, logName(r.file))}; output: ${path.join(logDir, outName(r.file))})` : r.line);
        }
        if (msg && (msg.ready || msg.result)) next();
      });
      w.on('exit', () => {
        live -= 1;
        if (live === 0) {
          const missing = suites.filter((f) => !results.has(f));
          if (missing.length) reject(new Error(`a worker stopped before ${missing.length} suite(s) ran (${missing[0]} first)`));
          else resolve(suites.map((f) => results.get(f)));
        }
      });
      return w;
    });
    process.on('exit', () => {
      for (const w of workers) if (w.exitCode === null) w.kill('SIGKILL');
    });
  });
}

// <git-common-dir>/drb-review/_runs/<timestamp>/, the default --log-dir.
function defaultLogDir(root) {
  return path.join(gitCommonDir(root), 'drb-review', '_runs', new Date().toISOString().replace(/[:.]/g, '-'));
}

function writeSummary(logDir, summary) {
  fs.writeFileSync(path.join(logDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

// The dev-suite lock file of `slot`: DRB_DEVDB_LOCK_FILE (one slot only),
// else drb-devdb.lock (slot 1) or drb-devdb-2.lock (slot 2) in the git common
// dir (throws when git cannot name it).
function devdbLockFile(root, slot = 1) {
  if (process.env.DRB_DEVDB_LOCK_FILE) return path.resolve(process.env.DRB_DEVDB_LOCK_FILE);
  return path.join(gitCommonDir(root), slot === 2 ? 'drb-devdb-2.lock' : 'drb-devdb.lock');
}

// The slot the re-exec was launched for: 2 only when the launcher said so.
function slotFromEnv(env = process.env) {
  return env[SLOT_ENV] === '2' && !env.DRB_DEVDB_LOCK_FILE ? 2 : 1;
}

// Holders plus waiters on lockFile's inode in /proc/locks (0 when the file
// or the table cannot be read: a guess here only picks a line to wait in).
function lockLine(lockFile, locksPath = '/proc/locks') {
  let ino;
  let raw;
  try {
    ino = String(fs.statSync(lockFile, { bigint: true }).ino);
    raw = fs.readFileSync(locksPath, 'utf8');
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of raw.split('\n')) {
    const m = /\bFLOCK\s+\S+\s+\S+\s+\d+\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/.exec(line);
    if (m && m[1] === ino) n++;
  }
  return n;
}

// Pure: the slot a parallel-eligible run takes. A free slot 1, else a free
// slot 2, else the shorter line, slot 1 on a tie.
function pickSlot({ free1, free2, line1, line2 }) {
  if (free1) return 1;
  if (free2) return 2;
  return line2 < line1 ? 2 : 1;
}

// The launcher's slot for this run: 2 is possible only for a run that will go
// parallel on Neon branches; everything else (a serial run on the dev
// database, a fixture root, a lock override, named databases) is slot 1.
function chooseSlot(root, nWorkers, serverSuites, env = process.env) {
  if (env.DRB_DEVDB_LOCK_FILE || env.RUN_SUITES_ROOT || env.RUN_SUITES_DB_URLS) return 1;
  if (nWorkers < 2 || serverSuites < 2) return 1;
  if (!require('./lib/neonBranches').discoverApiKey()) return 1;
  const [l1, l2] = [devdbLockFile(root, 1), devdbLockFile(root, 2)];
  const free = (f) => spawnSync('flock', ['-n', f, 'true']).status === 0;
  const free1 = free(l1);
  const free2 = !free1 && free(l2);
  return pickSlot({ free1, free2, line1: lockLine(l1), line2: lockLine(l2) });
}

// The slot-1 marker: drb-devdb-slot1.json in the git common dir,
// {pid, mode}, written by the run holding slot 1: mode "no-dev" once it runs
// on its own ci-suites branches, or serially with no server suite (neither
// touches the dev database's server fixtures), "dev" before it runs a server
// suite serially on the dev database (null when the root has no
// git dir). Slot 2 cuts its branches from dev only while slot 1 is free or its
// holder has said "no-dev"; a held slot 1 with no such word (an older lane's
// runner writes none, a run still preparing, a serial run) means wait.
function slot1MarkerFile(root) {
  try {
    return path.join(gitCommonDir(root), 'drb-devdb-slot1.json');
  } catch {
    return null;
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
function ppidOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return null;
  }
}
// The marker's {pid, mode}, or null (missing, unreadable, malformed).
function readSlot1Marker(file) {
  if (!file) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pid = Number(m && m.pid);
    return Number.isInteger(pid) && pid > 1 && (m.mode === 'no-dev' || m.mode === 'dev') ? { pid, mode: m.mode } : null;
  } catch {
    return null;
  }
}
// Pure: may slot 2 cut its branches from dev now? Yes when slot 1 is free, or
// when the marker says "no-dev" and its pid (or its flock parent) holds
// slot 1's lock and is alive; anything unknown is no.
function slot1Quiet({ free, marker, alive, holders, ppid }) {
  if (free) return true;
  if (!marker || marker.mode !== 'no-dev' || !alive || !holders) return false;
  return holders.has(marker.pid) || (ppid !== null && holders.has(ppid));
}
// The slot-1 run's word on what it touches, replacing its earlier word; the
// marker goes when this run ends, if it still names this run.
let slot1Cleanup = false;
function markSlot1(root, mode) {
  const file = slot1MarkerFile(root);
  if (!file) return;
  try {
    fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, mode })}\n`);
  } catch (err) {
    // A missing word only makes a slot-2 run wait for slot 1 to end.
    console.error(`run-suites: could not write the slot-1 marker ${file} (${err.code || err.message}); a slot-2 run waits for this run to end`);
    return;
  }
  if (slot1Cleanup) return;
  slot1Cleanup = true;
  process.on('exit', () => {
    try {
      const m = readSlot1Marker(file);
      if (m && m.pid === process.pid) fs.rmSync(file, { force: true });
    } catch (err) {
      console.error(`run-suites: could not remove the slot-1 marker ${file} (${err.code || err.message})`);
    }
  });
}
// Slot 2, before its reset: wait until slot1Quiet, one stderr line when it
// waits. The knobs are for tests.
async function waitForSlot1Quiet(root, { pollMs = 5000, lockFile = devdbLockFile(root, 1), file = slot1MarkerFile(root), locksPath = '/proc/locks' } = {}) {
  let said = false;
  for (;;) {
    const free = spawnSync('flock', ['-n', lockFile, 'true']).status === 0;
    const marker = free ? null : readSlot1Marker(file);
    const quiet = slot1Quiet({
      free,
      marker,
      alive: marker ? pidAlive(marker.pid) : false,
      holders: free ? null : flockHolders(lockFile, locksPath),
      ppid: marker ? ppidOf(marker.pid) : null,
    });
    if (quiet) return;
    if (!said) console.error('run-suites: slot 1 is held by a run that may be on the dev database; waiting for it before resetting the second slot\'s branches from dev');
    said = true;
    await yieldToSignals();
    if (lockParentGone()) throw new Error('the process that launched this run is gone');
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
let lockParentGone = () => false;

// One line for an error, git's own first line when git said something.
function oneLine(err) {
  const text = String((err && err.stderr && String(err.stderr).trim()) || (err && err.message) || err);
  return text.split('\n').map((l) => l.trim()).find(Boolean) || 'unknown error';
}

function overridesNotice() {
  const set = ['RUN_SUITES_ROOT', 'DRB_DEVDB_LOCK_FILE'].filter((k) => process.env[k]);
  if (!set.length) return null;
  return `run-suites: override in effect: ${set.map((k) => `${k}=${process.env[k]}`).join(', ')}`;
}

async function cli(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const root = process.env.RUN_SUITES_ROOT ? path.resolve(process.env.RUN_SUITES_ROOT) : REPO_ROOT;
  const runDir = opts.logDir ? path.resolve(opts.logDir) : null;
  const waitLine = (lockFile) => `run-suites: waiting for the dev-suite lock (${lockFile}; fuser names the holder)`;
  // Where a refusal writes its did-not-run summary: the --log-dir, once this
  // process has prepared it (a launcher) or proved its guard (the re-exec).
  let verdictDir = null;
  const refuse = (why) => {
    console.error(`run-suites: ${why}`);
    if (verdictDir) {
      try {
        writeSummary(verdictDir, didNotRun(why));
      } catch (err) {
        console.error(`run-suites: could not write summary.json (${err.code || err.message}); the line above still says why`);
      }
    }
    process.exit(1);
  };
  // A --log-dir is claimed first, before any refusal and before the lock
  // wait (tapSummary.claimRunDir): a dir another live run owns, or one that
  // holds anything no runner wrote, is refused in one line and left as it
  // was; otherwise what an earlier run left there (summary.json, .log and
  // .out files) goes, so none of it can stand in for this run, and the
  // marker goes when this run ends. The re-exec under flock never touches
  // the dir before it has proved its guard: a waiter orphaned by a kill -9
  // of its launcher stops in underLock, having touched nothing.
  const claim = runDir
    ? () => {
      try {
        claimRunDir(runDir);
      } catch (err) {
        console.error(`run-suites: ${oneLine(err)}`);
        process.exit(1);
      }
      process.on('exit', () => releaseRunDir(runDir));
    }
    : null;
  let lock = null;
  if (looksLikeReexec(GUARD)) {
    let lockFile;
    try {
      lockFile = devdbLockFile(root, slotFromEnv());
    } catch (err) {
      console.error(`run-suites: ${oneLine(err)}`);
      process.exit(1);
    }
    lock = await underLock({ lockFile, guardVar: GUARD, waitLine: waitLine(lockFile), notice: null, prepare: claim });
    exitOnStopSignals();
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
  } else if (claim) {
    claim();
    verdictDir = runDir;
  }
  if (opts.mode === 'changed') {
    try {
      verifyRange(root, opts.range);
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    }
  }
  let suites;
  try {
    suites = resolveSuites(opts, root);
  } catch (err) {
    refuse(oneLine(err));
  }
  const notice = overridesNotice();
  if (suites.length === 0) {
    // Nothing to run, so no lock; the empty summary still says so, so a reader
    // can tell "nothing to run" from "died before writing".
    if (notice && !lock) console.error(notice);
    let logDir;
    try {
      logDir = runDir || defaultLogDir(root);
      fs.mkdirSync(logDir, { recursive: true });
      writeSummary(logDir, { suites: [], total_pass: 0, total_fail: 0, skipped: false });
    } catch (err) {
      refuse(oneLine(err));
    }
    console.log(`run-suites: no suites reached; summary.json in ${logDir}`);
    process.exit(0);
  }
  if (!gnuTimeout()) refuse(NO_GNU_TIMEOUT);
  if (!lock) {
    let lockFile;
    try {
      const slot = chooseSlot(root, Math.min(workerCount(opts), suites.length), suites.filter((f) => f.startsWith('server/')).length);
      // The re-exec inherits this and takes the same lock file.
      process.env[SLOT_ENV] = String(slot);
      lockFile = devdbLockFile(root, slot);
    } catch (err) {
      refuse(oneLine(err));
    }
    // Resolves only in the run that holds the lock; the outer exits from inside.
    lock = await underLock({ lockFile, guardVar: GUARD, waitLine: waitLine(lockFile), notice, prepare: null });
  }

  // The locked run: a signal becomes an exit, so the marker still goes.
  exitOnStopSignals();
  let logDir;
  try {
    logDir = runDir || defaultLogDir(root);
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    refuse(oneLine(err));
  }

  const nWorkers = Math.min(workerCount(opts), suites.length);
  const serverSuites = suites.filter((f) => f.startsWith('server/')).length;
  const slot = slotFromEnv();
  lockParentGone = () => parentGone(lock.parentPid);
  const why = {};
  let urls = nWorkers > 1 && serverSuites >= 2 ? await workerDbUrls(nWorkers, slot, why) : null;
  // Slot 2 never goes serial: slot 1 may be on the dev database right now.
  if (slot === 2 && !urls) refuse(`the second slot cannot run serially on the dev database: ${why.reason || 'this run no longer reaches two server suites (the staged set changed while it waited)'}; run again`);
  if (urls) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drb-initdb-'));
    const res = await Promise.all(urls.map((u, i) => initWorkerDb(root, u, i + 1, outDir, lock.lockFd)));
    const unexpected = res.find((r) => r.unexpected);
    const failed = res.find((r) => r.failed);
    if (unexpected) refuse(unexpected.unexpected);
    if (failed && slot === 2) refuse(`${failed.failed}; the second slot never runs serially on the dev database, run again`);
    if (failed) {
      console.error(`run-suites: ${failed.failed}; running serially on the dev database`);
      urls = null;
    } else {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
  if (urls && urls.length > 1) {
    if (slot === 1) markSlot1(root, 'no-dev');
    // A sweep between suites would kill the other workers' suites, so the
    // session is swept once, after every worker has ended (a stated limit: a
    // stray child a suite leaves lives until the run ends).
    process.on('exit', () => sweepSession(lock.session));
    console.log(`run-suites: ${suites.length} suite(s) across ${urls.length} workers, each on its own ci-suites branch (slot ${slot})`);
    const gone = () => parentGone(lock.parentPid);
    let results;
    try {
      results = await runParallel(root, suites, urls, logDir, lock.lockFd, gone);
    } catch (err) {
      if (gone()) {
        console.error(`run-suites: the process that launched this run (pid ${lock.parentPid}) is gone; stopped handing out suites, no summary written.`);
        process.exit(1);
      }
      refuse(oneLine(err));
    }
    const left = sweepSession(lock.session);
    if (left.length) console.error(`run-suites: the suites left ${left.length} process(es) in the run's session, outside GNU timeout's groups; killed them`);
    writeDurations(root, results);
    const summary = smokeSummary(results.map((r) => ({ file: r.file, text: r.text, exitOk: r.exitOk })));
    writeSummary(logDir, summary);
    const failed = results.filter((r) => r.failed).length;
    console.log(`run-suites: ${results.length} suite(s), pass ${summary.total_pass} fail ${summary.total_fail}, ${failed} failed; logs in ${logDir}`);
    process.exit(failed ? 1 : 0);
  }

  if (slot === 1) markSlot1(root, serverSuites > 0 ? 'dev' : 'no-dev');
  const results = [];
  for (const f of suites) {
    await yieldToSignals();
    if (parentGone(lock.parentPid)) {
      console.error(`run-suites: the process that launched this run (pid ${lock.parentPid}) is gone; stopping before ${f}, no summary written.`);
      process.exit(1);
    }
    results.push(runSuite(root, f, logDir, { lockFd: lock.lockFd }));
    const left = sweepSession(lock.session);
    if (left.length) console.error(`run-suites: ${f} left ${left.length} process(es) in the run's session, outside GNU timeout's group, after it ended; killed them`);
  }
  writeDurations(root, results);
  const summary = smokeSummary(results.map((r) => ({ file: r.file, text: r.text, exitOk: r.exitOk })));
  writeSummary(logDir, summary);
  const failed = results.filter((r) => r.failed).length;
  console.log(`run-suites: ${results.length} suite(s), pass ${summary.total_pass} fail ${summary.total_fail}, ${failed} failed; logs in ${logDir}`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) cli(process.argv.slice(2));

module.exports = { reachedSuites, stagedPaths, parseArgs, runSuite, queueOrder, workerCount, pickSlot, lockLine, slotFromEnv, devdbLockFile, readSlot1Marker, slot1Quiet, waitForSlot1Quiet, SUITE_TIMEOUT_MS };
