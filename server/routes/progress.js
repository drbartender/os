const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Get progress
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [req.user.id]);
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update a step
router.put('/step', auth, async (req, res) => {
  const { step } = req.body;
  const validSteps = ['welcome_viewed', 'field_guide_completed', 'agreement_completed', 'contractor_profile_completed', 'payday_protocols_completed', 'onboarding_completed'];
  if (!validSteps.includes(step)) return res.status(400).json({ error: 'Invalid step' });

  try {
    await pool.query(
      `UPDATE onboarding_progress SET ${step} = true, last_completed_step = $1 WHERE user_id = $2`,
      [step, req.user.id]
    );

    // If onboarding_completed, update user status
    if (step === 'onboarding_completed') {
      await pool.query("UPDATE users SET onboarding_status = 'approved' WHERE id = $1", [req.user.id]);
    }

    const result = await pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
