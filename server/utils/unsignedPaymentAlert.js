'use strict';
/**
 * Payment on an unsigned proposal (audit 2026-11-05, M4).
 *
 * A deposit or full payment can settle on a proposal nobody signed: the
 * PaymentIntent is minted when the proposal page loads, before /sign is
 * posted, and an admin-issued Stripe Payment Link needs no signature at all.
 * The money is recorded exactly as before. This is the breadcrumb and the
 * admin email that make the missing agreement visible, so someone asks the
 * client to sign before the event (POST /t/:token/sign accepts a signature on
 * a paid row as long as none is on file).
 *
 * Post-commit only: takes its own pooled connection (one-connection rule).
 * Never throws into a webhook tail; callers .catch() and log.
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { notifyAdminCategory } = require('./adminNotifications');
const { ADMIN_URL, PUBLIC_SITE_URL } = require('./urls');
const { esc } = require('./htmlEscape');

async function notifyUnsignedPayment({ proposalId, amountCents, paymentType, source }) {
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.client_signed_at, c.name AS client_name
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const p = rows[0];
  if (!p || p.client_signed_at) return { alerted: false };

  const dollars = `$${(Number(amountCents || 0) / 100).toFixed(2)}`;
  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
     VALUES ($1, 'payment_unsigned', 'system', $2)`,
    [proposalId, JSON.stringify({ amount: Number(amountCents || 0), payment_type: paymentType, source })]
  );
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(
      `payment_on_unsigned_proposal (proposal ${proposalId}, ${paymentType}, ${dollars}, ${source})`,
      { level: 'warning', tags: { webhook: 'stripe', issue: 'unsigned_payment' } }
    );
  }

  const proposalUrl = `${PUBLIC_SITE_URL}/proposal/${encodeURIComponent(p.token)}`;
  const adminUrl = `${ADMIN_URL}/proposals/${proposalId}`;
  const line = `A ${paymentType} payment of ${dollars} landed on proposal #${proposalId}`
    + `${p.client_name ? ` (${p.client_name})` : ''} and there is no signed agreement on file. `
    + 'The booking is recorded as paid. Ask the client to sign at their proposal link; the page accepts a signature after payment.';
  await notifyAdminCategory({
    category: 'urgent_booking',
    subject: `Unsigned booking paid: proposal #${proposalId}`,
    emailText: `${line}\n\nProposal link: ${proposalUrl}\nAdmin: ${adminUrl}`,
    emailHtml: `<p>${esc(line)}</p><p><a href="${esc(proposalUrl)}">Client proposal link</a> &middot; <a href="${esc(adminUrl)}">Open in admin</a></p>`,
  });
  return { alerted: true };
}

module.exports = { notifyUnsignedPayment };
