'use strict';

/**
 * Expire pending service-extension requests (spec section 5.5).
 *
 * The hard stop is the whole coverage argument: no greenlight means bar service
 * ends at the contracted time. Nothing enforces that without this sweep, so it
 * is load-bearing rather than housekeeping.
 *
 * closeExtension's claim (WHERE status='pending') is the race gate against a
 * payment settling at the same moment: exactly one of the two wins, and the
 * webhook's post-commit path contains the losing case by alerting for a refund
 * rather than extending an event nobody paid for.
 *
 * Runs every 60 seconds because a bartender is standing at a bar waiting, and
 * the decline message carries the insurance warning.
 */

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { closeExtension } = require('./serviceExtensionSettle');
const { applyExtensionHours, maybeAlertPayroll } = require('./serviceExtensionPayroll');
const { cancelOpenInvoiceIntents } = require('./invoiceVoid');
const notify = require('./serviceExtensionNotify');

// Cap per tick so a backlog cannot make one run unbounded. At real volume
// (a handful of events a night) this is never reached.
const SWEEP_LIMIT = 50;

async function sweepExpiredExtensions() {
  const { rows } = await pool.query(
    `SELECT id FROM service_extensions
      WHERE status = 'pending' AND expires_at < NOW()
      ORDER BY expires_at ASC
      LIMIT $1`,
    [SWEEP_LIMIT]
  );
  if (rows.length === 0) return { expired: 0, notified: 0, stranded: 0 };

  let expired = 0;
  let notified = 0;
  let stranded = 0;

  for (const { id } of rows) {
    try {
      // Read the copy inputs AND the invoice status BEFORE claiming.
      const pre = await pool.query(
        `SELECT se.contracted_end_time, se.proposal_id, i.status AS invoice_status
           FROM service_extensions se
           LEFT JOIN invoices i ON i.id = se.invoice_id
          WHERE se.id = $1`,
        [id]
      );
      const contractedEndDisplay = pre.rows[0] ? pre.rows[0].contracted_end_time : null;

      // STRANDED-PAID GUARD. A pending row whose invoice is already PAID means
      // the client paid but the settle never ran: the webhook committed the
      // payment and then the process died before its post-commit tail, or the
      // tail threw. Expiring it here would be the worst outcome in the feature:
      // DRB keeps the money, the event is never extended, and the bartender gets
      // told service is over. The invoice void would also silently no-op against
      // its own `status <> 'paid'` guard, so nothing would even look wrong.
      // Leave the row pending, alert, and let a human settle or refund it.
      if (pre.rows[0] && pre.rows[0].invoice_status === 'paid') {
        stranded += 1;
        // THROTTLE, mandatory (merge-gate blocker, 2026-08-03): this row stays
        // pending until a human acts, the driver re-selects it every 60
        // seconds, and notifyAdminCategory has no dedupe of its own. This kind
        // is urgent email AND SMS, so one stranded row overnight is ~480 of
        // each: the shared Resend cap dies, Twilio bleeds, and the one alert
        // that matters drowns. Same law as balanceInvoiceMonitor's
        // recentlyNotified marker: once per 24h per extension, tracked in
        // proposal_activity_log. (Throttled rows still occupy driver slots,
        // but each costs two indexed reads per tick and stranded rows are
        // near-zero volume by design.)
        const recent = await pool.query(
          `SELECT 1 FROM proposal_activity_log
            WHERE proposal_id = $1 AND action = 'extension_stranded_alert'
              AND (details->>'extension_id')::int = $2
              AND created_at > NOW() - INTERVAL '24 hours'
            LIMIT 1`,
          [pre.rows[0].proposal_id, id]
        );
        if (recent.rowCount) continue;
        await notify.alertAdminsProblem({
          proposalId: pre.rows[0].proposal_id,
          kind: 'paid_extension_stranded',
          detail: `Extension ${id} is still pending but its invoice is PAID. The client paid and the event was NOT extended. Settle it by hand (bump the duration and the shift end time, and check payroll hours) or refund the payment. The bartender has NOT been told anything.`,
        });
        await pool.query(
          `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
           VALUES ($1, 'extension_stranded_alert', 'system', $2::jsonb)`,
          [pre.rows[0].proposal_id, JSON.stringify({ extension_id: id, admin_notified: true })]
        );
        continue;
      }

      const closed = await closeExtension({ extensionId: id, outcome: 'expired' });
      if (!closed.ok) continue; // a settle or an admin won the claim
      expired += 1;

      // Make the invoice unpayable. Best-effort intent cancel first so a client
      // mid-checkout cannot complete against an invoice about to be voided.
      if (closed.invoiceId) {
        await cancelOpenInvoiceIntents(closed.proposalId, closed.invoiceId);
        const voided = await pool.query(
          "UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = $1 AND status <> 'paid'",
          [closed.invoiceId]
        );
        // TOCTOU detector (merge-gate finding): if the payment committed
        // between the pre-read above and this void, the guard no-ops and the
        // row is now 'expired' with a PAID invoice — invisible to the
        // stranded guard (not pending), the heal (not paid/overridden), and
        // the webhook retry (isFirstDelivery false). Alert loudly; it is the
        // same human-fix shape as stranded-paid.
        if (voided.rowCount === 0) {
          await notify.alertAdminsProblem({
            proposalId: closed.proposalId,
            kind: 'paid_extension_stranded',
            detail: `Extension ${id} was EXPIRED by the sweep but its invoice turned out PAID (the payment landed mid-sweep). The client paid and the event was NOT extended, and no automatic path will revisit this row. Settle by hand or refund.`,
          });
        }
      }

      const result = await notify.notifyStaffOfOutcome({
        staffUserIds: closed.staffUserIds,
        outcome: 'declined',
        newEndDisplay: null,
        contractedEndDisplay,
        proposalId: closed.proposalId,
      });
      notified += result.notified.length;
    } catch (err) {
      // One bad row must not stop the sweep: the next tick retries it, and the
      // claim makes that safe.
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, { tags: { feature: 'service-extension', step: 'sweep' }, extra: { extensionId: id } });
      }
      console.error(`[serviceExtensionSweep] extension ${id} failed:`, err.message);
    }
  }

  if (expired > 0 || stranded > 0) {
    console.log(`[serviceExtensionSweep] expired ${expired}, notified ${notified} staffer(s), stranded-paid ${stranded}`);
  }
  return { expired, notified, stranded };
}

