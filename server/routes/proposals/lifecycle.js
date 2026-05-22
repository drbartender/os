const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const { createInvoiceOnSend } = require('../../utils/invoiceHelpers');
const { sendProposalSentEmail } = require('../../utils/sendProposalSentEmail');

const router = express.Router();

// Dependency seam for tests. lifecycle.js carries its own copy because the
// PATCH /:id/status handler lives here. createInvoiceOnSend runs INSIDE the
// status transaction; sendProposalSentEmail runs AFTER commit. crud.test.js
// stubs both to count emails and to force an invoice failure that must roll
// the status change back.
let _deps = { createInvoiceOnSend, sendProposalSentEmail };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

// Status state machine — enforced on PATCH /:id/status unless ?force=true (admin only).
// Transitions are one-way except for admin-backed corrections via force.
// `archived` is the soft-terminal bucket: shelf for duplicates/abandoned/client-cancelled
// proposals before payment. Recoverable — `archived → draft` brings it back into the active
// pipeline. Not reachable from paid statuses (deposit_paid/balance_paid/confirmed/completed) —
// those reflect real money and archiving them via a state transition would desync the ledger.
// Admins can ?force=true to bypass for ledger-corrected refunds.
const STATUS_TRANSITIONS = {
  draft:        ['sent', 'archived'],
  sent:         ['viewed', 'accepted', 'modified', 'draft', 'archived'],
  viewed:       ['accepted', 'modified', 'sent', 'archived'],
  modified:     ['sent', 'accepted', 'archived'],
  accepted:     ['deposit_paid', 'confirmed', 'archived'],
  deposit_paid: ['balance_paid', 'confirmed', 'completed'],
  balance_paid: ['completed'],
  confirmed:    ['completed', 'deposit_paid', 'balance_paid'],
  completed:    [],
  archived:     ['draft'],
};

/** PATCH /api/proposals/:id/status — update status. Enforce state machine unless ?force=true (admin-only) */
router.patch('/:id/status', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const { status } = req.body;
  const validStatuses = Object.keys(STATUS_TRANSITIONS);
  if (!validStatuses.includes(status)) {
    throw new ValidationError({ status: 'Invalid status' });
  }

  const force = req.query.force === 'true' && req.user.role === 'admin';

  // The whole status change runs in ONE transaction. The current status is read
  // under a row lock (SELECT ... FOR UPDATE) so two concurrent →sent PATCHes
  // serialize: the second blocks until the first commits, then re-reads the
  // now-'sent' status and the transition check rejects the duplicate. Without
  // the lock, both could read 'draft', both pass the check, and both write a
  // duplicate activity-log row + send a duplicate client email (the invoice is
  // safe either way — createInvoiceOnSend is idempotent on proposal_id).
  const dbClient = await pool.connect();
  let result;
  let currentStatus;
  try {
    await dbClient.query('BEGIN');

    const current = await dbClient.query(
      'SELECT status FROM proposals WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    if (!current.rows[0]) throw new NotFoundError('Proposal not found');
    currentStatus = current.rows[0].status;

    if (!force && currentStatus !== status) {
      const allowed = STATUS_TRANSITIONS[currentStatus] || [];
      if (!allowed.includes(status)) {
        throw new ValidationError({
          status: `Cannot transition from '${currentStatus}' to '${status}'. Allowed: [${allowed.join(', ') || 'none'}]. Admins may use ?force=true.`,
        });
      }
    }

    // $1 is cast to text consistently in every position — `status` is a varchar
    // column, and mixing a bare `$1` with `$1::text` makes Postgres deduce
    // conflicting types for the same parameter ("inconsistent types deduced").
    result = await dbClient.query(
      `UPDATE proposals SET
         status = $1::text,
         sent_at     = CASE WHEN $1::text = 'sent'     THEN COALESCE(sent_at, NOW())     ELSE sent_at END,
         accepted_at = CASE WHEN $1::text = 'accepted' THEN COALESCE(accepted_at, NOW()) ELSE accepted_at END
       WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );

    const action = force ? 'status_force_changed' : 'status_changed';
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, $2, 'admin', $3, $4)`,
      [req.params.id, action, req.user.id, JSON.stringify({ from: currentStatus, to: status, forced: force })]
    );

    // Auto-create the first invoice when the proposal is sent. Runs INSIDE this
    // transaction so a proposal is never committed in 'sent' without its
    // invoice; createInvoiceOnSend is idempotent on proposal_id (a re-send
    // finds the existing invoice and no-ops). A throw here rolls back the
    // status change too.
    if (status === 'sent') {
      await _deps.createInvoiceOnSend(req.params.id, dbClient);
    }

    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }

  // Email the client AFTER commit — best-effort, on EVERY →sent transition (no
  // sent_at check, so a modified→sent re-send still notifies the client). The
  // proposals row has no client_email / client_name (those live on `clients`),
  // so we re-fetch joined to `clients` — sendProposalSentEmail needs
  // client_email / client_name / token / event_type*. Its own try/catch: this
  // runs post-COMMIT, so a failed SELECT here must never 500 a request whose
  // status change + invoice are already durably committed. Mirrors the
  // clients-JOIN email step in POST /.
  if (status === 'sent') {
    try {
      const pd = await pool.query(`
        SELECT p.token, p.event_type, p.event_type_custom,
               c.name AS client_name, c.email AS client_email
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1`, [req.params.id]);
      if (pd.rows[0]) {
        await _deps.sendProposalSentEmail(
          { ...pd.rows[0], id: Number(req.params.id) },
          { actorType: 'admin' },
        );
      }
    } catch (e) {
      console.error('Post-send email re-fetch failed for proposal', req.params.id, e.code || e.name);
    }
  }

  // Plan 2d: comms hooks on the status transition. All best-effort and
  // non-blocking — a scheduling failure must never break the status change.
  // The marketing helpers are idempotent, so a same-status re-PATCH is safe.
  if (status === 'sent') {
    try {
      const { scheduleDripForProposal } = require('../../utils/marketingHandlers');
      await scheduleDripForProposal(Number(req.params.id));
    } catch (dripErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(dripErr, { tags: { route: 'proposals/status', issue: 'drip-enroll' } });
      }
      console.error('Drip enrollment failed (non-blocking):', dripErr);
    }
  }
  if (status === 'archived') {
    try {
      const { cancelMarketingForProposal } = require('../../utils/marketingHandlers');
      await cancelMarketingForProposal(Number(req.params.id));
    } catch (cancelErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(cancelErr, { tags: { route: 'proposals/status', issue: 'archive-cancel' } });
      }
      console.error('Marketing cancel on archive failed (non-blocking):', cancelErr);
    }
  }
  if (status === 'completed') {
    try {
      const { scheduleReviewRequest, scheduleRetentionNudge } = require('../../utils/marketingHandlers');
      await scheduleReviewRequest(Number(req.params.id));
      await scheduleRetentionNudge(Number(req.params.id));
    } catch (completeErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(completeErr, { tags: { route: 'proposals/status', issue: 'completion-enroll' } });
      }
      console.error('Completion enroll failed (non-blocking):', completeErr);
    }
  }

  res.json(result.rows[0]);
}));

module.exports = router;
// Dependency seam for tests — attached to the router export so the proposals
// composition router still mounts cleanly (Express ignores extra properties).
module.exports.__setDeps = __setDeps;
