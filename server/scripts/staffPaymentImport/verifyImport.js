// Post-import verification (spec §4/§11, plan C3). READ-ONLY. Re-derives the
// expected facts from the sheet (validateSheets) and asserts the DB agrees.
// Scoped to THIS sheet's fingerprints — the shared dev DB may hold other lanes'
// rows, so verification checks the rows this import produced, not the whole table.
// Exits 1 on ANY mismatch (an incomplete verification is never a pass).
//
// Usage:
//   DOTENV_CONFIG_PATH=/home/drbartender/projects/os/.env node -r dotenv/config \
//     server/scripts/staffPaymentImport/verifyImport.js --review-dir <dir>
//
// Asserts: (1) ledger row count == sheet toImport count; (2) per contractor×year
// sum matches the sheet; (3) no rows paid_on >= boundary except boundary_exception;
// (4) every boundary_exception row matches NO payout (person+amount ±1¢, any
// status) — the no-double-count assert; (5) fingerprint uniqueness; (6) every
// contractor_id resolves to a users row with the status its account_decision implies.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { pool } = require('../../db');
const { getArg, BOUNDARY } = require('./config');
const { validateSheets, planPeopleEmails, ymd, checkBoundaryNoDoubleCount } = require('./importValidation');
const {
  loadSheet, findOrphanedFingerprints, readPriorRunLogs, readRetractions,
  findReimportedRetractions, runLogUserIds,
} = require('./importFromSheet');

const EXPECTED_STATUS = { 'create-current': 'in_progress', 'create-ex': 'deactivated' };

// Pure (E2b): ledger rows for THIS import's contractors whose fingerprint is NOT
// in (toImport ∪ retractions) are orphaned residue — a DB-side check independent
// of run logs, so a lost/deleted run log can no longer hide a stale row. `dbRows`
// carry row_fingerprint; returns the residue fingerprints (deduped, sorted).
function findLedgerResidue(dbRows, toImport, retracted = []) {
  const accounted = new Set([...toImport.map((r) => r.fingerprint), ...retracted]);
  const residue = new Set();
  for (const r of dbRows) if (!accounted.has(r.row_fingerprint)) residue.add(r.row_fingerprint);
  return [...residue].sort();
}

