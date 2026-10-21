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
 * Each suite runs serially as `node -r dotenv/config --test-reporter=tap
 * --test-reporter-destination=<log> <file>` (tapSummary.suiteArgv, the argv
 * testdb-smoke uses too) with cwd at the repo root. Its log,
 * <log-dir>/<path with slashes as dashes>.<6 hex of the path's sha1>.log
 * (tapSummary.logName; default dir <git-common-dir>/drb-review/_runs/
 * <timestamp>/), is the TAP record that
 * Node's reporter alone writes; what the suite itself prints to stdout and
 * stderr goes to the sibling .out. A suite runs under GNU coreutils timeout
 * (flockExec.boundedNodeSync), which at 180 s KILLs the suite and every
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
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
// git runs under sensitive-match's env: no replace refs, no diff driver, no
// diff options from the environment (review-tooling security, run-suites L4).
const SM = require('./sensitive-match');
const { parse, logName, outName, suiteArgv, suiteEnv, smokeSummary, didNotRun, claimRunDir, joinRunDir, releaseRunDir } = require('./lib/tapSummary');
const { underLock, parentGone, looksLikeReexec, exitOnStopSignals, yieldToSignals, sweepSession, gnuTimeout, boundedNodeSync, NO_GNU_TIMEOUT } = require('./lib/flockExec');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOTS = ['server/', 'scripts/'];
const REQUIRE_RE = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
const GUARD = 'DRB_DEVDB_LOCKED';
const SUITE_TIMEOUT_MS = 180_000;

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
  const opts = { mode: null, range: null, files: [], logDir: null };
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
    if (a === '--log-dir') {
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
      env: suiteEnv(),
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

// <git-common-dir>/drb-review/_runs/<timestamp>/, the default --log-dir.
function defaultLogDir(root) {
  return path.join(gitCommonDir(root), 'drb-review', '_runs', new Date().toISOString().replace(/[:.]/g, '-'));
}

function writeSummary(logDir, summary) {
  fs.writeFileSync(path.join(logDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

// The dev-suite lock file: DRB_DEVDB_LOCK_FILE, else drb-devdb.lock in the
// git common dir (throws when git cannot name it).
function devdbLockFile(root) {
  return process.env.DRB_DEVDB_LOCK_FILE ? path.resolve(process.env.DRB_DEVDB_LOCK_FILE) : path.join(gitCommonDir(root), 'drb-devdb.lock');
}

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
      lockFile = devdbLockFile(root);
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
      lockFile = devdbLockFile(root);
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
  const summary = smokeSummary(results.map((r) => ({ file: r.file, text: r.text, exitOk: r.exitOk })));
  writeSummary(logDir, summary);
  const failed = results.filter((r) => r.failed).length;
  console.log(`run-suites: ${results.length} suite(s), pass ${summary.total_pass} fail ${summary.total_fail}, ${failed} failed; logs in ${logDir}`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) cli(process.argv.slice(2));

module.exports = { reachedSuites, stagedPaths, parseArgs, runSuite, SUITE_TIMEOUT_MS };
