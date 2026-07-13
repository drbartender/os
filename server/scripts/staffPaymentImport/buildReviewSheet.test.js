// End-to-end review-sheet builder test. Assembles a temp share dir from the
// per-parser fixtures in the real layout (.txt = pre-extracted pdftotext output
// for Cash App / Chase), then drives the orchestrator and asserts on every
// output surface. Pure, no DB.
// Run: node --test server/scripts/staffPaymentImport/buildReviewSheet.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./buildReviewSheet');

const FX = path.join(__dirname, '__fixtures__');
function cp(src, destAbs) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(path.join(FX, src), destAbs);
}

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sph-share-'));
  cp('venmo-business.csv', path.join(dataDir, 'apr-2025-statement.csv'));
  cp('venmo-personal.csv', path.join(dataDir, 'New folder', 'may-2025-statement.csv'));
  cp('cashapp-sample.txt', path.join(dataDir, 'June 2025.txt'));
  cp('chase-sample.txt', path.join(dataDir, 'Chase Statements Dec2024-Jun2026', 'Dr Bartending LLC - 6835', '2025-08 August.txt'));
  cp('paypal-sample.csv', path.join(dataDir, 'Download (1).CSV'));
  cp('cc-expenses.csv', path.join(dataDir, 'cc-expenses.csv'));
  cp('cc-contacts.csv', path.join(dataDir, 'cc-contacts.csv'));
  cp('cc-bookings.csv', path.join(dataDir, 'cc-bookings.csv'));
  const reviewDir = path.join(dataDir, 'review');
  fs.mkdirSync(reviewDir, { recursive: true });
  // known-people: an approved staffer whose phone matches the CC "Test Person"
  // phone → exercises existing:<id> prefill AND the PHONE COLLISION check.
  fs.writeFileSync(path.join(reviewDir, 'known-people.csv'),
    'user_id,name,preferred_name,email,phone,onboarding_status\n'
    + '42,Test Person,Test Person,test.person@example.com,(555) 100-2000,approved\n');
  return { dataDir, reviewDir };
}

test('orchestrator produces all four output files', () => {
  const { dataDir, reviewDir } = setup();
  const s = run({ dataDir, reviewDir });
  for (const f of ['transactions.csv', 'people.csv', '.manifest.json', 'coverage-report.txt']) {
    assert.ok(fs.existsSync(path.join(reviewDir, f)), `missing ${f}`);
  }
  assert.ok(s.transactions > 0);
  assert.strictEqual(s.ccReportsFound.expenses, true);
});

test('people.csv carries the cluster with CC contact info + existing:<id>', () => {
  const { dataDir, reviewDir } = setup();
  run({ dataDir, reviewDir });
  const people = fs.readFileSync(path.join(reviewDir, 'people.csv'), 'utf8');
  const line = people.split('\n').find((l) => l.startsWith('test person'));
  assert.ok(line, 'people.csv has a test person cluster');
  assert.match(line, /test\.person@example\.com/);
  assert.match(line, /existing:42/); // matched to the known-people OS user
});

test('transactions.csv marks dictionary payees staff-pay and CC-only as cash_other/unsure', () => {
  const { dataDir, reviewDir } = setup();
  run({ dataDir, reviewDir });
  const txn = fs.readFileSync(path.join(reviewDir, 'transactions.csv'), 'utf8').split('\n');
  const staffPay = txn.filter((l) => /,staff-pay,/.test(l));
  assert.ok(staffPay.length >= 2, 'has staff-pay rows (Test Person + Test Freyer)');
  const cashOther = txn.filter((l) => /cash_other,cc_expense_log/.test(l));
  assert.ok(cashOther.length >= 1, 'has a cash_other CC-only row');
  assert.ok(cashOther.every((l) => /,unsure,/.test(l)), 'cash_other rows are unsure');
});

test('manifest holds canonical facts keyed by fingerprint', () => {
  const { dataDir, reviewDir } = setup();
  run({ dataDir, reviewDir });
  const manifest = JSON.parse(fs.readFileSync(path.join(reviewDir, '.manifest.json'), 'utf8'));
  const keys = Object.keys(manifest);
  assert.ok(keys.length > 0);
  assert.ok(keys.every((k) => k.startsWith('fp-')));
  const one = manifest[keys[0]];
  assert.ok('amount_cents' in one && 'platform' in one && 'post_boundary' in one);
});

test('coverage report lists the unmatched Chase mirrors + phone collision', () => {
  const { dataDir, reviewDir } = setup();
  const s = run({ dataDir, reviewDir });
  const cov = fs.readFileSync(path.join(reviewDir, 'coverage-report.txt'), 'utf8');
  assert.match(cov, /MISSING EXPORT\?/);
  assert.ok(s.missingExport >= 1, 'at least one unmatched mirror');
  assert.match(cov, /mirror-of=(venmo|cashapp|paypal)/);
  assert.ok(s.phoneCollisions >= 1, 'phone collision detected');
  assert.match(cov, /PHONE COLLISION/);
});

