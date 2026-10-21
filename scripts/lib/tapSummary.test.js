'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parse, sum, logName, outName: outNameOf, smokeSummary } = require('./tapSummary');

// A complete summary block as Node's TAP reporter ends a run: the column-0
// plan line, then `# tests N` and the counts.
const block = (pass, fail) => `1..${pass + fail}\n# tests ${pass + fail}\n# suites 0\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 3\n`;

test('parse reads the TAP summary lines', () => {
  const r = parse('TAP version 13\nok 1 - a\nok 2 - b\n1..2\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 12.5\n');
  assert.deepStrictEqual(r, { pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 12.5, found: true });
});

test('parse: count lines with no plan line before them are not a summary (a top-level diagnostic reads "# pass 9")', () => {
  const witness = 'TAP version 13\n# Subtest: a\nok 1 - a\n  ---\n  duration_ms: 1.07\n  type: \'test\'\n  ...\n# pass 9\n# fail 0\n';
  assert.strictEqual(parse(witness).found, false, JSON.stringify(parse(witness)));
  assert.strictEqual(parse('# pass 9\n').found, false);
  assert.strictEqual(parse('# tests 9\n# pass 9\n# fail 0\n').found, false, 'no plan line');
  assert.strictEqual(parse('1..9\n# pass 9\n# fail 0\n').found, false, 'the block opens with # tests right after the plan');
  assert.strictEqual(parse('  1..9\n# tests 9\n# pass 9\n# fail 0\n').found, false, 'a plan line at column 0 only');
  assert.strictEqual(parse('1..9\n# tests 9\n').found, false, 'a block cut short before its pass and fail lines');
});

// Node's root postRun prints the root's own diagnostics between the plan line and
// the summary (an async-activity warning, a coverage note, the randomize seed);
// they are column-0 lines that start with '# ' and are not count lines, and the
// block still opens after them.
test('parse: root diagnostics between the plan line and the summary do not hide it', () => {
  const r = parse(['TAP version 13', 'ok 1 - a', 'ok 2 - b', '1..2',
    '# generated asynchronous activity after the test ended. This activity created the error "Error: late"',
    '# Warning: a coverage note', '# tests 2', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 7.5', ''].join('\n'));
  assert.deepStrictEqual(r, { pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 7.5, found: true });
});

test('parse reports found: false when there is no summary (a suite that died)', () => {
  const r = parse('TAP version 13\nok 1 - a\n');
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.pass, 0);
  assert.strictEqual(r.fail, 0);
});

test('parse takes the LAST complete summary block when a log holds several', () => {
  const r = parse(`TAP version 13\n${block(1, 1)}ok 1 - again\n${block(5, 0)}`);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.pass, 5);
  assert.strictEqual(r.fail, 0);
  const last = parse(`${block(5, 0)}# pass 9\n# fail 0\n`);
  assert.strictEqual(last.pass, 5, 'count lines after the block, with no plan of their own, open nothing');
});

test('sum totals across summaries and is not found when any is missing', () => {
  const a = parse(block(2, 1));
  const b = parse(block(3, 0));
  assert.deepStrictEqual(sum([a, b]), { pass: 5, fail: 1, cancelled: 0, skipped: 0, todo: 0, duration_ms: 6, found: true });
  assert.strictEqual(sum([a, parse('')]).found, false);
});

test('sum of no summaries is not found (nothing ran is never a pass)', () => {
  assert.strictEqual(sum([]).found, false);
});

const sha6 = (p) => require('node:crypto').createHash('sha1').update(p).digest('hex').slice(0, 6);

test('logName and outName: the flattened path plus 6 hex of the path\'s sha1', () => {
  const { outName } = require('./tapSummary');
  assert.strictEqual(logName('server/utils/good.test.js'), `server-utils-good.test.js.${sha6('server/utils/good.test.js')}.log`);
  assert.strictEqual(outName('server/utils/good.test.js'), `server-utils-good.test.js.${sha6('server/utils/good.test.js')}.out`);
  assert.strictEqual(logName('./scripts/x.test.js'), logName('scripts/x.test.js'), 'a leading ./ names the same file');
});

