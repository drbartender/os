'use strict';

// Comms action: proposal_send (plan P2, spec 4.4). The compose-first INITIAL
// send: the creation flow now saves the proposal as a draft first, then this
// action's ensureSideEffects performs the legacy PATCH /:id/status 'sent'
// transition (row-locked flip + sent_at + activity log + invoice, one
// transaction, mirroring server/routes/proposals/lifecycle.js) so a proposal
// is never committed 'sent' without its invoice. Cancel in the modal leaves a
// plain draft (existing draft semantics + cleanup scheduler).
//
// Recipient, message parts, and dispatch are IDENTICAL to proposal_resend
// (same proposalSent email + initial-proposal SMS, same suppression), so those
// are delegated to that action rather than duplicated.
const { pool } = require('../../../db');
const { createInvoiceOnSend } = require('../../invoiceHelpers');
const { NotFoundError, ConflictError } = require('../../errors');
const resend = require('./proposalResend');

const key = 'proposal_send';

/**
 * Draft -> sent, idempotently. FOR UPDATE lock serializes concurrent sends
 * (second reads 'sent', returns applied:false, no duplicate invoice/log).
 * createInvoiceOnSend runs INSIDE the transaction (never 'sent' without its
 * invoice) and is itself idempotent on proposal_id. Grouped proposals are
 * blocked exactly like the legacy solo-send path (USE_GROUP_SEND).
 * Drip enrollment runs post-release, best-effort: marketingHandlers takes its
 * own pooled connections, so holding our client across it risks the pool
 * deadlock invariant (CLAUDE.md, SERVER-17).
 */
async function ensureSideEffects(proposalId, ctx = {}) {
  const dbClient = await pool.connect();
  let applied = false;
  try {
    await dbClient.query('BEGIN');
    const current = await dbClient.query(
      'SELECT status, group_id FROM proposals WHERE id = $1 FOR UPDATE', [proposalId]
    );
    if (!current.rows[0]) throw new NotFoundError('Proposal not found');
    if (current.rows[0].group_id) {
      throw new ConflictError('Grouped proposals are sent together from the comparison. Use Send options.', 'USE_GROUP_SEND');
    }
    if (current.rows[0].status !== 'draft') {
      // Already sent (or beyond): idempotent no-op so Retry never double-flips.
      await dbClient.query('ROLLBACK');
      return { applied: false };
    }
    await dbClient.query(
      `UPDATE proposals SET status = 'sent', sent_at = COALESCE(sent_at, NOW()) WHERE id = $1`,
      [proposalId]
    );
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'status_changed', 'admin', $2, $3)`,
      [proposalId, ctx.sentBy || null, JSON.stringify({ from: 'draft', to: 'sent', via: 'comms_send' })]
    );
    await createInvoiceOnSend(proposalId, dbClient);
    await dbClient.query('COMMIT');
    applied = true;
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }

  // Post-release, best-effort: unsigned-proposal drip (allowlisted on status,
  // idempotent inserts). A failure never unwinds the committed send.
  try {
    const { scheduleDripForProposal } = require('../../marketingHandlers');
    await scheduleDripForProposal(proposalId);
  } catch (dripErr) {
    console.error('Drip enrollment failed (non-blocking):', dripErr);
    if (process.env.SENTRY_DSN_SERVER) {
      const Sentry = require('@sentry/node');
      Sentry.captureException(dripErr, { tags: { action: 'proposal_send', issue: 'drip-enroll' } });
    }
  }
  return { applied };
}

module.exports = {
  key,
  messageType: resend.messageType,       // 'proposal_sent' — same ledger type
  defaultChannels: resend.defaultChannels,
  resolveRecipient: resend.resolveRecipient,
  buildMessages: resend.buildMessages,
  ensureSideEffects,
  dispatch: resend.dispatch,
};
