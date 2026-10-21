'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isSensitive, matchSensitive } = require('./sensitive-match');

test('matches known sensitive files (exact patterns)', () => {
  for (const p of [
    'server/utils/pricingEngine.js',
    'server/utils/stripeClient.js',
    'server/utils/encryption.js',
    'server/utils/gratuityLabels.js',
    'server/utils/eventTypes.js',
    'server/utils/errors.js',
    'server/db/schema.sql',
    'server/routes/stripeWebhook.js',
    'server/routes/sms.js',
    'server/middleware/auth.js',
    'server/middleware/rateLimiters.js',
    '.env.example',
  ]) {
    assert.ok(isSensitive([p]), `${p} should be sensitive`);
  }
});

test('glob patterns match real files', () => {
  assert.ok(isSensitive(['server/utils/payrollAccrual.js']), 'payroll*.js');
  assert.ok(isSensitive(['server/utils/payrollMath.js']), 'payroll*.js');
  assert.ok(isSensitive(['server/utils/autoAssignScheduler.js']), '*Scheduler.js');
  assert.ok(isSensitive(['server/utils/marketingEmailTemplates.js']), '*EmailTemplates.js');
  assert.ok(isSensitive(['server/utils/preEventHandlers.js']), '*Handlers.js');
  assert.ok(isSensitive(['server/scripts/repairProposal54Balance.sql']), 'scripts/*.sql');
});

test('rejects cosmetic / non-sensitive files', () => {
  for (const p of [
    'client/src/index.css',
    'client/src/components/Button.jsx',
    'README.md',
    'server/routes/blog.js',
    'docs/build-board.md',
    'server/utils/eventTypes.test.js', // exact 'eventTypes.js' pattern must not over-match
  ]) {
    assert.ok(!isSensitive([p]), `${p} should NOT be sensitive`);
  }
});

test("'*' does not cross a directory boundary", () => {
  // payroll*.js is scoped to server/utils/; it must not match a same-named file elsewhere
  assert.ok(!isSensitive(['client/src/payrollWidget.js']));
});

test('matchSensitive returns only the sensitive subset of a mixed set', () => {
  const input = [
    'README.md',
    'server/utils/pricingEngine.js',
    'client/src/index.css',
    'server/utils/payrollMath.js',
  ];
  assert.deepStrictEqual(
    matchSensitive(input).sort(),
    ['server/utils/payrollMath.js', 'server/utils/pricingEngine.js'].sort()
  );
});

test('normalizes a leading ./ and backslashes', () => {
  assert.ok(isSensitive(['./server/utils/stripeClient.js']));
  assert.ok(isSensitive(['server\\utils\\stripeClient.js']));
});

// ---- instruction rewrite step 2, lane sensitive-match-2 ----------------------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sm = require('./sensitive-match');

// Every temp directory a test makes is removed when the file's tests finish, so a
// run leaves nothing under os.tmpdir() (review 2 L5).
const TEMP_DIRS = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixtureList(text) {
  const dir = tempDir('sensitive-list-');
  const file = path.join(dir, 'list.txt');
  fs.writeFileSync(file, text);
  return file;
}

function diffFor(filePath, addedLines, { isNew = false } = {}) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    isNew ? 'new file mode 100644' : 'index 0000000..1111111 100644',
    `--- ${isNew ? '/dev/null' : 'a/' + filePath}`,
    `+++ b/${filePath}`,
    '@@ -0,0 +1 @@',
    ...addedLines.map((l) => '+' + l),
    '',
  ].join('\n');
}

// A parsed diff that adds one harmless line to each path (a code path with no
// parsed diff section fails closed to A, review 1 M3).
function plain(paths) {
  return paths.map((p) => diffFor(p, ['const unrelated = 1;'])).join('');
}

test("'**' crosses a slash and '*' still does not", () => {
  const list = fixtureList('server/utils/inbox/**\nserver/utils/payroll*.js\n');
  assert.ok(sm.isSensitive(['server/utils/inbox/a.js'], list));
  assert.ok(sm.isSensitive(['server/utils/inbox/deep/b.js'], list), '** crosses a slash');
  assert.ok(!sm.isSensitive(['server/utils/deep/payrollX.js'], list), '* does not cross a slash');
});

test('an unsectioned list reads as section money; a sectioned list carries each section', () => {
  const plain = sm.loadPatterns(fixtureList('server/utils/pricingEngine.js\n.env.example\n'));
  assert.deepStrictEqual(plain.map((p) => p.section), ['money', 'money']);
  const sectioned = sm.loadPatterns(fixtureList('# section: money\nserver/utils/pricingEngine.js\n# section: auth-and-pii\nserver/middleware/auth.js\n# section: hinge\nscripts/merge-lane.sh\n'));
  assert.deepStrictEqual(sectioned.map((p) => [p.pattern, p.section]), [
    ['server/utils/pricingEngine.js', 'money'],
    ['server/middleware/auth.js', 'auth-and-pii'],
    ['scripts/merge-lane.sh', 'hinge'],
  ]);
});

test('isDocsOnly: the allowlist by path, never a sensitive or hinge path', () => {
  assert.strictEqual(sm.isDocsOnly(['docs/x.md', 'README.md', 'ARCHITECTURE.md']), true);
  assert.strictEqual(sm.isDocsOnly(['docs/money-laws.md']), false, 'a hinge doc is never docs-only');
  assert.strictEqual(sm.isDocsOnly(['docs/runbooks/override-conversion.md']), false);
  assert.strictEqual(sm.isDocsOnly(['docs/x.md', 'server/routes/a.js']), false);
  assert.strictEqual(sm.isDocsOnly([]), false);
});

test('the content rule fires on added lines in code paths only', () => {
  const line = "await client.query(`UPDATE proposals SET amount_paid = amount_paid + $2 WHERE id = $1`);";
  assert.strictEqual(sm.contentRuleHits(diffFor('server/routes/x.js', [line])).length, 1);
  assert.strictEqual(sm.contentRuleHits(diffFor('docs/x.md', [line])).length, 0, 'docs never fire');
  assert.strictEqual(sm.contentRuleHits(diffFor('server/routes/x.test.js', [line])).length, 0, 'tests never fire');
  assert.strictEqual(sm.contentRuleHits(diffFor('.claude/agents/money.md', [line])).length, 0);
  assert.strictEqual(sm.contentRuleHits(diffFor('server/utils/y.js', ['const r = await stripe.refunds.create({ payment_intent: id });'])).length, 1);
  assert.strictEqual(sm.contentRuleHits(diffFor('server/utils/y.js', ['await applyRefundReconciliation(client, proposalId);'])).length, 1);
  assert.strictEqual(sm.contentRuleHits(diffFor('client/src/pages/P.js', ['const owed = Number(p.total_price) - Number(p.amount_paid);'])).length, 1);
  assert.strictEqual(sm.contentRuleHits(diffFor('server/routes/x.js', ['UPDATE proposals SET notes = $1 WHERE id = $2'])).length, 0, 'a non-money column is not a hit');
  assert.strictEqual(sm.contentRuleHits(diffFor('server/routes/blog.js', ["const title = 'hello';"])).length, 0);
  assert.strictEqual(sm.contentRuleHits(diffFor('server/utils/payrollAccrual.js', ['const shares = splitEvenly(netGratuity, n);'])).length, 1, 'the money-word rule');
  assert.strictEqual(sm.contentRuleHits(diffFor('server/utils/z.js', ['const r = await stripe.customers.retrieve(id);'])).length, 1, 'any Stripe call');
  assert.strictEqual(sm.contentRuleHits(diffFor('server/utils/z.js', ['// payouts are described in the runbook'])).length, 1, 'a money word in a comment still fires; the lens decides');
  assert.ok(sm.isCodePath('scripts/cc-transfer-events.js'));
  assert.ok(!sm.isCodePath('scripts/money-smoke-list.txt'));
  assert.ok(!sm.isCodePath('scripts/content-rule-calibrate.js'));
});

