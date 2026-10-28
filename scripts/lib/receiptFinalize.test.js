'use strict';

// Tests for scripts/lib/receiptFinalize.js (instruction rewrite step 2, lane
// receipt-lib): finalize's validation as pure functions, fed the state, the
// report texts and the git facts the CLI gathered. Nothing here touches git,
// the disk or the dev database.

const { test } = require('node:test');
const assert = require('node:assert');

const F = require('./receiptFinalize');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const T = 'c'.repeat(40);
const KEY = 'd'.repeat(40);
const FILES = ['server/a.js', 'server/b.js'];

function table(rows) {
  return ['| file | verdict | note |', '|---|---|---|', ...rows.map(([f, v, n = '']) => `| ${f} | ${v} | ${n} |`), ''].join('\n');
}

function passing(files = FILES) {
  return table(files.map((f) => [f, 'pass']));
}

// A working state with one stored report per lens (first passes, stored at T).
function state(reports, extra = {}) {
  return {
    version: 1,
    state: 'working',
    name: 'lane',
    mode: 'lane',
    branch: 'lane',
    commit: null,
    created_at: '2026-10-20T00:00:00.000Z',
    reports: reports.map(([file, lens, pass = 0]) => ({ file, lens, pass, part: null, tip: T, main: A, at: '2026-10-20T00:00:01.000Z' })),
    triage: {},
    tests: [{ type: 'suites', pass: 1, fail: 0, suites: [], tip: T, head: T }],
    externals: {},
    ...extra,
  };
}

// The facts of a lane whose base is main (every ancestry fact proven).
function git(extra = {}) {
  return { base: A, reviewed: A, main: A, baseOnMain: true, mergeBase: A, baseOnTip: true, tip: T, key: KEY, files: FILES, problems: [], ...extra };
}

// The facts the CLI gathers; readBase (the base each report was read on,
// merge-base(main, tip)) defaults to the base for every stored report.
function input(over = {}) {
  const i = {
    name: 'lane',
    kind: 'lane',
    tier: 'B',
    state: state([['seams.md', 'seams']]),
    texts: { 'seams.md': passing() },
    select: { tier: 'B' },
    git: git(),
    flags: { notAFix: 'a feature' },
    now: '2026-10-20T01:00:00.000Z',
    ...over,
  };
  if (!i.git.readBase) i.git = { ...i.git, readBase: Object.fromEntries(i.state.reports.map((r) => [`${r.main} ${r.tip}`, i.git.base])) };
  // tiers_by_file, when the selection names none, maps the diff's files to its tier.
  if (i.select && !Object.prototype.hasOwnProperty.call(i.select, 'tiers_by_file')) {
    i.select = { ...i.select, tiers_by_file: Object.fromEntries((i.git.files || []).map((f) => [f, i.select.tier])) };
  }
  // The tier finalize computes, when the facts name none: the selection's.
  if (!Object.prototype.hasOwnProperty.call(i.git, 'computedTier')) {
    const sel = i.select && i.select.tiers_by_file && typeof i.select.tiers_by_file === 'object' ? i.select.tiers_by_file : {};
    i.git = { ...i.git, computedTier: (i.select && i.select.tier) || i.tier, computedTiers: { ...sel }, computedFloors: [] };
  }
  return i;
}

test('validate passes a clean tier B lane and builds its receipt', () => {
  const { problems, receipt } = F.validate(input());
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(receipt.key, KEY);
  assert.strictEqual(receipt.kind, 'lane');
  assert.strictEqual(receipt.tip, T);
  assert.strictEqual(receipt.base, A);
  assert.strictEqual(receipt.timestamp, '2026-10-20T01:00:00.000Z');
  assert.deepStrictEqual(receipt.lenses.map((l) => [l.name, l.passes]), [['seams', ['seams.md']]]);
  assert.deepStrictEqual(receipt.coverage, { files_in_diff: FILES, files_with_verdicts: FILES, not_reached: [], allowed_not_reached: false });
  assert.deepStrictEqual(receipt.externals.codex, { state: 'not_run', reason: 'not required at tier B' });
});

test('validate names each problem: a missing floor lens, a file not reached, an untriaged finding', () => {
  const st = state([['seams.md', 'seams']]);
  const text = `- H1 \`server/a.js:3\` A defect. Check: SEAM-1.\n\n${table([['server/a.js', 'finding', 'H1']])}`;
  const { problems } = F.validate(input({ tier: 'hinge', state: st, texts: { 'seams.md': text } }));
  assert.ok(problems.some((p) => /^lenses: access-egress was selected and has no report$/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /^coverage: 1 file\(s\) not reached \(seams: server\/b\.js\)/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /^triage: 1 finding\(s\) untriaged \(seams\.md H1\)/.test(p)), problems.join('\n'));
});

test('--allow-not-reached admits a file only when a --pass report of its lens lists it not reached', () => {
  const run = (later, parts = []) => {
    const st = state([['seams.md', 'seams'], ...parts.map((_, i) => [`seams.part-${i + 2}.md`, 'seams']), ...later.map((_, i) => [`seams.pass-${i + 1}.md`, 'seams', i + 1])]);
    const texts = { 'seams.md': passing(['server/a.js']), ...Object.fromEntries(parts.map((x, i) => [`seams.part-${i + 2}.md`, x])), ...Object.fromEntries(later.map((x, i) => [`seams.pass-${i + 1}.md`, x])) };
    return F.validate(input({ state: st, texts, flags: { notAFix: 'x', allowNotReached: true } })).problems.filter((p) => /^coverage:/.test(p));
  };
  assert.match(run([])[0], /^coverage: --allow-not-reached admits a file only after its one re-dispatch missed it too, a --pass report of its lens with a not reached row for it; none for seams: server\/b\.js/);
  assert.deepStrictEqual(run([table([['server/b.js', 'not reached', 'budget']])]), [], 'a re-pass that lists it not reached');
  // A re-pass of another file, or a malformed one, is no evidence the file was re-dispatched.
  assert.strictEqual(run([table([['server/a.js', 'pass']])]).length, 1, 'a re-pass that leaves it out');
  assert.strictEqual(run(['no table\n']).length, 1, 'a malformed re-pass');
  assert.strictEqual(run([], [table([['server/b.js', 'not reached', 'budget']])]).length, 1, 'a part is not a re-dispatch');
});

