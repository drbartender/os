const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const { createInvoiceOnSend } = require('../../utils/invoiceHelpers');
const { sendProposalSentEmail } = require('../../utils/sendProposalSentEmail');
const { accruePayoutsForProposal } = require('../../utils/payrollAccrual');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { PUBLIC_SITE_URL } = require('../../utils/urls');

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
      'SELECT status, group_id FROM proposals WHERE id = $1 FOR UPDATE', [req.params.id]
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

    // Grouped proposals are sent together via POST /:id/send-group (one compare
    // email, deferred invoicing). Block the solo send path so a grouped option
    // never gets its own proposalSent email + eager invoice. Applies even under
    // force: solo-sending a grouped option is always wrong (dissolve it first).
    if (status === 'sent' && current.rows[0].group_id) {
      throw new ConflictError('Grouped proposals are sent together from the comparison. Use Send options.', 'USE_GROUP_SEND');
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
        SELECT p.token, p.event_type, p.event_type_custom, p.event_date, p.status,
               c.id AS client_id, c.name AS client_name, c.email AS client_email,
               c.phone AS client_phone, c.communication_preferences,
               c.email_status, c.phone_status
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
    try {
      const { cancelPendingChangeRequestsForProposal } = require('../../utils/changeRequests');
      await cancelPendingChangeRequestsForProposal(Number(req.params.id));
    } catch (crErr) {
      console.error('Change-request reap on archive failed (non-blocking):', crErr);
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
    try {
      await accruePayoutsForProposal(Number(req.params.id));
    } catch (err) {
      Sentry.captureException(err, { tags: { route: 'proposal_status', step: 'payout_accrual' } });
    }
    try {
      const { cancelPendingChangeRequestsForProposal } = require('../../utils/changeRequests');
      await cancelPendingChangeRequestsForProposal(Number(req.params.id));
    } catch (crErr) {
      console.error('Change-request reap on complete failed (non-blocking):', crErr);
    }
  }

  res.json(result.rows[0]);
}));

/**
 * POST /api/proposals/:id/resend — manually re-send the proposal to the client
 * (email + SMS), leaving status untouched. The auto-send fires on the →sent
 * transition; this is the detail-page "Resend" button for when a client says
 * they never saw it. sendProposalSentEmail is best-effort (never throws) and
 * gates the SMS half through shouldSendImmediate, so an opted-out client is not
 * texted. A 'resent' activity row records that it went out again.
 */
router.post('/:id/resend', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const pd = await pool.query(`
    SELECT p.token, p.event_type, p.event_type_custom, p.event_date, p.status,
           c.id AS client_id, c.name AS client_name, c.email AS client_email,
           c.phone AS client_phone, c.communication_preferences,
           c.email_status, c.phone_status
    FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1`, [req.params.id]);
  const proposal = pd.rows[0];
  if (!proposal) throw new NotFoundError('Proposal not found');
  // Only re-send in the active, already-sent-and-not-yet-paid window. Draft is
  // not sent yet (use "Send to client"); archived is shelved/cancelled; paid,
  // confirmed, and completed are past the "review and sign" proposal stage, so
  // the proposalSent copy would be stale/confusing there. The client mirrors this.
  const RESENDABLE = ['sent', 'viewed', 'modified', 'accepted'];
  if (!RESENDABLE.includes(proposal.status)) {
    throw new ValidationError({}, `This proposal can't be resent from its current status (${proposal.status}).`);
  }
  if (!proposal.client_email && !proposal.client_phone) {
    throw new ValidationError({}, 'No client email or phone on file to resend to.');
  }

  // Best-effort (never throws): resends the proposalSent email + initial-proposal
  // SMS, the SMS half suppressed for opted-out clients inside sendProposalSentEmail.
  await _deps.sendProposalSentEmail(
    { ...proposal, id: Number(req.params.id) },
    { actorType: 'admin' },
  );

  // The activity log is secondary to the send that already went out — never let
  // a logging blip 500 the request (that would prompt a duplicate resend).
  try {
    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'resent', 'admin', $2, $3)`,
      [req.params.id, req.user.id, JSON.stringify({ via: 'admin_resend' })]
    );
  } catch (logErr) {
    console.error('Resend activity-log insert failed (non-blocking) for proposal', req.params.id, logErr.code || logErr.name);
  }

  res.json({ ok: true });
}));

/**
 * POST /api/proposals/:id/portal-invite — email the client their portal link
 * (admin-triggered). Plain invite: the portal sits behind the OTP login
 * (email a one-time code), so no token rides in the email. Email-only per the
 * prefer-email-over-SMS default. A send failure surfaces to the admin (this
 * is a deliberate manual action, not a best-effort side effect); the activity
 * log is secondary and never 500s an already-sent invite.
 */
router.post('/:id/portal-invite', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const pd = await pool.query(`
    SELECT c.name AS client_name, c.email AS client_email
    FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1`, [req.params.id]);
  const row = pd.rows[0];
  if (!row) throw new NotFoundError('Proposal not found');
  if (!row.client_email) throw new ValidationError({}, 'No client email on file to invite.');

  const tpl = emailTemplates.portalInvite({
    clientName: row.client_name,
    portalUrl: `${PUBLIC_SITE_URL}/my-proposals`,
  });
  await sendEmail({
    to: row.client_email,
    ...tpl,
    meta: { proposalId: Number(req.params.id), messageType: 'portal_invite' },
  });

  try {
    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'portal_invite_sent', 'admin', $2, $3)`,
      [req.params.id, req.user.id, JSON.stringify({ via: 'admin_invite' })]
    );
  } catch (logErr) {
    console.error('Portal-invite activity-log insert failed (non-blocking) for proposal', req.params.id, logErr.code || logErr.name);
  }

  res.json({ ok: true });
}));

module.exports = router;
// Dependency seam for tests — attached to the router export so the proposals
// composition router still mounts cleanly (Express ignores extra properties).
module.exports.__setDeps = __setDeps;
