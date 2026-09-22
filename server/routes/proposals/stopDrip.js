// POST /api/proposals/:id/stop-drip — admin "Stop follow-ups" (2026-09-22).
//
// One-way. The unsigned-proposal drip is owned per EVENT, not per proposal
// (a second option sent solo joins the first one's sequence, see
// utils/dripSiblings.js), so stopping it from either option's page kills the
// in-flight touches on every open proposal of the client with the same
// event_date and stamps drip_stopped_at on each. The stamp is the durable
// signal: rows are marked 'suppressed' (which survives the archive doors'
// DELETE of pending rows) and the archive hand-off refuses to rebuild a
// stopped drip on a surviving option. Only drip_touch_% rows are touched;
// balance, event-week and post-event touches keep firing. A resend starts a
// fresh sequence on a new proposal, which is the only way back.
//
// A decision recorded here because it came up in the same conversation: a
// CLIENT REPLY does not stop the drip. Only this button, a signature, an
// archive, or STOP does.
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError, ConflictError } = require('../../utils/errors');
const { OPEN_STATUS_LIST } = require('../../utils/dripSiblings');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');

const router = express.Router();

router.post('/:id/stop-drip', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('Proposal not found');

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const me = await db.query('SELECT id, status, drip_stopped_at FROM proposals WHERE id = $1 FOR UPDATE', [id]);
    if (!me.rows[0]) { await db.query('ROLLBACK'); throw new NotFoundError('Proposal not found'); }
    if (!OPEN_STATUS_LIST.includes(me.rows[0].status)) {
      await db.query('ROLLBACK');
      throw new ConflictError('Follow-ups only run on a sent, viewed, or modified proposal.', 'DRIP_NOT_ACTIVE');
    }
    const alreadyStopped = Boolean(me.rows[0].drip_stopped_at);

    // The conversation: this proposal plus every OPEN sibling for the same
    // client + event_date. Compared in SQL so a DATE never round-trips through
    // JS; a NULL event_date matches nothing, so it stops only itself. A draft
    // alternative is not in the conversation yet (sent later, it starts
    // fresh) and a booked sibling has no drip to stop.
    const conv = await db.query(
      `SELECT p.id
         FROM proposals me
         JOIN proposals p
           ON p.id = me.id
           OR (p.client_id = me.client_id AND p.event_date = me.event_date AND p.status = ANY($2::text[]))
        WHERE me.id = $1
        ORDER BY p.id`,
      [id, OPEN_STATUS_LIST]
    );
    const ids = conv.rows.map((r) => r.id);

    // Always run the suppress, stamped or not: a repeat click must still be
    // able to kill a stray in-flight touch (the button is the only door).
    const killed = await db.query(
      `UPDATE scheduled_messages
          SET status = 'suppressed', error_message = 'stopped by admin'
        WHERE entity_type = 'proposal'
          AND entity_id = ANY($1::int[])
          AND message_type LIKE 'drip_touch_%'
          AND status IN ('pending', 'deferred')`,
      [ids]
    );
    const stamped = await db.query(
      `UPDATE proposals
          SET drip_stopped_at = COALESCE(drip_stopped_at, NOW())
        WHERE id = ANY($1::int[])
        RETURNING id, drip_stopped_at`,
      [ids]
    );
    if (!alreadyStopped || killed.rowCount > 0) {
      await db.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'drip_stopped', 'admin', $2, $3)`,
        [id, req.user.id, JSON.stringify({ suppressed: killed.rowCount, proposal_ids: ids, repeat: alreadyStopped })]
      );
    }
    await db.query('COMMIT');

    const mine = stamped.rows.find((r) => r.id === id);
    res.json({ suppressed: killed.rowCount, already_stopped: alreadyStopped, proposal_ids: ids, drip_stopped_at: mine ? mine.drip_stopped_at : null });
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    db.release();
  }
}));

module.exports = router;
