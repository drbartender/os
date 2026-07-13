// Reconciliation report (spec §4, plan C3). READ-ONLY: writes NOTHING to the DB.
// Post-boundary staff-pay payments (paid_on >= 2026-06-02, no boundary_exception)
// are NOT in the ledger; this matches each to a PENDING payout so Dallas can mark
// it paid by hand through the payroll UI (deliberately manual — spec §4).
//
// Usage:
//   DOTENV_CONFIG_PATH=/home/drbartender/projects/os/.env node -r dotenv/config \
//     server/scripts/staffPaymentImport/reconcile.js --review-dir <dir>
//
// Output: <review-dir>/reconciliation-report.csv, three sections:
//   MATCHED               — payment ↔ pending payout (mark paid via payroll UI)
//   PAYMENT WITHOUT PAYOUT — a post-boundary payment with no matching payout
//   PAYOUT STILL UNPAID   — a pending payout with no matching payment (awaiting payday)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');
const { pool } = require('../../db');
const { getArg } = require('./config');
const { validateSheets, planPeopleEmails, ymd, inPayoutWindow } = require('./importValidation');
const { loadSheet } = require('./importFromSheet');

const dollars = (c) => (c / 100).toFixed(2);
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Pure matcher (tested in reconcile.test.js). Each toReconcile row carries a
// resolved contractorId (cluster → user). A payout matches on same contractor +
// |amount| ≤ 1¢ + paid_on within the payout collection window [start_date,
// payday+14d] — payments land ON payday, AFTER the period end. One payout/payment.
function matchReconcile(rows, payouts) {
  const matched = [];
  const withoutPayout = [];
  const usedPayoutIds = new Set();
  for (const r of rows) {
    const hit = payouts.find((po) => !usedPayoutIds.has(po.id)
      && po.contractor_id === r.contractorId
      && Math.abs(po.total_cents - r.amount_cents) <= 1
      && inPayoutWindow(r.paid_on, po));
    if (hit) { usedPayoutIds.add(hit.id); matched.push({ ...r, payout: hit }); }
    else withoutPayout.push(r);
  }
  const unmatchedPayouts = payouts.filter((po) => !usedPayoutIds.has(po.id));
  return { matched, withoutPayout, unmatchedPayouts };
}

async function run({ reviewDir }) {
  const { manifest, people, transactions } = loadSheet(reviewDir);
  const { errors, toReconcile, peopleActions } = validateSheets({ manifest, people, transactions });
  if (errors.length) {
    console.error(`[reconcile] sheet does not validate — ${errors.length} error(s); refusing to produce a partial report:`);
    errors.forEach((e) => console.error(`  - ${e}`));
    return { ok: false, errors };
  }

  // Resolve cluster → contractor user id (existing ids + created/reused by email).
  const clusterToEmail = planPeopleEmails(peopleActions);
  const emails = [...clusterToEmail.values()];
  const emailRows = emails.length
    ? (await pool.query('SELECT id, lower(email) AS email FROM users WHERE lower(email) = ANY($1)', [emails])).rows
    : [];
  const idByEmail = new Map(emailRows.map((r) => [r.email, r.id]));
  const clusterToUserId = new Map();
  for (const p of peopleActions) {
    if (p.action === 'existing') clusterToUserId.set(p.cluster, p.existingId);
    else { const id = idByEmail.get(clusterToEmail.get(p.cluster)); if (id) clusterToUserId.set(p.cluster, id); }
  }
  const rows = toReconcile.map((r) => ({ ...r, contractorId: clusterToUserId.get(r.cluster) || null }));

  const { rows: payouts } = await pool.query(
    `SELECT po.id, po.contractor_id, po.total_cents, po.status, pp.start_date, pp.end_date, pp.payday
       FROM payouts po JOIN pay_periods pp ON pp.id = po.pay_period_id
      WHERE po.status = 'pending'`,
  );

  const { matched, withoutPayout, unmatchedPayouts } = matchReconcile(rows, payouts);

  const out = [];
  out.push('# STAFF PAYMENT RECONCILIATION (read-only; no DB writes)');
  out.push(`# generated: ${new Date().toISOString()}`);
  out.push(`# post-boundary staff-pay payments: ${rows.length} | pending payouts: ${payouts.length}`);
  out.push('');
  out.push('section,cluster,contractor_id,date,amount_usd,platform,payout_id,period_start,period_end');
  matched.forEach((m) => out.push(['MATCHED', m.cluster, m.contractorId, ymd(m.paid_on), dollars(m.amount_cents), m.platform, m.payout.id, ymd(m.payout.start_date), ymd(m.payout.end_date)].map(csvCell).join(',')));
  withoutPayout.forEach((w) => out.push(['PAYMENT WITHOUT PAYOUT', w.cluster, w.contractorId, ymd(w.paid_on), dollars(w.amount_cents), w.platform, '', '', ''].map(csvCell).join(',')));
  unmatchedPayouts.forEach((po) => out.push(['PAYOUT STILL UNPAID', '', po.contractor_id, '', dollars(po.total_cents), '', po.id, ymd(po.start_date), ymd(po.end_date)].map(csvCell).join(',')));

  const outPath = path.join(reviewDir, 'reconciliation-report.csv');
  fs.writeFileSync(outPath, `${out.join('\n')}\n`);
  console.log(`[reconcile] MATCHED ${matched.length} | PAYMENT WITHOUT PAYOUT ${withoutPayout.length} | PAYOUT STILL UNPAID ${unmatchedPayouts.length}`);
  console.log(`[reconcile] wrote ${outPath}`);
  return { ok: true, matched, withoutPayout, unmatchedPayouts, outPath };
}

if (require.main === module) {
  const reviewDir = getArg(process.argv.slice(2), '--review-dir');
  if (!reviewDir) { console.error('--review-dir <dir> is required'); process.exit(1); }
  run({ reviewDir: path.resolve(reviewDir) })
    .then((res) => pool.end().then(() => process.exit(res && res.ok === false ? 1 : 0)))
    .catch((err) => { console.error('[reconcile] FAILED:', err.message); pool.end().then(() => process.exit(1)); });
}

module.exports = { run, matchReconcile };