test('tier: per-file tiers, the union of floors, the label order A, hinge, B, C, docs', () => {
  const money = sm.tier({ paths: ['server/routes/x.js'], diffText: diffFor('server/routes/x.js', ['UPDATE proposals SET amount_paid = 1']) });
  assert.strictEqual(money.tier, 'A');
  assert.deepStrictEqual(money.floors.sort(), ['access-egress', 'concurrency', 'lifecycle', 'money', 'outcomes-providers', 'seams']);
  assert.strictEqual(money.externals, true);
  assert.strictEqual(money.verify, true);
  assert.deepStrictEqual(money.tests, { smoke: true, suites: true, clientBuild: false });

  const docsLine = sm.tier({ paths: ['docs/x.md'], diffText: diffFor('docs/x.md', ['UPDATE proposals SET amount_paid = 1']) });
  assert.strictEqual(docsLine.tier, 'docs');
  assert.deepStrictEqual(docsLine.floors, []);

  const testLine = sm.tier({ paths: ['server/routes/x.test.js'], diffText: diffFor('server/routes/x.test.js', ['UPDATE proposals SET amount_paid = 1']) });
  assert.strictEqual(testLine.tier, 'B');
  assert.deepStrictEqual(testLine.contentRuleHits, []);

  assert.strictEqual(sm.tier({ paths: ['server/routes/blog.js'], diffText: plain(['server/routes/blog.js']) }).tier, 'B');
  assert.strictEqual(sm.tier({ paths: ['scripts/merge-lane.sh'], diffText: plain(['scripts/merge-lane.sh']) }).tier, 'hinge');
  assert.strictEqual(sm.tier({ paths: ['scripts/money-smoke-list.txt'], diffText: '' }).tier, 'A', 'a listed file is A whatever its extension');
  assert.strictEqual(sm.tier({ paths: ['scripts/mobile-capture.manifest.json'], diffText: '' }).tier, 'hinge', 'an unlisted non-code file under scripts/ is hinge');
  assert.strictEqual(sm.tier({ paths: ['.claude/agents/money.md'], diffText: '' }).tier, 'hinge', 'unclassified paths are hinge');
  assert.strictEqual(sm.tier({ paths: ['client/src/index.css'], diffText: '' }).tier, 'C');
  assert.strictEqual(sm.tier({ paths: ['docs/superpowers/plans/p.md'], diffText: '' }).tier, 'docs');
  assert.strictEqual(sm.tier({ paths: ['server/utils/pricingEngine.js'], diffText: '' }).tier, 'A', 'a listed path is A under the unsectioned list');

  const mixedB = sm.tier({ paths: ['scripts/merge-lane.sh', 'server/routes/blog.js'], diffText: plain(['scripts/merge-lane.sh', 'server/routes/blog.js']) });
  assert.strictEqual(mixedB.tier, 'hinge');
  assert.deepStrictEqual(mixedB.floors.sort(), ['access-egress', 'seams']);
  assert.deepStrictEqual(mixedB.tiersByFile, { 'scripts/merge-lane.sh': 'hinge', 'server/routes/blog.js': 'B' });

  const mixedC = sm.tier({ paths: ['scripts/merge-lane.sh', 'client/src/index.css'], diffText: plain(['scripts/merge-lane.sh', 'client/src/index.css']) });
  assert.strictEqual(mixedC.tier, 'hinge');
  assert.deepStrictEqual(mixedC.floors.sort(), ['access-egress', 'client', 'seams']);
  assert.deepStrictEqual(mixedC.tests, { smoke: false, suites: true, clientBuild: true });

  const newRoute = sm.tier({ paths: ['server/routes/newThing.js'], diffText: diffFor('server/routes/newThing.js', ["const router = require('express').Router();"], { isNew: true }), newPaths: ['server/routes/newThing.js'] });
  assert.strictEqual(newRoute.tier, 'B');
  assert.deepStrictEqual(newRoute.floors.sort(), ['access-egress', 'seams'], 'a new route file adds access-egress to the B floor');
});

test('HINGE_PATHS carries the D11 set', () => {
  for (const p of ['scripts/merge-lane.sh', 'scripts/ship.js', 'scripts/push-gate.js', 'scripts/lib/receipt.js', '.husky/pre-push', 'package.json', 'client/package-lock.json', '.node-version', 'eslint.config.mjs', '.gitignore', 'docs/money-laws.md', 'docs/runbooks/x.md', 'AGENTS.md', 'client/vercel.json', '.claude/settings.json', 'scripts/sensitive-paths.txt', 'scripts/static-checks.js', '.claude/skills/review/SKILL.md', '.claude/agents/money.md', 'scripts/lib/staticChecks/jsScan.js', 'scripts/lib/flockExec.js']) {
    assert.ok(sm.isHingePath(p), `${p} should be hinge`);
  }
  assert.ok(!sm.isHingePath('server/routes/blog.js'));
});

// ---- fix pass after review 1 (M1-M6, L1-L5) ------------------------------------

test('M2: the heaviest section wins when a path matches patterns in several sections', () => {
  const list = fixtureList('# section: hinge\nscripts/lib/*\n# section: money\nscripts/lib/devDbGate.js\n');
  assert.deepStrictEqual(sm.matchSensitiveDetailed(['scripts/lib/devDbGate.js'], list).map((h) => h.section), ['money']);
  assert.strictEqual(sm.tier({ paths: ['scripts/lib/devDbGate.js'], diffText: diffFor('scripts/lib/devDbGate.js', ['const x = 1;']), listFile: list }).tier, 'A');
  const authOverHinge = fixtureList('# section: hinge\nserver/middleware/*\n# section: auth-and-PII\nserver/middleware/auth.js\n');
  assert.deepStrictEqual(sm.matchSensitiveDetailed(['server/middleware/auth.js'], authOverHinge).map((h) => h.section), ['auth-and-pii']);
});

test('M2: a malformed section header throws with its line number; prose comments stay comments', () => {
  for (const bad of ['# section: client money surfaces', '# section: money  # note', '# section: payroll', '# section money', '#section:', '# sections: money']) {
    const list = fixtureList(`server/a.js\n# section: hinge\nscripts/x.sh\n${bad}\nserver/utils/pricingEngine.js\n`);
    assert.throws(() => sm.loadPatterns(list), (e) => e instanceof Error && /line 4/.test(e.message), bad);
    assert.throws(() => sm.isSensitive(['server/utils/pricingEngine.js'], list), /line 4/, `${bad} fails closed through isSensitive too`);
  }
  const prose = sm.loadPatterns(fixtureList('# A header block that runs over\n# section 8). The routes mint sessions; the guard decides.\n# sections 5.1 and 13; lane x. The only modules.\nserver/a.js\n'));
  assert.deepStrictEqual(prose.map((p) => [p.pattern, p.section]), [['server/a.js', 'money']]);
  assert.ok(sm.loadPatterns().length > 0, 'the real list loads');
});

