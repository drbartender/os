'use strict';

// Tests for scripts/lib/receiptTests.js (instruction rewrite step 2, lane
// receipt-lib): recording a test run into a review's working directory. Every
// directory here is a throwaway under the temp dir, removed when the test
// ends; nothing here touches git or the dev database.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { recordLog, recordRun, recordBuild } = require('./receiptTests');
const { smokeSummary } = require('./tapSummary');

// A string that stands for anything a log could say: it may be stored, never
// put in a message.
const MARK = 'STORED-ONLY-7f3a';

function tmpDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `receipt-tests-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tap(pass, fail = 0) {
  return [
    'TAP version 13',
    `# ${MARK} something the suite printed`,
    `ok 1 - a test # ${MARK}`,
    `1..${pass + fail}`,
    `# tests ${pass + fail}`,
    '# suites 0',
    `# pass ${pass}`,
    `# fail ${fail}`,
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 5',
    '',
  ].join('\n');
}

// A runner directory in the shape run-suites and testdb-smoke write.
function runDir(t, suites, extra = {}) {
  const dir = tmpDir(t, 'run');
  const summary = { ...smokeSummary(suites.map((s) => ({ file: s.file, text: s.text, exitOk: s.exitOk !== false }))), ...extra };
  for (const s of suites) {
    const entry = summary.suites.find((e) => e.file === s.file);
    fs.writeFileSync(path.join(dir, entry.log), s.text);
    fs.writeFileSync(path.join(dir, entry.out), `${MARK}\n`);
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return dir;
}

function summaryOnly(t, label, summary) {
  const dir = tmpDir(t, label);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary));
  return dir;
}

// A working directory and the state the CLI keeps in it.
function work(t) {
  return { dir: tmpDir(t, 'work'), state: { tests: [] } };
}

function refusedWith(fn, re) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'refused');
  assert.match(err.message, re);
  assert.ok(!err.message.includes(MARK), `the message carries a stored value: ${err.message}`);
  return err;
}

test('a smoke or suites run is refused when skipped, did not run, a suite is not ok, or (the smoke) it ran no suite', (t) => {
  const { dir, state } = work(t);
  refusedWith(() => recordRun(dir, state, 'smoke', summaryOnly(t, 'skip', { suites: [], total_pass: 0, total_fail: 0, skipped: true })), /skipped/);
  const dnr = summaryOnly(t, 'dnr', { suites: [], total_pass: 0, total_fail: 1, skipped: false, did_not_run: `no timeout ${MARK}` });
  refusedWith(() => recordRun(dir, state, 'smoke', dnr), /did not run/);
  refusedWith(() => recordRun(dir, state, 'suites', dnr), /did not run/);
  const red = runDir(t, [{ file: 'server/m1.test.js', text: tap(3, 1) }, { file: 'server/m2.test.js', text: tap(2) }]);
  refusedWith(() => recordRun(dir, state, 'smoke', red), /1 suite\(s\) not ok/);
  const exitBad = runDir(t, [{ file: 'server/m1.test.js', text: tap(3), exitOk: false }]);
  refusedWith(() => recordRun(dir, state, 'suites', exitBad), /not ok/);
  const empty = summaryOnly(t, 'empty', { suites: [], total_pass: 0, total_fail: 0, skipped: false });
  refusedWith(() => recordRun(dir, state, 'smoke', empty), /ran no suite/);
  refusedWith(() => recordRun(dir, state, 'smoke', tmpDir(t, 'none')), /missing or not JSON/);
  refusedWith(() => recordRun(dir, state, 'smoke', summaryOnly(t, 'shape', { suites: 'x' })), /not in the runners' shape/);
  const suites = recordRun(dir, state, 'suites', empty);
  assert.deepStrictEqual([suites.type, suites.pass, suites.fail, suites.skipped, suites.suites], ['suites', 0, 0, false, []]);
});

test('each suite is checked against its own log; a summary its logs do not back is refused', (t) => {
  const { dir, state } = work(t);
  const forged = runDir(t, [{ file: 'server/m1.test.js', text: tap(3) }]);
  const summary = JSON.parse(fs.readFileSync(path.join(forged, 'summary.json'), 'utf8'));
  summary.suites[0].pass = 30;
  summary.total_pass = 30;
  fs.writeFileSync(path.join(forged, 'summary.json'), JSON.stringify(summary));
  refusedWith(() => recordRun(dir, state, 'smoke', forged), /does not match/);
  const missing = runDir(t, [{ file: 'server/m1.test.js', text: tap(3) }]);
  for (const f of fs.readdirSync(missing)) if (f.endsWith('.log')) fs.rmSync(path.join(missing, f));
  refusedWith(() => recordRun(dir, state, 'smoke', missing), /missing/);
  const sly = runDir(t, [{ file: 'server/m1.test.js', text: tap(3) }]);
  const s2 = JSON.parse(fs.readFileSync(path.join(sly, 'summary.json'), 'utf8'));
  s2.suites[0].log = '../../etc/passwd';
  fs.writeFileSync(path.join(sly, 'summary.json'), JSON.stringify(s2));
  refusedWith(() => recordRun(dir, state, 'smoke', sly), /not a plain file name/);
  const sum = runDir(t, [{ file: 'server/m1.test.js', text: tap(3) }]);
  const s3 = JSON.parse(fs.readFileSync(path.join(sum, 'summary.json'), 'utf8'));
  s3.total_pass = 4;
  fs.writeFileSync(path.join(sum, 'summary.json'), JSON.stringify(s3));
  refusedWith(() => recordRun(dir, state, 'smoke', sum), /do not add up/);
  assert.deepStrictEqual(fs.existsSync(path.join(dir, 'tests')) ? fs.readdirSync(path.join(dir, 'tests')) : [], [], 'a refusal copies nothing');
});

test('a green run is copied into the working directory, summary, logs and outs, so a later run cannot change it', (t) => {
  const { dir, state } = work(t);
  const run = runDir(t, [{ file: 'server/m1.test.js', text: tap(10) }, { file: 'server/m2.test.js', text: tap(5) }]);
  const entry = recordRun(dir, state, 'smoke', run, 'node scripts/testdb-smoke.js --tap-dir x');
  assert.strictEqual(entry.type, 'smoke');
  assert.strictEqual(entry.pass, 15);
  assert.strictEqual(entry.command, 'node scripts/testdb-smoke.js --tap-dir x');
  assert.strictEqual(entry.log, 'tests/smoke-1/summary.json');
  assert.deepStrictEqual(entry.suites.map((s) => [s.file, s.pass, s.fail]), [['server/m1.test.js', 10, 0], ['server/m2.test.js', 5, 0]]);
  for (const s of entry.suites) assert.ok(fs.existsSync(path.join(dir, s.log)), s.log);
  fs.writeFileSync(path.join(run, 'summary.json'), '{}');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, entry.log), 'utf8')).total_pass, 15);
});

