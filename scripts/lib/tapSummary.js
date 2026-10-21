'use strict';

// The one TAP summary parser (instruction rewrite step 2, lane suite-runner).
// scripts/run-suites.js, scripts/testdb-smoke.js and the review receipt all read
// their counts here, from the summary block Node's TAP reporter ends a run
// with (`1..N`, `# tests N`, `# pass N`, `# fail N`, ...), never from an exit
// code alone. A log with no such block is `found: false`: a failure, never a
// zero.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEYS = ['pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'];
const PLAN = /^1\.\.\d+\s*$/;
const TESTS = /^# tests \d+\s*$/;
const COUNT = /^# ([a-z_]+) (\d+(?:\.\d+)?)\s*$/;

function empty() {
  return { pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 0 };
}

// Reads the LAST summary block in `text`. A block is what Node's TAP reporter
// writes when a run ends: a plan line `1..N` at column 0, `# tests N` next
// (after any root diagnostics, column-0 `# ` lines that are not count lines:
// an async-activity warning, a coverage note), then the count lines (`# suites`, `# pass`, `# fail`, ...),
// each once; the first line that is not a count, or a count already read,
// ends it. Count lines anywhere else open nothing: a test's diagnostic at the
// top level prints `# pass 9` at column 0 (the reporter escapes newlines, so
// it can never print a plan line), and a suite that exits before its run ends
// leaves no plan. A block is found only when it holds both `# pass` and
// `# fail`. A log that holds several is read by the last one opened, never a
// mix of two, and a last block cut short is not found.
function parse(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  let last = null;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!PLAN.test(lines[i])) continue;
    let t = i + 1;
    while (t < lines.length && lines[t].startsWith('# ') && !TESTS.test(lines[t]) && !COUNT.test(lines[t])) t++;
    if (t >= lines.length || !TESTS.test(lines[t])) continue;
    const block = empty();
    const seen = new Set();
    let j = t + 1;
    for (; j < lines.length; j++) {
      const m = COUNT.exec(lines[j]);
      if (!m || seen.has(m[1])) break;
      seen.add(m[1]);
      if (KEYS.includes(m[1])) block[m[1]] = Number(m[2]);
    }
    last = seen.has('pass') && seen.has('fail') ? block : null;
    i = j - 1;
  }
  return last ? { ...last, found: true } : { ...empty(), found: false };
}

// Totals across summaries. Found only when there is at least one summary and
// every one of them was found, so a dead suite can never vanish into a total.
function sum(summaries) {
  const total = empty();
  for (const s of summaries) {
    for (const k of KEYS) total[k] += s[k] || 0;
  }
  return { ...total, found: summaries.length > 0 && summaries.every((s) => s.found) };
}

