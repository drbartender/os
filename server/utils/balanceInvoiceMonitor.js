// Balance-invoice monitor — ALERT ONLY.
//
// Watches one invariant:
//
//     Σ(open invoice remaining)  ≤  owed,   owed = total_price − amount_paid
//
// Not equality. Billing a client LESS than they owe is sometimes deliberate (a
// Deposit is a partial bill by design, and ~154 sit open at any time). Billing
// them MORE is never correct. The two directions are separate failures with
// separate urgency, so they are detected and reported separately.
//
// WHY ALERT-ONLY: revisions 1-3 of the 2026-07-21 design auto-minted the
// missing invoice. Two design-fleet rounds each found reachable money bugs in
// that mint path (double-bill via an open unpaid Deposit, re-bill via a
// partially paid unlocked invoice, a no-op row lock, a swallowed 23505, a
// zero-due invoice stealing open_invoice_token) and ZERO in detection. This
// module therefore reads `proposals`/`invoices` and writes only
// `proposal_activity_log`. It never creates, edits, or voids an invoice. A bug
// here is a spurious email; a bug in a mint path is a wrong number in front of
// a client.
//
// It does NOT catch its own errors: wrapScheduler (schedulerHealth.js) catches,
// captures to Sentry, and records status='failed' on the heartbeat. Swallowing
// here would make scheduler_health read 'ok' while the query fails forever.

'use strict';

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { notifyAdminCategory } = require('./adminNotifications');
const { OFF_LEDGER_INVOICE_LABELS } = require('./proposalMoneyShared');

const OVER_ACTION = 'invoice_over_bill';
const UNDER_ACTION = 'balance_invoice_missing';

const usd = (cents) => '$' + (Number(cents) / 100).toFixed(2);

// The payable sum, shared by both directions: what a client can actually pay
// right now across their open invoices. Off-ledger labels are carved out:
// their money never enters amount_paid (OFF_LEDGER_INVOICE_LABELS,
// proposalMoneyShared.js), so they are structurally incapable of satisfying
// the invariant in either direction. $1 is the OFF_LEDGER_INVOICE_LABELS
// array; every query interpolating this fragment must bind it at the call
// site. invoices.label is NOT NULL DEFAULT 'Invoice', so there is no
// NULL-label trap in the ANY().
const PAYABLE_SUM = `
  COALESCE((
    SELECT SUM(i.amount_due - i.amount_paid)
      FROM invoices i
     WHERE i.proposal_id = p.id
       AND i.status IN ('sent', 'partially_paid')
       AND i.amount_due > i.amount_paid
       AND NOT (i.label = ANY($1::text[]))
  ), 0)`;

const OWED_CENTS = `
  ROUND(COALESCE(p.total_price, 0) * 100)::int
- ROUND(COALESCE(p.amount_paid, 0) * 100)::int`;

// Labels present on the proposal, for context in the alert.
const LABELS = `
  (SELECT string_agg(i2.label, ', ' ORDER BY i2.id)
     FROM invoices i2
    WHERE i2.proposal_id = p.id AND i2.status <> 'void')`;