test("select.json's tiers_by_file must name exactly the diff's files, the generated docs aside", () => {
  const run = (tiers) => F.validate(input({ select: { tier: 'B', tiers_by_file: tiers } })).problems.filter((p) => /^select:/.test(p));
  assert.deepStrictEqual(run({ 'server/a.js': 'B', 'server/b.js': 'B', 'README.md': 'docs', 'ARCHITECTURE.md': 'docs' }), []);
  assert.deepStrictEqual(run({ 'server/a.js': 'B' }), ['select: tiers_by_file does not match the diff (not in it: server/b.js); run review-select again at the final tip']);
  assert.deepStrictEqual(run({ 'server/a.js': 'B', 'server/b.js': 'B', 'server/c.js': 'A' }), ['select: tiers_by_file does not match the diff (not in the diff: server/c.js); run review-select again at the final tip']);
  const absent = input();
  delete absent.select.tiers_by_file;
  assert.ok(F.validate(absent).problems.some((p) => p === 'select: tiers_by_file does not match the diff (not in it: server/a.js, server/b.js); run review-select again at the final tip'));
});

test('the merge and the fixed-finding clearing follow storage order (seq), not the --pass number', () => {
  const texts = {
    'seams.md': `- H1 \`server/a.js:1\` One. Check: SEAM-1.\n\n${table([['server/a.js', 'finding', 'H1'], ['server/b.js', 'pass']])}`,
    'seams.pass-2.md': `- H2 \`server/a.js:2\` Two. Check: SEAM-1.\n\n${table([['server/a.js', 'finding', 'H2']])}`,
    'seams.pass-1.md': table([['server/a.js', 'pass']]),
  };
  const run = (order) => {
    const st = state(order.map((f) => [f, 'seams', Number((/pass-(\d)/.exec(f) || [0, 0])[1])]));
    st.reports.forEach((r, i) => { r.seq = i + 1; });
    st.triage = { 'seams.md#H1': { status: 'fixed' }, 'seams.pass-2.md#H2': { status: 'fixed' } };
    return F.lensSummary(st, texts, 'seams');
  };
  // pass-2 stored before pass-1: pass-1 is the later read.
  const late = run(['seams.md', 'seams.pass-2.md', 'seams.pass-1.md']);
  assert.deepStrictEqual(late.entries.map((e) => e.file), ['seams.md', 'seams.pass-2.md', 'seams.pass-1.md']);
  assert.deepStrictEqual([late.merged['server/a.js'].verdict, late.merged['server/a.js'].report], ['pass', 'seams.pass-1.md']);
  assert.deepStrictEqual(late.fixedNoRepass, []);
  // Stored in number order: pass-2's finding is the latest read and nothing clears it.
  const inOrder = run(['seams.md', 'seams.pass-1.md', 'seams.pass-2.md']);
  assert.strictEqual(inOrder.merged['server/a.js'].verdict, 'finding');
  assert.deepStrictEqual(inOrder.fixedNoRepass.map((f) => `${f.report} ${f.id}`), ['seams.pass-2.md H2']);
});

test('lensSummary counts triage per report and finding, and merges the passes in order', () => {
  const st = state([['money.md', 'money'], ['money.pass-1.md', 'money', 1]]);
  st.triage = { 'money.md#H1': { status: 'fixed' }, 'money.md#M2': { status: 'rejected' } };
  const texts = {
    'money.md': `- H1 \`server/a.js:1\` One. Check: MON-1.\n- M2 \`server/b.js:2\` Two. Check: MON-2.\n\n${table([['server/a.js', 'finding', 'H1'], ['server/b.js', 'finding', 'M2']])}`,
    'money.pass-1.md': table([['server/a.js', 'pass']]),
  };
  const s = F.lensSummary(st, texts, 'money');
  assert.deepStrictEqual([s.raised, s.confirmed, s.fixed, s.rejected, s.untriaged.length], [2, 1, 1, 1, 0]);
  assert.strictEqual(s.merged['server/a.js'].verdict, 'pass');
  assert.strictEqual(s.merged['server/b.js'].verdict, 'finding');
  assert.deepStrictEqual(s.entries.map((e) => e.file), ['money.md', 'money.pass-1.md']);
});

test('readSelect reads the snake_case shape and names every problem', () => {
  const { select, problems } = F.readSelect({
    tier: 'B',
    label: 'B',
    tiers_by_file: { 'server/a.js': 'B' },
    floors: ['seams'],
    lenses: [{ name: 'seams', fired_because: ['floor'], forecast: true }, { name: 'business-time', fired_because: ['business-time.current-date'] }],
    unforecast_lenses: ['business-time'],
    externals: false,
    verify: false,
    tests: { smoke: false, suites: ['server/a.test.js'], client_build: false },
    collapse: false,
    refuse_quick_fix: false,
  });
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(select.tier, 'B');
  assert.deepStrictEqual(select.lenses.map((l) => [l.name, l.fired_because, l.forecast]), [['seams', ['floor'], true], ['business-time', ['business-time.current-date'], false]]);
  assert.deepStrictEqual(select.unforecast, ['business-time']);
  assert.deepStrictEqual(select.tests, { smoke: false, suites: ['server/a.test.js'], client_build: false });
  assert.deepStrictEqual(F.readSelect([1]).problems, ['select: select.json is not an object']);
});

test('readSelect refuses no tier, camelCase keys, unknown lens names and a lens with no reason', () => {
  const p = (raw) => F.readSelect(raw).problems;
  assert.ok(p({ lenses: [] }).some((x) => /select: no tier/.test(x)));
  assert.ok(p({ tier: 'Z' }).some((x) => /tier is not one of/.test(x)));
  assert.ok(p({ tier: 'B', tiersByFile: {} }).some((x) => /snake_case.*tiersByFile/.test(x)));
  assert.ok(p({ tier: 'B', lenses: [{ name: 'seams', firedBecause: ['floor'] }] }).some((x) => /snake_case.*firedBecause/.test(x)));
  assert.ok(p({ tier: 'B', tests: { clientBuild: true } }).some((x) => /snake_case.*clientBuild/.test(x)));
  assert.ok(p({ tier: 'B', lenses: [{ name: 'moneyy', fired_because: ['x'] }] }).some((x) => /lenses names a lens that does not exist/.test(x)));
  assert.ok(p({ tier: 'B', floors: ['moneyy'] }).some((x) => /floors names a lens that does not exist/.test(x)));
  assert.ok(p({ tier: 'B', unforecast_lenses: ['moneyy'] }).some((x) => /unforecast_lenses names a lens that does not exist/.test(x)));
  assert.ok(p({ tier: 'B', lenses: [{ name: 'seams' }] }).some((x) => /seams has no fired_because/.test(x)));
  assert.ok(p({ tier: 'B', lenses: [{ name: 'seams', fired_because: 'floor' }] }).some((x) => /seams has no fired_because/.test(x)));
  assert.ok(p({ tier: 'B', lenses: [{ name: 'seams', fired_because: ['floor'], forecast: 'yes' }] }).some((x) => /forecast is not true or false/.test(x)));
  assert.ok(p({ tier: 'B', verify: 'yes' }).some((x) => /verify is not true or false/.test(x)));
});

