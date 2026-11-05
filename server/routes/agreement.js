// Contractor agreement + digital signature

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { ensureOnboardingProgress } = require('../utils/onboardingProgress');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { publicReadLimiter, signLimiter } = require('../middleware/rateLimiters');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { getCurrentAgreement, CURRENT_VERSION, agreementVersionSha256 } = require('../data/contractorAgreement');
const { renderAgreementPdf } = require('../utils/agreementPdf');
const { uploadFile, getSignedUrl } = require('../utils/storage');
const { sendEmail } = require('../utils/email');
const { STAFF_URL } = require('../utils/urls');
const { refreshDisplayName } = require('../utils/refreshDisplayName');
const { validatePhone } = require('../utils/phone');
const { validateSignaturePayload } = require('../utils/signaturePayload');

const router = express.Router();

// The email shape every signup route checks (routes/auth.js): one @, a dot
// after it, no whitespace. Shape only; the inbox is proven by the copy arriving.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  // Bounds are the column widths (schema.sql: full_name and email VARCHAR(255),
  // phone VARCHAR(50)); an overflow used to reach Postgres as a 22001 500, and
  // the email is where the only copy of the signed contract is sent.
  const fullName = typeof full_name === 'string' ? full_name.trim() : '';
  if (!fullName) fieldErrors.full_name = 'Full name is required';
  else if (fullName.length < 2 || fullName.length > 255) fieldErrors.full_name = 'Full name must be 2 to 255 characters';
  const emailValue = typeof email === 'string' ? email.trim() : '';
  if (!emailValue) fieldErrors.email = 'Email is required';
  else if (emailValue.length < 3 || emailValue.length > 255 || !EMAIL_RE.test(emailValue)) {
    fieldErrors.email = 'Enter a valid email address';
  }
  // The save-time phone helper the proposal sign uses (10-digit storage);
  // empty stays optional and stores NULL.
  const phoneCheck = validatePhone(phone);
  if (phoneCheck.error) fieldErrors.phone = phoneCheck.error;
  // An acknowledgment is the boolean true and nothing else: the old `!!`
  // coercion recorded the string "false" as acknowledged.
  const acks = { ack_ic_status, ack_commitment, ack_non_solicit, ack_damage_recoupment, ack_legal_protections, ack_field_guide };
  for (const key of Object.keys(acks)) {
    if (acks[key] !== true) fieldErrors[key] = 'This acknowledgment is required';
  }
  if (!signature_data) fieldErrors.signature = 'Please sign the agreement before submitting';
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  // The signature itself: a PNG or JPEG data URL of bounded size under 'draw',
  // a 2 to 120 character name under 'type' (utils/signaturePayload.js, shared
  // with the proposal sign). A row that says signed must hold a signature.
  const sig = validateSignaturePayload({ data: signature_data, method: signature_method });
  if (sig.error) throw new ValidationError({ signature: sig.error });
  const signatureValue = sig.value;

  // req.ip is the proxy-validated client address (trust proxy is set in
  // index.js) and is bounded to the VARCHAR(45) column; the leftmost
  // X-Forwarded-For entry is signer-forgeable and could overflow it into a
  // 22001 500. A signature IP is dispute evidence (it prints on the archived
  // PDF), so it must be the one the proxy saw. Matches publicAccept.js and
  // the proposal sign route.
  const ip = (req.ip || '').replace(/^::ffff:/, '').slice(0, 45) || null;
  const userAgent = req.headers['user-agent'] || null;

  // The content pin of the text being signed (audit ESIG-10): the row carries
  // the hash of what its version string pointed to on the day, beside the
  // version itself.
  const documentSha256 = agreementVersionSha256(getCurrentAgreement());

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
      'signature_document_version','signature_document_sha256','signed_at',
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
           signature_document_version=$15, signature_document_sha256=$17, signed_at=NOW()
         WHERE user_id=$16
         RETURNING *`,
        [
          fullName, emailValue, phoneCheck.value, sms_consent === true,
          true, true, true, true, true, true, // every ack was asserted === true above
          signatureValue, signature_method, ip, userAgent,
          CURRENT_VERSION, req.user.id, documentSha256,
        ]
      );
      saved = upd.rows[0];
    } else {
      const ins = await client.query(
        `INSERT INTO agreements
           (user_id, ${cols.join(', ')})
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
         RETURNING *`,
        [
          req.user.id,
          fullName, emailValue, phoneCheck.value, sms_consent === true,
          true, true, true, true, true, true, // every ack was asserted === true above
          signatureValue, signature_method, ip, userAgent,
          CURRENT_VERSION, documentSha256,
        ]
      );
      saved = ins.rows[0];
    }

    await ensureOnboardingProgress(req.user.id, client);
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

  // Signing supplies the legal name, which can change the last initial.
  // NO previousPreferredName: this cannot have changed the preferred name, so
  // it must not re-raise a §3.5 notice. The transaction client is already
  // released, so the shared pool is the right handle here.
  //
  // Contained, like every other post-commit step in this handler: the signature
  // row is already committed, so a DB blip here must not 500 a request whose
  // write succeeded. Worst case is a stale display name, and
  // scripts/refreshDisplayNames.js --check is the net that finds it.
  try {
    await refreshDisplayName(req.user.id, pool);
  } catch (dnErr) {
    console.error('[agreement] display-name refresh failed:', dnErr.message);
    Sentry.captureException(dnErr, { tags: { route: 'POST /api/agreement', step: 'display_name' } });
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
