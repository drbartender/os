'use strict';

// Informational notice when a staff preferred name is set or changed.
// Spec §3.5. THIS IS NOT A GATE: the name is live from the moment it is typed,
// and no name read path consults preferred_name_reviewed_at. The only action is
// "Got it", which stamps the timestamp. There is deliberately no reject action;
// the remedy for a bad name is a conversation, and if that conversation ends in
// a change, it gets made in the profile like any other edit.

const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');

const router = express.Router();

router.get('/name-notices', auth, adminOnly, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT cp.user_id,
            cp.display_name,
            cp.preferred_name,
            COALESCE(ag.full_name, ap.full_name) AS legal_name
       FROM contractor_profiles cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN agreements   ag ON ag.user_id = cp.user_id
       LEFT JOIN applications ap ON ap.user_id = cp.user_id
      WHERE cp.preferred_name_reviewed_at IS NULL
        AND cp.preferred_name IS NOT NULL
        -- Deactivated staff are not working, so their name is not going on
        -- anything and a departed staffer is not a thing that needs attention.
        AND u.onboarding_status <> 'deactivated'
      ORDER BY cp.updated_at DESC`
  );
  res.json({ rows });
}));

router.post('/name-notices/:userId/ack', auth, adminOnly, asyncHandler(async (req, res) => {
  // user_id is an INTEGER column, so a non-numeric segment reaches Postgres as a
  // 22P02 invalid_text_representation and surfaces as a 500 plus Sentry noise.
  // Reject it here as the client error it actually is.
  if (!/^\d+$/.test(String(req.params.userId))) {
    throw new ValidationError({ userId: 'Must be a numeric user id.' });
  }
  const userId = Number(req.params.userId);

  // Scoped to a row that is actually pending. Without the NULL guard this
  // returns { ok: true } for a nonexistent user or an already-acked one, so a
  // stale strip (or a double click) reads as success and, worse, re-dates a
  // review that already happened.
  const { rowCount } = await pool.query(
    `UPDATE contractor_profiles
        SET preferred_name_reviewed_at = NOW()
      WHERE user_id = $1
        AND preferred_name_reviewed_at IS NULL`,
    [userId]
  );
  if (rowCount === 0) throw new NotFoundError('No pending name notice for that user.');
  res.json({ ok: true });
}));

module.exports = router;
