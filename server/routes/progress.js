const express = require('express');
const { pool } = require('../db');
const { ensureOnboardingProgress } = require('../utils/onboardingProgress');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');
const { outstandingFor } = require('../utils/outstandingDocuments');

const router = express.Router();

// Get progress
router.get('/', auth, asyncHandler(async (req, res) => {
  const [result, documentsOutstanding] = await Promise.all([
    pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [req.user.id]),
    outstandingFor(req.user.id),
  ]);
  res.json({ ...(result.rows[0] || {}), documents_outstanding: documentsOutstanding });
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
    // Same shape as the main return below. Two exits from one endpoint handing
    // back different shapes is how a consumer ends up with the field on one call
    // and undefined on the next.
    return res.json({
      ...cur.rows[0],
      documents_outstanding: await outstandingFor(req.user.id),
    });
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

  // Return documents_outstanding here too. Welcome.js, FieldGuide.js and
  // ContractorProfile.js all call setProgress(r.data) with this response, so a
  // reply lacking the field blanks it in context and the notice blinks off until
  // Layout refetches on the next route change.
  const [result, documentsOutstanding] = await Promise.all([
    pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [req.user.id]),
    outstandingFor(req.user.id),
  ]);
  res.json({ ...result.rows[0], documents_outstanding: documentsOutstanding });
}));

// Autosaved drafts for the two long onboarding forms.
//
// payday_protocols is deliberately absent: it carries SSN and bank routing and
// account numbers, which live encrypted at rest. A draft row would be a second,
// plaintext copy of exactly the data we encrypt. The allowlist is the guard.
const DRAFT_FORM_KEYS = ['application', 'contractor_profile'];
const MAX_DRAFT_BYTES = 64 * 1024;

function assertFormKey(formKey) {
  if (!DRAFT_FORM_KEYS.includes(formKey)) {
    throw new ValidationError({ formKey: 'Unknown form.' });
  }
}

router.get('/draft/:formKey', auth, asyncHandler(async (req, res) => {
  assertFormKey(req.params.formKey);
  const result = await pool.query(
    'SELECT data, updated_at FROM onboarding_drafts WHERE user_id = $1 AND form_key = $2',
    [req.user.id, req.params.formKey]
  );
  const row = result.rows[0];
  res.json(row ? { data: row.data, updated_at: row.updated_at } : { data: null });
}));

router.put('/draft/:formKey', auth, asyncHandler(async (req, res) => {
  assertFormKey(req.params.formKey);
  const { data } = req.body;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError({ data: 'Draft data must be an object.' });
  }
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > MAX_DRAFT_BYTES) {
    throw new ValidationError({ data: 'Draft is too large to save.' });
  }

  const result = await pool.query(`
    INSERT INTO onboarding_drafts (user_id, form_key, data)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (user_id, form_key)
      DO UPDATE SET data = EXCLUDED.data
    RETURNING data, updated_at
  `, [req.user.id, req.params.formKey, serialized]);

  res.json({ data: result.rows[0].data, updated_at: result.rows[0].updated_at });
}));

router.delete('/draft/:formKey', auth, asyncHandler(async (req, res) => {
  assertFormKey(req.params.formKey);
  await pool.query(
    'DELETE FROM onboarding_drafts WHERE user_id = $1 AND form_key = $2',
    [req.user.id, req.params.formKey]
  );
  res.json({ ok: true });
}));

module.exports = router;