test('PayPal fixture rows all currency-resolve (no unresolved)', () => {
  const { dataDir, reviewDir } = setup();
  const s = run({ dataDir, reviewDir });
  assert.strictEqual(s.unresolvedCurrency, 0);
});

test('re-run preserves Dallas edits to verdict/person by fingerprint', () => {
  const { dataDir, reviewDir } = setup();
  run({ dataDir, reviewDir });
  const txnPath = path.join(reviewDir, 'transactions.csv');
  const lines = fs.readFileSync(txnPath, 'utf8').split('\n');
  // Flip an unsure row to staff-pay with a hand-entered cluster.
  const idx = lines.findIndex((l) => /,unsure,/.test(l));
  assert.ok(idx > 0);
  const cols = lines[idx].split(',');
  const fp = cols[0];
  cols[9] = 'dallas cluster';   // person_cluster
  cols[10] = 'staff-pay';       // verdict
  lines[idx] = cols.join(',');
  fs.writeFileSync(txnPath, lines.join('\n'));

  run({ dataDir, reviewDir }); // re-run
  const after = fs.readFileSync(txnPath, 'utf8').split('\n').find((l) => l.startsWith(fp));
  assert.match(after, /,staff-pay,/);
  assert.match(after, /dallas cluster/);
});

test('re-run preserves Dallas boundary_exception=yes AND event_label edits', () => {
  const { dataDir, reviewDir } = setup();
  run({ dataDir, reviewDir });
  const txnPath = path.join(reviewDir, 'transactions.csv');
  const lines = fs.readFileSync(txnPath, 'utf8').split('\n');
  // Pick a clean 17-column data row (no embedded commas) to edit in place.
  const idx = lines.findIndex((l, i) => i > 0 && l.split(',').length === 17);
  assert.ok(idx > 0);
  const cols = lines[idx].split(',');
  const fp = cols[0];
  cols[12] = 'Hand Event 2099'; // event_label
  cols[16] = 'yes';            // boundary_exception
  lines[idx] = cols.join(',');
  fs.writeFileSync(txnPath, lines.join('\n'));

  run({ dataDir, reviewDir }); // regenerate
  const after = fs.readFileSync(txnPath, 'utf8').split('\n').find((l) => l.startsWith(fp)).split(',');
  assert.strictEqual(after[12], 'Hand Event 2099', 'event_label survives regeneration');
  assert.strictEqual(after[16], 'yes', 'boundary_exception survives regeneration');
});

test('a malformed routed file lands in ERRORS (loud, non-empty errors)', () => {
  const { dataDir, reviewDir } = setup();
  // Routes to the Venmo parser (root "*-statement.csv") but has no header.
  fs.writeFileSync(path.join(dataDir, 'broken-statement.csv'), 'garbage,header,row\n1,2,3\n');
  const s = run({ dataDir, reviewDir });
  assert.ok(s.errors.length >= 1, 'errors non-empty');
  assert.ok(s.errors.some((e) => /broken-statement/.test(e)), 'names the bad file');
  const cov = fs.readFileSync(path.join(reviewDir, 'coverage-report.txt'), 'utf8');
  assert.match(cov, /ERRORS \(routed files/);
});

test('a clean fixture run reports zero errors', () => {
  const { dataDir, reviewDir } = setup();
  const s = run({ dataDir, reviewDir });
  assert.strictEqual(s.errors.length, 0);
  const cov = fs.readFileSync(path.join(reviewDir, 'coverage-report.txt'), 'utf8');
  assert.match(cov, /ERRORS \(routed files[^\n]*— 0/);
});

test('re-run people.csv aggregates the PRESERVED cluster, no ghost person rows', () => {
  const { dataDir, reviewDir } = setup();
  run({ dataDir, reviewDir });
  const txnPath = path.join(reviewDir, 'transactions.csv');
  const peoplePath = path.join(reviewDir, 'people.csv');
  const lines = fs.readFileSync(txnPath, 'utf8').split('\n');
  // Re-assign one row's cluster to an existing other cluster (a "dupe" merge).
  const idx = lines.findIndex((l, i) => i > 0 && l.split(',').length === 17 && l.split(',')[9]);
  assert.ok(idx > 0);
  const cols = lines[idx].split(',');
  const fromCluster = cols[9];
  cols[9] = 'merged target cluster';
  lines[idx] = cols.join(',');
  fs.writeFileSync(txnPath, lines.join('\n'));

  run({ dataDir, reviewDir }); // re-run
  const people = fs.readFileSync(peoplePath, 'utf8');
  // The merged-into cluster must exist as a people row...
  assert.match(people, /^merged target cluster,/m);
  // ...and if the source cluster had only that one row, it must NOT ghost:
  const txnsAfter = fs.readFileSync(txnPath, 'utf8').split('\n').slice(1);
  const stillReferenced = txnsAfter.some((l) => l.split(',')[9] === fromCluster);
  const ghostRow = people.split('\n').find((l) => l.startsWith(fromCluster + ','));
  if (!stillReferenced) assert.strictEqual(ghostRow, undefined, `ghost people row for unreferenced cluster "${fromCluster}"`);
});