test('M3: the parser survives CRLF, an added line that starts with ++, quoted and spaced paths', () => {
  const money = 'UPDATE proposals SET amount_paid = 1';
  const crlf = diffFor('server/routes/x.js', [money]).replace(/\n/g, '\r\n');
  assert.strictEqual(sm.contentRuleHits(crlf).length, 1, 'CRLF');
  assert.strictEqual(sm.tier({ paths: ['server/routes/x.js'], diffText: crlf }).tier, 'A');

  const plusPlus = diffFor('server/utils/y.js', ['++attempts; await stripe.refunds.create({ payment_intent: id });']);
  assert.ok(plusPlus.includes('\n+++attempts;'), 'fixture carries a +++ line after the @@');
  assert.strictEqual(sm.contentRuleHits(plusPlus).length, 1, 'an added line starting ++ is not a header');

  const quoted = [
    'diff --git "a/server/routes/caf\\303\\251.js" "b/server/routes/caf\\303\\251.js"',
    'index 0000000..1111111 100644',
    '--- "a/server/routes/caf\\303\\251.js"',
    '+++ "b/server/routes/caf\\303\\251.js"',
    '@@ -0,0 +1 @@',
    '+' + money,
    '',
  ].join('\n');
  assert.deepStrictEqual(sm.contentRuleHits(quoted).map((h) => h.file), ['server/routes/café.js'], 'C-quoted path decoded');

  const spaced = [
    'diff --git a/server/routes/a b.js b/server/routes/a b.js',
    'index 0000000..1111111 100644',
    '--- a/server/routes/a b.js\t',
    '+++ b/server/routes/a b.js\t',
    '@@ -0,0 +1 @@',
    '+' + money,
    '',
  ].join('\n');
  assert.deepStrictEqual(sm.contentRuleHits(spaced).map((h) => h.file), ['server/routes/a b.js'], 'a path with a space');
  assert.strictEqual(sm.tier({ paths: ['server/routes/a b.js'], diffText: spaced }).tier, 'A');
});

test('M3: tier fails closed on a code path with no parsed section or a binary section; deleted files are exempt', () => {
  const none = sm.tier({ paths: ['server/routes/blog.js'], diffText: '' });
  assert.strictEqual(none.tier, 'A');
  assert.deepStrictEqual(none.contentRuleHits, [{ file: 'server/routes/blog.js', line: 0, text: '', rule: 'diff-unparsed' }]);

  const binary = 'diff --git a/server/routes/x.js b/server/routes/x.js\nindex 0000000..1111111 100644\nBinary files a/server/routes/x.js and b/server/routes/x.js differ\n';
  const b = sm.tier({ paths: ['server/routes/x.js'], diffText: binary });
  assert.strictEqual(b.tier, 'A', 'a binary code section');
  assert.deepStrictEqual(b.contentRuleHits, [{ file: 'server/routes/x.js', line: 0, text: '', rule: 'diff-unparsed' }]);

  for (const [label, text] of [
    ['noprefix', 'diff --git server/routes/x.js server/routes/x.js\nindex 0000000..1111111 100644\n--- server/routes/x.js\n+++ server/routes/x.js\n@@ -0,0 +1 @@\n+UPDATE proposals SET amount_paid = 1\n'],
    ['mnemonic', 'diff --git c/server/routes/x.js w/server/routes/x.js\nindex 0000000..1111111 100644\n--- c/server/routes/x.js\n+++ w/server/routes/x.js\n@@ -0,0 +1 @@\n+UPDATE proposals SET amount_paid = 1\n'],
    ['colour', '\u001b[1mdiff --git a/server/routes/x.js b/server/routes/x.js\u001b[m\n\u001b[32m+UPDATE proposals SET amount_paid = 1\u001b[m\n'],
  ]) {
    assert.strictEqual(sm.tier({ paths: ['server/routes/x.js'], diffText: text }).tier, 'A', label);
  }
  assert.strictEqual(sm.tier({ paths: [], diffText: 'diff --git server/routes/x.js server/routes/x.js\n+++ server/routes/x.js\n@@ -0,0 +1 @@\n+const a = 1;\n' }).tier, 'A', 'a section with no parseable path is A even when no path names it');

  const deletedSection = 'diff --git a/server/routes/old.js b/server/routes/old.js\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/server/routes/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-const a = 1;\n';
  const d = sm.tier({ paths: ['server/routes/old.js'], diffText: deletedSection });
  assert.strictEqual(d.tier, 'B', 'a deleted file with its section');
  assert.deepStrictEqual(d.contentRuleHits, []);
  assert.strictEqual(sm.tier({ paths: ['server/routes/old.js'], diffText: '', deletedPaths: ['server/routes/old.js'] }).tier, 'B', 'a deleted file named by the caller');
  assert.strictEqual(sm.tier({ paths: ['client/src/index.css'], diffText: '' }).tier, 'C', 'a non-code path needs no section');
  const modeOnly = 'diff --git a/scripts/merge-lane.sh b/scripts/merge-lane.sh\nold mode 100644\nnew mode 100755\n';
  assert.strictEqual(sm.tier({ paths: ['scripts/merge-lane.sh'], diffText: modeOnly }).tier, 'hinge', 'a mode-only section is parsed');
});

test('M4: an empty path set is hinge, never docs', () => {
  for (const r of [sm.tier({ paths: [], diffText: '' }), sm.tier({ diffText: '' }), sm.tier({ paths: ['', '  '], diffText: '' })]) {
    assert.strictEqual(r.tier, 'hinge');
    assert.strictEqual(r.docsOnly, false);
    assert.deepStrictEqual(r.floors.sort(), ['access-egress', 'seams']);
    assert.strictEqual(r.tests.suites, true);
  }
});

// ---- the --tier CLI, run in throwaway repos ---------------------------------------
const { execFileSync, spawnSync } = require('node:child_process');
const SCRIPT = path.join(__dirname, 'sensitive-match.js');

function tempRepo() {
  const dir = tempDir('sensitive-cli-');
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test User');
  g('config', 'commit.gpgsign', 'false');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const commit = (paths, msg) => {
    if (paths.length) g('add', '--', ...paths);
    g('commit', '-q', '--no-verify', '-m', msg);
    return g('rev-parse', 'HEAD').trim();
  };
  write('README.md', 'seed\n');
  const seed = commit(['README.md'], 'seed');
  return { dir, g, write, commit, seed };
}

function cli(dir, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null };
}

test('M1: parseNameStatus takes both paths of a rename or copy, and the new one counts as new', () => {
  const z = ['R100', 'server/utils/stripeClient.js', 'server/utils/stripeClientV2.js', 'C75', 'server/utils/a.js', 'server/routes/a.js', 'M', 'server/x.js', 'U', 'server/y.js', 'D', 'server/z.js', 'A', 'server/routes/w.js', ''].join('\0');
  assert.deepStrictEqual(sm.parseNameStatus(z), {
    paths: ['server/utils/stripeClient.js', 'server/utils/stripeClientV2.js', 'server/utils/a.js', 'server/routes/a.js', 'server/x.js', 'server/y.js', 'server/z.js', 'server/routes/w.js'],
    newPaths: ['server/utils/stripeClientV2.js', 'server/routes/a.js', 'server/routes/w.js'],
    deletedPaths: ['server/z.js'],
  });
});

