'use strict';

// node:test suite for scripts/lib/lensTriggers.js (instruction rewrite step 2,
// lane review-tooling): the named triggers of the lens-selection contract,
// selectLenses and forecastDiff. Pure: no git, no database. The cross-check at
// the end reads the nine lens files under .claude/agents/.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LT = require('./lensTriggers');
const SM = require('../sensitive-match');
const { LENSES } = require('./receiptVerdicts');

const REPO = path.resolve(__dirname, '..', '..');
const PLAN = path.join(REPO, 'docs', 'superpowers', 'plans', '2026-10-20-instruction-rewrite-step2.md');

// A unified diff in git's form that adds `lines` to `file` (a new file).
function addDiff(file, lines) {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

function names(selected) {
  return selected.map((l) => l.name);
}

function byName(selected, name) {
  return selected.find((l) => l.name === name);
}

// ---- the constants ------------------------------------------------------------------

test('TRIGGERS has one entry per lens, in the receipt order, and seams has no trigger', () => {
  assert.deepStrictEqual(Object.keys(LT.TRIGGERS), [...LENSES]);
  assert.deepStrictEqual(LT.TRIGGERS.seams, { content: [], paths: [] });
  for (const lens of LENSES) {
    for (const t of LT.TRIGGERS[lens].content) {
      assert.ok(t.regex instanceof RegExp, t.name);
      assert.ok(!t.regex.global && !t.regex.sticky, `${t.name} must not carry lastIndex state`);
    }
    for (const t of LT.TRIGGERS[lens].paths) assert.strictEqual(typeof t.glob, 'string', t.name);
  }
});

test('every trigger name is <lens>.<slug> under its own lens, and there are 52 of them', () => {
  for (const lens of LENSES) {
    for (const t of [...LT.TRIGGERS[lens].content, ...LT.TRIGGERS[lens].paths]) {
      assert.match(t.name, /^[a-z-]+\.[a-z-]+$/, t.name);
      assert.strictEqual(t.name.split('.')[0], lens, t.name);
    }
  }
  assert.strictEqual(LT.TRIGGER_NAMES.length, 52);
  assert.strictEqual(new Set(LT.TRIGGER_NAMES).size, 52);
  assert.deepStrictEqual([...LT.TRIGGER_NAMES].sort(), LT.TRIGGER_NAMES);
});

test('TIER_FLOORS is re-exported from sensitive-match, not duplicated', () => {
  assert.strictEqual(LT.TIER_FLOORS, SM.TIER_FLOORS);
});

test('there is no money.paths: a money-section path is tier A, whose floor brings the money lens', () => {
  assert.deepStrictEqual(LT.TRIGGERS.money.paths, []);
  assert.ok(!LT.TRIGGER_NAMES.includes('money.paths'));
});

// ---- each trigger fires on its contract shape -----------------------------------------

const CONTENT_SAMPLES = {
  'money.update-proposals': "await client.query('UPDATE proposals SET archive_note = $1 WHERE id = $2');",
  'money.columns': 'const owed = row.amount_paid;',
  'money.stripe-calls': 'await stripe.refunds.create({ payment_intent: id });',
  'money.helpers': 'await refundExecute(proposalId);',
  'lifecycle.set-status': "await client.query(\"UPDATE leads SET status = 'closed'\");",
  'lifecycle.statuses': 'const LEAD_STATUSES = [];',
  'lifecycle.archive-reason': "row.archive_reason = 'event_passed';",
  'lifecycle.pay-periods': 'const q = `SELECT id FROM pay_periods`;',
  'lifecycle.set-interval': 'setInterval(tick, 60000);',
  'concurrency.for-update': 'const q = `SELECT id FROM leads WHERE id = $1 FOR UPDATE`;',
  'concurrency.pool-connect': 'const client = await pool.connect();',
  'concurrency.transaction': "await client.query('BEGIN');",
  'concurrency.on-conflict': 'const q = `INSERT INTO leads (id) VALUES ($1) ON CONFLICT DO NOTHING`;',
  'concurrency.promise-all': 'await Promise.all(jobs);',
  'concurrency.row-count': 'if (res.rowCount === 0) return;',
  'concurrency.retry': 'for (let attempt = 0; attempt < 3; attempt++) {}',
  'concurrency.timers': 'setTimeout(next, 10);',
  'concurrency.status-write': "row.status = 'done';",
  'concurrency.provider-call': 'const r = await fetch(url);',
  'business-time.current-date': 'const q = `SELECT id FROM events WHERE event_date > CURRENT_DATE`;',
  'business-time.new-date': 'const now = new Date();',
  'business-time.date-cast': 'const q = `SELECT created_at::date FROM leads`;',
  'business-time.at-time-zone': "const q = `SELECT now() AT TIME ZONE 'America/Chicago'`;",
  'business-time.date-helpers': 'const today = chicagoTodayYmd();',
  'business-time.days': 'const grace_days = 3;',
  'outcomes-providers.catch': '} catch (err) {',
  'outcomes-providers.ok-flag': 'return { ok: false };',
  'outcomes-providers.skipped-failed': "return { status: 'skipped' };",
  'outcomes-providers.process-env': 'const flag = process.env.FEATURE_FLAG;',
  'outcomes-providers.twiml': 'const twiml = new VoiceResponse();',
  'outcomes-providers.webhook': 'function handleWebhook() {}',
  'outcomes-providers.commit': "await client.query('COMMIT');",
  'outcomes-providers.provider-require': "const twilio = require('twilio');",
  'outcomes-providers.post-fetch': 'await axios.post(url, body);',
  'outcomes-providers.page-actions': "await page.click('#go');",
  'access-egress.router': "router.get('/x', handler);",
  'access-egress.auth': 'if (!req.user) throw new PermissionError();',
  'access-egress.rate-limit': 'const limiter = rateLimit({ max: 5 });',
  'access-egress.logging': 'console.log(row);',
  'access-egress.send': 'await sendEmail(msg);',
  'access-egress.response': 'res.json(rows);',
  'access-egress.webhook': '// the webhook handler',
  'access-egress.public-token': 'requireUuidToken(req.params.token);',
  'access-egress.export': "res.setHeader('Content-Disposition', disposition);",
  'schema-data.ddl': 'const q = `ALTER TABLE leads ADD COLUMN IF NOT EXISTS note TEXT`;',
  'schema-data.catalog-insert': 'const q = `INSERT INTO service_addons (slug) VALUES ($1)`;',
};

const PATH_SAMPLES = {
  'lifecycle.scheduler-paths': ['server/utils/leadScheduler.js', 'server/utils/shiftClosureSweep.js', 'server/utils/consultCallReaper.js'],
  'concurrency.scheduler-paths': ['server/utils/leadScheduler.js', 'server/utils/shiftClosureSweep.js', 'server/utils/consultCallReaper.js'],
  'outcomes-providers.thumbtack-agent-paths': ['thumbtack-agent/src/index.js', 'thumbtack-agent/README.md'],
  'access-egress.route-paths': ['server/routes/leads.js', 'server/middleware/auth.js'],
  'schema-data.schema-paths': ['server/db/schema.sql', 'server/db/index.js', 'server/scripts/repair.js', 'scripts/cc-ledger-import.js', 'server/utils/contractorSeed.js', 'server/db/seed.js'],
  'client.paths': ['client/src/index.css', 'client/src/pages/Home.js'],
};

test('the samples cover every trigger name exactly once', () => {
  assert.deepStrictEqual([...Object.keys(CONTENT_SAMPLES), ...Object.keys(PATH_SAMPLES)].sort(), LT.TRIGGER_NAMES);
});

for (const [name, line] of Object.entries(CONTENT_SAMPLES)) {
  test(`content trigger ${name} fires on an added line in a code path`, () => {
    const lens = name.split('.')[0];
    const fired = LT.firedTriggers({ diffText: addDiff('server/utils/sample.js', [line]), paths: ['server/utils/sample.js'] });
    assert.ok(fired[lens].includes(name), `${name} did not fire; fired: ${JSON.stringify(fired[lens])}`);
  });
}

for (const [name, paths] of Object.entries(PATH_SAMPLES)) {
  test(`path trigger ${name} fires on its paths`, () => {
    const lens = name.split('.')[0];
    for (const p of paths) {
      const fired = LT.firedTriggers({ diffText: '', paths: [p] });
      assert.ok(fired[lens].includes(name), `${name} did not fire on ${p}`);
    }
  });
}

// ---- what the triggers read, and what they never read -------------------------------

test('content triggers read added lines in code paths only: never docs, tests, .claude or a non-code file under scripts/', () => {
  const line = 'SELECT id FROM events WHERE event_date > CURRENT_DATE FOR UPDATE';
  for (const file of ['docs/notes.md', 'server/utils/a.test.js', '.claude/agents/money.md', 'scripts/claudemd-invariants.txt', 'client/src/index.css', 'thumbtack-agent/src/index.js']) {
    const fired = LT.firedTriggers({ diffText: addDiff(file, [line]), paths: [] });
    for (const lens of LENSES) assert.deepStrictEqual(fired[lens], [], `${file} fired ${lens}`);
  }
});

test('content triggers read added lines only, never removed or context lines', () => {
  const diff = [
    'diff --git a/server/utils/a.js b/server/utils/a.js',
    'index 1111111..2222222 100644',
    '--- a/server/utils/a.js',
    '+++ b/server/utils/a.js',
    '@@ -1,3 +1,3 @@',
    ' const q = `SELECT 1 FOR UPDATE`;',
    '-const d = new Date();',
    '+const d = 1;',
    '',
  ].join('\n');
  const fired = LT.firedTriggers({ diffText: diff, paths: [] });
  assert.deepStrictEqual(fired.concurrency, []);
  assert.deepStrictEqual(fired['business-time'], []);
});

test('a content trigger sees SQL split across added lines of one file', () => {
  const fired = LT.firedTriggers({ diffText: addDiff('server/utils/a.js', ['const q = `UPDATE proposals', '  SET archive_note = $1`;']), paths: [] });
  assert.ok(fired.money.includes('money.update-proposals'));
});

// The server writes SQL in either case; sensitive-match reads SQL keywords in
// any case, and so do the SQL-keyword triggers.
const fire = (line) => LT.firedTriggers({ diffText: addDiff('server/utils/sample.js', [line]), paths: [] });

test('the SQL-keyword triggers match lowercase SQL', () => {
  const cases = {
    'money.update-proposals': "await q('update proposals set archive_note = $1 where id = $2');",
    'concurrency.for-update': 'const q = `select id from leads where id = $1 for update`;',
    'concurrency.transaction': "await client.query('begin');",
    'concurrency.on-conflict': 'const q = `insert into leads (id) values ($1) on conflict do nothing`;',
    'business-time.current-date': 'const q = `select id from leads where created_at < now()`;',
    'business-time.date-cast': "const q = `select now() - interval '2 hours'`;",
    'business-time.at-time-zone': "const q = `select now() at time zone 'America/Chicago'`;",
    'schema-data.ddl': 'const q = `alter table leads add column if not exists note text`;',
    'schema-data.catalog-insert': 'const q = `insert into service_addons (slug) values ($1)`;',
  };
  for (const [name, line] of Object.entries(cases)) {
    assert.ok(fire(line)[name.split('.')[0]].includes(name), `${name} did not fire on lowercase SQL`);
  }
});

test('the status-write triggers fire on the contract regex or sensitive-match STATUS_WRITE: a write or a guard, never a JS comparison', () => {
  for (const line of [
    'const q = `update leads set note = $1, status = $2 where id = $3`;',
    "const q = `select id from shifts where id = $1 AND status = 'confirmed'`;",
    "const q = `select id from leads WHERE status = 'sent'`;",
  ]) {
    const fired = fire(line);
    assert.ok(fired.lifecycle.includes('lifecycle.set-status'), line);
    assert.ok(fired.concurrency.includes('concurrency.status-write'), line);
  }
  const js = fire("if (row.status === 'sent') return;");
  assert.ok(!js.lifecycle.includes('lifecycle.set-status'));
  assert.ok(!js.concurrency.includes('concurrency.status-write'));
  for (const t of [LT.TRIGGERS.lifecycle.content.find((x) => x.name === 'lifecycle.set-status'), LT.TRIGGERS.concurrency.content.find((x) => x.name === 'concurrency.status-write')]) {
    assert.ok(t.regex.source.includes(SM.STATUS_WRITE.source), `${t.name} does not carry STATUS_WRITE`);
    assert.ok(t.regex.flags.includes('i'));
  }
});

test('outcomes-providers.commit matches COMMIT in any case, like the other SQL keywords', () => {
  assert.ok(fire("await client.query('commit');")['outcomes-providers'].includes('outcomes-providers.commit'));
});

test('a diff section whose path cannot be read is scanned as code (fails closed)', () => {
  const diff = ['diff --git garbled', '@@ -0,0 +1 @@', '+const now = new Date();', ''].join('\n');
  const fired = LT.firedTriggers({ diffText: diff, paths: [] });
  assert.ok(fired['business-time'].includes('business-time.new-date'));
});

test('a C-quoted path is read: a test file stays out, a code file is scanned', () => {
  const quoted = (file) => [`diff --git "a/${file}" "b/${file}"`, 'new file mode 100644', '--- /dev/null', `+++ "b/${file}"`, '@@ -0,0 +1 @@', '+const now = new Date();', ''].join('\n');
  assert.deepStrictEqual(LT.firedTriggers({ diffText: quoted('server/utils/a\\tb.test.js'), paths: [] })['business-time'], []);
  assert.ok(LT.firedTriggers({ diffText: quoted('server/utils/a\\tb.js'), paths: [] })['business-time'].includes('business-time.new-date'));
});

test('path triggers see code paths only, except client.paths and the thumbtack agent', () => {
  const none = (p) => {
    const fired = LT.firedTriggers({ diffText: '', paths: [p] });
    for (const lens of LENSES) assert.deepStrictEqual(fired[lens], [], `${p} fired ${lens}`);
  };
  none('scripts/claudemd-invariants.txt');
  none('scripts/sensitive-paths.txt');
  none('scripts/lane-status.test.js');
  none('server/routes/leads.test.js');
  none('docs/seed-notes.md');
  none('.claude/agents/schema-data.md');
  none('render.yaml');
  assert.deepStrictEqual(LT.firedTriggers({ diffText: '', paths: ['client/src/App.test.js'] }).client, ['client.paths']);
  assert.deepStrictEqual(LT.firedTriggers({ diffText: '', paths: ['client/public/index.html'] }).client, []);
});

test('paths are normalized before they are matched', () => {
  assert.deepStrictEqual(LT.firedTriggers({ diffText: '', paths: ['./server/routes/leads.js'] })['access-egress'], ['access-egress.route-paths']);
});

// ---- selectLenses -----------------------------------------------------------------------

test('a money diff selects the tier A floor plus business-time when CURRENT_DATE appears', () => {
  const file = 'server/utils/pricingEngine.js';
  const diffText = addDiff(file, ['const q = `SELECT total_price FROM proposals WHERE event_date > CURRENT_DATE`;']);
  const selected = LT.selectLenses({ tiersByFile: { [file]: 'A' }, floors: SM.TIER_FLOORS.A, diffText, paths: [file] });
  assert.deepStrictEqual(names(selected).filter((n) => n !== 'business-time').sort(), [...SM.TIER_FLOORS.A].sort());
  const bt = byName(selected, 'business-time');
  assert.ok(bt, 'business-time was not selected');
  assert.ok(bt.firedBecause.includes('business-time.current-date'));
  assert.ok(!bt.firedBecause.includes('floor'));
  assert.deepStrictEqual(byName(selected, 'money').firedBecause, ['floor', 'money.columns']);
  assert.deepStrictEqual(byName(selected, 'seams').firedBecause, ['floor']);
});

test('a server status write selects lifecycle and concurrency', () => {
  const file = 'server/utils/leadState.js';
  const diffText = addDiff(file, ["await pool.query(\"UPDATE leads SET status = 'closed' WHERE id = $1\", [id]);"]);
  const selected = LT.selectLenses({ tiersByFile: { [file]: 'B' }, floors: SM.TIER_FLOORS.B, diffText, paths: [file] });
  assert.ok(byName(selected, 'lifecycle').firedBecause.includes('lifecycle.set-status'));
  assert.ok(byName(selected, 'concurrency').firedBecause.includes('concurrency.status-write'));
  assert.deepStrictEqual(byName(selected, 'seams').firedBecause, ['floor']);
});

test('a client CSS diff selects client and seams only', () => {
  const file = 'client/src/index.css';
  const diffText = addDiff(file, ['.lead-row { color: var(--ink); }', '/* new Date() CURRENT_DATE webhook */']);
  const selected = LT.selectLenses({ tiersByFile: { [file]: 'C' }, floors: SM.TIER_FLOORS.C, diffText, paths: [file] });
  assert.deepStrictEqual(names(selected), ['seams', 'client']);
  assert.deepStrictEqual(byName(selected, 'client').firedBecause, ['floor', 'client.paths']);
});

test('a docs diff selects nothing', () => {
  const file = 'docs/dev.md';
  const diffText = addDiff(file, ['UPDATE proposals SET total_price = 1 FOR UPDATE CURRENT_DATE webhook']);
  assert.deepStrictEqual(LT.selectLenses({ tiersByFile: { [file]: 'docs' }, floors: [], diffText, paths: [file] }), []);
});

test('floors default to the union of the per-file tier floors, and paths to the files', () => {
  const selected = LT.selectLenses({ tiersByFile: { 'server/routes/leads.js': 'B', 'client/src/a.js': 'C' }, diffText: '' });
  assert.deepStrictEqual(names(selected), ['access-egress', 'seams', 'client']);
  assert.deepStrictEqual(byName(selected, 'access-egress').firedBecause, ['access-egress.route-paths']);
});

test('the lenses come back in the receipt order', () => {
  const selected = LT.selectLenses({ tiersByFile: { 'server/utils/a.js': 'A' }, floors: SM.TIER_FLOORS.A, diffText: '' });
  assert.deepStrictEqual(names(selected), LENSES.filter((l) => SM.TIER_FLOORS.A.includes(l)));
});

// ---- forecastDiff -------------------------------------------------------------------------

function fixturePlan(t, frontMatter) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-triggers-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'plan.md');
  fs.writeFileSync(file, ['---', ...frontMatter, '---', '', '# A plan', '', 'lenses: money everywhere (body text, never read)', ''].join('\n'));
  return file;
}