// ── Direction 1: OVER-BILLED ────────────────────────────────────────────────
// The client is being asked for more than they owe. Never legitimate at any
// stage, so this runs on every proposal except 'draft' and 'archived' — a
// quote-stage proposal can be over-billed too.
//
// `PAYABLE_SUM > 0` is load-bearing, not belt-and-braces. An OVERPAID proposal
// has a negative owed, so `0 > -6000` is true and a proposal with NO open
// invoice at all would be reported as over-billed, with "$0.00 payable" and
// email copy claiming the pay button works. Prod proposal 599 (Emiline, paid
// $360 against a $300 total) is exactly that shape, is deliberately out of
// scope for the derivation work, and would otherwise alert every 24h forever.
//
// Note this counts every open invoice EXCEPT off-ledger labels, including
// bespoke labels the derivation leaves alone (syrup-only extras, manual fees)
// whose money is additive to total_price. That over-reports on the rare
// abandoned-card syrup-only shape. Deliberate: a false alert is cheap and
// throttled, while excluding those labels would have missed Eve Thornton,
// whose stranded $155 extras invoice WAS folded into total_price and
// self-cleared through amount_paid. Off-ledger labels ('Service Extension')
// are the one exception: their money NEVER enters amount_paid, so unlike
// Eve's invoice they can never self-clear, and a pending extension invoice on
// a paid-up event (the stranded-paid shape the expiry sweep deliberately
// leaves pending) would alert every 24h forever.
const OVER_SQL = `
  SELECT p.id, c.name AS client_name, p.status, p.event_date,
         ${PAYABLE_SUM} - (${OWED_CENTS}) AS excess_cents,
         ${PAYABLE_SUM} AS payable_cents,
         ${OWED_CENTS} AS owed_cents,
         ${LABELS} AS labels
    FROM proposals p
    JOIN clients c ON c.id = p.client_id
   WHERE p.status NOT IN ('draft', 'archived')
     AND ${PAYABLE_SUM} > 0
     AND ${PAYABLE_SUM} > (${OWED_CENTS})
   ORDER BY p.id`;

// ── Direction 2: UNDER-COVERED ──────────────────────────────────────────────
// The client owes money with nowhere to pay it. This query and its status
// filter come VERBATIM from docs/superpowers/specs/2026-07-21-balance-invoice-
// reconciler-design.md: it is tuned money SQL, verified at zero rows against
// the prod branch, and the status filter is precisely what excludes the
// legitimate deposit-stage case. Do not re-derive it.
const UNDER_SQL = `
  SELECT p.id, c.name AS client_name, p.status, p.event_date, p.balance_due_date,
         ${OWED_CENTS} AS balance_cents,
         ${PAYABLE_SUM} AS payable_cents,
         ${LABELS} AS labels
    FROM proposals p
    JOIN clients c ON c.id = p.client_id
   WHERE p.status IN ('confirmed', 'deposit_paid')
     AND ${OWED_CENTS} > ${PAYABLE_SUM}
   ORDER BY p.id`;

/**
 * Has this proposal already been notified for this direction inside 24h?
 *
 * Mirrors balanceScheduler.js:155-181 exactly. The throttle is mandatory: a
 * detected proposal stays detected until a human acts, notifyAdminCategory has
 * no dedupe of its own, and the Resend quota is shared with client comms.
 */
async function recentlyNotified(proposalId, action) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM proposal_activity_log
      WHERE proposal_id = $1 AND action = $2
        AND created_at > NOW() - INTERVAL '24 hours'
        AND details->>'admin_notified' = 'true'
      LIMIT 1`,
    [proposalId, action]
  );
  return rowCount > 0;
}

/**
 * Record one escalation: activity-log row (stamped as notified, so it doubles
 * as the throttle marker) plus a Sentry warning.
 *
 * The row is written ONLY when we are actually alerting. Writing one per run
 * would put 24 rows a day per stuck proposal into the activity log, which is
 * the same feed an admin reads to understand a proposal's history.
 */
async function escalate({ action, row, direction, detail }) {
  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
     VALUES ($1, $2, 'system', $3)`,
    [row.id, action, JSON.stringify({ ...detail, admin_notified: true, invoice_labels: row.labels || null })]
  );

  if (process.env.SENTRY_DSN_SERVER) {
    const message = direction === 'over'
      ? `Client over-billed: open invoices exceed balance due (proposal ${row.id})`
      : `Balance due with no payable invoice (proposal ${row.id})`;
    Sentry.captureMessage(message, {
      level: 'warning',
      tags: { scheduler: 'balance_invoice_monitor', direction },
      extra: { proposalId: row.id, ...detail, invoiceLabels: row.labels || null },
      fingerprint: ['balance-invoice-monitor', direction, String(row.id)],
    });
  }
}

