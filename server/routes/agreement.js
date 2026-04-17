const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');

const router = express.Router();

const AGREEMENT_DOCUMENT_VERSION = 'contractor-agreement-v1';

// Get agreement
router.get('/', auth, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM agreements WHERE user_id = $1', [req.user.id]);
  res.json(result.rows[0] || {});
}));

// Save agreement
router.post('/', auth, asyncHandler(async (req, res) => {
  const { full_name, email, phone, sms_consent, acknowledged_field_guide, agreed_non_solicitation, signature_data, signature_method } = req.body;

  const fieldErrors = {};
  if (!full_name) fieldErrors.full_name = 'Full name is required';
  if (!email) fieldErrors.email = 'Email is required';
  if (!acknowledged_field_guide) fieldErrors.acknowledged_field_guide = 'You must acknowledge the field guide';
  if (!agreed_non_solicitation) fieldErrors.agreed_non_solicitation = 'You must agree to the non-solicitation terms';
  if (!signature_data) fieldErrors.signature = 'Please sign the agreement before submitting';
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  if (signature_method !== 'draw' && signature_method !== 'type') {
    throw new ValidationError({ signature: 'Invalid signature method.' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM agreements WHERE user_id = $1', [req.user.id]);

    if (existing.rows[0]) {
      await client.query(
        `UPDATE agreements SET full_name=$1, email=$2, phone=$3, sms_consent=$4,
         acknowledged_field_guide=$5, agreed_non_solicitation=$6, signature_data=$7,
         signature_method=$8, signature_ip=$9, signature_user_agent=$10, signature_document_version=$11,
         signed_at=NOW()
         WHERE user_id=$12`,
        [full_name, email, phone, sms_consent, acknowledged_field_guide, agreed_non_solicitation, signature_data,
         signature_method, ip, userAgent, AGREEMENT_DOCUMENT_VERSION, req.user.id]
      );
    } else {
      await client.query(
        `INSERT INTO agreements (user_id, full_name, email, phone, sms_consent, acknowledged_field_guide, agreed_non_solicitation,
         signature_data, signature_method, signature_ip, signature_user_agent, signature_document_version, signed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
        [req.user.id, full_name, email, phone, sms_consent, acknowledged_field_guide, agreed_non_solicitation,
         signature_data, signature_method, ip, userAgent, AGREEMENT_DOCUMENT_VERSION]
      );
    }

    // Mark step complete
    await client.query(
      `UPDATE onboarding_progress SET agreement_completed=true, last_completed_step='agreement_completed' WHERE user_id=$1`,
      [req.user.id]
    );

    await client.query('COMMIT');
  } catch (txErr) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw txErr;
  } finally {
    client.release();
  }

  const result = await pool.query('SELECT * FROM agreements WHERE user_id = $1', [req.user.id]);
  res.json(result.rows[0]);
}));

module.exports = router;
