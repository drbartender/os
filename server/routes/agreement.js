const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { publicReadLimiter, signLimiter } = require('../middleware/rateLimiters');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { getCurrentAgreement, CURRENT_VERSION } = require('../data/contractorAgreement');
const { renderAgreementPdf } = require('../utils/agreementPdf');
const { uploadFile, getSignedUrl } = require('../utils/storage');
const { sendEmail } = require('../utils/email');
const { STAFF_URL } = require('../utils/urls');

const router = express.Router();

// Minimal HTML escape for inline interpolation in the signer confirmation email.
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── GET /api/agreement/legal-text — current version payload ──────────
router.get('/legal-text', publicReadLimiter, (req, res) => {
  res.json(getCurrentAgreement());
});

// ── GET /api/agreement — current user's saved agreement row ──────────
router.get('/', auth, asyncHandler(async (req, res) => {
  // Narrow projection — avoid shipping 200KB signature_data + UA on every read.
  const result = await pool.query(
    `SELECT full_name, email, phone, sms_consent,
            ack_ic_status, ack_commitment, ack_non_solicit,
            ack_damage_recoupment, ack_legal_protections, ack_field_guide,
            signature_document_version, signed_at,
            pdf_storage_key
       FROM agreements WHERE user_id = $1`,
    [req.user.id]
  );
  res.json(result.rows[0] || {});
}));

// ── GET /api/agreement/download — signed R2 URL to the PDF ───────────
router.get('/download', auth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT pdf_storage_key FROM agreements WHERE user_id = $1',
    [req.user.id]
  );
  const key = result.rows[0]?.pdf_storage_key;
  if (!key) throw new NotFoundError('Signed agreement PDF not available.');
  const url = await getSignedUrl(key);
  res.json({ url });
}));

