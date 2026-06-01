/**
 * Build and send the admin notification when Stripe reinstates funds on a
 * disputed card tip we already paid out. Phase 2 does not auto re-pay (see
 * the "Dispute reinstatement" carve-out at the top of the Phase 2 plan), so
 * this email gives the admin every figure needed to add the positive
 * adjustment on each bartender's next payout manually.
 *
 * Idempotent via tips.dispute_won_at.
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { splitEvenly } = require('./payrollMath');
const { getEventTypeLabel } = require('./eventTypes');

function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

const MAX_DISPUTE_EMAIL_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 10_000;

// _deps shape: pool is included so Task 4's computation-throw test can
// inject a pool wrapper that rejects on a specific query. Spec text said
// "Pool stays direct" but the test design surfaced a need to swap it.
let _deps = { sendEmail, Sentry, sendTimeoutMs: SEND_TIMEOUT_MS, pool };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

async function notifyDisputeWon(tipId, { reinstatedAmountCents, disputeOpenedAt, disputeWonAt }) {
  const client = await _deps.pool.connect();
  let reinstated = 0;
  let bartenders = [];
  let netTotal = 0;
  let abandoned = false;
  let bailedOut = false;
  let postCommitAttempts = MAX_DISPUTE_EMAIL_ATTEMPTS;
  let postCommitEventDateLabel = '';

  try {
    await client.query('BEGIN');

    // Lock + re-read. FOR UPDATE OF t scopes the lock to the tips row only,
    // which is required when FOR UPDATE is combined with LEFT JOINs to
    // nullable rows. Precedent: server/routes/drinkPlanConsult.js:144
    // uses the same pattern with alias `dp`.
    const tipRes = await client.query(
      `SELECT t.id, t.amount_cents, t.fee_cents, t.dispute_won_at, t.shift_id, t.target_user_id,
              t.dispute_email_attempts,
              s.event_date, p.event_type, p.event_type_custom, p.client_id,
              c.name AS client_name
         FROM tips t
    LEFT JOIN shifts s ON s.id = t.shift_id
    LEFT JOIN proposals p ON p.id = s.proposal_id
    LEFT JOIN clients c ON c.id = p.client_id
        WHERE t.id = $1
          FOR UPDATE OF t`,
      [tipId]
    );
    const tip = tipRes.rows[0];

    if (!tip || tip.dispute_won_at) {
      await client.query('ROLLBACK');
      return null;
    }

    postCommitEventDateLabel = fmtDate(tip.event_date);

    let bartenderIds = [];
    if (tip.shift_id) {
      const bRes = await client.query(
        `SELECT sr.user_id FROM shift_requests sr
          WHERE sr.shift_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL
            AND LOWER(sr.position) = 'bartender'
          ORDER BY sr.user_id`,
        [tip.shift_id]
      );
      bartenderIds = bRes.rows.map(r => r.user_id);
    }
    if (bartenderIds.length === 0 && tip.target_user_id) {
      bartenderIds = [tip.target_user_id];
    }

    if (bartenderIds.length) {
      const nRes = await client.query(
        `SELECT u.id, u.email, cp.preferred_name
           FROM users u
      LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
          WHERE u.id = ANY($1::int[])
          ORDER BY u.id`,
        [bartenderIds]
      );
      bartenders = nRes.rows.map(r => ({ id: r.id, name: r.preferred_name || r.email }));
    }

    reinstated = Math.max(0, Math.min(Number(reinstatedAmountCents || 0), Number(tip.amount_cents)));
    const original = Number(tip.amount_cents);
    const feePortion = original > 0
      ? Math.round(Number(tip.fee_cents || 0) * reinstated / original)
      : 0;
    netTotal = reinstated - feePortion;
    const shares = splitEvenly(netTotal, bartenders.length || 1);
    bartenders = bartenders.map((b, i) => ({
      ...b,
      shareCents: shares[i] || 0,
      shareDollars: ((shares[i] || 0) / 100).toFixed(2),
    }));

    let emailSent = false;
    try {
      if (!process.env.ADMIN_EMAIL) {
        throw new Error('ADMIN_EMAIL not set; cannot deliver dispute-won notification');
      }
      const tpl = emailTemplates.disputeWonAdminNotification({
        amountDollars: (reinstated / 100).toFixed(2),
        perBartender: bartenders.map(b => ({ name: b.name, shareDollars: b.shareDollars })),
        eventDateLabel: postCommitEventDateLabel,
        eventTypeLabel: getEventTypeLabel({ event_type: tip.event_type, event_type_custom: tip.event_type_custom }),
        clientName: tip.client_name || null,
        disputeOpenedLabel: fmtDate(disputeOpenedAt),
        disputeWonLabel: fmtDate(disputeWonAt),
        payrollUrl: `${process.env.CLIENT_URL || ''}/financials/payroll`,
      });
      const sendPromise = _deps.sendEmail({
        to: process.env.ADMIN_EMAIL,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      // Suppress unhandled-rejection on whichever Promise loses the race below.
      // sendPromise: if the timeout wins, sendPromise eventually settles unobserved.
      // timeoutPromise: if sendPromise wins, the timer still fires and rejects.
      sendPromise.catch(() => {});
      const timeoutPromise = new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('sendEmail timed out')), _deps.sendTimeoutMs);
        t.unref?.();
      });
      timeoutPromise.catch(() => {});
      await Promise.race([sendPromise, timeoutPromise]);
      emailSent = true;
    } catch (err) {
      _deps.Sentry.captureException(err, { tags: { util: 'payrollDisputeNotify', step: 'send_email' } });
    }

    if (emailSent) {
      await client.query(
        `UPDATE tips
            SET dispute_won_at = NOW(),
                dispute_email_attempts = 0
          WHERE id = $1
            AND dispute_won_at IS NULL`,
        [tipId]
      );
    } else {
      const r = await client.query(
        `UPDATE tips
            SET dispute_email_attempts = dispute_email_attempts + 1,
                dispute_won_at = CASE WHEN dispute_email_attempts + 1 >= ${MAX_DISPUTE_EMAIL_ATTEMPTS} THEN NOW() ELSE dispute_won_at END,
                dispute_email_failed_at = CASE WHEN dispute_email_attempts + 1 >= ${MAX_DISPUTE_EMAIL_ATTEMPTS} THEN NOW() ELSE dispute_email_failed_at END
          WHERE id = $1
            AND dispute_won_at IS NULL
        RETURNING dispute_email_attempts, dispute_email_failed_at IS NOT NULL AS bailed_out`,
        [tipId]
      );
      bailedOut = r.rows[0]?.bailed_out === true;
      abandoned = bailedOut;
      if (r.rows[0]) postCommitAttempts = r.rows[0].dispute_email_attempts;
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }

  // Post-commit Sentry capture. The DB column dispute_email_failed_at is the
  // canonical durable record of abandonment; the Sentry alert is best-effort.
  if (bailedOut) {
    try {
      _deps.Sentry.captureMessage('Dispute-won notification permanently abandoned after retry threshold', {
        level: 'error',
        tags: { util: 'payrollDisputeNotify', step: 'max_attempts_exceeded' },
        extra: {
          tipId,
          attempts: postCommitAttempts,
          reinstatedAmountCents: reinstated,
          bartenderIds: bartenders.map(b => b.id),
          eventDateLabel: postCommitEventDateLabel,
        },
      });
    } catch (sentryErr) {
      console.error(
        `[payrollDisputeNotify] BAILOUT_ALERT_FAILED tipId=${tipId} attempts=${postCommitAttempts}`,
        sentryErr
      );
    }
  }

  return { bartenders, reinstatedAmountCents: reinstated, netTotalCents: netTotal, abandoned };
}

module.exports = { notifyDisputeWon, __setDeps };