test("select.json's optional tip must be the final tip (review 4, L2)", () => {
  const run = (select, g = git()) => F.validate(input({ select: { tier: 'B', ...select }, git: g })).problems.filter((p) => /^select:/.test(p));
  assert.deepStrictEqual(run({}), [], 'absent until review-tooling writes it');
  assert.deepStrictEqual(run({ tip: T }), []);
  assert.deepStrictEqual(run({ tip: A }), ['select: select.json was computed at aaaaaaa; the tip is ccccccc: run review-select again']);
  assert.deepStrictEqual(run({ tip: 'ccccccc' }), ['select: tip is not a full commit id']);
  assert.deepStrictEqual(F.readSelect({ tier: 'B', tip: T }).select.tip, T);
  // A quick fix's tip is HEAD; a commit review's, the commit.
  const qf = F.validate(input({ kind: 'quick-fix', state: state([['seams.md', 'seams']], { mode: 'quick-fix' }), select: { tier: 'B', tip: B }, git: git({ head: A, tip: A }) })).problems;
  assert.ok(qf.includes('select: select.json was computed at bbbbbbb; the tip is aaaaaaa: run review-select again'), qf.join('\n'));
});

test('finalize needs --select for the lane, quick-fix and commit kinds, never for comment-only', () => {
  const noSelect = F.validate(input({ select: null })).problems;
  assert.ok(noSelect.some((p) => /^select: --kind lane needs --select <select\.json>/.test(p)), noSelect.join('\n'));
  const commentOnly = F.validate(input({ kind: 'comment-only', select: null, state: state([]), texts: {}, flags: { proof: { text: Buffer.from('p') } } })).problems;
  assert.ok(!commentOnly.some((p) => /^select:/.test(p)), commentOnly.join('\n'));
});

test('forecast is a boolean and fired_because never says not selected', () => {
  const st = state([['seams.md', 'seams'], ['client.md', 'client'], ['business-time.md', 'business-time']]);
  const texts = { 'seams.md': passing(), 'client.md': passing(), 'business-time.md': passing() };
  const select = { tier: 'B', lenses: [{ name: 'business-time', fired_because: ['business-time.current-date'] }] };
  const { problems, receipt } = F.validate(input({ state: st, texts, select }));
  assert.deepStrictEqual(problems, []);
  const by = Object.fromEntries(receipt.lenses.map((l) => [l.name, l]));
  assert.deepStrictEqual([by.seams.fired_because, by.seams.forecast], [['floor'], false]);
  assert.deepStrictEqual([by['business-time'].fired_because, by['business-time'].forecast], [['business-time.current-date'], false]);
  assert.deepStrictEqual([by.client.fired_because, by.client.forecast], [[], false]);
  for (const l of receipt.lenses) assert.strictEqual(typeof l.forecast, 'boolean');
});

test('the selection can require verify, the externals, the smoke and the reached suites below tier A', () => {
  const st = state([['seams.md', 'seams']], { tests: [] });
  const select = { tier: 'C', verify: true, externals: true, tests: { smoke: true, suites: ['server/a.test.js'] } };
  const { problems } = F.validate(input({ tier: 'C', state: st, select }));
  for (const re of [/^verify: select\.json needs the verify pass/, /^externals: select\.json records codex/, /^externals: select\.json records gemini/,
    /^tests: no money smoke recorded; select\.json needs one/, /^tests: no reached-suites run recorded; select\.json needs one/]) {
    assert.ok(problems.some((p) => re.test(p)), `${re}\n${problems.join('\n')}`);
  }
  const qf = F.validate(input({ state: state([['seams.md', 'seams']], { mode: 'quick-fix' }), kind: 'quick-fix', select: { tier: 'B', refuse_quick_fix: true }, git: git({ head: A }) })).problems;
  assert.ok(qf.some((p) => /^tier: select\.json computes a tier A file; tier A is a lane/.test(p)), qf.join('\n'));
});