test('forecastDiff against this plan: the review-tooling lane names no lens, so every selected lens is unforecast', () => {
  const selected = [{ name: 'access-egress' }, { name: 'seams' }, { name: 'schema-data' }];
  assert.deepStrictEqual(LT.forecastDiff(selected, PLAN, 'review-tooling'), ['access-egress', 'seams', 'schema-data']);
});

test('forecastDiff returns the selected names the lane line does not mention, matched as words', (t) => {
  const plan = fixturePlan(t, [
    'lanes:',
    '  - id: fixture-lane',
    '    scope: a fixture',
    '    lenses: money and the seams lens, plus access and egress; not the money-laws doc',
    '    revert: none',
    '  - id: other-lane',
    '    lenses: lifecycle, business-time, outcomes and providers, client',
  ]);
  assert.deepStrictEqual(LT.forecastDiff(['money', 'lifecycle', 'access-egress', 'seams'], plan, 'fixture-lane'), ['lifecycle']);
  assert.deepStrictEqual(LT.forecastDiff(['lifecycle', 'business-time', 'outcomes-providers', 'client', 'concurrency'], plan, 'other-lane'), ['concurrency']);
});

test('forecastDiff: a lens name inside a longer word is not a mention', (t) => {
  const plan = fixturePlan(t, ['lanes:', '  - id: x', '    lenses: the client-money-surfaces section and moneyball']);
  assert.deepStrictEqual(LT.forecastDiff(['client', 'money'], plan, 'x'), ['client', 'money']);
});