// ── POST /api/agreement — sign ───────────────────────────────────────
router.post('/', signLimiter, auth, asyncHandler(async (req, res) => {
  const {
    full_name, email, phone, sms_consent,
    ack_ic_status, ack_commitment, ack_non_solicit,
    ack_damage_recoupment, ack_legal_protections, ack_field_guide,
    signature_data, signature_method,
  } = req.body;

  const fieldErrors = {};
  if (!full_name) fieldErrors.full_name = 'Full name is required';
  if (!email) fieldErrors.email = 'Email is required';
  if (!ack_ic_status)         fieldErrors.ack_ic_status         = 'This acknowledgment is required';
  if (!ack_commitment)        fieldErrors.ack_commitment        = 'This acknowledgment is required';
  if (!ack_non_solicit)       fieldErrors.ack_non_solicit       = 'This acknowledgment is required';
  if (!ack_damage_recoupment) fieldErrors.ack_damage_recoupment = 'This acknowledgment is required';
  if (!ack_legal_protections) fieldErrors.ack_legal_protections = 'This acknowledgment is required';
  if (!ack_field_guide)       fieldErrors.ack_field_guide       = 'This acknowledgment is required';
  if (!signature_data) fieldErrors.signature = 'Please sign the agreement before submitting';
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  if (typeof signature_data !== 'string' || signature_data.length > 200000) {
    throw new ValidationError({ signature: 'Signature payload is too large.' });
  }

  if (signature_method !== 'draw' && signature_method !== 'type') {
    throw new ValidationError({ signature: 'Invalid signature method.' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;

  // ── Transaction: upsert agreement row + mark onboarding step ──────
  let saved;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id FROM agreements WHERE user_id = $1',
      [req.user.id]
    );

    const cols = [
      'full_name','email','phone','sms_consent',
      'ack_ic_status','ack_commitment','ack_non_solicit',
      'ack_damage_recoupment','ack_legal_protections','ack_field_guide',
      'signature_data','signature_method','signature_ip','signature_user_agent',
      'signature_document_version','signed_at',
    ];

    if (existing.rows[0]) {
      // Note: pdf_storage_key/pdf_generated_at/pdf_email_sent_at are intentionally
      // NOT wiped here. If the post-commit PDF render/upload fails, the old key
      // stays usable (wrong version but readable) until the next successful
      // re-sign atomically overwrites it. Wiping inside the tx would create a
      // dead-link window on every re-sign until upload succeeded.
      const upd = await client.query(
        `UPDATE agreements SET
           full_name=$1, email=$2, phone=$3, sms_consent=$4,
           ack_ic_status=$5, ack_commitment=$6, ack_non_solicit=$7,
           ack_damage_recoupment=$8, ack_legal_protections=$9, ack_field_guide=$10,
           signature_data=$11, signature_method=$12, signature_ip=$13, signature_user_agent=$14,
           signature_document_version=$15, signed_at=NOW()
         WHERE user_id=$16
         RETURNING *`,
        [
          full_name, email, phone, !!sms_consent,
          !!ack_ic_status, !!ack_commitment, !!ack_non_solicit,
          !!ack_damage_recoupment, !!ack_legal_protections, !!ack_field_guide,
          signature_data, signature_method, ip, userAgent,
          CURRENT_VERSION, req.user.id,
        ]
      );
      saved = upd.rows[0];
    } else {
      const ins = await client.query(
        `INSERT INTO agreements
           (user_id, ${cols.join(', ')})
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
         RETURNING *`,
        [
          req.user.id,
          full_name, email, phone, !!sms_consent,
          !!ack_ic_status, !!ack_commitment, !!ack_non_solicit,
          !!ack_damage_recoupment, !!ack_legal_protections, !!ack_field_guide,
          signature_data, signature_method, ip, userAgent,
          CURRENT_VERSION,
        ]
      );
      saved = ins.rows[0];
    }

    await client.query(
      `UPDATE onboarding_progress
          SET agreement_completed=true, last_completed_step='agreement_completed'
        WHERE user_id=$1`,
      [req.user.id]
    );

    await client.query('COMMIT');
  } catch (txErr) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw txErr;
  } finally {
    client.release();
  }

  // ── Post-commit: render PDF, upload, respond, then background email ──
  try {
    const versionData = getCurrentAgreement();
    const pdfBuf = await renderAgreementPdf(versionData, {
      full_name: saved.full_name,
      email: saved.email,
      phone: saved.phone,
      signature_data: saved.signature_data,
      signature_method: saved.signature_method,
      signature_ip: saved.signature_ip,
      signature_user_agent: saved.signature_user_agent,
      signed_at: saved.signed_at,
      acknowledgments: {
        ack_ic_status: saved.ack_ic_status,
        ack_commitment: saved.ack_commitment,
        ack_non_solicit: saved.ack_non_solicit,
        ack_damage_recoupment: saved.ack_damage_recoupment,
        ack_legal_protections: saved.ack_legal_protections,
        ack_field_guide: saved.ack_field_guide,
      },
    });

    const storageKey = `agreements/${req.user.id}/${CURRENT_VERSION}-${Date.now()}.pdf`;
    await uploadFile(pdfBuf, storageKey);

    await pool.query(
      `UPDATE agreements
          SET pdf_storage_key=$1, pdf_generated_at=NOW()
        WHERE user_id=$2`,
      [storageKey, req.user.id]
    );

    const pdfUrl = await getSignedUrl(storageKey);

    // Respond immediately — user doesn't need to wait for email delivery.
    const agreement = {
      ...saved,
      pdf_storage_key: storageKey,
      pdf_generated_at: new Date(),
    };
    res.json({ agreement, pdf_url: pdfUrl });

    // Background the email send — fire-and-forget with error capture.
    const safeName = escapeHtml(saved.full_name) || 'there';
    const portalUrl = escapeHtml(`${STAFF_URL}/dashboard`);
    sendEmail({
      to: saved.email,
      subject: 'Your signed Dr. Bartender Contractor Agreement',
      html: `
        <p>Hi ${safeName},</p>
        <p>Thanks for signing — your Dr. Bartender Independent Contractor Agreement is attached as a PDF for your records.</p>
        <p>You can also download it anytime from your <a href="${portalUrl}">staff portal</a>.</p>
        <p>— Dr. Bartender</p>
      `,
      text: 'Thanks for signing — your Dr. Bartender Independent Contractor Agreement is attached.',
      attachments: [
        { filename: 'dr-bartender-contractor-agreement.pdf', content: pdfBuf },
      ],
    })
      .then(() => pool.query(
        `UPDATE agreements SET pdf_email_sent_at=NOW() WHERE user_id=$1`,
        [req.user.id]
      ))
      .catch((emailErr) => {
        console.error('[agreement] PDF email send failed:', emailErr.message);
        Sentry.captureException(emailErr, { tags: { route: 'POST /api/agreement', step: 'email' } });
      });
  } catch (pdfErr) {
    console.error('[agreement] PDF render/upload failed:', pdfErr.message);
    Sentry.captureException(pdfErr, { tags: { route: 'POST /api/agreement', step: 'pdf' } });
    // Signature row itself is committed; surface the saved row with a null
    // pdf_url so the client can proceed. Guard against double-send in case a
    // prior success path already responded.
    if (!res.headersSent) {
      res.json({ agreement: saved, pdf_url: null });
    }
  }
}));

module.exports = router;
