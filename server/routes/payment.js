// Payment method + W-9 upload

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { ensureOnboardingProgress } = require('../utils/onboardingProgress');
const { promoteOnboardingIfEligible } = require('../utils/onboardingPromotion');
const { auth } = require('../middleware/auth');
const { isValidUpload, safeUploadExtension } = require('../utils/fileValidation');
const { uploadFile } = require('../utils/storage');
const { decrypt } = require('../utils/encryption');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');
const { resolveBankFields, BANK_REQUIRED_MESSAGES } = require('../utils/bankNumbers');
const {
  normalizeVenmoHandle,
  normalizeCashappHandle,
  normalizePaypalUrl,
  normalizeZelleHandle,
} = require('../utils/tipHandleValidation');

const router = express.Router();

// A corrupted/mismatched encrypted value should not 500 the whole response —
// fall back to a fixed mask so the rest of the profile still loads and the
// user can re-enter it if needed.
function safeMask(enc) {
  if (!enc) return enc;
  try {
    const raw = decrypt(enc);
    return '****' + String(raw).slice(-4);
  } catch {
    return '****';
  }
}

// Get payment profile
router.get('/', auth, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM payment_profiles WHERE user_id = $1', [req.user.id]);
  const profile = result.rows[0] || {};
  if (profile.routing_number) profile.routing_number = safeMask(profile.routing_number);
  if (profile.account_number) profile.account_number = safeMask(profile.account_number);
  res.json(profile);
}));