function renderEmail(over, under) {
  const line = (r, figure) =>
    `<li><strong>${r.client_name}</strong> (proposal #${r.id}, ${r.status}` +
    `${r.event_date ? ', event ' + new Date(r.event_date).toISOString().slice(0, 10) : ''})` +
    ` ${figure}. Invoices: ${r.labels || 'none'}. ` +
    `<a href="${process.env.CLIENT_URL || ''}/admin/proposals/${r.id}">Open</a></li>`;

  const parts = [];
  const textParts = [];

  if (over.length > 0) {
    parts.push(
      '<h3>Over-billed: the client can pay more than they owe</h3>',
      '<p>These are wrong in the client\'s disfavor and the pay button works. Fix the proposal, or void the invoice.</p>',
      '<ul>' + over.map((r) => line(r, `is billed ${usd(r.payable_cents)} against ${usd(r.owed_cents)} owed, ${usd(r.excess_cents)} too much`)).join('') + '</ul>'
    );
    textParts.push('OVER-BILLED:', ...over.map((r) =>
      `  #${r.id} ${r.client_name}: billed ${usd(r.payable_cents)} vs ${usd(r.owed_cents)} owed (${usd(r.excess_cents)} too much)`));
  }

  if (under.length > 0) {
    parts.push(
      '<h3>No payable invoice: the client owes money with nowhere to pay it</h3>',
      '<p>Balance reminders link to the proposal page, which shows a pay control only when an open invoice exists.</p>',
      '<ul>' + under.map((r) => line(r, `owes ${usd(r.balance_cents)} with only ${usd(r.payable_cents)} payable`)).join('') + '</ul>'
    );
    textParts.push('NO PAYABLE INVOICE:', ...under.map((r) =>
      `  #${r.id} ${r.client_name}: owes ${usd(r.balance_cents)}, only ${usd(r.payable_cents)} payable`));
  }

  const count = over.length + under.length;
  const subject = over.length > 0
    ? `Invoice check: ${over.length} client${over.length === 1 ? '' : 's'} over-billed` +
      (under.length > 0 ? `, ${under.length} with no payable invoice` : '')
    : `Invoice check: ${count} client${count === 1 ? '' : 's'} with no payable invoice`;

  return { subject, emailHtml: parts.join('\n'), emailText: textParts.join('\n') };
}

/**
 * One monitor pass.
 *
 * @returns {Promise<{candidates:number, alerted:number, throttled:number}>}
 */
async function monitorMissingBalanceInvoices() {
  const [overRes, underRes] = await Promise.all([
    pool.query(OVER_SQL, [OFF_LEDGER_INVOICE_LABELS]),
    pool.query(UNDER_SQL, [OFF_LEDGER_INVOICE_LABELS]),
  ]);

  const candidates = overRes.rows.length + underRes.rows.length;
  const freshOver = [];
  const freshUnder = [];
  let throttled = 0;

  for (const row of overRes.rows) {
    if (await recentlyNotified(row.id, OVER_ACTION)) { throttled += 1; continue; }
    await escalate({
      action: OVER_ACTION, row, direction: 'over',
      detail: {
        excess_cents: Number(row.excess_cents),
        payable_cents: Number(row.payable_cents),
        owed_cents: Number(row.owed_cents),
      },
    });
    freshOver.push(row);
  }

  for (const row of underRes.rows) {
    if (await recentlyNotified(row.id, UNDER_ACTION)) { throttled += 1; continue; }
    await escalate({
      action: UNDER_ACTION, row, direction: 'under',
      detail: {
        balance_cents: Number(row.balance_cents),
        payable_cents: Number(row.payable_cents),
      },
    });
    freshUnder.push(row);
  }

  const alerted = freshOver.length + freshUnder.length;

  if (alerted > 0) {
    // One batched email per RUN, not per proposal. The per-proposal throttle
    // above already bounds how often any single proposal can appear in one.
    const { subject, emailHtml, emailText } = renderEmail(freshOver, freshUnder);
    await notifyAdminCategory({ category: 'payment_failure', subject, emailHtml, emailText });
  }

  console.log(`[balance_invoice_monitor] candidates=${candidates} alerted=${alerted} throttled=${throttled}`);
  return { candidates, alerted, throttled };
}

module.exports = {
  monitorMissingBalanceInvoices,
  OVER_ACTION,
  UNDER_ACTION,
};