test('forecastDiff reads a lenses value continued on more-indented lines', (t) => {
  const plan = fixturePlan(t, ['lanes:', '  - id: x', '    lenses: money,', '      lifecycle', '    footprint:', '      - concurrency.js']);
  assert.deepStrictEqual(LT.forecastDiff(['money', 'lifecycle', 'concurrency'], plan, 'x'), ['concurrency']);
});

test('forecastDiff: a lane with no lenses line forecasts nothing; it never reads the next lane', (t) => {
  const plan = fixturePlan(t, ['lanes:', '  - id: bare', '    scope: no lenses here', '  - id: next', '    lenses: money']);
  assert.deepStrictEqual(LT.forecastDiff(['money'], plan, 'bare'), ['money']);
});

test('forecastDiff refuses a lane the front matter does not hold, and a plan with no front matter', (t) => {
  const plan = fixturePlan(t, ['lanes:', '  - id: x', '    lenses: money']);
  assert.throws(() => LT.forecastDiff(['money'], plan, 'missing'), /no lane missing/);
  const bare = path.join(path.dirname(plan), 'bare.md');
  fs.writeFileSync(bare, '# no front matter\n');
  assert.throws(() => LT.forecastDiff(['money'], bare, 'x'), /front matter/);
});

// ---- the cross-check against the lens files -----------------------------------------------

