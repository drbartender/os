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

async function notifyDisputeWon(tipId, { reinstatedAmountCents, disputeOpenedAt, disputeWonAt }) {
  const tipRes = await pool.query(
    `SELECT t.id, t.amount_cents, t.fee_cents, t.dispute_won_at, t.shift_id, t.target_user_id,
            s.event_date, p.event_type, p.event_type_custom, p.client_id,
            c.name AS client_name
       FROM tips t
  LEFT JOIN shifts s ON s.id = t.shift_id
  LEFT JOIN proposals p ON p.id = s.proposal_id
  LEFT JOIN clients c ON c.id = p.client_id
      WHERE t.id = $1`,
    [tipId]
  );
  const tip = tipRes.rows[0];
  if (!tip || tip.dispute_won_at) return null;

  // Bartenders on the original shift. If the tip was never matched (no shift_id),
  // fall back to just the original recipient.
  let bartenderIds = [];
  if (tip.shift_id) {
    const { rows } = await pool.query(
      `SELECT sr.user_id FROM shift_requests sr
        WHERE sr.shift_id = $1 AND sr.status = 'approved'
          AND LOWER(sr.position) = 'bartender'
        ORDER BY sr.user_id`,
      [tip.shift_id]
    );
    bartenderIds = rows.map(r => r.user_id);
  }
  if (bartenderIds.length === 0 && tip.target_user_id) {
    bartenderIds = [tip.target_user_id];
  }

  // Resolve display names.
  let bartenders = [];
  if (bartenderIds.length) {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, cp.preferred_name
         FROM users u
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
        WHERE u.id = ANY($1::int[])
        ORDER BY u.id`,
      [bartenderIds]
    );
    bartenders = rows.map(r => ({ id: r.id, name: r.preferred_name || r.email }));
  }

  // Per-bartender net share of the reinstated amount.
  const reinstated = Math.max(0, Math.min(Number(reinstatedAmountCents || 0), Number(tip.amount_cents)));
  const original = Number(tip.amount_cents);
  const feePortion = original > 0
    ? Math.round(Number(tip.fee_cents || 0) * reinstated / original)
    : 0;
  const netTotal = reinstated - feePortion;
  const shares = splitEvenly(netTotal, bartenders.length || 1);
  bartenders = bartenders.map((b, i) => ({
    ...b,
    shareCents: shares[i] || 0,
    shareDollars: ((shares[i] || 0) / 100).toFixed(2),
  }));

  // Send (best-effort — log to Sentry, but still mark the flag so a retry
  // doesn't spam a fixed inbox).
  try {
    const tpl = emailTemplates.disputeWonAdminNotification({
      amountDollars: (reinstated / 100).toFixed(2),
      perBartender: bartenders.map(b => ({ name: b.name, shareDollars: b.shareDollars })),
      eventDateLabel: fmtDate(tip.event_date),
      eventTypeLabel: getEventTypeLabel({ event_type: tip.event_type, event_type_custom: tip.event_type_custom }),
      clientName: tip.client_name || null,
      disputeOpenedLabel: fmtDate(disputeOpenedAt),
      disputeWonLabel: fmtDate(disputeWonAt),
      payrollUrl: `${process.env.CLIENT_URL || ''}/financials/payroll`,
    });
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { util: 'payrollDisputeNotify', step: 'send_email' } });
  }

  await pool.query('UPDATE tips SET dispute_won_at = NOW() WHERE id = $1', [tipId]);
  return {
    bartenders,
    reinstatedAmountCents: reinstated,
    netTotalCents: netTotal,
  };
}

module.exports = { notifyDisputeWon };