// One flat file name per suite, shared by run-suites and testdb-smoke:
// <path with slashes as dashes>.<first 6 hex of the path's sha1>, so two
// paths that flatten alike (scripts/a/b-c.test.js, scripts/a-b/c.test.js)
// still get two names; a leading ./ is dropped first. The .log is the
// suite's TAP record, written by Node's TAP reporter alone (see suiteArgv);
// outName is its sibling .out, which holds whatever the suite itself printed
// to stdout and stderr. A reader takes both names from summary.json (each
// suite entry's log and out) rather than recomputing them.
function flatName(file) {
  const p = String(file).replace(/^\.\//, '');
  const hash = crypto.createHash('sha1').update(p).digest('hex').slice(0, 6);
  return `${p.replace(/[\\/]/g, '-')}.${hash}`;
}

function logName(file) {
  return `${flatName(file)}.log`;
}

function outName(file) {
  return `${flatName(file)}.out`;
}

// The summary.json of testdb-smoke and run-suites, from each suite's TAP text
// and its exit witness (`exitOk` in: exited 0, no signal, inside the
// timeout). Each suite entry is {file, log, out, pass, fail, found, ok,
// exit_ok}:
//   log, out the suite's file names in the run dir (logName, outName; the
//            smoke's gate path writes no .out and keeps its .log in a temp
//            dir it removes).
//   exit_ok  the raw exit witness, exactly as passed in.
//   ok       the verdict: a summary was found, fail 0, cancelled 0 (Node
//            reports a test killed by its own timeout as cancelled, not
//            fail) AND exit_ok. A suite that never ran, registered no tests
//            or died before its summary reads ok false whatever its exit.
// A suite whose verdict is false is recorded with fail at least 1, so the
// totals never read it as a zero.
function smokeSummary(results) {
  const suites = results.map(({ file, text, exitOk }) => {
    const s = parse(text);
    const exit_ok = Boolean(exitOk);
    const ok = exit_ok && s.found && s.fail === 0 && s.cancelled === 0;
    return { file, log: logName(file), out: outName(file), pass: s.pass, fail: ok ? 0 : Math.max(s.fail, 1), found: s.found, ok, exit_ok };
  });
  return {
    suites,
    total_pass: suites.reduce((n, s) => n + s.pass, 0),
    total_fail: suites.reduce((n, s) => n + s.fail, 0),
    skipped: false,
  };
}

// The summary.json of a run that refused before it ran a suite (the reason in
// did_not_run): no suites, one failure, so no reader can take it for a pass
// or for "nothing to run".
function didNotRun(reason) {
  return { suites: [], total_pass: 0, total_fail: 1, skipped: false, did_not_run: String(reason) };
}

// The one way run-suites and testdb-smoke run a suite: node's argv for
//   node -r dotenv/config --test-reporter=tap --test-reporter-destination=<tapFile>
//        [--test-reporter=<console> --test-reporter-destination=stdout] <file>
// with the preload resolved from here (so it works from any cwd) and NO
// `--test`. Every run carries the TAP witness: Node's TAP reporter writes the
// suite's record to tapFile, a file nothing else writes, so a summary the
// suite prints on its own stdout can never stand in for it. A suite that
// registers no tests, or that calls process.exit() before its tests end
// (mid-file or in a hook), leaves a witness with no summary, which every
// reader treats as a failure; under `--test` Node would instead wrap a file
// with no tests as one PASSING test. A failing test and a test cancelled by
// its own timeout still exit non-zero. `console` ('spec' or 'tap') adds a
// second reporter to stdout, for the one path that shows the suite on a
// console (testdb-smoke without --tap-dir); defaultConsoleReporter() picks
// the one Node itself would use, so that console looks as it always did.
function dotenvPreload() {
  try {
    return require.resolve('dotenv/config');
  } catch {
    return 'dotenv/config';
  }
}

function suiteArgv(file, { tapFile, console: consoleReporter = null } = {}) {
  if (!tapFile) throw new Error('suiteArgv: tapFile is required; a suite never runs without its TAP witness');
  if (consoleReporter !== null && !['spec', 'tap'].includes(consoleReporter)) throw new Error(`suiteArgv: console must be 'spec' or 'tap', not ${consoleReporter}`);
  return [
    '-r', dotenvPreload(),
    '--test-reporter=tap', `--test-reporter-destination=${tapFile}`,
    ...(consoleReporter ? [`--test-reporter=${consoleReporter}`, '--test-reporter-destination=stdout'] : []),
    file,
  ];
}

// The reporter Node uses for a file run with no reporter flags: spec on
// Node 23 and later (whatever stdout is; checked on 24.16 with stdout a
// pipe), and before that spec on a terminal, tap otherwise.
function defaultConsoleReporter(stream = process.stdout, version = process.versions.node) {
  if (Number(String(version).split('.')[0]) >= 23) return 'spec';
  return stream && stream.isTTY ? 'spec' : 'tap';
}

// The one environment run-suites and testdb-smoke give a suite: this
// process's environment plus `extra`, without NODE_TEST_CONTEXT. A runner
// started from inside a node:test process inherits that variable, and a suite
// that sees it writes v8-serialized results instead of TAP, so its log would
// hold no summary. process.env itself is left alone.
function suiteEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// ---- The run directory: one run per dir, and only the runner's own files ----
//
// A run dir (run-suites' --log-dir, testdb-smoke's --tap-dir) holds only what
// a runner writes there: summary.json, the run marker .drb-run, and each
// suite's <name>.log and <name>.out (logName, outName; a run from before the
// hash wrote <path with slashes as dashes>.log and .out, which count as the
// runner's too). The marker names the
// run that owns the dir, one `<pid> <start time>` line per process of the run
// (the launcher, then the locked run once it has proved its guard), so a pid
// reused by an unrelated process does not read as the run.

const MARKER = '.drb-run';
const RUN_FILE = /^(?:summary\.json|\.drb-run|.+\.test\.js(?:\.[0-9a-f]{6})?\.(?:log|out))$/;

// The start time (field 22 of /proc/<pid>/stat) of a live process, or null
// when it is gone or a zombie.
function startTime(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return rest[0] === 'Z' ? null : rest[19];
  } catch {
    return null;
  }
}