// The names a lens file cites: the comma-separated tail after `Names:` on each
// trigger line, `floor` included.
function citedNames(lens) {
  const text = fs.readFileSync(path.join(REPO, '.claude', 'agents', `${lens}.md`), 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const m = /\bNames:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    for (const n of m[1].split(',')) out.push(n.trim().replace(/\.$/, ''));
  }
  return out;
}

test('cross-check: every name cited in the nine lens files exists in lensTriggers.js, and every name in lensTriggers.js is cited by its lens', () => {
  const missing = [];
  const uncited = [];
  for (const lens of LENSES) {
    const cited = citedNames(lens);
    assert.ok(cited.length > 0, `${lens}.md has no Names line`);
    for (const n of cited) if (n !== 'floor' && !LT.TRIGGER_NAMES.includes(n)) missing.push(`${lens}.md cites ${n}`);
    const own = [...LT.TRIGGERS[lens].content, ...LT.TRIGGERS[lens].paths].map((t) => t.name);
    for (const n of new Set(own)) if (!cited.includes(n)) uncited.push(`${n} is not cited by ${lens}.md`);
  }
  assert.deepStrictEqual(missing, []);
  assert.deepStrictEqual(uncited, []);
  assert.deepStrictEqual([...new Set(citedNames('seams'))], ['floor']);
});