test('logName and outName are injective: two paths that flatten alike get two names', () => {
  const { outName } = require('./tapSummary');
  const a = 'scripts/a/b-c.test.js';
  const b = 'scripts/a-b/c.test.js';
  assert.notStrictEqual(logName(a), logName(b));
  assert.notStrictEqual(outName(a), outName(b));
});

// The with-key shape of testdb-smoke's summary.json, over a fixture log set, so
// it is covered without running a real smoke (eight minutes of a shared branch).
const LOG_GREEN = 'TAP version 13\nok 1 - a\nok 2 - b\nok 3 - c\n1..3\n# tests 3\n# suites 0\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 40.1\n';
const LOG_RED = 'TAP version 13\nok 1 - a\nnot ok 2 - b\nnot ok 3 - c\n1..3\n# tests 3\n# suites 0\n# pass 1\n# fail 2\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 51\n';
const LOG_DEAD = 'TAP version 13\n# Subtest: a\n'; // killed at the 180 s timeout: no summary

test('smokeSummary: counts from each log, totals, skipped false', () => {
  const s = smokeSummary([
    { file: 'server/routes/a.test.js', text: LOG_GREEN, exitOk: true },
    { file: 'server/utils/b.test.js', text: LOG_RED, exitOk: false },
  ]);
  assert.deepStrictEqual(s, {
    suites: [
      { file: 'server/routes/a.test.js', log: logName('server/routes/a.test.js'), out: outNameOf('server/routes/a.test.js'), pass: 3, fail: 0, found: true, ok: true, exit_ok: true },
      { file: 'server/utils/b.test.js', log: logName('server/utils/b.test.js'), out: outNameOf('server/utils/b.test.js'), pass: 1, fail: 2, found: true, ok: false, exit_ok: false },
    ],
    total_pass: 4,
    total_fail: 2,
    skipped: false,
  });
});

test('smokeSummary: a log with no summary, or a clean log from a suite that exited non-zero, counts as a failure', () => {
  const s = smokeSummary([
    { file: 'server/routes/a.test.js', text: LOG_GREEN, exitOk: true },
    { file: 'server/utils/dead.test.js', text: LOG_DEAD, exitOk: false },
    { file: 'server/utils/odd.test.js', text: LOG_GREEN, exitOk: false },
  ]);
  assert.deepStrictEqual(s.suites[1], { file: 'server/utils/dead.test.js', log: logName('server/utils/dead.test.js'), out: outNameOf('server/utils/dead.test.js'), pass: 0, fail: 1, found: false, ok: false, exit_ok: false });
  assert.deepStrictEqual(s.suites[2], { file: 'server/utils/odd.test.js', log: logName('server/utils/odd.test.js'), out: outNameOf('server/utils/odd.test.js'), pass: 3, fail: 1, found: true, ok: false, exit_ok: false });
  assert.strictEqual(s.total_fail, 2, 'a dead suite never sums to zero');
  assert.strictEqual(s.total_pass, 6);
});

const LOG_CANCELLED = 'TAP version 13\nok 1 - a\nnot ok 2 - slow # timed out\n1..2\n# tests 2\n# suites 0\n# pass 1\n# fail 0\n# cancelled 1\n# skipped 0\n# todo 0\n# duration_ms 220\n';

test('smokeSummary: a cancelled test is a failure even when the suite exited 0', () => {
  const s = smokeSummary([{ file: 'server/utils/c.test.js', text: LOG_CANCELLED, exitOk: true }]);
  assert.deepStrictEqual(s.suites[0], { file: 'server/utils/c.test.js', log: logName('server/utils/c.test.js'), out: outNameOf('server/utils/c.test.js'), pass: 1, fail: 1, found: true, ok: false, exit_ok: true });
  assert.strictEqual(s.total_fail, 1);
});