// Save payment profile
router.post('/', auth, asyncHandler(async (req, res) => {
  const { preferred_payment_method, payment_username, routing_number, account_number } = req.body;
  // The certification event's inputs (audit ESIG-07), sent beside the file by
  // the Payday Protocols page: the W-9 revision the fill-mode page drew and
  // how it was signed ('draw' or 'type'; a scanned form says 'upload').
  const { w9_form_revision, w9_signature_method } = req.body;

  // Step marker — on failure we log which step the handler was on so Render logs
  // pinpoint the exact operation that crashed. Hardening while we diagnose a
  // reproducible submit-onboarding 500 seen from a mobile Safari user.
  let step = 'validate_input';
  try {
    if (!preferred_payment_method) {
      throw new ValidationError({ preferred_payment_method: 'Payment method is required.' });
    }

    // preferred_name is deliberately NOT destructured here: this route no longer
    // reads or writes a name (spec §3.3).
    const { venmo_handle, cashapp_handle, paypal_url, zelle_handle } = req.body;

    // Normalize handles BEFORE the method-vs-handle requirement check so
    // (a) bad formats fail loudly with a clear message instead of being silently
    // stored and then rendered into the public tip page's payment buttons, and
    // (b) the "handle required" check sees the cleaned value (e.g. user typed
    // "@bartender" — strip the @ first, then check non-empty).
    const normalizedVenmoHandle = normalizeVenmoHandle(venmo_handle);
    const normalizedCashappHandle = normalizeCashappHandle(cashapp_handle);
    const normalizedPaypalUrl = normalizePaypalUrl(paypal_url);
    const normalizedZelleHandle = normalizeZelleHandle(zelle_handle);

    // Validate payroll method matches handle requirement (per Task 5 spec)
    const methodToHandleField = {
      venmo: { value: normalizedVenmoHandle, name: 'Venmo handle' },
      cashapp: { value: normalizedCashappHandle, name: 'Cash App handle' },
      paypal: { value: normalizedPaypalUrl, name: 'PayPal URL' },
      zelle: { value: normalizedZelleHandle, name: 'Zelle handle' },
    };
    const reqHandle = methodToHandleField[preferred_payment_method];
    if (reqHandle && !reqHandle.value) {
      throw new ValidationError(
        `${reqHandle.name} is required when "${preferred_payment_method}" is your payroll preference.`
      );
    }

    // Bank numbers. Every screen shows them masked ('****' plus the last four), and
    // a page that posts that display value back must not have it encrypted over the
    // real number: a masked value means unchanged, kept inside the UPDATE below.
    // A real value must be a valid bank number (utils/bankNumbers.js). Only direct
    // deposit stores them; any other method clears them, as before.
    step = 'resolve_bank_numbers';
    const isDirectDeposit = preferred_payment_method === 'direct_deposit';
    const bank = isDirectDeposit
      ? resolveBankFields({ routing_number, account_number }, { blank: 'require' })
      : { routing_number: { keep: false, value: null }, account_number: { keep: false, value: null } };

    let w9_url = null, w9_name = null;
    // The certification event (audit ESIG-07): recorded only when a NEW W-9
    // arrives, from the request and the proxy-validated address, never from
    // the PDF the browser built. A reuse of the stored file keeps the stored
    // event. Never the TIN: it stays inside the PDF and out of every column.
    const W9_METHODS = ['draw', 'type', 'upload'];
    const w9Cert = {
      isNew: false,
      ip: (req.ip || '').replace(/^::ffff:/, '').slice(0, 45) || null,
      ua: (req.headers['user-agent'] || '').slice(0, 500) || null,
      revision: typeof w9_form_revision === 'string' ? (w9_form_revision.trim().slice(0, 20) || null) : null,
      method: W9_METHODS.includes(w9_signature_method) ? w9_signature_method : null,
    };

    step = 'load_existing_profile';
    const existing = await pool.query(
      `SELECT id, w9_file_url, w9_filename,
              routing_number IS NOT NULL AS has_routing, account_number IS NOT NULL AS has_account
         FROM payment_profiles WHERE user_id = $1`,
      [req.user.id]
    );

    // A masked value with nothing stored behind it is no number at all.
    const keepMissing = {};
    if (bank.routing_number.keep && !existing.rows[0]?.has_routing) keepMissing.routing_number = BANK_REQUIRED_MESSAGES.routing_number;
    if (bank.account_number.keep && !existing.rows[0]?.has_account) keepMissing.account_number = BANK_REQUIRED_MESSAGES.account_number;
    if (Object.keys(keepMissing).length > 0) throw new ValidationError(keepMissing);

    if (req.files?.w9) {
      const file = req.files.w9;
      step = 'validate_w9_upload';
      if (!isValidUpload(file)) {
        throw new ValidationError({ w9: 'Invalid file type. Use PDF, JPEG, or PNG only.' });
      }
      // Mobile Safari has been observed to drop the filename on File-from-Blob
      // uploads, so the DISPLAY name still needs a default. The STORED
      // extension is derived from the sniffed bytes, never from the client's
      // filename, so a validated upload cannot land in R2 as a runnable file.
      const originalName = (typeof file.name === 'string' && file.name.length > 0) ? file.name : 'w9.pdf';
      const ext = safeUploadExtension(file) || '.pdf';
      const filename = `${req.user.id}_w9_${uuidv4()}${ext}`;
      step = 'upload_w9_to_r2';
      await uploadFile(file.data, filename);
      w9_url = `/files/${filename}`;
      w9_name = originalName;
      w9Cert.isNew = true;
    } else if (existing.rows[0]?.w9_file_url) {
      // Reuse previously uploaded W-9
      w9_url = existing.rows[0].w9_file_url;
      w9_name = existing.rows[0].w9_filename;
    }

    // Enforce W-9 requirement on the backend (not just the frontend)
    if (!w9_url) {
      throw new ValidationError({ w9: 'A signed W-9 is required.' });
    }

    step = 'open_tx';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Re-check a keep under the row lock. The check above read the row before
      // the transaction, so a write that cleared the bank numbers since then must
      // refuse here instead of leaving direct deposit with nothing behind it.
      if (bank.routing_number.keep || bank.account_number.keep) {
        step = 'lock_bank_row';
        const locked = await client.query(
          `SELECT routing_number IS NOT NULL AS has_routing, account_number IS NOT NULL AS has_account
             FROM payment_profiles WHERE user_id = $1 FOR UPDATE`,
          [req.user.id]
        );
        const lockMissing = {};
        if (bank.routing_number.keep && !locked.rows[0]?.has_routing) lockMissing.routing_number = BANK_REQUIRED_MESSAGES.routing_number;
        if (bank.account_number.keep && !locked.rows[0]?.has_account) lockMissing.account_number = BANK_REQUIRED_MESSAGES.account_number;
        if (Object.keys(lockMissing).length > 0) throw new ValidationError(lockMissing);
      }

      step = existing.rows[0] ? 'update_payment_profile' : 'insert_payment_profile';
      if (existing.rows[0]) {
        // $8 and $9 keep the stored bank column when a masked value came back.
        // $10 is the new-W-9 flag: the certification columns move only with a
        // new file (ESIG-07); a reuse keeps the stored event.
        await client.query(
          `UPDATE payment_profiles
           SET preferred_payment_method=$1, payment_username=$2,
               routing_number = CASE WHEN $8::boolean THEN routing_number ELSE $3 END,
               account_number = CASE WHEN $9::boolean THEN account_number ELSE $4 END,
               w9_file_url=$5, w9_filename=$6,
               w9_submitted_at = CASE WHEN $10::boolean THEN NOW() ELSE w9_submitted_at END,
               w9_submit_ip = CASE WHEN $10::boolean THEN $11 ELSE w9_submit_ip END,
               w9_submit_ua = CASE WHEN $10::boolean THEN $12 ELSE w9_submit_ua END,
               w9_form_revision = CASE WHEN $10::boolean THEN $13 ELSE w9_form_revision END,
               w9_signature_method = CASE WHEN $10::boolean THEN $14 ELSE w9_signature_method END
           WHERE user_id=$7`,
          [preferred_payment_method, payment_username || null, bank.routing_number.value, bank.account_number.value,
           w9_url, w9_name, req.user.id, bank.routing_number.keep, bank.account_number.keep,
           w9Cert.isNew, w9Cert.isNew ? w9Cert.ip : null, w9Cert.isNew ? w9Cert.ua : null,
           w9Cert.isNew ? w9Cert.revision : null, w9Cert.isNew ? w9Cert.method : null]
        );
      } else {
        // A first profile always carries a new file (the W-9 gate above), so
        // the certification event is written with it.
        await client.query(
          `INSERT INTO payment_profiles
             (user_id, preferred_payment_method, payment_username, routing_number, account_number, w9_file_url, w9_filename,
              w9_submitted_at, w9_submit_ip, w9_submit_ua, w9_form_revision, w9_signature_method)
           VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::boolean THEN NOW() ELSE NULL END, $9, $10, $11, $12)`,
          [req.user.id, preferred_payment_method, payment_username || null,
           bank.routing_number.value, bank.account_number.value, w9_url, w9_name,
           w9Cert.isNew, w9Cert.isNew ? w9Cert.ip : null, w9Cert.isNew ? w9Cert.ua : null,
           w9Cert.isNew ? w9Cert.revision : null, w9Cert.isNew ? w9Cert.method : null]
        );
      }

      step = 'update_onboarding_progress';
      await ensureOnboardingProgress(req.user.id, client);
      await client.query(
        `UPDATE onboarding_progress SET payday_protocols_completed=true, onboarding_completed=true, last_completed_step='onboarding_completed' WHERE user_id=$1`,
        [req.user.id]
      );

      step = 'update_user_status';
      // Gate the flip on prior status: only promote users who are currently
      // mid-onboarding. Already-approved → no-op (idempotent re-submit).
      // Rejected/deactivated → blocked at the auth middleware before reaching here.
      // Prevents a user from re-elevating themselves after an admin demotion to
      // an off-funnel state, and (spec 2026-07-22) prevents a self-registered
      // account from promoting itself at all. The rule and the reasoning live in
      // server/utils/onboardingPromotion.js so this route and its tests share one
      // definition. Passes `client` so it joins this transaction.
      const promotedRows = await promoteOnboardingIfEligible(client, req.user.id);
      // A refused promotion used to be impossible for anyone who got this far,
      // so nothing downstream reports it: the route still 200s and the client
      // still says "You're All Set". Leave a breadcrumb so a genuinely stuck
      // person is findable instead of silently bounced back to /apply.
      if (promotedRows === 0) {
        const cur = await client.query('SELECT onboarding_status FROM users WHERE id=$1', [req.user.id]);
        const priorStatus = cur.rows[0] && cur.rows[0].onboarding_status;
        if (priorStatus !== 'approved') {
          console.warn(`[payment] onboarding promotion skipped user=${req.user.id} status=${priorStatus}`);
          try {
            Sentry.captureMessage('Onboarding promotion skipped', {
              level: 'warning',
              tags: { event: 'promotion_skipped' },
              extra: { user_id: req.user.id, onboarding_status: priorStatus },
            });
          } catch (_) { /* never let telemetry break onboarding */ }
        }
      }

      // New for tip page (2026-05-08): persist payment handles + payroll preference
      step = 'upsert_tip_handles';
      // (direct_deposit/check/other require no specific handle here)

      // NO name write here. Payday Protocols used to ask for the preferred name
      // a second time, with copy inviting a stage name, and overwrote step 4's
      // answer. The field is gone from the client and the write is gone from
      // here. Step 4 (routes/contractor.js) is the only name entry point.
      // Spec §3.3.

      // Upsert tip handles onto payment_profiles (row already exists from above).
      // COALESCE so a re-submit that leaves a previously-set handle blank can't
      // silently null it — staff edit handles via /me/tip-page after onboarding.
      await client.query(`
        UPDATE payment_profiles
        SET venmo_handle = COALESCE($1, payment_profiles.venmo_handle),
            cashapp_handle = COALESCE($2, payment_profiles.cashapp_handle),
            paypal_url = COALESCE($3, payment_profiles.paypal_url),
            zelle_handle = COALESCE($4, payment_profiles.zelle_handle),
            tip_page_active = COALESCE(payment_profiles.tip_page_active, TRUE),
            updated_at = NOW()
        WHERE user_id = $5
      `, [
        normalizedVenmoHandle,
        normalizedCashappHandle,
        normalizedPaypalUrl,
        normalizedZelleHandle,
        req.user.id,
      ]);

      // Generate tip_page_token if missing
      const tokenCheck = await client.query(
        'SELECT tip_page_token FROM payment_profiles WHERE user_id = $1',
        [req.user.id]
      );
      if (!tokenCheck.rows[0]?.tip_page_token) {
        const tipToken = uuidv4();
        await client.query(
          'UPDATE payment_profiles SET tip_page_token = $1 WHERE user_id = $2',
          [tipToken, req.user.id]
        );
      }

      step = 'commit_tx';
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
      throw err;
    } finally {
      client.release();
    }

    // Create the Stripe Payment Link (best-effort; never block onboarding submit)
    step = 'stripe_payment_link';
    try {
      const { rows: ppRows } = await pool.query(
        'SELECT tip_page_token FROM payment_profiles WHERE user_id = $1',
        [req.user.id]
      );
      const token = ppRows[0]?.tip_page_token;
      const { createTipPaymentLink } = require('../utils/tipPaymentLinks');
      // Read the name off the profile rather than the request body: the body no
      // longer carries one. The transaction client is already released above, so
      // pool.query here is correct and not a pool deadlock.
      const { rows: dnRows } = await pool.query(
        'SELECT display_name, preferred_name FROM contractor_profiles WHERE user_id = $1',
        [req.user.id]
      );
      const { url, id: linkId } = await createTipPaymentLink({
        userId: req.user.id,
        displayName: dnRows[0]?.display_name || dnRows[0]?.preferred_name || null,
        token,
      });
      await pool.query(
        'UPDATE payment_profiles SET stripe_payment_link_url = $1, stripe_payment_link_id = $2 WHERE user_id = $3',
        [url, linkId, req.user.id]
      );
    } catch (err) {
      console.error('[tip] failed to auto-generate Stripe Payment Link at onboarding-submit', err.message);
      Sentry.captureException(err, { extra: { userId: req.user.id, op: 'onboarding-submit-stripe-link' } });
      // Admin can hit "Generate Stripe link" later from the contractor record.
    }

    step = 'hydrate_response';
    const result = await pool.query('SELECT * FROM payment_profiles WHERE user_id = $1', [req.user.id]);
    const profile = result.rows[0];
    if (profile.routing_number) profile.routing_number = safeMask(profile.routing_number);
    if (profile.account_number) profile.account_number = safeMask(profile.account_number);
    res.json(profile);
  } catch (err) {
    // AppError subclasses carry statusCode and are expected user-facing errors;
    // only log breadcrumbs for truly unknown failures.
    if (!err?.statusCode) {
      console.error('Payment submit failed at step:', step, {
        userId: req.user?.id,
        method: preferred_payment_method,
        hasFile: !!req.files?.w9,
        fileSize: req.files?.w9?.size,
        fileName: req.files?.w9?.name,
        errMessage: err?.message,
        errCode: err?.code,
      });
    }
    throw err;
  }
}));

module.exports = router;