test('a log needs a TAP summary, no failure and at least one test; a green log is copied and named', (t) => {
  const { dir, state } = work(t);
  const logs = tmpDir(t, 'logs');
  const w = (name, text) => {
    fs.writeFileSync(path.join(logs, name), text);
    return path.join(logs, name);
  };
  refusedWith(() => recordLog(dir, state, w('a.log', `${MARK}\n`)), /no TAP summary/);
  refusedWith(() => recordLog(dir, state, w('b.log', tap(2, 1))), /1 failing/);
  refusedWith(() => recordLog(dir, state, w('c.log', tap(0))), /ran no test/);
  refusedWith(() => recordLog(dir, state, path.join(logs, 'nope.log')), /cannot read the log/);
  const entry = recordLog(dir, state, w('scripts-lib-receipt.test.js.ab12cd.log', tap(7)), 'node --test scripts/lib/receipt.test.js');
  assert.strictEqual(entry.type, 'log');
  assert.strictEqual(entry.pass, 7);
  assert.strictEqual(entry.fail, 0);
  assert.strictEqual(entry.name, 'scripts-lib-receipt.test.js');
  assert.strictEqual(entry.file, 'scripts/lib/receipt.test.js', 'the one suite the command names');
  assert.strictEqual(entry.command, 'node --test scripts/lib/receipt.test.js');
  assert.strictEqual(recordLog(dir, state, w('two.log', tap(1)), 'node --test ./a.test.js b.test.js').file, null, 'two suites name no one file');
  assert.strictEqual(recordLog(dir, state, w('none.log', tap(1))).file, null);
  assert.match(entry.read_from, /# pass 7/);
  assert.strictEqual(fs.readFileSync(path.join(dir, entry.log), 'utf8'), tap(7));
});

test('a client build is recorded with its exit code, green or not, and its log copied', (t) => {
  const { dir, state } = work(t);
  const logs = tmpDir(t, 'build');
  const log = path.join(logs, 'client-build.log');
  fs.writeFileSync(log, `Compiled successfully. ${MARK}\n`);
  const green = recordBuild(dir, state, log, 0, 'cd client && CI=true npx react-scripts build');
  assert.deepStrictEqual([green.type, green.ok, green.exit, green.command], ['build', true, 0, 'cd client && CI=true npx react-scripts build']);
  assert.strictEqual(fs.readFileSync(path.join(dir, green.log), 'utf8'), `Compiled successfully. ${MARK}\n`);
  state.tests.push(green);
  const red = recordBuild(dir, state, log, 1);
  assert.deepStrictEqual([red.ok, red.exit, red.command], [false, 1, null]);
  assert.notStrictEqual(red.log, green.log);
  refusedWith(() => recordBuild(dir, state, path.join(logs, 'nope.log'), 0), /cannot read the build log/);
});

test('a client build is green only on exit 0, a compile success line and no Failed to compile in its log', (t) => {
  const { dir, state } = work(t);
  const logs = tmpDir(t, 'build-log');
  const cases = [
    [`Creating an optimized production build...\nCompiled successfully. ${MARK}\n`, 0, true, null],
    ['Compiled with warnings.\n', 0, true, null],
    [`Treating warnings as errors because process.env.CI = true.\nFailed to compile. ${MARK}\n`, 0, false, 'exit 0, but the log says Failed to compile'],
    ['Compiled successfully.\nFailed to compile.\n', 0, false, 'exit 0, but the log says Failed to compile'],
    ['Creating an optimized production build...\n', 0, false, 'exit 0, but the log has no compile success line'],
    ['Compiled successfully.\n', 1, false, 'exit 1'],
  ];
  cases.forEach(([text, exit, okay, why], i) => {
    const log = path.join(logs, `b${i}.log`);
    fs.writeFileSync(log, text);
    const e = recordBuild(dir, state, log, exit);
    assert.deepStrictEqual([e.ok, e.why], [okay, why], text);
    assert.ok(!JSON.stringify([e.why, e.read_from]).includes(MARK));
  });
});