test('smokeSummary: ok is the verdict and exit_ok the raw exit witness; a suite that exited 0 with no summary is ok false', () => {
  const s = smokeSummary([
    { file: 'server/utils/dead.test.js', text: LOG_DEAD, exitOk: true },
    { file: 'server/utils/zero.test.js', text: '', exitOk: true },
    { file: 'server/utils/green.test.js', text: LOG_GREEN, exitOk: true },
  ]);
  assert.deepStrictEqual(s.suites[0], { file: 'server/utils/dead.test.js', log: logName('server/utils/dead.test.js'), out: outNameOf('server/utils/dead.test.js'), pass: 0, fail: 1, found: false, ok: false, exit_ok: true });
  assert.deepStrictEqual(s.suites[1], { file: 'server/utils/zero.test.js', log: logName('server/utils/zero.test.js'), out: outNameOf('server/utils/zero.test.js'), pass: 0, fail: 1, found: false, ok: false, exit_ok: true });
  assert.deepStrictEqual(s.suites[2], { file: 'server/utils/green.test.js', log: logName('server/utils/green.test.js'), out: outNameOf('server/utils/green.test.js'), pass: 3, fail: 0, found: true, ok: true, exit_ok: true });
  assert.strictEqual(s.total_fail, 2);
});

// ---- suiteArgv: the one way run-suites and testdb-smoke run a suite ----

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');

const fixtureDirs = [];
after(() => {
  for (const d of fixtureDirs) fs.rmSync(d, { recursive: true, force: true });
});

function fixture(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suiteargv-'));
  fixtureDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

function runWith(file) {
  const { suiteArgv } = require('./tapSummary');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // started from node:test, a suite would otherwise report in v8 form, not TAP
  const tapFile = path.join(path.dirname(file), `${path.basename(file)}.tap`);
  const r = spawnSync(process.execPath, suiteArgv(file, { tapFile }), { encoding: 'utf8', timeout: 20000, env });
  const witness = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, 'utf8') : '';
  return { status: r.status, stdout: r.stdout, summary: parse(witness) };
}

test('suiteArgv: preload dotenv, a TAP witness to its file always, a console reporter only when asked, the file last, never --test', () => {
  const { suiteArgv } = require('./tapSummary');
  const preload = require.resolve('dotenv/config');
  const witness = ['--test-reporter=tap', '--test-reporter-destination=/x/s.log'];
  assert.deepStrictEqual(suiteArgv('server/x.test.js', { tapFile: '/x/s.log' }), ['-r', preload, ...witness, 'server/x.test.js']);
  assert.deepStrictEqual(suiteArgv('server/x.test.js', { tapFile: '/x/s.log', console: 'spec' }), ['-r', preload, ...witness, '--test-reporter=spec', '--test-reporter-destination=stdout', 'server/x.test.js']);
  assert.deepStrictEqual(suiteArgv('server/x.test.js', { tapFile: '/x/s.log', console: 'tap' }), ['-r', preload, ...witness, '--test-reporter=tap', '--test-reporter-destination=stdout', 'server/x.test.js']);
  assert.throws(() => suiteArgv('server/x.test.js'), /tapFile/, 'a suite never runs without its TAP witness');
  assert.throws(() => suiteArgv('server/x.test.js', { tapFile: '/x/s.log', console: 'dot' }), /console/);
});

test('suiteArgv: a suite that registers no tests leaves no summary in its witness (never "pass 1")', () => {
  const r = runWith(fixture('zero.test.js', "process.stdout.write('no tests here\\n');\n"));
  assert.strictEqual(r.summary.found, false, JSON.stringify(r.summary));
  assert.strictEqual(r.summary.pass, 0);
});

test('suiteArgv: a suite that calls process.exit(0) mid-file leaves no summary in its witness', () => {
  const r = runWith(fixture('exit0.test.js', "const { test } = require('node:test');\ntest('a', () => {});\ntest('b', async () => { await new Promise((r) => setTimeout(r, 50)); process.exit(0); });\ntest('c', () => {});\n"));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.summary.found, false, JSON.stringify(r.summary));
});