async function run({ reviewDir }) {
  const { manifest, people, transactions } = loadSheet(reviewDir);
  const { errors, toImport, peopleActions } = validateSheets({ manifest, people, transactions });
  const results = [];
  const fail = (msg) => results.push({ level: 'fail', msg });
  const pass = (msg) => results.push({ level: 'pass', msg });
  const warn = (msg) => results.push({ level: 'warn', msg });

  if (errors.length) { fail(`sheet no longer validates (${errors.length} errors) — cannot verify`); return report(results); }

  // (VECTOR 2 / E2) Retraction guards. Read the run logs + retraction ledger once.
  const priorRunLogs = readPriorRunLogs(reviewDir);
  const retracted = readRetractions(reviewDir);

  // (E2a) A retracted fingerprint that reappears as staff-pay must be un-retracted
  // explicitly, not silently reconciled.
  const reimported = findReimportedRetractions(toImport, retracted);
  if (reimported.length) {
    fail(`${reimported.length} fingerprint(s) are retracted but present as staff-pay in the sheet: ${reimported.join(', ')} — remove them from retractions.json to re-import`);
  }

  // A fingerprint imported by a PRIOR run but no longer in toImport and not formally
  // retracted is an orphan the insert/update-only import cannot retract — a silent
  // ledger residue. Fail loud; retraction is manual.
  const orphaned = findOrphanedFingerprints(priorRunLogs, toImport, retracted);
  if (orphaned.length) {
    fail(`${orphaned.length} orphaned fingerprint(s) from prior run logs are absent from the current sheet — retract manually: DELETE FROM staff_payment_history WHERE row_fingerprint IN (${orphaned.map((fp) => `'${fp}'`).join(', ')});`);
  } else {
    pass('no orphaned fingerprints from prior run logs');
  }

  // (E2b) The retraction ledger must not lie: if any RETRACTED fingerprint is still
  // present in staff_payment_history, the manual DELETE never happened — FAIL,
  // regardless of user scope.
  const retractedPresent = retracted.length
    ? (await pool.query('SELECT row_fingerprint FROM staff_payment_history WHERE row_fingerprint = ANY($1)', [retracted])).rows.map((r) => r.row_fingerprint)
    : [];
  if (retractedPresent.length) {
    fail(`retraction ledger is lying — ${retractedPresent.length} retracted fingerprint(s) are STILL in staff_payment_history: ${retractedPresent.join(', ')}`);
  } else if (retracted.length) {
    pass(`all ${retracted.length} retracted fingerprint(s) are absent from the ledger`);
  }

  // Resolve cluster → user id (existing ids + created/reused by email) + status.
  const clusterToEmail = planPeopleEmails(peopleActions);
  const emails = [...clusterToEmail.values()];
  const userRows = emails.length
    ? (await pool.query('SELECT id, lower(email) AS email, onboarding_status, import_source FROM users WHERE lower(email) = ANY($1)', [emails])).rows
    : [];
  const userByEmail = new Map(userRows.map((r) => [r.email, r]));
  const clusterToUserId = new Map();
  for (const p of peopleActions) {
    if (p.action === 'existing') { clusterToUserId.set(p.cluster, p.existingId); continue; }
    const u = userByEmail.get(clusterToEmail.get(p.cluster));
    if (!u) { fail(`person "${p.cluster}" has no created user for email ${clusterToEmail.get(p.cluster)}`); continue; }
    clusterToUserId.set(p.cluster, u.id);
    const expected = EXPECTED_STATUS[p.action];
    if (!expected) continue;
    if (u.onboarding_status === expected) {
      pass(`user ${u.id} ("${p.cluster}") status ${u.onboarding_status} (expected ${expected})`);
    } else if (u.import_source === 'payment_history_import') {
      // A claimed import account advancing past its seed status (in_progress /
      // deactivated) is expected, not a defect — WARN, don't fail the run.
      warn(`user ${u.id} ("${p.cluster}") status ${u.onboarding_status}, expected ${expected} — likely claimed between runs (import account advanced)`);
    } else {
      fail(`user ${u.id} ("${p.cluster}") status ${u.onboarding_status}, expected ${expected} (non-import account)`);
    }
  }

  // (E2b) DB-side residue scan: every ledger row belonging to this import's contractors
  // must be accounted for by the sheet or a retraction. The user set is widened to
  // include ALL user ids recorded in surviving run logs, so a FULLY-dropped person
  // (removed from the sheet entirely) whose id lives only in a log is still scanned.
  const importUserIds = [...new Set([...clusterToUserId.values(), ...runLogUserIds(priorRunLogs)])].filter((v) => v !== null && v !== undefined);
  const residueRows = importUserIds.length
    ? (await pool.query('SELECT row_fingerprint, contractor_id FROM staff_payment_history WHERE contractor_id = ANY($1)', [importUserIds])).rows
    : [];
  const residue = findLedgerResidue(residueRows, toImport, retracted);
  if (residue.length) fail(`${residue.length} ledger row(s) for this import's contractors are in neither the sheet nor retractions (stale residue): ${residue.join(', ')}`);
  else pass(`no stale ledger residue for this import's contractors (${residueRows.length} rows scanned)`);

  const fps = toImport.map((r) => r.fingerprint);
  const dbRows = fps.length
    ? (await pool.query('SELECT row_fingerprint, contractor_id, paid_on, amount_cents, boundary_exception FROM staff_payment_history WHERE row_fingerprint = ANY($1)', [fps])).rows
    : [];

  // (1) row count.
  if (dbRows.length === toImport.length) pass(`ledger row count ${dbRows.length} == sheet toImport ${toImport.length}`);
  else fail(`ledger row count ${dbRows.length} != sheet toImport ${toImport.length}`);

  // (5) fingerprint uniqueness (within the import scope).
  const distinct = new Set(dbRows.map((r) => r.row_fingerprint));
  if (distinct.size === dbRows.length) pass(`fingerprint uniqueness ok (${distinct.size})`);
  else fail(`duplicate fingerprints in ledger (${dbRows.length - distinct.size})`);

  // (6b) every contractor_id resolves to a users row.
  const contractorIds = [...new Set(dbRows.map((r) => r.contractor_id))];
  const known = contractorIds.length
    ? new Set((await pool.query('SELECT id FROM users WHERE id = ANY($1)', [contractorIds])).rows.map((r) => r.id))
    : new Set();
  const orphan = contractorIds.filter((id) => !known.has(id));
  if (!orphan.length) pass(`all ${contractorIds.length} contractor_ids resolve to users`);
  else fail(`contractor_ids with no users row: ${orphan.join(', ')}`);

  // (2) per contractor×year sum vs sheet.
  const sheetSums = new Map(); // `${uid}|${yr}` → cents
  for (const r of toImport) {
    const uid = clusterToUserId.get(r.cluster);
    const key = `${uid}|${ymd(r.paid_on).slice(0, 4)}`;
    sheetSums.set(key, (sheetSums.get(key) || 0) + r.amount_cents);
  }
  const dbSums = new Map();
  for (const r of dbRows) {
    const key = `${r.contractor_id}|${ymd(r.paid_on).slice(0, 4)}`;
    dbSums.set(key, (dbSums.get(key) || 0) + r.amount_cents);
  }
  let sumsOk = sheetSums.size === dbSums.size;
  for (const [k, v] of sheetSums) if (dbSums.get(k) !== v) sumsOk = false;
  if (sumsOk) pass(`per contractor×year sums match sheet (${sheetSums.size} buckets)`);
  else fail(`per contractor×year sums differ — sheet ${JSON.stringify([...sheetSums])} vs db ${JSON.stringify([...dbSums])}`);

  // (3) no rows past the boundary except boundary_exception=true.
  const past = dbRows.filter((r) => ymd(r.paid_on) >= BOUNDARY);
  const illegalPast = past.filter((r) => !r.boundary_exception);
  if (!illegalPast.length) pass(`no post-boundary rows without boundary_exception (${past.length} exception rows past ${BOUNDARY})`);
  else fail(`${illegalPast.length} row(s) paid_on >= ${BOUNDARY} without boundary_exception: ${illegalPast.map((r) => r.row_fingerprint).join(', ')}`);

  // (4) boundary_exception rows match NO payout (any status).
  const exceptionRows = dbRows.filter((r) => r.boundary_exception);
  const allPayouts = exceptionRows.length
    ? (await pool.query(
      `SELECT po.id, po.contractor_id, po.total_cents, po.status, pp.start_date, pp.payday
         FROM payouts po JOIN pay_periods pp ON pp.id = po.pay_period_id`)).rows
    : [];
  const dblFailures = checkBoundaryNoDoubleCount(exceptionRows, allPayouts);
  if (!dblFailures.length) pass(`no boundary_exception row matches a payout (${exceptionRows.length} exception rows checked)`);
  else dblFailures.forEach((f) => fail(f));

  return report(results);
}