test('M1: the CLI keeps a renamed listed file at A and widens the floor for a file renamed into server/routes/', () => {
  const r = tempRepo();
  r.write('server/utils/stripeClient.js', 'module.exports = {};\n');
  r.write('server/utils/helper.js', 'module.exports = 1;\n');
  const c1 = r.commit(['server/utils/stripeClient.js', 'server/utils/helper.js'], 'c1');
  r.g('mv', 'server/utils/stripeClient.js', 'server/utils/stripeClientV2.js');
  const c2 = r.commit([], 'rename listed');
  const listed = cli(r.dir, ['--tier', '--base', c1, '--tip', c2]);
  assert.strictEqual(listed.code, 0, listed.err);
  assert.strictEqual(listed.json.tier, 'A');
  assert.ok('server/utils/stripeClient.js' in listed.json.tiersByFile, 'the old path is in the set');
  fs.mkdirSync(path.join(r.dir, 'server/routes'), { recursive: true });
  r.g('mv', 'server/utils/helper.js', 'server/routes/helper.js');
  const c3 = r.commit([], 'rename into routes');
  const moved = cli(r.dir, ['--tier', '--base', c2, '--tip', c3]);
  assert.strictEqual(moved.json.tier, 'B');
  assert.deepStrictEqual(Object.keys(moved.json.tiersByFile).sort(), ['server/routes/helper.js', 'server/utils/helper.js']);
  assert.deepStrictEqual(moved.json.floors.sort(), ['access-egress', 'seams'], 'a file renamed into server/routes/ is a new route file');
});

test('M3: the CLI reads the content whatever the diff config and attributes say', () => {
  const r = tempRepo();
  r.write('server/routes/x.js', 'module.exports = 1;\n');
  const c1 = r.commit(['server/routes/x.js'], 'c1');
  r.write('server/routes/x.js', 'module.exports = 1;\nawait q(`UPDATE proposals SET amount_paid = $1 WHERE id = $2`);\n');
  r.write('.gitattributes', '*.js -diff\n');
  const c2 = r.commit(['server/routes/x.js', '.gitattributes'], 'c2');
  for (const [k, v] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['color.diff', 'always'], ['color.ui', 'always'], ['diff.relative', 'true'], ['diff.external', 'false']]) r.g('config', k, v);
  for (const cwd of [r.dir, path.join(r.dir, 'server')]) {
    const out = cli(cwd, ['--tier', '--base', c1, '--tip', c2]);
    assert.strictEqual(out.code, 0, out.err);
    assert.strictEqual(out.json.tier, 'A');
    assert.deepStrictEqual(out.json.contentRuleHits.map((h) => [h.file, h.rule]), [['server/routes/x.js', 'update-money-table']], `content read from ${cwd}`);
    assert.ok('.gitattributes' in out.json.tiersByFile, 'paths are repo-relative, not cut to the cwd');
  }
});

test('M4 and L3: the CLI checks its refs and flags and exits 2 with the usage line', () => {
  const r = tempRepo();
  const outFile = path.join(r.dir, 'leak.txt');
  for (const args of [
    ['--tier', '--base', `--output=${outFile}`, '--tip', r.seed],
    ['--tier', '--base', 'no-such-ref', '--tip', r.seed],
    ['--tier', '--base', r.seed],
    ['--tier', '--base'],
    ['--tier', '--tip', r.seed, '--base'],
    ['--tier', '--base', r.seed, '--tip', r.seed, '--staged'],
    ['--tier'],
  ]) {
    const res = cli(r.dir, args);
    assert.strictEqual(res.code, 2, args.join(' '));
    assert.match(res.err, /^usage: sensitive-match\.js --tier/m, args.join(' '));
  }
  assert.ok(!fs.existsSync(outFile), 'git never wrote the diff to a file');
  assert.strictEqual(cli(r.dir, ['--tier', '--base', r.seed, '--tip', r.seed]).json.tier, 'hinge', 'an empty range is hinge');
});

test('L3: an unmerged path in --staged contributes its path', () => {
  const r = tempRepo();
  r.write('server/routes/x.js', 'module.exports = 0;\n');
  r.commit(['server/routes/x.js'], 'base');
  r.g('checkout', '-q', '-b', 'side');
  r.write('server/routes/x.js', 'module.exports = 1;\n');
  r.commit(['server/routes/x.js'], 'side');
  r.g('checkout', '-q', 'main');
  r.write('server/routes/x.js', 'module.exports = 2;\n');
  r.commit(['server/routes/x.js'], 'main');
  spawnSync('git', ['merge', '-q', 'side'], { cwd: r.dir, encoding: 'utf8' });
  assert.match(r.g('diff', '--cached', '--name-status'), /^U\tserver\/routes\/x\.js/m, 'fixture has an unmerged row');
  const res = cli(r.dir, ['--tier', '--staged']);
  assert.strictEqual(res.code, 0, res.err);
  assert.ok('server/routes/x.js' in res.json.tiersByFile);
  assert.strictEqual(res.json.tier, 'A', 'an unmerged code path has no parsed section, so it fails closed');
});

test('L4: new files come from the diff when the caller passes no newPaths', () => {
  const route = sm.tier({ paths: ['server/routes/newThing.js'], diffText: diffFor('server/routes/newThing.js', ["const router = require('express').Router();"], { isNew: true }) });
  assert.strictEqual(route.tier, 'B');
  assert.deepStrictEqual(route.floors.sort(), ['access-egress', 'seams'], 'new file mode marks a new route file');
  const mw = sm.tier({ paths: ['server/middleware/newGuard.js'], diffText: diffFor('server/middleware/newGuard.js', ['module.exports = () => {};'], { isNew: true }) });
  assert.deepStrictEqual(mw.floors.sort(), ['access-egress', 'seams'], 'and a new middleware file');
  const renamed = 'diff --git a/server/utils/h.js b/server/routes/h.js\nsimilarity index 100%\nrename from server/utils/h.js\nrename to server/routes/h.js\n';
  const r = sm.tier({ paths: ['server/routes/h.js'], diffText: renamed });
  assert.deepStrictEqual(Object.keys(r.tiersByFile).sort(), ['server/routes/h.js', 'server/utils/h.js'], 'the rename source joins the set');
  assert.deepStrictEqual(r.floors.sort(), ['access-egress', 'seams'], 'a rename into server/routes/ is a new route file');
  const edited = sm.tier({ paths: ['server/routes/blog.js'], diffText: plain(['server/routes/blog.js']) });
  assert.deepStrictEqual(edited.floors, ['seams'], 'an edited route file is not new');
});

test('L2: paths are made canonical, and one that leaves the repo root is unclassified', () => {
  for (const p of ['././server/utils/stripeClient.js', 'server/x/../utils/stripeClient.js', '  ./server/utils/stripeClient.js  ', 'server//utils/stripeClient.js']) {
    assert.ok(sm.isSensitive([p]), p);
    assert.strictEqual(sm.tier({ paths: [p], diffText: '' }).tier, 'A', p);
  }
  assert.strictEqual(sm.isDocsOnly(['docs/../server/routes/blog.js']), false);
  assert.strictEqual(sm.tier({ paths: ['docs/../server/routes/blog.js'], diffText: plain(['server/routes/blog.js']) }).tier, 'B');
  for (const p of ['../server/routes/x.js', '/docs/x.md', 'docs/../../x.md', '../docs/x.md', '..']) {
    const t = sm.tier({ paths: [p], diffText: '' });
    assert.strictEqual(t.tier, 'hinge', p);
    assert.strictEqual(t.docsOnly, false, p);
    assert.strictEqual(sm.isDocsOnly([p]), false, p);
    assert.strictEqual(sm.isDocsOnly(['docs/x.md', p]), false, p);
  }
});