test('suiteArgv: a real witness parses; diagnostics that read "pass 9" before a process.exit(0) are no summary', () => {
  const real = runWith(fixture('real.test.js', "const { test, describe, it } = require('node:test');\ndescribe('d', () => { it('a', () => {}); it('b', () => {}); });\ntest('c', (t) => { t.diagnostic('pass 9'); });\n"));
  assert.strictEqual(real.status, 0);
  assert.deepStrictEqual({ found: real.summary.found, pass: real.summary.pass, fail: real.summary.fail }, { found: true, pass: 3, fail: 0 });
  const forged = runWith(fixture('diag.test.js', "const { test } = require('node:test');\ntest('a', (t) => { t.diagnostic('pass 9'); t.diagnostic('fail 0'); });\ntest('b', async () => { await new Promise((r) => setTimeout(r, 50)); process.exit(0); });\n"));
  assert.strictEqual(forged.status, 0);
  assert.strictEqual(forged.summary.found, false, JSON.stringify(forged.summary));
});

test('suiteArgv: a summary the suite prints on its own stdout never reaches the witness', () => {
  const r = runWith(fixture('fake.test.js', "process.stdout.write('# pass 9\\n# fail 0\\n');\n"));
  assert.match(r.stdout, /# pass 9/);
  assert.strictEqual(r.summary.found, false, JSON.stringify(r.summary));
});

test('suiteArgv: a failing test exits non-zero and a timed-out test exits non-zero with cancelled 1', () => {
  const failing = runWith(fixture('fail.test.js', "const { test } = require('node:test'); const assert = require('node:assert');\ntest('ok', () => {});\ntest('bad', () => assert.ok(false));\n"));
  assert.notStrictEqual(failing.status, 0);
  assert.strictEqual(failing.summary.fail, 1);
  const cancelled = runWith(fixture('cancel.test.js', "const { test } = require('node:test');\ntest('ok', () => {});\ntest('slow', { timeout: 200 }, async () => { await new Promise((r) => setTimeout(r, 1500)); });\n"));
  assert.notStrictEqual(cancelled.status, 0);
  assert.strictEqual(cancelled.summary.cancelled, 1);
  assert.strictEqual(cancelled.summary.fail, 0, 'node reports a timeout as cancelled, not fail');
});

// ---- suiteEnv: the one environment both runners give a suite ----

test('suiteEnv: the process env plus extras, never NODE_TEST_CONTEXT, and process.env untouched', () => {
  const { suiteEnv } = require('./tapSummary');
  const saved = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  try {
    const env = suiteEnv({ DATABASE_URL: 'postgres://unused.invalid/none' });
    assert.strictEqual('NODE_TEST_CONTEXT' in env, false);
    assert.strictEqual(env.DATABASE_URL, 'postgres://unused.invalid/none');
    assert.strictEqual(env.PATH, process.env.PATH);
    assert.strictEqual(process.env.NODE_TEST_CONTEXT, 'child-v8', 'suiteEnv must not change this process');
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = saved;
  }
});

test('defaultConsoleReporter: spec from Node 23 on whatever stdout is; before that spec on a terminal, tap otherwise', () => {
  const { defaultConsoleReporter } = require('./tapSummary');
  assert.strictEqual(defaultConsoleReporter({ isTTY: false }, '24.16.0'), 'spec');
  assert.strictEqual(defaultConsoleReporter({ isTTY: true }, '26.5.0'), 'spec');
  assert.strictEqual(defaultConsoleReporter({ isTTY: true }, '22.1.0'), 'spec');
  assert.strictEqual(defaultConsoleReporter({ isTTY: false }, '22.1.0'), 'tap');
  assert.strictEqual(defaultConsoleReporter({}, '20.0.0'), 'tap');
});
