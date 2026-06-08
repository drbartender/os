const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');

const router = express.Router();

// GET /api/proposals/change-requests?status=pending, the admin queue.
router.get('/change-requests', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  const r = await pool.query(
    `SELECT cr.*, p.token AS proposal_token, p.event_date, p.event_type, p.event_type_custom,
            c.name AS client_name, c.email AS client_email
       FROM proposal_change_requests cr
       JOIN proposals p ON p.id = cr.proposal_id
       LEFT JOIN clients c ON c.id = cr.client_id
      WHERE cr.status = $1
      ORDER BY (cr.edit_window = 'inside_t14') DESC, cr.created_at ASC
      LIMIT 200`,
    [status]
  );
  res.json({ requests: r.rows });
}));

// GET /api/proposals/:id/change-requests, one proposal's requests.
router.get('/:id/change-requests', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM proposal_change_requests WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.params.id]
  );
  res.json({ requests: r.rows });
}));

// POST /api/proposals/change-requests/:id/decline, decline with a required reason.
router.post('/change-requests/:id/decline', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const note = (req.body.decision_note || '').trim().slice(0, 1000);
  if (!note) throw new ValidationError({ decision_note: 'A reason is required to decline.' });
  const dbClient = await pool.connect();
  let cr;
  try {
    await dbClient.query('BEGIN');
    const r = await dbClient.query(
      `UPDATE proposal_change_requests
          SET status = 'declined', decided_by = $1, decided_at = NOW(), decision_note = $2, updated_at = NOW()
        WHERE id = $3 AND status = 'pending' RETURNING *`,
      [req.user.id, note, req.params.id]
    );
    if (!r.rows[0]) throw new NotFoundError('No pending request to decline.');
    cr = r.rows[0];
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'change_declined', 'admin', $2, $3)`,
      [cr.proposal_id, req.user.id, JSON.stringify({ change_request_id: cr.id })]
    );
    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    dbClient.release();
  }
  try {
    const { notifyClientOfDecision } = require('../../utils/changeRequestNotifications');
    const p = await pool.query('SELECT * FROM proposals WHERE id = $1', [cr.proposal_id]);
    if (p.rows[0]) await notifyClientOfDecision(cr, p.rows[0], 'declined');
  } catch (e) { console.error('decline notify failed (non-blocking):', e.message); }
  res.json({ change_request: cr });
}));

module.exports = router;