/**
 * Crash recovery: re-run the post-settle side effects for rows that settled but
 * never finalized. See the note in the task body for why nothing else catches
 * this state. A short age gate keeps the heal from racing a settle that is still
 * legitimately mid-tail.
 */
async function healUnfinalizedExtensions() {
  const { rows } = await pool.query(
    `SELECT se.id, se.proposal_id, se.requested_duration_hours, se.contracted_end_time,
            se.requested_end_time, se.status, se.invoice_id,
            i.status AS invoice_status
       FROM service_extensions se
       LEFT JOIN invoices i ON i.id = se.invoice_id
      WHERE se.finalized_at IS NULL
        AND se.status IN ('paid', 'overridden')
        AND se.updated_at < NOW() - INTERVAL '2 minutes'
      ORDER BY se.updated_at ASC
      LIMIT $1`,
    [SWEEP_LIMIT]
  );
  if (rows.length === 0) return { healed: 0 };

  let healed = 0;
  for (const row of rows) {
    try {
      // CARRY-OVER (ext-routes merge-gate review, 2026-08-03): the admin
      // override settles in its own transaction and THEN voids the invoice
      // (decision 14), so a crash between the two leaves the invoice 'sent' on
      // an 'overridden' row. The plan's heal re-ran payroll and the greenlight
      // but never touched that invoice, so the client could still pay for time
      // an admin already granted free, forever. Close it here exactly the way
      // the override route does: cancel open intents first so a client
      // mid-checkout cannot complete against it, then void. The status <>
      // 'paid' guard stays: money that actually landed (the client paid while
      // the admin was overriding) is a manual refund decision, never an
      // automatic void, and the payable-status check keeps the Stripe
      // round-trip off every ordinary heal retry.
      if (
        row.status === 'overridden' && row.invoice_id &&
        ['draft', 'sent', 'partially_paid'].includes(row.invoice_status)
      ) {
        await cancelOpenInvoiceIntents(row.proposal_id, row.invoice_id);
        await pool.query(
          "UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = $1 AND status <> 'paid'",
          [row.invoice_id]
        );
      }

      // Both side effects are idempotent: applyExtensionHours no-ops when
      // contracted_hours already equals the target, and re-sending the greenlight
      // beats a bartender who was never told.
      const payroll = await applyExtensionHours({
        proposalId: row.proposal_id,
        newDurationHours: Number(row.requested_duration_hours),
      });
      // Merge-gate blocker fix (2026-08-03), mirror of the webhook settle
      // tail: if accrual already ran while this row was pending, the 12b
      // gratuity addend was $0 and nothing else re-runs accrual. Idempotent
      // recompute; only 'paid' rows contribute, so an overridden heal adds $0.
      if ((payroll.updatedLines + payroll.lockedLines + payroll.frozenLines) > 0) {
        const { accruePayoutsForProposal } = require('./payrollAccrual');
        await accruePayoutsForProposal(row.proposal_id);
      }
      await maybeAlertPayroll(notify, row.proposal_id, payroll);

      const staffUserIds = await assignedStaffUserIdsFor(row.proposal_id);
      await notify.notifyStaffOfOutcome({
        staffUserIds,
        outcome: 'approved',
        newEndDisplay: row.requested_end_time,
        contractedEndDisplay: row.contracted_end_time,
        proposalId: row.proposal_id,
      });

      await pool.query(
        'UPDATE service_extensions SET finalized_at = NOW(), updated_at = NOW() WHERE id = $1',
        [row.id]
      );
      healed += 1;
      await notify.alertAdminsProblem({
        proposalId: row.proposal_id,
        kind: 'settle_healed',
        detail: `Extension ${row.id} settled but its follow-up work never ran (likely a restart mid-request). It has now been healed: payroll hours re-applied and the crew re-notified. Spot-check the payout line and that the bartender knows.`,
      });
    } catch (err) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, { tags: { feature: 'service-extension', step: 'heal' }, extra: { extensionId: row.id } });
      }
      console.error(`[serviceExtensionSweep] heal of ${row.id} failed:`, err.message);
    }
  }
  if (healed > 0) console.log(`[serviceExtensionSweep] healed ${healed} unfinalized extension(s)`);
  return { healed };
}

/** Roster lookup for the heal path (settleExtension returns this on the live path). */
async function assignedStaffUserIdsFor(proposalId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT sr.user_id
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
      WHERE s.proposal_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL`,
    [proposalId]
  );
  return rows.map((r) => r.user_id);
}

module.exports = { sweepExpiredExtensions, healUnfinalizedExtensions, SWEEP_LIMIT };