function report(results) {
  console.log('\n=== verifyImport ===');
  const label = { pass: 'PASS', fail: 'FAIL', warn: 'WARN' };
  results.forEach((r) => console.log(`  ${label[r.level]}  ${r.msg}`));
  const failed = results.filter((r) => r.level === 'fail').length;
  const warned = results.filter((r) => r.level === 'warn').length;
  const passed = results.filter((r) => r.level === 'pass').length;
  console.log(`\n${failed ? `FAILED — ${failed} assertion(s)${warned ? `, ${warned} warning(s)` : ''}` : `OK — ${passed} assertions passed${warned ? `, ${warned} warning(s)` : ''}`}`);
  return { ok: failed === 0, failed, warned, results };
}

if (require.main === module) {
  const reviewDir = getArg(process.argv.slice(2), '--review-dir');
  if (!reviewDir) { console.error('--review-dir <dir> is required'); process.exit(1); }
  run({ reviewDir: path.resolve(reviewDir) })
    .then((res) => pool.end().then(() => process.exit(res.ok ? 0 : 1)))
    .catch((err) => { console.error('[verifyImport] FAILED:', err.message); pool.end().then(() => process.exit(1)); });
}

// checkBoundaryNoDoubleCount is re-exported (it now lives in importValidation, so
// importFromSheet can run it inside its transaction without a require cycle).
module.exports = { run, checkBoundaryNoDoubleCount, findLedgerResidue };