function markerLine(pid) {
  return `${pid} ${startTime(pid)}\n`;
}

// The pids a marker names, in order, each with whether it is still that
// live process (a line with no start time is checked by pid alone).
function markerPids(marker) {
  let raw;
  try {
    raw = fs.readFileSync(marker, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').map((l) => l.trim().split(/\s+/)).filter(([p]) => /^\d+$/.test(p || '')).map(([p, start]) => {
    const pid = Number(p);
    const now = startTime(pid);
    return { pid, live: now !== null && (start === undefined || start === now) };
  });
}

// What in `dir` no runner wrote: anything but a regular file with one of the
// runner's names (a subdirectory, a symlink and notes.txt alike).
function foreignEntries(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !(e.isFile() && RUN_FILE.test(e.name))).map((e) => e.name).sort();
}

function refuseForeign(dir, foreign) {
  const shown = foreign.slice(0, 3).join(', ') + (foreign.length > 3 ? `, and ${foreign.length - 3} more` : '');
  return new Error(`${dir} holds what no runner wrote (${shown}); give a new dir or one only a runner has written to`);
}

// Readies a reused run dir: creates it when missing and removes what an
// earlier run left (summary.json and every .log and .out), so none of it can
// stand in for this run; the marker stays. Throws, before removing anything,
// when the dir holds anything else (a mistyped --log-dir, say).
function clearRunDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const foreign = foreignEntries(dir);
  if (foreign.length) throw refuseForeign(dir, foreign);
  for (const name of fs.readdirSync(dir)) {
    if (name !== MARKER) fs.rmSync(path.join(dir, name), { force: true });
  }
}

// Claims `dir` for this run, then clears it (clearRunDir). Throws a one-line
// Error, with the dir left exactly as it was, when the dir holds anything no
// runner wrote or its marker names a live process of another run. A marker
// whose processes are all gone (a run killed -9) is cleared. The marker is
// created exclusively, so two runs that claim at once cannot both win.
function claimRunDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, MARKER);
  for (let attempt = 0; attempt < 3; attempt++) {
    const live = markerPids(marker).filter((m) => m.live && m.pid !== process.pid).map((m) => m.pid);
    if (live.length) throw new Error(`${dir} is in use by another run (pid ${live.join(', ')}); one run per dir`);
    const foreign = foreignEntries(dir);
    if (foreign.length) throw refuseForeign(dir, foreign);
    fs.rmSync(marker, { force: true });
    try {
      fs.writeFileSync(marker, markerLine(process.pid), { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    clearRunDir(dir);
    return;
  }
  throw new Error(`${dir}: another run keeps claiming it; one run per dir`);
}

// The locked run adds itself to its launcher's marker, so a kill -9 of the
// launcher leaves the dir claimed while the locked run still writes there.
function joinRunDir(dir, launcherPid) {
  const marker = path.join(dir, MARKER);
  const [first] = markerPids(marker);
  if (first && first.pid === launcherPid) fs.appendFileSync(marker, markerLine(process.pid));
}

// Removes the marker when the run it names first is `ownerPid` (the
// launcher), so a run never removes another run's claim.
function releaseRunDir(dir, ownerPid = process.pid) {
  const marker = path.join(dir, MARKER);
  const [first] = markerPids(marker);
  if (first && first.pid === ownerPid) fs.rmSync(marker, { force: true });
}

module.exports = { parse, sum, logName, outName, smokeSummary, didNotRun, suiteArgv, suiteEnv, defaultConsoleReporter, clearRunDir, claimRunDir, joinRunDir, releaseRunDir, RUN_MARKER: MARKER };