test('a report read on another base is refused unless --stale-base, which needs seams stored under the overlap snapshot', () => {
  const M1 = 'e'.repeat(40);
  const T0 = 'f'.repeat(40);
  const st = state([['seams.md', 'seams'], ['money.md', 'money']]);
  const texts = { 'seams.md': passing(), 'money.md': passing() };
  const facts = (o) => git({ main: M1, baseOnMain: true, reviewedOnMain: true, mergeBase: A, baseOnTip: true, ...o });
  const run = (g, flags = {}, s = st) => F.validate(input({ state: s, texts, git: g, flags: { notAFix: 'x', ...flags } })).problems.filter((p) => /^(main|stale-base):/.test(p));
  // Read at a newer main whose merge-base with the tip is still the base: the same diff, accepted.
  const newer = state([['seams.md', 'seams'], ['money.md', 'money']]);
  newer.reports.forEach((r) => { r.main = M1; });
  assert.deepStrictEqual(run(facts({ readBase: { [`${M1} ${T}`]: A } }), {}, newer), []);
  // Read on an older base (the lane was rebased after it); main changed no diff file since it.
  const older = facts({ base: M1, reviewed: M1, mergeBase: M1, readBase: { [`${A} ${T}`]: A }, olderBase: { [A]: true }, overlapFiles: { [A]: [] } });
  const plain = run(older);
  assert.deepStrictEqual(plain.length, 2, plain.join('\n'));
  assert.match(plain[0], /^main: seams\.md was read on base aaaaaaa \(main aaaaaaa\), not the base eeeeeee: the lane moved onto a newer main after it/);
  assert.match(run(older, { staleBase: true })[0], /^stale-base: seams's latest pass \(seams\.md\) is not the overlap pass against main eeeeeee; run position --overlap eeeeeee, then seams --pass <n>$/);
  const overlap = state([['seams.md', 'seams'], ['money.md', 'money'], ['seams.pass-1.md', 'seams', 1]]);
  overlap.reports[2].main = M1;
  overlap.reports[2].overlap = M1;
  overlap.reports[2].tip = T0;
  const og = { ...older, readBase: { ...older.readBase, [`${M1} ${T0}`]: M1 }, changedSince: { [T0]: [] }, landedSensitive: false };
  assert.deepStrictEqual(F.validate(input({ state: overlap, texts: { ...texts, 'seams.pass-1.md': passing() }, git: og, flags: { notAFix: 'x', staleBase: true } })).problems, []);
  // A base git could not name, or one that is not older, is refused even with --stale-base.
  assert.match(run(facts({ base: M1, reviewed: M1, mergeBase: M1, readBase: { [`${A} ${T}`]: null } }), { staleBase: true })[0], /^main: git could not say which base seams\.md was read on/);
  const notOlder = run(facts({ base: M1, reviewed: M1, mergeBase: M1, readBase: { [`${A} ${T}`]: A }, olderBase: { [A]: false } }), { staleBase: true });
  assert.ok(notOlder.some((p) => /^main: seams\.md was read on base aaaaaaa, which is neither the base eeeeeee nor an older main/.test(p)), notOlder.join('\n'));
  const noSeams = state([['money.md', 'money']]);
  assert.ok(F.validate(input({ state: noSeams, texts, git: { ...older, readBase: { [`${A} ${T}`]: A } }, flags: { notAFix: 'x', staleBase: true } })).problems.some((p) => /^stale-base: .*seams has no report/.test(p)));
  // A commit review reads parent..commit: main is not its base.
  assert.deepStrictEqual(F.validate(input({ kind: 'commit', state: state([['seams.md', 'seams']], { mode: 'commit' }), git: git({ parent: A, readBase: {} }) })).problems, []);
});

test('validate records stale_base: a lane rebased onto main B, its first pass read on the older base A', () => {
  const T0 = 'f'.repeat(40);
  // The lane at T0 on base A, rebased onto B (tip T): seams.md read before, the overlap pass after.
  const g = git({ base: B, reviewed: B, main: B, mergeBase: B, baseOnTip: true, baseOnMain: true, reviewedOnMain: true,
    readBase: { [`${A} ${T0}`]: A, [`${B} ${T}`]: B }, olderBase: { [A]: true }, changedSince: { [T0]: [] }, landedSensitive: false });
  const st = state([['seams.md', 'seams'], ['seams.pass-1.md', 'seams', 1]]);
  st.reports[0].tip = T0;
  st.reports[1].main = B;
  st.reports[1].overlap = B;
  const texts = { 'seams.md': passing(), 'seams.pass-1.md': passing() };
  assert.ok(F.validate(input({ state: st, texts, git: g })).problems.some((p) => /^main: seams\.md was read on base aaaaaaa/.test(p)), 'an older base needs --stale-base');
  const { problems, receipt } = F.validate(input({ state: st, texts, git: g, flags: { notAFix: 'x', staleBase: true } }));
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual([receipt.stale_base, receipt.base, receipt.reviewed_against], [true, B, B]);
  assert.strictEqual(F.validate(input()).receipt.stale_base, false);
  // A base that is not --reviewed-against is refused, the overlap pass notwithstanding.
  const notRebased = F.validate(input({ state: st, texts, git: { ...g, base: A, mergeBase: A }, flags: { notAFix: 'x', staleBase: true } })).problems;
  assert.ok(notRebased.some((p) => /^stale-base: --reviewed-against bbbbbbb is not the base aaaaaaa; .*rebase onto bbbbbbb first/.test(p)), notRebased.join('\n'));
});

test('a lane file whose verdict was read before a later commit changed it is stale until its lens re-passes it', () => {
  const T0 = 'f'.repeat(40);
  const st = state([['seams.md', 'seams']]);
  st.reports[0].tip = T0;
  const stale = (changedSince, reports = st) => F.validate(input({ state: reports, git: git({ changedSince }) })).problems.filter((p) => /^stale:/.test(p));
  const one = stale({ [T0]: ['server/a.js', 'README.md'] });
  assert.strictEqual(one.length, 1, one.join('\n'));
  assert.match(one[0], /^stale: seams read server\/a\.js before a later change to it/);
  assert.doesNotMatch(one[0], /server\/b\.js/);
  assert.deepStrictEqual(stale({ [T0]: [] }), []);
  assert.match(stale({})[0], /server\/a\.js, server\/b\.js/, 'a tip git could not diff leaves every file it gave stale');
  const repassed = state([['seams.md', 'seams'], ['seams.pass-1.md', 'seams', 1]]);
  repassed.reports[0].tip = T0;
  const texts = { 'seams.md': passing(), 'seams.pass-1.md': passing(['server/a.js']) };
  assert.deepStrictEqual(F.validate(input({ state: repassed, texts, git: git({ changedSince: { [T0]: ['server/a.js'] } }) })).problems, []);
  const noTip = state([['seams.md', 'seams']]);
  noTip.reports[0].tip = null;
  assert.strictEqual(stale({}, noTip).length, 1);
  assert.deepStrictEqual(F.validate(input({ state: state([['seams.md', 'seams']], { mode: 'commit' }), kind: 'commit', git: git({ parent: A }) })).problems, []);
});

test("a quick fix needs every lens's latest report, and verify's, read at the finalize-time staged tree", () => {
  const T1 = '1'.repeat(40);
  const T2 = '2'.repeat(40);
  const qf = (reports, trees, changedSince = {}) => {
    const st = state(reports, { mode: 'quick-fix' });
    st.reports.forEach((r, i) => { r.tree = trees[i]; });
    const texts = Object.fromEntries(st.reports.map((r) => [r.file, r.lens === 'verify' ? 'No findings.\n' : passing()]));
    return F.validate(input({ kind: 'quick-fix', state: st, texts, git: git({ head: A, tree: T2, key: T2, changedSince }) })).problems.filter((p) => /^stale:/.test(p));
  };
  assert.deepStrictEqual(qf([['seams.md', 'seams']], [T2]), []);
  const moved = qf([['seams.md', 'seams']], [T1], { [T1]: ['server/a.js'] });
  assert.ok(moved.some((p) => /^stale: the staged tree changed after seams's latest report \(seams\.md\)/.test(p)), moved.join('\n'));
  assert.ok(moved.some((p) => /^stale: seams read server\/a\.js before a later change to it/.test(p)), moved.join('\n'));
  assert.deepStrictEqual(qf([['seams.md', 'seams'], ['seams.pass-1.md', 'seams', 1]], [T1, T2], { [T1]: ['server/b.js'] }).filter((p) => /staged tree/.test(p)), []);
  assert.ok(qf([['seams.md', 'seams'], ['verify.md', 'verify']], [T2, T1]).some((p) => /after verify's latest report \(verify\.md\)/.test(p)));
  assert.ok(qf([['seams.md', 'seams']], [undefined]).some((p) => /after seams's latest report/.test(p)), 'a report with no tree recorded is stale');
});

test("a lane's verify is stale when a later commit changed a diff file after its latest pass", () => {
  const T0 = 'f'.repeat(40);
  const texts = { 'seams.md': passing(), 'verify.md': 'No findings.\n', 'verify.pass-1.md': 'No findings.\n' };
  const run = (changedSince, reports = [['seams.md', 'seams'], ['verify.md', 'verify']]) => {
    const st = state(reports);
    st.reports[1].tip = T0;
    return F.validate(input({ state: st, texts, git: git({ changedSince }) })).problems.filter((p) => /^stale:/.test(p));
  };
  assert.deepStrictEqual(run({ [T0]: ['server/a.js'] }), ["stale: verify's latest pass (verify.md) read the lane before a later change to server/a.js; re-pass verify (--pass <n>)"]);
  assert.deepStrictEqual(run({ [T0]: ['README.md'] }), [], 'a change outside the diff');
  assert.match(run({})[0], /^stale: verify's latest pass \(verify\.md\) read the lane before a later change to server\/a\.js, server\/b\.js;/, 'a tip git could not diff');
  assert.deepStrictEqual(run({ [T0]: ['server/a.js'] }, [['seams.md', 'seams'], ['verify.md', 'verify'], ['verify.pass-1.md', 'verify', 1]]), [], 'a later verify pass at the final tip');
});

test('a report read on an older base counts the diff files main changed since that base as changed (review 5, M1)', () => {
  const T0 = 'f'.repeat(40);
  // The lane at T0 on base A, rebased onto B (tip T); the conflict on a.js resolved to the lane's side, so
  // a.js is byte-identical at T (changedSince {T0: []}) while the diff now reverts main's change to it.
  const g = (overlapFiles) => git({ base: B, reviewed: B, main: B, mergeBase: B, reviewedOnMain: true,
    readBase: { [`${A} ${T0}`]: A, [`${B} ${T}`]: B }, olderBase: { [A]: true }, changedSince: { [T0]: [] }, overlapFiles, landedSensitive: false });
  const st = state([['seams.md', 'seams'], ['verify.md', 'verify'], ['seams.pass-1.md', 'seams', 1]]);
  for (const r of st.reports.slice(0, 2)) r.tip = T0;
  Object.assign(st.reports[2], { main: B, overlap: B });
  const texts = { 'seams.md': passing(), 'verify.md': 'No findings.\n', 'seams.pass-1.md': passing(['server/b.js']) };
  const run = (overlapFiles, s = st) => F.validate(input({ state: s, texts, git: g(overlapFiles), flags: { notAFix: 'x', staleBase: true } })).problems;
  // main changed a.js (in the diff) and m.js (not in it) between A and B.
  assert.deepStrictEqual(run({ [A]: ['server/a.js', 'server/m.js'] }), [
    'stale: seams read server/a.js before a later change to it; re-pass seams on it (--pass <n>)',
    "stale: verify's latest pass (verify.md) read the lane before a later change to server/a.js; re-pass verify (--pass <n>)",
  ]);
  assert.deepStrictEqual(run({ [A]: ['server/m.js'] }), [], 'main changed no diff file');
  // A base git could not diff against reviewed leaves every file that report gave stale.
  assert.match(run({})[0], /^stale: seams read server\/a\.js before a later change to it/);
  assert.match(run(undefined)[1], /^stale: verify's latest pass \(verify\.md\) read the lane before a later change to server\/a\.js, server\/b\.js;/);
  // The same report at the final tip on the older base: no position moved, and a.js is still stale.
  const atFinal = state([['seams.md', 'seams'], ['seams.pass-1.md', 'seams', 1]]);
  Object.assign(atFinal.reports[1], { main: B, overlap: B });
  const gf = { ...g({ [A]: ['server/a.js'] }), readBase: { [`${A} ${T}`]: A, [`${B} ${T}`]: B } };
  assert.deepStrictEqual(F.validate(input({ state: atFinal, texts, git: gf, flags: { notAFix: 'x', staleBase: true } })).problems, ['stale: seams read server/a.js before a later change to it; re-pass seams on it (--pass <n>)']);
  // seams re-reads a.js and verify re-runs on the base: accepted.
  const repassed = state([['seams.md', 'seams'], ['verify.md', 'verify'], ['seams.pass-1.md', 'seams', 1], ['seams.pass-2.md', 'seams', 2], ['verify.pass-1.md', 'verify', 1]]);
  for (const r of repassed.reports.slice(0, 2)) r.tip = T0;
  for (const r of repassed.reports.slice(2)) Object.assign(r, { main: B, overlap: B });
  const all = { ...texts, 'seams.pass-2.md': passing(['server/a.js']), 'verify.pass-1.md': 'No findings.\n' };
  assert.deepStrictEqual(F.validate(input({ state: repassed, texts: all, git: g({ [A]: ['server/a.js'] }), flags: { notAFix: 'x', staleBase: true } })).problems, []);
});

test('a verify report is read findings-only; one with an id read twice blocks finalize', () => {
  const st = state([['seams.md', 'seams'], ['verify.md', 'verify']]);
  st.triage = { 'verify.md#H1': { status: 'rejected' } };
  const clean = { 'seams.md': passing(), 'verify.md': '- H1 `server/a.js:5` x. Against: money math.\n' };
  const ok = F.validate(input({ state: st, texts: clean }));
  assert.deepStrictEqual(ok.problems, []);
  assert.deepStrictEqual([ok.receipt.verify.run, ok.receipt.verify.raised, ok.receipt.verify.rejected], [true, 1, 1]);
  const twice = { ...clean, 'verify.md': '- H1 `server/a.js:5` x. Against: a.\n- H1 `server/a.js:6` y. Against: b.\n' };
  const { problems } = F.validate(input({ state: st, texts: twice }));
  assert.ok(problems.some((p) => /^verify: verify\.md is malformed \(1 problem\(s\)\)/.test(p)), problems.join('\n'));
  // A heading-form finding is not read as 0 findings: it blocks too.
  const heading = F.validate(input({ state: state([['seams.md', 'seams'], ['verify.md', 'verify']]), texts: { ...clean, 'verify.md': '### H1 `server/a.js:5` x. Against: a.\n' } })).problems;
  assert.ok(heading.some((p) => /^verify: verify\.md is malformed \(1 problem\(s\)\); a finding read twice or in a form the reading misses escapes triage/.test(p)), heading.join('\n'));
});

test('a verify report whose finding escapes the reading blocks finalize: in a fence, a two-id cell, a bold id with no ticks, an id in parentheses (review 4, M3)', () => {
  const st = state([['seams.md', 'seams'], ['verify.md', 'verify']]);
  const forms = [
    '```\n- H1 `server/a.js:5` x. Against: money math.\n```\n',
    '| H1, H2 | `server/a.js:5` | x. Against: money math. |\n',
    '- **H1** server/a.js:5 x. Against: money math.\n',
    '- (H1) `server/a.js:5` x. Against: money math.\n',
    'Verified the fixes.\n',
  ];
  for (const text of forms) {
    const { problems } = F.validate(input({ state: st, texts: { 'seams.md': passing(), 'verify.md': text } }));
    assert.ok(problems.some((p) => /^verify: verify\.md is malformed \(\d+ problem\(s\)\)/.test(p)), `${JSON.stringify(text)}: ${problems.join('\n')}`);
  }
  assert.deepStrictEqual(F.validate(input({ state: st, texts: { 'seams.md': passing(), 'verify.md': 'No findings.\nChecked the fixes: H1 in `server/a.js`.\n' } })).problems, []);
});

test("verify's record is No findings alone on its line: the reviewer forms that go on to name a finding block finalize (review 5, M2)", () => {
  const st = state([['seams.md', 'seams'], ['verify.md', 'verify']]);
  const run = (text) => F.validate(input({ state: st, texts: { 'seams.md': passing(), 'verify.md': text } }));
  for (const text of [
    'No findings on the fixes, but M1 `server/a.js:1` drops the refund label.\n',
    'No findings.\n\nFinding H1 at `server/a.js:3`: drops a cent.\n',
    'No findings. Checked the fixes: H1 in `server/a.js`.\n',
  ]) {
    const { problems, receipt } = run(text);
    assert.strictEqual(receipt, null, JSON.stringify(text));
    assert.ok(problems.some((p) => /^verify: verify\.md is malformed \(\d+ problem\(s\)\)/.test(p)), `${JSON.stringify(text)}: ${problems.join('\n')}`);
  }
  const { receipt } = run('No findings.\nChecked H1 at `server/a.js:12`: the refund label survives the cancel.\n');
  assert.deepStrictEqual([receipt.verify.run, receipt.verify.findings], [true, 0]);
});

test('a finding marked fixed needs a later pass of its lens whose table lists the finding file as pass', () => {
  const first = `- H1 \`server/a.js:1\` One. Check: SEAM-1.\n\n${table([['server/a.js', 'finding', 'H1'], ['server/b.js', 'pass']])}`;
  const fixedNoRepass = (later) => {
    const st = state([['seams.md', 'seams'], ...later.map((_, i) => [`seams.pass-${i + 1}.md`, 'seams', i + 1])]);
    st.triage = { 'seams.md#H1': { status: 'fixed' } };
    const texts = { 'seams.md': first, ...Object.fromEntries(later.map((t, i) => [`seams.pass-${i + 1}.md`, t])) };
    return F.lensSummary(st, texts, 'seams').fixedNoRepass.map((f) => `${f.report} ${f.id} ${f.file}`);
  };
  assert.deepStrictEqual(fixedNoRepass([]), ['seams.md H1 server/a.js']);
  assert.deepStrictEqual(fixedNoRepass([table([['server/b.js', 'pass']])]), ['seams.md H1 server/a.js'], 'a pass that does not list the file');
  assert.deepStrictEqual(fixedNoRepass([table([['server/a.js', 'not reached', 'budget']])]), ['seams.md H1 server/a.js'], 'not reached');
  assert.deepStrictEqual(fixedNoRepass([`- H2 \`server/a.js:2\` Still. Check: SEAM-1.\n\n${table([['server/a.js', 'finding', 'H2']])}`]), ['seams.md H1 server/a.js'], 'still a finding');
  assert.deepStrictEqual(fixedNoRepass([table([['server/b.js', 'pass']]), table([['server/a.js', 'pass']])]), []);
  const st = state([['seams.md', 'seams']]);
  st.triage = { 'seams.md#H1': { status: 'fixed' } };
  const { problems } = F.validate(input({ state: st, texts: { 'seams.md': first } }));
  assert.ok(problems.some((p) => /^triage: seams\.md H1 \(seams\) is marked fixed but no later seams pass lists server\/a\.js as pass \(--pass <n>\)$/.test(p)), problems.join('\n'));
});

test('a verify finding marked fixed needs a later verify pass that raises nothing on its file', () => {
  const run = (later) => {
    const st = state([['verify.md', 'verify'], ...later.map((_, i) => [`verify.pass-${i + 1}.md`, 'verify', i + 1])]);
    st.triage = { 'verify.md#H1': { status: 'fixed' } };
    const texts = { 'verify.md': '- H1 `server/a.js:5` x. Against: money math.\n', ...Object.fromEntries(later.map((t, i) => [`verify.pass-${i + 1}.md`, t])) };
    return F.lensSummary(st, texts, 'verify').fixedNoRepass.length;
  };
  assert.strictEqual(run([]), 1);
  assert.strictEqual(run(['- M1 `server/a.js:9` Still wrong. Against: H1.\n']), 1);
  assert.strictEqual(run(['- M1 `server/b.js:9` Elsewhere. Against: H1.\n']), 0);
  assert.strictEqual(run(['No findings.\n']), 0);
});

// A comment-only proof as scripts/comment-only-proof.js writes it, parsed:
// a range proof of the lane git() describes, every diff file ok.
function rangeProof(extra = {}) {
  return { version: 1, mode: 'range', base: A, tip: T, tree: 'e'.repeat(40), files: FILES.map((f) => ({ path: f, ok: true, reason: null })), ok: true, ...extra };
}

test('comment-only is accepted on a JSON proof of the reviewed diff; its exemptions stand', () => {
  const st = state([], { tests: [] });
  const proof = { json: rangeProof() };
  assert.deepStrictEqual(F.checkKind('lane', 'comment-only'), { ok: true, problems: [] });
  assert.deepStrictEqual(F.checkKind('quick-fix', 'comment-only').ok, true);
  assert.deepStrictEqual(F.checkKind('commit', 'comment-only').ok, false);
  // No problem: it runs no lens, so no lens, verify, externals, tests or failing test is asked of it.
  const { problems, receipt } = F.validate(input({ kind: 'comment-only', tier: 'A', state: st, texts: {}, select: null, flags: { proof } }));
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(receipt.kind, 'comment-only');
  assert.strictEqual(receipt.proof, 'proof.json');
  assert.strictEqual(receipt.written_by, 'comment-only proof');
  assert.strictEqual(receipt.not_a_fix, 'comment-only: the proof shows the diff adds nothing but comment lines');
  assert.deepStrictEqual([receipt.lenses, receipt.verify.run, receipt.failing_test_on_old_code], [[], false, null]);
  assert.deepStrictEqual(receipt.externals.codex, { state: 'not_run', reason: 'comment-only: no lens runs (spec 3.7)' });
  // Every other kind keeps them.
  const lane = F.validate(input({ tier: 'A', state: st, texts: {}, select: { tier: 'A' }, flags: {} })).problems;
  for (const re of [/^lenses: money was selected and has no report$/, /^verify: tier A needs the verify pass/, /^externals: tier A records codex/, /^tests: no money smoke recorded/, /^failing test: name the test/]) {
    assert.ok(lane.some((p) => re.test(p)), `${re}\n${lane.join('\n')}`);
  }
});

test('a comment-only proof is refused, one line each, unless it is version 1, ok, the review\'s mode, base and tip or staged tree, and covers the diff', () => {
  const st = state([], { tests: [] });
  const run = (json, extra = {}) => F.validate(input({ kind: 'comment-only', state: st, texts: {}, select: null, flags: { proof: { json } }, ...extra })).problems;
  const S = (c) => c.repeat(7);
  assert.deepStrictEqual(run(rangeProof({ tip: B })), [`proof: tip ${S('b')} is not the review's tip ${S('c')}`]);
  assert.deepStrictEqual(run(rangeProof({ base: B })), [`proof: base ${S('b')} is not the review's base ${S('a')}`]);
  assert.deepStrictEqual(run(rangeProof({ mode: 'staged', tip: null })), ['proof: a staged proof cannot finalize a lane review']);
  assert.deepStrictEqual(run(rangeProof({ mode: 'other' })), ['proof: its mode is neither range nor staged']);
  assert.deepStrictEqual(run(rangeProof({ ok: false })), ['proof: the proof says not comment-only']);
  assert.deepStrictEqual(run(rangeProof({ version: 2 })), ['proof: version 2 is not 1']);
  assert.deepStrictEqual(run(rangeProof({ version: 'x' })), ['proof: version (not a number) is not 1'], 'a value from the proof is never printed');
  assert.deepStrictEqual(run(rangeProof({ base: 'not-a-sha' })), [`proof: base (none) is not the review's base ${S('a')}`]);
  assert.deepStrictEqual(run([]), ['proof: not a proof object']);
  assert.deepStrictEqual(run(rangeProof({ files: 'x' })), ['proof: files is not a list']);
  assert.deepStrictEqual(run(rangeProof({ files: [{ path: 'server/a.js', ok: true }] })), ['proof: server/b.js is not in the proof']);
  assert.deepStrictEqual(run(rangeProof({ files: [{ path: 'server/a.js', ok: true }, { path: 'server/b.js', ok: false }] })), ['proof: server/b.js is not ok in the proof']);
  assert.deepStrictEqual(run(rangeProof({ files: [...rangeProof().files, { path: 'server/b.js', ok: false }] })), ['proof: server/b.js is not ok in the proof'], 'a path listed twice is ok only when every entry is');
  // The generated docs need no place in it: the key leaves them out.
  assert.deepStrictEqual(run(rangeProof(), { git: git({ files: [...FILES, 'README.md'] }) }), []);
  assert.deepStrictEqual(F.validate(input({ kind: 'comment-only', state: st, texts: {}, select: null, flags: { proof: { error: 'not JSON' } } })).problems, ['proof: not JSON']);
  // A quick fix: a staged proof of the staged tree, on the review's base.
  const T2 = '2'.repeat(40);
  const qf = state([], { mode: 'quick-fix', tests: [] });
  const quick = (json) => F.validate(input({ kind: 'comment-only', state: qf, texts: {}, select: null, flags: { proof: { json } }, git: git({ head: A, tree: T2, key: T2 }) })).problems;
  const staged = rangeProof({ mode: 'staged', tip: null, tree: T2 });
  assert.deepStrictEqual(quick(staged), []);
  assert.deepStrictEqual(quick(rangeProof()), ['proof: a range proof cannot finalize a quick fix']);
  assert.deepStrictEqual(quick({ ...staged, tree: KEY }), [`proof: tree ${S('d')} is not the staged tree ${S('2')}`]);
  assert.deepStrictEqual(quick({ ...staged, base: B }), [`proof: base ${S('b')} is not the review's base ${S('a')}`]);
  // --proof with any other kind is refused for that, and its content is not read.
  const lane = F.validate(input({ flags: { notAFix: 'x', proof: { json: rangeProof() } } })).problems;
  assert.deepStrictEqual(lane, ['proof: --proof is only for --kind comment-only']);
});

test('the tier floor holds for comment-only: a --tier below the computed tier is refused, the exemptions stay', () => {
  const st = state([], { tests: [] });
  const g = git({ computedTier: 'A', computedTiers: { 'server/a.js': 'A', 'server/b.js': 'B' }, computedFloors: ['money', 'seams'] });
  const run = (tier) => F.validate(input({ kind: 'comment-only', tier, state: st, texts: {}, select: null, git: g, flags: { proof: { json: rangeProof() } } })).problems;
  assert.deepStrictEqual(run('B'), ['tier: B is lower than the tier sensitive-match computes for the diff, A']);
  assert.deepStrictEqual(run('A'), [], 'no lens, verify, externals, tests or failing test at tier A either');
  const none = F.validate(input({ kind: 'comment-only', tier: 'A', state: st, texts: {}, select: null, git: git({ computedTier: undefined }), flags: { proof: { json: rangeProof() } } })).problems;
  assert.deepStrictEqual(none, ['tier: no computed tier for the diff; finalize computes it itself']);
});

test("a test entry that ran anywhere but the final tip, or a quick fix's final tree, is refused, naming it", () => {
  const T0 = 'f'.repeat(40);
  const run = (tests, extra = {}, g = git()) => F.validate(input({ state: state([['seams.md', 'seams']], { tests, ...extra }), git: g })).problems.filter((p) => /^tests:/.test(p));
  assert.deepStrictEqual(run([{ type: 'suites', log: 'tests/suites-1/summary.json', suites: [], tip: T }]), []);
  assert.deepStrictEqual(run([{ type: 'suites', log: 'tests/suites-1/summary.json', suites: [], tip: T0 }, { type: 'build', log: 'tests/2-b.log', ok: true, exit: 0, tip: T }]),
    ['tests: the suites entry tests/suites-1/summary.json ran at fffffff, the tip is ccccccc; run it again on the final tip']);
  assert.deepStrictEqual(run([{ type: 'suites', log: 'tests/suites-1/summary.json', suites: [] }]), ['tests: the suites entry tests/suites-1/summary.json records no position; record it again after position']);
  const T1 = '1'.repeat(40);
  const T2 = '2'.repeat(40);
  assert.deepStrictEqual(run([{ type: 'log', log: 'tests/1-x.log', pass: 1, fail: 0, tip: A, tree: T1 }], { mode: 'quick-fix' }, git({ head: A, tree: T2, key: T2 })),
    ['tests: the log entry tests/1-x.log ran at tree 1111111, the staged tree is 2222222; run it again on the final tree']);
  assert.deepStrictEqual(run([{ type: 'log', log: 'tests/1-x.log', pass: 1, fail: 0, tip: A, tree: T2 }], { mode: 'quick-fix' }, git({ head: A, tree: T2, key: T2 })), []);
});

test('a client file in the diff, or the selection, requires a client build whose latest run is green', () => {
  const C = ['client/src/x.js'];
  const st = (tests) => state([['client.md', 'client'], ['seams.md', 'seams']], { tests });
  const texts = { 'client.md': passing(C), 'seams.md': passing(C) };
  const run = (tests, select = { tier: 'C' }, files = C) => F.validate(input({ tier: 'C', state: st(tests), texts, select, git: git({ files }) })).problems.filter((p) => /^tests:/.test(p));
  assert.ok(run([]).some((p) => /^tests: no client build recorded; a client\/ file in the diff needs one \(tests <name> --build <log> --exit <code>\)$/.test(p)));
  assert.deepStrictEqual(run([{ type: 'build', ok: true, exit: 0, tip: T }]), []);
  assert.ok(run([{ type: 'build', ok: true, exit: 0, tip: T }, { type: 'build', ok: false, exit: 2, tip: T }]).some((p) => /^tests: the latest client build failed \(exit 2\)/.test(p)));
  assert.deepStrictEqual(run([{ type: 'build', ok: false, exit: 2, tip: T }, { type: 'build', ok: true, exit: 0, tip: T }]), [], 'the latest build is the one that counts');
  const sel = F.validate(input({ state: state([['seams.md', 'seams']]), select: { tier: 'B', tests: { client_build: true } } })).problems;
  assert.ok(sel.some((p) => /^tests: no client build recorded; select\.json needs one/.test(p)), sel.join('\n'));
  const failedAnyway = F.validate(input({ state: state([['seams.md', 'seams']], { tests: [{ type: 'suites', suites: [], tip: T }, { type: 'build', ok: false, exit: 1, tip: T }] }) })).problems;
  assert.ok(failedAnyway.some((p) => /^tests: the latest client build failed \(exit 1\)/.test(p)), 'a failed build is refused even where none is required');
});

test('finalize refuses without the tier it computes, and names each file whose selected tier is not the computed one', () => {
  const tierLines = (g) => F.validate(input({ git: git(g) })).problems.filter((p) => /^(tier|select):/.test(p));
  assert.deepStrictEqual(tierLines({ computedTier: undefined }), ['tier: no computed tier for the diff; finalize computes it itself']);
  assert.deepStrictEqual(tierLines({ computedTier: undefined, problems: ['tier: sensitive-match could not compute the tier of the diff'] }), ['tier: sensitive-match could not compute the tier of the diff']);
  assert.deepStrictEqual(tierLines({ computedTier: 'A', computedTiers: { 'server/a.js': 'A', 'server/b.js': 'B' }, computedFloors: [] }), [
    'tier: B is lower than the tier sensitive-match computes for the diff, A',
    'select: tiers_by_file gives server/a.js (B, computed A) another tier than sensitive-match computes for the diff now; run review-select again at the final tip',
  ]);
  const floors = F.validate(input({ git: git({ computedTier: 'B', computedTiers: { 'server/a.js': 'B', 'server/b.js': 'B' }, computedFloors: ['seams', 'access-egress'] }) })).problems;
  assert.ok(floors.includes('lenses: access-egress was selected and has no report'), floors.join('\n'));
});

test('with --stale-base, a landing range git could not read is refused, never taken as no sensitive path', () => {
  // A lane rebased onto B: seams's overlap pass read at B.
  const st = state([['seams.md', 'seams']]);
  st.reports[0].main = B;
  st.reports[0].overlap = B;
  const g = git({ base: B, reviewed: B, main: B, mergeBase: B, reviewedOnMain: true, readBase: { [`${B} ${T}`]: B } });
  const run = (landedSensitive) => F.validate(input({ state: st, git: { ...g, landedSensitive }, flags: { notAFix: 'x', staleBase: true } })).problems.filter((p) => /^stale-base:/.test(p));
  assert.deepStrictEqual(run(null), ['stale-base: git could not say which files main changed between the base and --reviewed-against bbbbbbb']);
  assert.deepStrictEqual(run(false), []);
  assert.deepStrictEqual(run(true), []);
  // A seams overlap pass that leaves a diff file out, once a sensitive path landed.
  const part = F.validate(input({ state: st, texts: { 'seams.md': passing(['server/a.js']) }, git: { ...g, landedSensitive: true }, flags: { notAFix: 'x', staleBase: true, allowNotReached: true } })).problems;
  assert.ok(part.includes("stale-base: a sensitive path landed on main between the base and --reviewed-against; seams's overlap pass (seams.md) must give every diff file a verdict, and gives none to server/b.js"), part.join('\n'));
});

test("a commit review's test entry counts only when it ran with the checkout's HEAD at the commit", () => {
  const run = (tests) => F.validate(input({ kind: 'commit', state: state([['seams.md', 'seams']], { mode: 'commit', tests }), git: git({ parent: A, readBase: {} }) })).problems;
  assert.deepStrictEqual(run([{ type: 'suites', log: 'tests/suites-1/summary.json', suites: [], tip: T, head: T }]), []);
  assert.deepStrictEqual(run([{ type: 'suites', log: 'tests/suites-1/summary.json', suites: [], tip: T, head: B }]),
    ["tests: the suites entry tests/suites-1/summary.json ran with HEAD at bbbbbbb, not the commit ccccccc; check out the commit and run it again"]);
  assert.deepStrictEqual(run([{ type: 'suites', log: 'tests/suites-1/summary.json', suites: [], tip: T }]),
    ["tests: the suites entry tests/suites-1/summary.json ran with HEAD at (none), not the commit ccccccc; check out the commit and run it again"]);
});