test('M5: the content rule sees .jsx, .cjs and .sql code; tests stay out', () => {
  for (const p of ['client/src/pages/TipPage.jsx', 'server/scripts/repairX.sql', 'server/utils/x.cjs', 'scripts/x.mjs', 'scripts/x.sh', 'server/x.js']) assert.ok(sm.isCodePath(p), p);
  for (const p of ['client/src/pages/TipPage.test.jsx', 'server/x.test.js', 'scripts/content-rule-calibrate.js', 'client/src/index.css', 'client/public/x.js', 'docs/x.sql']) assert.ok(!sm.isCodePath(p), p);
  const jsx = diffFor('client/src/pages/TipPage.jsx', ['const owed = Number(p.total_price) - Number(p.amount_paid);']);
  assert.strictEqual(sm.contentRuleHits(jsx).length, 1, '.jsx');
  assert.strictEqual(sm.tier({ paths: ['client/src/pages/TipPage.jsx'], diffText: jsx }).tier, 'A');
  assert.strictEqual(sm.tier({ paths: ['client/src/pages/TipPage.jsx'], diffText: plain(['client/src/pages/TipPage.jsx']) }).tier, 'C');
  assert.ok(!sm.isSensitive(['server/db/fixX.sql']), 'fixture is unlisted (server/scripts/*.sql is listed)');
  const sql = diffFor('server/db/fixX.sql', ['UPDATE proposals SET total_price = 0 WHERE id = 1;']);
  assert.strictEqual(sm.contentRuleHits(sql).length, 1, '.sql');
  assert.strictEqual(sm.tier({ paths: ['server/db/fixX.sql'], diffText: sql }).tier, 'A');
  assert.strictEqual(sm.tier({ paths: ['server/db/fixX.sql'], diffText: diffFor('server/db/fixX.sql', ['SELECT 1;']) }).tier, 'B');
  for (const p of ['scripts/reports/y.sql', 'scripts/x.cjs', 'scripts/x.jsx']) {
    assert.ok(!sm.isSensitive([p]), `${p} fixture is unlisted`);
    assert.strictEqual(sm.tier({ paths: [p], diffText: diffFor(p, ['SELECT 1;']) }).tier, 'hinge', `${p}: the contract's B for scripts/ is .js, .mjs and .sh only`);
  }
  assert.strictEqual(sm.contentRuleHits(diffFor('client/src/pages/TipPage.test.jsx', ['const t = p.total_price;'])).length, 0, 'a .test.jsx never fires');
});

function hunkDiff(filePath, body) {
  return [`diff --git a/${filePath} b/${filePath}`, 'index 0000000..1111111 100644', `--- a/${filePath}`, `+++ b/${filePath}`, '@@ -10,4 +10,5 @@', ...body, ''].join('\n');
}

test('L1: a status write under a money-table UPDATE in the context fires; SQL keywords ignore case; camelCase helpers and getStripe() fire', () => {
  const underExisting = hunkDiff('server/routes/x.js', [
    '   await client.query(`UPDATE proposals',
    '-     SET archived_reason = $2',
    '+     SET archived_reason = $2,',
    "+         status = 'archived'",
    '      WHERE id = $1`, [id, reason]);',
  ]);
  const h = sm.contentRuleHits(underExisting);
  assert.deepStrictEqual(h.map((x) => [x.text.trim(), x.rule]), [["status = 'archived'", 'update-money-table']]);
  assert.strictEqual(sm.tier({ paths: ['server/routes/x.js'], diffText: underExisting }).tier, 'A');

  assert.deepStrictEqual(sm.contentRuleHits(diffFor('server/routes/x.js', ["await q(`update proposals set status = 'archived' where id = $1`, [id]);"])).map((x) => x.rule), ['update-money-table'], 'lower-case SQL');
  for (const [line, rule] of [
    ['const rate = deriveGratuityRate(body);', 'money-helper'],
    ['await executeRefund(client, proposalId);', 'money-helper'],
    ['const totals = calculateProposal(pkg, opts);', 'money-helper'],
    ['const pi = await getStripe().paymentIntents.create({ amount });', 'stripe-call'],
  ]) {
    assert.deepStrictEqual(sm.contentRuleHits(diffFor('server/utils/y.js', [line])).map((x) => x.rule), [rule], line);
  }

  assert.strictEqual(sm.contentRuleHits(hunkDiff('server/routes/x.js', [
    '   await client.query(`UPDATE events',
    "+     SET status = 'archived'",
    '      WHERE id = $1`, [id]);',
  ])).length, 0, 'a status write on a table outside the money set is not the A rule');
  assert.strictEqual(sm.contentRuleHits(hunkDiff('server/routes/x.js', [
    '   await client.query(`UPDATE proposals SET notes = $2 WHERE id = $1`, [id, n]);',
    "+  const label = 'saved';",
  ])).length, 0, 'an UPDATE in the context arms nothing without a status or money write');
});

test('L1: the CLI carries enough context for a write well below its UPDATE', () => {
  const r = tempRepo();
  const sets = Array.from({ length: 14 }, (_, i) => `         col_${i} = $${i + 3},`);
  const before = ['module.exports = async (client, id, reason) => {', '  await client.query(`UPDATE proposals', '     SET archived_reason = $2,', ...sets, '         updated_at = NOW()', '   WHERE id = $1`, [id, reason]);', '};', ''];
  r.write('server/routes/archive.js', before.join('\n'));
  const c1 = r.commit(['server/routes/archive.js'], 'c1');
  const after = before.slice();
  after.splice(after.indexOf('         updated_at = NOW()'), 1, '         updated_at = NOW(),', "         status = 'archived'");
  r.write('server/routes/archive.js', after.join('\n'));
  const c2 = r.commit(['server/routes/archive.js'], 'c2');
  const res = cli(r.dir, ['--tier', '--base', c1, '--tip', c2]);
  assert.strictEqual(res.code, 0, res.err);
  assert.strictEqual(res.json.tier, 'A');
  assert.ok(res.json.contentRuleHits.some((x) => x.rule === 'update-money-table'), 'the UPDATE 17 lines up is in the hunk context');
});

test('L5: any other status write lifts a code file to at least B; heavier tiers and tests stay put', () => {
  const lifted = sm.tier({ paths: ['client/src/pages/Foo.js'], diffText: diffFor('client/src/pages/Foo.js', ["row.status = 'archived';"]) });
  assert.strictEqual(lifted.tier, 'B', 'a client status write is B, not C');
  assert.deepStrictEqual(lifted.tiersByFile, { 'client/src/pages/Foo.js': 'B' });
  assert.deepStrictEqual(lifted.contentRuleHits, [], 'not the tier A rule');
  assert.deepStrictEqual(lifted.statusWrites, [{ file: 'client/src/pages/Foo.js', line: 1, text: "row.status = 'archived';", rule: 'status-write' }]);
  assert.strictEqual(sm.tier({ paths: ['client/src/pages/Foo.jsx'], diffText: diffFor('client/src/pages/Foo.jsx', ["await q(`update events set status = 'done'`);"]) }).tier, 'B', 'SET status, any case');
  assert.strictEqual(sm.tier({ paths: ['client/src/pages/Foo.js'], diffText: diffFor('client/src/pages/Foo.js', ["if (status === 'paid') return null;"]) }).tier, 'C', 'a comparison is not a write');
  assert.strictEqual(sm.tier({ paths: ['client/src/pages/Foo.js'], diffText: plain(['client/src/pages/Foo.js']) }).tier, 'C');
  assert.strictEqual(sm.tier({ paths: ['scripts/merge-lane.sh'], diffText: diffFor('scripts/merge-lane.sh', ["status='merged'"]) }).tier, 'hinge', 'hinge outranks B');
  assert.strictEqual(sm.tier({ paths: ['client/src/pages/Foo.test.js'], diffText: diffFor('client/src/pages/Foo.test.js', ["row.status = 'archived';"]) }).tier, 'C', 'tests never lift');
  assert.strictEqual(sm.tier({ paths: ['scripts/sensitive-match.test.js'], diffText: diffFor('scripts/sensitive-match.test.js', ["row.status = 'archived';"]) }).tier, 'hinge', 'scripts tests stay hinge');
});

