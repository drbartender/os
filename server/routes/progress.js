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
    if (step === 'onboarding_completed') {
      // Verify user is in a valid onboarding state before allowing completion
      const userRes = await pool.query('SELECT onboarding_status FROM users WHERE id = $1', [req.user.id]);
      const currentStatus = userRes.rows[0]?.onboarding_status;
      if (!['hired', 'in_progress'].includes(currentStatus)) {
        return res.status(400).json({ error: 'Invalid onboarding state.' });
      }

      const prog = await pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [req.user.id]);
      const p = prog.rows[0];
      if (!p || !p.welcome_viewed || !p.field_guide_completed || !p.agreement_completed ||
          !p.contractor_profile_completed || !p.payday_protocols_completed) {
        return res.status(400).json({ error: 'Complete all prior steps first.' });
      }
    }

    await pool.query(`
      UPDATE onboarding_progress SET
        welcome_viewed = CASE WHEN $1 = 'welcome_viewed' THEN true ELSE welcome_viewed END,
        field_guide_completed = CASE WHEN $1 = 'field_guide_completed' THEN true ELSE field_guide_completed END,
        agreement_completed = CASE WHEN $1 = 'agreement_completed' THEN true ELSE agreement_completed END,
        contractor_profile_completed = CASE WHEN $1 = 'contractor_profile_completed' THEN true ELSE contractor_profile_completed END,
        payday_protocols_completed = CASE WHEN $1 = 'payday_protocols_completed' THEN true ELSE payday_protocols_completed END,
        onboarding_completed = CASE WHEN $1 = 'onboarding_completed' THEN true ELSE onboarding_completed END,
        last_completed_step = $1
      WHERE user_id = $2
    `, [step, req.user.id]);

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
