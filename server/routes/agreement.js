const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

const AGREEMENT_DOCUMENT_VERSION = 'contractor-agreement-v1';

// Get agreement
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM agreements WHERE user_id = $1', [req.user.id]);
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Save agreement
router.post('/', auth, async (req, res) => {
  const { full_name, email, phone, sms_consent, acknowledged_field_guide, agreed_non_solicitation, signature_data, signature_method } = req.body;

  if (!full_name || !email || !acknowledged_field_guide || !agreed_non_solicitation || !signature_data) {
    return res.status(400).json({ error: 'All fields required including signature' });
  }

  if (signature_method !== 'draw' && signature_method !== 'type') {
    return res.status(400).json({ error: 'Invalid signature method.' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;

  try {
    const existing = await pool.query('SELECT id FROM agreements WHERE user_id = $1', [req.user.id]);

    if (existing.rows[0]) {
      await pool.query(
        `UPDATE agreements SET full_name=$1, email=$2, phone=$3, sms_consent=$4,
         acknowledged_field_guide=$5, agreed_non_solicitation=$6, signature_data=$7,
         signature_method=$8, signature_ip=$9, signature_user_agent=$10, signature_document_version=$11,
         signed_at=NOW()
         WHERE user_id=$12`,
        [full_name, email, phone, sms_consent, acknowledged_field_guide, agreed_non_solicitation, signature_data,
         signature_method, ip, userAgent, AGREEMENT_DOCUMENT_VERSION, req.user.id]
      );
    } else {
      await pool.query(
        `INSERT INTO agreements (user_id, full_name, email, phone, sms_consent, acknowledged_field_guide, agreed_non_solicitation,
         signature_data, signature_method, signature_ip, signature_user_agent, signature_document_version, signed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
        [req.user.id, full_name, email, phone, sms_consent, acknowledged_field_guide, agreed_non_solicitation,
         signature_data, signature_method, ip, userAgent, AGREEMENT_DOCUMENT_VERSION]
      );
    }

    // Mark step complete
    await pool.query(
      `UPDATE onboarding_progress SET agreement_completed=true, last_completed_step='agreement_completed' WHERE user_id=$1`,
      [req.user.id]
    );

    const result = await pool.query('SELECT * FROM agreements WHERE user_id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
