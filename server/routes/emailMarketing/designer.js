/**
 * Email designer support: image upload, live preview, and the
 * single-address test send.
 *
 * Extracted from the single 987-line emailMarketing.js. Paths and mount
 * order are unchanged; see ./index.js for why the order still matters.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { sendEmail } = require('../../utils/email');
const { wrapMarketingEmail } = require('../../utils/emailTemplates');
const { sanitizeHtml } = require('../../utils/emailSanitize');
const { uploadFile } = require('../../utils/storage');
const { isValidUpload } = require('../../utils/fileValidation');
const asyncHandler = require('../../middleware/asyncHandler');
const { compileEmailDesign } = require('./shared');
const { clientOptedOutByEmail, leadUnsubscribedByEmail } = require('../../utils/marketingAudience');
const { ValidationError, NotFoundError, ExternalServiceError } = require('../../utils/errors');
const { API_URL } = require('../../utils/urls');

const router = express.Router();
// ─── Email Designer support ───────────────────────────────────────

/** POST /upload-image — store an image for use in a designed campaign.
 *  Gated to admin OR manager so anyone who can compose a campaign can add
 *  images. The image is decoded and re-encoded through sharp: that bounds the
 *  width (emails render at ~544px; 1088 keeps retina sharp), strips metadata,
 *  caps the payload a blast recipient downloads, and makes the stored bytes
 *  AND extension come from the decoder — never from the client's filename or
 *  mimetype (isValidUpload's magic check passes PDFs; the decode does not).
 *  Returns a root-relative URL served by the public image route; the renderer
 *  absolutizes it for email. */
router.post('/upload-image', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  if (!req.files?.image) {
    throw new ValidationError({ image: 'No image provided.' });
  }
  const file = req.files.image;
  if (!isValidUpload(file) || file.data.subarray(0, 4).equals(Buffer.from('%PDF'))) {
    throw new ValidationError({ image: 'Invalid file type. Use JPEG, PNG, or WebP.' });
  }
  let out;
  let ext;
  try {
    const img = sharp(file.data).rotate().resize({ width: 1088, withoutEnlargement: true });
    const { format } = await sharp(file.data).metadata();
    if (format === 'png') { out = await img.png().toBuffer(); ext = '.png'; }
    else if (format === 'webp') { out = await img.webp({ quality: 82 }).toBuffer(); ext = '.webp'; }
    else { out = await img.jpeg({ quality: 82 }).toBuffer(); ext = '.jpg'; }
  } catch (err) {
    throw new ValidationError({ image: 'Could not process this image. Use JPEG, PNG, or WebP.' });
  }
  const filename = `email_${uuidv4()}${ext}`;
  await uploadFile(out, filename);
  res.json({ url: `/api/blog/images/${filename}` });
}));

/** POST /preview — render a design (or raw html) into the full branded email
 *  shell so the composer can show an accurate, exactly-as-sent preview. */
router.post('/preview', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { design_json, html_body } = req.body;
  const compiled = compileEmailDesign(design_json);
  const inner = compiled ? compiled.html_body : (sanitizeHtml(html_body) || '');
  const sampleUnsub = `${API_URL}/api/email-marketing/unsubscribe?token=preview`;
  res.json({ html: wrapMarketingEmail(inner || '<p style="color:#999">Your email is empty — add some blocks.</p>', sampleUnsub) });
}));

/** POST /campaigns/:id/test — send the campaign to a single address so the
 *  admin can see the real thing in their own inbox before blasting. */
router.post('/campaigns/:id/test', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const campaign = await pool.query('SELECT * FROM email_campaigns WHERE id = $1', [req.params.id]);
  const c = campaign.rows[0];
  if (!c) throw new NotFoundError('Campaign not found.');
  if (!c.html_body) throw new ValidationError({ html_body: 'Add some content before sending a test.' });

  const to = (req.body.email && String(req.body.email).trim()) || req.user.email;
  if (!to) throw new ValidationError({ email: 'No test recipient — enter an email address.' });

  // A test send lands in a REAL inbox, so its unsubscribe link has to be real.
  // The composer preview can keep the placeholder (nobody clicks a link inside
  // a preview pane), but shipping token=preview in an actual email means the
  // one legally required element is the one element that does not work, and an
  // admin checking the footer gets "invalid or expired".
  //
  // Resolve the recipient to whatever they actually are. A lead token and a
  // client token unsubscribe different things, so guessing is not an option.
  // If the address matches nothing we have, fall back to the placeholder: there
  // is no record to unsubscribe, and minting a token for a non-existent row
  // would be a link that 400s just as loudly.
  // A test send is a REAL marketing send: same campaign body, real inbox, and
  // since this lane, a real unsubscribe token. So it owes the same suppression
  // every other marketing sender owes. Without this it is the fourth ungated
  // sender, and the argument that retired the blast send ("it can email someone
  // you excluded") is true of it verbatim, one address at a time.
  const optedOut = await pool.query(
    `SELECT ${clientOptedOutByEmail('$1')} OR ${leadUnsubscribedByEmail('$1')} AS blocked`, [to]
  );
  if (optedOut.rows[0]?.blocked) {
    throw new ValidationError({
      email: 'That address is unsubscribed or on the do-not-contact list. Test sends honor it too.',
    });
  }

  const unsubSecret = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  let unsubToken = 'preview';
  const leadRow = await pool.query(
    'SELECT id FROM email_leads WHERE lower(btrim(email)) = lower(btrim($1)) LIMIT 1', [to]);
  if (leadRow.rows[0]) {
    unsubToken = jwt.sign({ leadId: leadRow.rows[0].id, typ: 'unsub' }, unsubSecret, { expiresIn: '365d' });
  } else {
    const clientRow = await pool.query(
      'SELECT id FROM clients WHERE lower(btrim(email)) = lower(btrim($1)) LIMIT 1', [to]);
    if (clientRow.rows[0]) {
      unsubToken = jwt.sign({ clientId: clientRow.rows[0].id, marketing: true, typ: 'unsub' }, unsubSecret, { expiresIn: '365d' });
    }
  }
  const sampleUnsub = `${API_URL}/api/email-marketing/unsubscribe?token=${unsubToken}`;
  const html = wrapMarketingEmail(c.html_body, sampleUnsub);
  let result;
  try {
    result = await sendEmail({
      to,
      subject: `[TEST] ${c.subject || c.name}`,
      html,
      text: c.text_body || undefined,
      from: c.from_email || undefined,
      replyTo: c.reply_to || undefined,
      meta: { skipLog: true },
    });
  } catch (err) {
    throw new ExternalServiceError('Resend', err, 'Email sending temporarily unavailable. Please try again.');
  }
  if (result.id === 'skipped-invalid') {
    throw new ValidationError({ email: 'That address was rejected as invalid.' });
  }
  if (result.id === 'dev-skipped') {
    throw new ExternalServiceError('Resend', null, 'Email sending is not enabled in this environment.');
  }
  res.json({ message: `Test sent to ${to}.`, to });
}));

module.exports = router;
