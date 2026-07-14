const express = require('express');
const { pool } = require('../db');
const { ensureOnboardingProgress } = require('../utils/onboardingProgress');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');

const router = express.Router();

// Get progress
router.get('/', auth, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [req.user.id]);
  res.json(result.rows[0] || {});
}));

// Update a step. Note: 'onboarding_completed' is owned by POST /payment, which
// flips the boolean and the user's onboarding_status atomically inside its
// transaction. This route handles the 5 user-driven progress steps only.
router.put('/step', auth, asyncHandler(async (req, res) => {
  const { step } = req.body;
  const validSteps = ['welcome_viewed', 'field_guide_completed', 'agreement_completed', 'contractor_profile_completed', 'payday_protocols_completed'];
  if (!validSteps.includes(step)) throw new ValidationError({ step: 'Invalid step' });

  // A finished account must never be rewound. If onboarding is already
  // complete, ignore step writes — otherwise a stale client that gets bounced
  // back through /welcome (see Completion.js handoff) would regress
  // last_completed_step and re-corrupt the row. Return the row unchanged.
  await ensureOnboardingProgress(req.user.id);
  const cur = await pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [req.user.id]);
  if (cur.rows[0]?.onboarding_completed) {
    return res.json(cur.rows[0]);
  }

  await pool.query(`
    UPDATE onboarding_progress SET
      welcome_viewed = CASE WHEN $1::text = 'welcome_viewed' THEN true ELSE welcome_viewed END,
      field_guide_completed = CASE WHEN $1::text = 'field_guide_completed' THEN true ELSE field_guide_completed END,
      agreement_completed = CASE WHEN $1::text = 'agreement_completed' THEN true ELSE agreement_completed END,
      contractor_profile_completed = CASE WHEN $1::text = 'contractor_profile_completed' THEN true ELSE contractor_profile_completed END,
      payday_protocols_completed = CASE WHEN $1::text = 'payday_protocols_completed' THEN true ELSE payday_protocols_completed END,
      last_completed_step = $1
    WHERE user_id = $2
  `, [step, req.user.id]);

  const result = await pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [req.user.id]);
  res.json(result.rows[0]);
}));

module.exports = router;