// ---- the diff reader ------------------------------------------------------------------------

test('addedLinesByFile: a rename with a change reads the new path; a pure rename adds nothing; a no-newline marker is not a line', () => {
  const diff = [
    'diff --git a/server/utils/old.js b/server/utils/new.js',
    'similarity index 80%',
    'rename from server/utils/old.js',
    'rename to server/utils/new.js',
    'index 1111111..2222222 100644',
    '--- a/server/utils/old.js',
    '+++ b/server/utils/new.js',
    '@@ -1 +1 @@',
    '-const a = 1;',
    '+const now = new Date();',
    '\\ No newline at end of file',
    'diff --git a/server/utils/x.js b/server/utils/y.js',
    'similarity index 100%',
    'rename from server/utils/x.js',
    'rename to server/utils/y.js',
    '',
  ].join('\n');
  assert.deepStrictEqual(LT.addedLinesByFile(diff), [
    { path: 'server/utils/new.js', added: ['const now = new Date();'] },
    { path: null, added: [] },
  ]);
});

test('unquote reads octal escapes as bytes and the C escapes; a malformed token is null', () => {
  const cafe = `${Buffer.from([0x63, 0x61, 0x66, 0xc3, 0xa9]).toString('utf8')}.js`;
  assert.strictEqual(LT.unquote('"b/caf\\303\\251.js"'), `b/${cafe}`);
  assert.strictEqual(LT.unquote('"a\\tb\\"c\\\\d"'), 'a\tb"c\\d');
  assert.strictEqual(LT.unquote('"unterminated'), null);
  assert.strictEqual(LT.unquote('"ends in a backslash\\"'), null);
  assert.strictEqual(LT.unquote('bare'), null);
});

test('a query string that names status fires neither status trigger; a quoted SQL guard and a parameterized write fire both', () => {
  const qs = fire("const url = '/api/proposals?status=' + tab;");
  assert.ok(!qs.lifecycle.includes('lifecycle.set-status'));
  assert.ok(!qs.concurrency.includes('concurrency.status-write'));
  const amp = fire("const url = `/api/leads?page=2&status='open'`;");
  assert.ok(!amp.lifecycle.includes('lifecycle.set-status'));
  for (const line of ["const q = `select id from leads WHERE status = 'sent'`;", 'const q = `update leads set note = $1, status = $2`;']) {
    const f = fire(line);
    assert.ok(f.lifecycle.includes('lifecycle.set-status') && f.concurrency.includes('concurrency.status-write'), line);
  }
});