test("M6: the calibration prints the rule alone against the plan's floor and the adopted measure with its own verdict", () => {
  const cal = require('./content-rule-calibrate');
  const counts = { selected: 401, distinctCommits: 230, hits: 268, hitOrListed: 361, hitOrFlip: 371, unlisted: 38, unlistedHit: 8, misses: [], since: '2026-10-01', docsCommits: 229, docsHits: 0 };
  const r = cal.summarize(counts);
  assert.strictEqual(r.recall_rule_alone, 66.8);
  assert.strictEqual(r.floor, 85);
  assert.strictEqual(r.floor_rule_alone_met, false);
  assert.strictEqual(r.rule_or_listed_today, 90);
  assert.strictEqual(r.rule_or_listed_after_flip, 92.5);
  assert.strictEqual(r.floor_combined_met_today, true);
  assert.strictEqual(r.floor_combined_met_after_flip, true);
  assert.ok(!('recall' in r) && !('floor_measure' in r), 'no field that names one measure while holding another');
  const text = cal.formatReport(r, '2026-10-20').join('\n');
  assert.match(text, /content rule alone \(the plan's letter\): 66\.8% \(268 of 401\)\s+floor 85%\s+BELOW FLOOR$/m);
  assert.match(text, /sensitive list OR rule \(the adopted measure\), today: 90%\s+floor 85%\s+OK$/m);
  assert.match(text, /sensitive list OR rule \(the adopted measure\), after the flip's list additions: 92\.5%\s+floor 85%\s+OK$/m);
  assert.match(text, /docs-only commits since 2026-10-01: 229, content-rule hits: 0 OK$/m);
  const met = cal.formatReport(cal.summarize({ ...counts, hits: 345, hitOrListed: 330 }), '2026-10-20').join('\n');
  assert.match(met, /content rule alone \(the plan's letter\): 86\% \(345 of 401\)\s+floor 85%\s+OK$/m);
  assert.match(met, /today: 82\.3%\s+floor 85%\s+BELOW FLOOR$/m, 'the adopted measure has its own verdict');
  assert.match(cal.formatReport(cal.summarize({ ...counts, docsHits: 2 }), 'd').join('\n'), /content-rule hits: 2 UNEXPECTED$/m);
});

// ---- fix pass after review 2 (M1, L1-L5; security S-L1 to S-L8) ---------------------

// A file whose added status write sits 11 lines under its UPDATE: out of reach of
// a -U3 or -U10 diff, in reach of the DIFF_CONTEXT_LINES the git half asks for.
function writeUnderUpdate(r) {
  const cols = Array.from({ length: 9 }, (_, i) => `         col_${i} = $${i + 3},`);
  const before = ['module.exports = async (client, id, reason) => {', '  await client.query(`UPDATE proposals', '     SET archived_reason = $2,', ...cols, '         updated_at = NOW()', '   WHERE id = $1`, [id, reason]);', '};', ''];
  r.write('server/routes/archive.js', before.join('\n'));
  const c1 = r.commit(['server/routes/archive.js'], 'c1');
  const after = before.slice();
  after.splice(after.indexOf('         updated_at = NOW()'), 0, "         status = 'archived',");
  assert.strictEqual(after.indexOf("         status = 'archived',") - after.indexOf('  await client.query(`UPDATE proposals'), 11, 'fixture: 11 lines under the UPDATE');
  r.write('server/routes/archive.js', after.join('\n'));
  const c2 = r.commit(['server/routes/archive.js'], 'c2');
  return { c1, c2 };
}

test('M1 (review 2): tierFromGit is the git half the CLI runs, exported for review-select', () => {
  const r = tempRepo();
  const { c1, c2 } = writeUnderUpdate(r);
  const lib = sm.tierFromGit({ base: c1, tip: c2 }, { cwd: r.dir });
  assert.strictEqual(lib.tier, 'A', 'a status write 11 lines under its UPDATE');
  assert.ok(lib.contentRuleHits.some((h) => h.rule === 'update-money-table'));
  const out = cli(r.dir, ['--tier', '--base', c1, '--tip', c2]);
  assert.strictEqual(out.code, 0, out.err);
  assert.deepStrictEqual(lib, out.json, 'the same result object the CLI prints');

  r.write('server/routes/archive.js', fs.readFileSync(path.join(r.dir, 'server/routes/archive.js'), 'utf8') + 'const owed = p.total_price;\n');
  r.g('add', '--', 'server/routes/archive.js');
  const staged = sm.tierFromGit({ staged: true }, { cwd: r.dir });
  assert.strictEqual(staged.tier, 'A');
  assert.deepStrictEqual(staged, cli(r.dir, ['--tier', '--staged']).json, 'the staged form too');

  for (const [label, range] of [
    ['an unknown ref', { base: 'no-such-ref', tip: c2 }],
    ['a flag for a ref', { base: '--output=x', tip: c2 }],
    ['a blob for a ref', { base: `${c2}:server/routes/archive.js`, tip: c2 }],
    ['no range', {}],
    ['base alone', { base: c1 }],
    ['both forms', { staged: true, base: c1, tip: c2 }],
  ]) {
    assert.throws(() => sm.tierFromGit(range, { cwd: r.dir }), /^Error: tierFromGit: /, label);
  }
  assert.ok(!fs.existsSync(path.join(r.dir, 'x')), 'git never wrote a file');

  const elsewhere = tempDir('sensitive-cli-');
  const res = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(SCRIPT)}).tierFromGit({ base: 'HEAD', tip: 'HEAD' }).tier)`], { cwd: elsewhere, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stdout, 'hinge', 'the default cwd is the repo the script lives in, not the process cwd');
});

test('S-L1: GIT_DIFF_OPTS and GIT_EXTERNAL_DIFF in the environment change nothing', () => {
  const r = tempRepo();
  const before = ['module.exports = async (client, id) => {', '  await client.query(`UPDATE proposals', '     SET archived_reason = $2,', '         col_a = $3,', '         updated_at = NOW()', '   WHERE id = $1`, [id]);', '};', ''];
  r.write('server/routes/archive.js', before.join('\n'));
  const c1 = r.commit(['server/routes/archive.js'], 'c1');
  const after = before.slice();
  after.splice(after.indexOf('         updated_at = NOW()'), 0, "         status = 'archived',");
  r.write('server/routes/archive.js', after.join('\n'));
  const c2 = r.commit(['server/routes/archive.js'], 'c2');
  const marker = path.join(r.dir, 'ext-diff-ran');
  const driver = path.join(r.dir, 'ext-diff.sh');
  fs.writeFileSync(driver, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const env = { ...process.env, GIT_DIFF_OPTS: '-u0', GIT_EXTERNAL_DIFF: driver };
  const res = spawnSync(process.execPath, [SCRIPT, '--tier', '--base', c1, '--tip', c2], { cwd: r.dir, encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(JSON.parse(res.stdout).tier, 'A', 'the CLI: a status write 3 lines under its UPDATE');
  const saved = { opts: process.env.GIT_DIFF_OPTS, ext: process.env.GIT_EXTERNAL_DIFF };
  process.env.GIT_DIFF_OPTS = '-u0';
  process.env.GIT_EXTERNAL_DIFF = driver;
  try {
    assert.strictEqual(sm.tierFromGit({ base: c1, tip: c2 }, { cwd: r.dir }).tier, 'A', 'tierFromGit');
    const cal = require('./content-rule-calibrate');
    const shown = cal.showDiff('d6f02e8c');
    assert.ok(shown.split('\n').some((l) => l.startsWith(' ')), 'the calibration keeps its context lines');
  } finally {
    if (saved.opts === undefined) delete process.env.GIT_DIFF_OPTS; else process.env.GIT_DIFF_OPTS = saved.opts;
    if (saved.ext === undefined) delete process.env.GIT_EXTERNAL_DIFF; else process.env.GIT_EXTERNAL_DIFF = saved.ext;
  }
  assert.ok(!fs.existsSync(marker), 'the external driver never ran');
});

test('S-L4: an untracked file named like a ref never makes the range ambiguous', () => {
  const r = tempRepo();
  r.write('server/routes/x.js', 'module.exports = 1;\n');
  r.commit(['server/routes/x.js'], 'c1');
  r.write('server/routes/x.js', 'module.exports = 2;\n');
  const c2 = r.commit(['server/routes/x.js'], 'c2');
  for (const name of ['main', 'HEAD', c2]) fs.writeFileSync(path.join(r.dir, name), 'untracked\n');
  const lib = sm.tierFromGit({ base: 'main~1', tip: 'main' }, { cwd: r.dir });
  assert.strictEqual(lib.tier, 'B');
  const out = cli(r.dir, ['--tier', '--base', 'HEAD~1', '--tip', 'HEAD']);
  assert.strictEqual(out.code, 0, out.err);
  assert.deepStrictEqual(out.json, lib);
});

test('L1 (review 2): one hit shape {file, line, text, rule}, line the new-file line number', () => {
  const twoHunks = [
    'diff --git a/server/routes/x.js b/server/routes/x.js',
    'index 0000000..1111111 100644',
    '--- a/server/routes/x.js',
    '+++ b/server/routes/x.js',
    '@@ -10,4 +10,5 @@ function pay() {',
    '   const a = 1;',
    '-  const owed = 0;',
    '+  const owed = p.total_price;',
    '+  const paid = p.amount_paid;',
    '   return owed;',
    '@@ -40,2 +41,3 @@',
    '   const b = 2;',
    '+  await stripe.refunds.create({ payment_intent: id });',
    '',
  ].join('\n');
  const hits = sm.contentRuleHits(twoHunks);
  for (const h of hits) assert.deepStrictEqual(Object.keys(h).sort(), ['file', 'line', 'rule', 'text']);
  assert.deepStrictEqual(hits, [
    { file: 'server/routes/x.js', line: 11, text: '  const owed = p.total_price;', rule: 'money-column' },
    { file: 'server/routes/x.js', line: 12, text: '  const paid = p.amount_paid;', rule: 'money-column' },
    { file: 'server/routes/x.js', line: 42, text: '  await stripe.refunds.create({ payment_intent: id });', rule: 'stripe-call' },
  ]);

  assert.deepStrictEqual(sm.tier({ paths: ['server/routes/blog.js'], diffText: '' }).contentRuleHits, [{ file: 'server/routes/blog.js', line: 0, text: '', rule: 'diff-unparsed' }]);
  assert.deepStrictEqual(sm.tier({ paths: [], diffText: 'diff --git server/routes/x.js server/routes/x.js\n+++ server/routes/x.js\n@@ -0,0 +1 @@\n+const a = 1;\n' }).contentRuleHits,
    [{ file: null, line: 0, text: '', rule: 'diff-unparsed' }], 'file null: a section with no readable path');

  const lifted = sm.tier({ paths: ['client/src/pages/Foo.js'], diffText: hunkDiff('client/src/pages/Foo.js', ['   const x = 1;', "+  row.status = 'archived';"]) });
  assert.deepStrictEqual(lifted.statusWrites, [{ file: 'client/src/pages/Foo.js', line: 11, text: "  row.status = 'archived';", rule: 'status-write' }]);

  for (const line of ['const rate = deriveGratuityRate(body);', 'const totals = calculateProposal(pkg, opts);', 'await executeRefund(client, proposalId);']) {
    assert.deepStrictEqual(sm.contentRuleHits(diffFor('server/utils/y.js', [line])).map((x) => x.rule), ['money-helper'], line);
  }
});

test('L4 (review 2): a status comparison or query string is not a status write', () => {
  const foo = 'client/src/pages/Foo.js';
  for (const line of [
    "const rows = await q(`SELECT id FROM events WHERE status = 'sent'`);",
    'const r = await api.get(`/admin/proposals?status=${key}`);',
    "const url = `/admin/events?page=2&status='open'`;",
    "  and status = $1",
    "   WHERE id = $1 AND\tstatus = 'sent'",
    "   OR status = 'viewed'",
  ]) {
    const t = sm.tier({ paths: [foo], diffText: diffFor(foo, [line]) });
    assert.strictEqual(t.tier, 'C', line);
    assert.deepStrictEqual(t.statusWrites, [], line);
  }
  for (const [label, diffText] of [
    ['SET status', diffFor(foo, ["await q(`UPDATE events SET status = 'archived' WHERE id = $1`);"])],
    ['SET status with a WHERE guard', diffFor(foo, ["await q(`UPDATE events SET status = 'done' WHERE status = 'sent'`);"])],
    ['a later column of one SET line', diffFor(foo, ["await q(`UPDATE events SET notes = $2, status = 'archived' WHERE id = $1`);"])],
    ['inside an UPDATE', hunkDiff(foo, ['   await q(`UPDATE events', '     SET notes = $2,', "+        status = 'archived',", '         updated_at = NOW()', '    WHERE id = $1`);'])],
  ]) {
    const t = sm.tier({ paths: [foo], diffText });
    assert.strictEqual(t.tier, 'B', label);
    assert.strictEqual(t.statusWrites.length, 1, label);
  }
  const guard = sm.tier({ paths: ['server/utils/g.js'], diffText: hunkDiff('server/utils/g.js', ['   await q(`UPDATE shifts SET notes = $2', "+     WHERE id = $1 AND status = 'open'`);"]) });
  assert.deepStrictEqual(guard.contentRuleHits.map((h) => h.rule), ['update-money-table'], 'a status guard on a money-table UPDATE still fires the A rule');
  assert.deepStrictEqual(guard.statusWrites, [], 'but it is not a status write');
});

test('R1-L1: quoted and schema-qualified money tables, an upsert on one, and status = CASE or COALESCE(', () => {
  const g = 'server/utils/g.js';
  const rules = (diffText) => sm.contentRuleHits(diffText).map((h) => h.rule);
  for (const line of [
    "await q(`UPDATE \"proposals\" SET status = 'archived' WHERE id = $1`);",
    "await q(`UPDATE public.proposals SET status = 'archived' WHERE id = $1`);",
    "await q(`UPDATE \"public\".\"shifts\" SET status = 'open' WHERE id = $1`);",
  ]) {
    assert.deepStrictEqual(rules(diffFor(g, [line])), ['update-money-table'], line);
  }
  assert.deepStrictEqual(rules(diffFor(g, ["await q(`UPDATE proposals_archive SET status = 'x'`);"])), [], 'a longer table name is not a money table');

  const upsertAdded = diffFor(g, ['await q(`INSERT INTO shifts (proposal_id, status) VALUES ($1, $2)', "   ON CONFLICT (proposal_id) DO UPDATE SET status = 'open'`, [id, s]);"]);
  assert.deepStrictEqual(rules(upsertAdded), ['update-money-table', 'update-money-table'], 'an upsert on a money table, all added');
  const upsertUnder = hunkDiff(g, ['   await q(`INSERT INTO "public".shifts (proposal_id, status)', '      VALUES ($1, $2)', "+     ON CONFLICT (proposal_id) DO UPDATE SET status = EXCLUDED.status`, [id, s]);"]);
  assert.deepStrictEqual(rules(upsertUnder), ['update-money-table'], 'DO UPDATE SET status added under an INSERT INTO a money table');
  assert.deepStrictEqual(rules(diffFor(g, ['await q(`INSERT INTO events (id, status) VALUES ($1, $2)', "   ON CONFLICT (id) DO UPDATE SET status = 'open'`);"])), [], 'an upsert on another table');
  assert.deepStrictEqual(rules(diffFor(g, ["await q(`INSERT INTO shifts (proposal_id, status) VALUES ($1, 'open')`);"])), [], 'a plain INSERT is not the update rule');

  for (const line of ['       status = COALESCE($9, status),', "       status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END"]) {
    assert.deepStrictEqual(rules(hunkDiff(g, ['   await q(`UPDATE shifts SET notes = $2,', '+' + line, '    WHERE id = $1`);'])), ['update-money-table'], line);
    const c = sm.tier({ paths: ['client/src/pages/Foo.js'], diffText: diffFor('client/src/pages/Foo.js', [line]) });
    assert.strictEqual(c.tier, 'B', `${line}: a status write lifts a client file`);
  }
});

test('S-L7: a Stripe call fires however deep the resource path', () => {
  for (const line of [
    'const s = await stripe.checkout.sessions.create({ mode: "payment" });',
    'const s = await getStripe().checkout.sessions.retrieve(id);',
    'const r = await stripe.refunds.create({ payment_intent: id });',
    'const e = stripe.webhooks.constructEvent(body, sig, secret);',
  ]) {
    assert.deepStrictEqual(sm.contentRuleHits(diffFor('server/utils/z.js', [line])).map((h) => h.rule), ['stripe-call'], line);
  }
  assert.deepStrictEqual(sm.contentRuleHits(diffFor('server/utils/z.js', ["const stripe = require('./stripeClient');"])), [], 'naming the client is not a call');
});

test('S-L2: header typos throw; the list prose that opens with "section" stays a comment', () => {
  for (const bad of ['## section: money', '# section client money surfaces', '# [section: money]', '# -- section: money --', '# section = money', '#  section - money', '# section auth-and-pii', '# section payroll']) {
    const list = fixtureList(`server/a.js\n# section: hinge\nscripts/x.sh\n${bad}\nserver/utils/pricingEngine.js\n`);
    assert.throws(() => sm.loadPatterns(list), /line 4/, bad);
  }
  // Lines 472 and 580 of scripts/sensitive-paths.txt today, verbatim.
  for (const prose of ['# section 8). The webauthn routes mint sessions; AuthContext and', '# sections 5.1 and 13; lane menu-art-foundation). The only modules that reach']) {
    assert.deepStrictEqual(sm.loadPatterns(fixtureList(`${prose}\nserver/a.js\n`)).map((p) => [p.pattern, p.section]), [['server/a.js', 'money']], prose);
  }
  assert.ok(sm.loadPatterns().length > 0, 'the real list loads');
  assert.deepStrictEqual(sm.loadPatterns(fixtureList('#section:hinge\nscripts/x.sh\n# Section: Money\nserver/a.js\n')).map((p) => p.section), ['hinge', 'money'], 'well-formed headers still read');
});

test('S-L3: a non-empty diff that parses to no section, with no paths, fails closed to A', () => {
  for (const [label, diffText] of [
    ['colour', '\u001b[1mdiff --git a/server/routes/x.js b/server/routes/x.js\u001b[m\n\u001b[32m+UPDATE proposals SET amount_paid = 1\u001b[m\n'],
    ['plain diff -u', '--- server/routes/x.js\t2026-10-20\n+++ server/routes/x.js\t2026-10-20\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n'],
    ['combined', 'diff --cc server/routes/x.js\nindex 1111111,2222222..3333333\n@@@ -1,1 -1,1 +1,1 @@@\n- const a = 1;\n -const a = 2;\n++const a = 3;\n'],
  ]) {
    for (const t of [sm.tier({ paths: [], diffText }), sm.tier({ diffText })]) {
      assert.strictEqual(t.tier, 'A', label);
      assert.deepStrictEqual(t.contentRuleHits, [{ file: null, line: 0, text: '', rule: 'diff-unparsed' }], label);
    }
  }
  assert.strictEqual(sm.tier({ paths: [], diffText: '\n  \n' }).tier, 'hinge', 'a blank diff with no paths is the empty case');
});

test('S-L6: the calibration leaves diff-unparsed hits out of recall and the docs count, and reports them', () => {
  const cal = require('./content-rule-calibrate');
  const u = { file: null, line: 0, text: '', rule: 'diff-unparsed' };
  const m = { file: 'server/x.js', line: 3, text: 'const a = p.total_price;', rule: 'money-column' };
  assert.deepStrictEqual(cal.splitHits([u]), { fired: false, real: 0, unparsed: 1 });
  assert.deepStrictEqual(cal.splitHits([u, m, m]), { fired: true, real: 2, unparsed: 1 });
  assert.deepStrictEqual(cal.splitHits([]), { fired: false, real: 0, unparsed: 0 });
  const counts = { selected: 401, distinctCommits: 230, hits: 268, hitOrListed: 361, hitOrFlip: 371, unlisted: 38, unlistedHit: 8, misses: [], since: '2026-10-01', docsCommits: 229, docsHits: 0 };
  const zero = cal.summarize(counts);
  assert.strictEqual(zero.diff_unparsed_hits_in_fix_commits, 0);
  assert.strictEqual(zero.diff_unparsed_hits_in_docs_commits, 0);
  assert.match(cal.formatReport(zero, 'd').join('\n'), /^ {2}diff-unparsed hits \(left out of both counts\): 0 in the fix commits, 0 in the docs-only commits$/m);
  const some = cal.summarize({ ...counts, unparsedFix: 3, unparsedDocs: 1 });
  assert.match(cal.formatReport(some, 'd').join('\n'), /diff-unparsed hits \(left out of both counts\): 3 in the fix commits, 1 in the docs-only commits$/m);
});

test('STATUS_WRITE is exported for the lens triggers: a parameterized or lowercase status write fires, a WHERE guard does not', () => {
  const { STATUS_WRITE } = require('./sensitive-match');
  assert.ok(STATUS_WRITE instanceof RegExp, 'STATUS_WRITE is exported as a RegExp');
  assert.ok(STATUS_WRITE.test('update leads set note = $1, status = $2'), 'a parameterized lowercase write');
  assert.ok(STATUS_WRITE.test("UPDATE proposals SET status = 'sent'"), 'the plan form');
  assert.ok(!STATUS_WRITE.test("SELECT 1 FROM proposals WHERE status = 'sent'"), 'a guard is not a write');
});

test('gitEnv neutralizes replace refs, so tierFromGit reads the real tip (review-tooling security L3)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const SM = require('./sensitive-match');
  assert.strictEqual(SM.gitEnv({}).GIT_NO_REPLACE_OBJECTS, '1', 'the env var is set');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-replace-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', ['t', 'example.com'].join('@'));
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server/x.js'), 'const a = 1;\n');
    git('add', 'server/x.js');
    git('commit', '-q', '-m', 'A');
    const A = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'server/x.js'), "const a = 1;\nawait stripe.refunds.create({ payment_intent: id });\n");
    git('add', 'server/x.js');
    git('commit', '-q', '-m', 'B');
    const B = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'server/x.js'), 'const a = 1;\nconst b = 2;\n');
    git('add', 'server/x.js');
    git('commit', '-q', '-m', 'C');
    const C = git('rev-parse', 'HEAD');
    git('replace', B, C);
    assert.strictEqual(SM.tierFromGit({ base: A, tip: B }, { cwd: dir }).tier, 'A', 'the real B carries a Stripe call: tier A, not the replacement');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
