'use strict';

// Recording a test run into a review's working directory (instruction rewrite
// step 2, lane receipt-lib; scripts/review-receipt.js `tests`). Each function
// takes the working directory and its state, copies what it read into
// tests/, and returns the entry the CLI appends to state.tests; a run it
// cannot vouch for throws, and nothing is copied.
//
// Every entry but a client build is a green run. A log needs a TAP summary (tapSummary.parse)
// with fail 0, cancelled 0 and pass above 0. A summary.json (run-suites
// --log-dir, testdb-smoke --tap-dir) is refused when skipped is true, when it
// carries did_not_run, when any suite's ok is not true or total_fail is not 0,
// or (the smoke) when it ran no suite; each suite's own .log is re-read and
// must agree with its entry, and the files are copied into the receipt, so a
// later run in the same directory cannot change what the receipt says.
//
// A message names files and counts only, never a line of a log.

const fs = require('fs');
const path = require('path');
const { parse: parseTap } = require('./tapSummary');

function refuse(why) {
  throw new Error(why);
}

function readFile(file, what) {
  try {
    return fs.readFileSync(file);
  } catch {
    return refuse(`cannot read the ${what} ${file}`);
  }
}

function freeName(dir, base) {
  let name = base;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}.${i}`;
  return name;
}

function plainName(n) {
  return typeof n === 'string' && n.length > 0 && path.basename(n) === n && !n.startsWith('.') && !n.includes('\\');
}

// The one suite a command names (`node --test scripts/x.test.js`), as a path
// in the repo, so the block names a --log entry the way it names a suite;
// null when the command names none or several.
function suiteOf(command) {
  const named = String(command || '').split(/\s+/).filter((w) => /\.test\.js$/.test(w) && !path.isAbsolute(w)).map((w) => w.replace(/^\.\//, ''));
  return named.length === 1 ? named[0] : null;
}

function recordLog(dir, state, file, command) {
  const base = path.basename(file);
  const text = readFile(file, 'log').toString('utf8');
  const s = parseTap(text);
  if (!s.found) refuse(`${base}: no TAP summary (a plan line, then # pass and # fail); never a pass`);
  if (s.fail > 0 || s.cancelled > 0) refuse(`${base}: ${s.fail} failing, ${s.cancelled} cancelled; only a green run is recorded`);
  if (s.pass === 0) refuse(`${base}: ran no test (# pass 0)`);
  const testsDir = path.join(dir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  const copy = freeName(testsDir, `${state.tests.length + 1}-${base}`);
  fs.writeFileSync(path.join(testsDir, copy), text);
  return {
    type: 'log',
    command: command === undefined ? null : command,
    log: `tests/${copy}`,
    name: base.replace(/\.log$/, '').replace(/\.[0-9a-f]{6}$/, ''),
    file: suiteOf(command),
    pass: s.pass,
    fail: s.fail,
    read_from: `TAP summary: # pass ${s.pass}, # fail ${s.fail}`,
  };
}

function recordRun(dir, state, type, runDir, command) {
  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
  } catch {
    refuse(`${type}: ${path.join(runDir, 'summary.json')} is missing or not JSON`);
  }
  if (!summary || typeof summary !== 'object' || !Array.isArray(summary.suites) || typeof summary.total_pass !== 'number'
    || typeof summary.total_fail !== 'number' || typeof summary.skipped !== 'boolean') {
    refuse(`${type}: summary.json is not in the runners' shape {suites, total_pass, total_fail, skipped}`);
  }
  if (summary.skipped) refuse(`${type}: the run was skipped (no Neon key resolved); a skipped run is never a pass`);
  if (summary.did_not_run !== undefined) refuse(`${type}: the run did not run (summary.json carries did_not_run); never a pass`);
  const notOk = summary.suites.filter((s) => !s || s.ok !== true);
  if (notOk.length || summary.total_fail !== 0) refuse(`${type}: ${notOk.length} suite(s) not ok, total_fail ${summary.total_fail}; only a green run is recorded`);
  if (type === 'smoke' && summary.suites.length === 0) refuse('smoke: the smoke ran no suite');
  for (const s of summary.suites) {
    if (typeof s.file !== 'string' || !s.file) refuse(`${type}: a suite entry names no file`);
    if (!plainName(s.log) || (s.out !== undefined && !plainName(s.out))) refuse(`${type}: a suite's log or out is not a plain file name`);
    if (!fs.existsSync(path.join(runDir, s.log))) refuse(`${type}: ${s.log} is named in summary.json but missing`);
    const t = parseTap(fs.readFileSync(path.join(runDir, s.log), 'utf8'));
    if (!t.found || t.pass !== s.pass || t.fail !== s.fail || t.cancelled !== 0) refuse(`${type}: ${s.log} does not match its summary.json entry`);
  }
  const p = summary.suites.reduce((n, s) => n + s.pass, 0);
  const f = summary.suites.reduce((n, s) => n + s.fail, 0);
  if (p !== summary.total_pass || f !== summary.total_fail) refuse(`${type}: summary.json totals do not add up to its suites`);
  const testsDir = path.join(dir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  const sub = freeName(testsDir, `${type}-${state.tests.length + 1}`);
  fs.mkdirSync(path.join(testsDir, sub));
  fs.copyFileSync(path.join(runDir, 'summary.json'), path.join(testsDir, sub, 'summary.json'));
  for (const s of summary.suites) {
    fs.copyFileSync(path.join(runDir, s.log), path.join(testsDir, sub, s.log));
    if (s.out && fs.existsSync(path.join(runDir, s.out))) fs.copyFileSync(path.join(runDir, s.out), path.join(testsDir, sub, s.out));
  }
  return {
    type,
    command: command === undefined ? null : command,
    log: `tests/${sub}/summary.json`,
    pass: summary.total_pass,
    fail: summary.total_fail,
    skipped: false,
    read_from: 'summary.json, each suite checked against its own TAP log',
    suites: summary.suites.map((s) => ({ file: s.file, pass: s.pass, fail: s.fail, log: `tests/${sub}/${s.log}` })),
  };
}

// A client build (cd client && CI=true npx react-scripts build) prints no TAP
// summary. Its record is the exit code the skill captured and the log,
// copied, and it is green (ok) only when the exit code is 0, the log has a
// compile success line (Compiled successfully, or Compiled with warnings) and
// no line says Failed to compile; why names the failed condition, never a
// line of the log. A failing build is recorded too, ok false, and finalize
// refuses it while it is the latest build (spec 3.3: tier C's tests are the
// client build).
const BUILD_FAILED = /Failed to compile/;
const BUILD_COMPILED = /Compiled successfully|Compiled with warnings/;

function recordBuild(dir, state, log, exit, command) {
  const base = path.basename(log);
  const text = readFile(log, 'build log');
  const t = text.toString('utf8');
  let why = null;
  if (exit !== 0) why = `exit ${exit}`;
  else if (BUILD_FAILED.test(t)) why = 'exit 0, but the log says Failed to compile';
  else if (!BUILD_COMPILED.test(t)) why = 'exit 0, but the log has no compile success line';
  const testsDir = path.join(dir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  const copy = freeName(testsDir, `${state.tests.length + 1}-${base}`);
  fs.writeFileSync(path.join(testsDir, copy), text);
  return {
    type: 'build',
    command: command === undefined ? null : command,
    log: `tests/${copy}`,
    exit,
    ok: why === null,
    why,
    read_from: 'the exit code (--exit) and the log: a compile success line and no Failed to compile',
  };
}

module.exports = { recordLog, recordRun, recordBuild, readFile, freeName };
