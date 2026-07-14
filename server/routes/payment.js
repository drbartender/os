const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { ensureOnboardingProgress } = require('../utils/onboardingProgress');
const { auth } = require('../middleware/auth');
const { isValidUpload } = require('../utils/fileValidation');
const { uploadFile } = require('../utils/storage');
const { encrypt, decrypt } = require('../utils/encryption');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');
const {
  normalizeVenmoHandle,
  normalizeCashappHandle,
  normalizePaypalUrl,
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

  // Step marker — on failure we log which step the handler was on so Render logs
  // pinpoint the exact operation that crashed. Hardening while we diagnose a
  // reproducible submit-onboarding 500 seen from a mobile Safari user.
  let step = 'validate_input';
  try {
    if (!preferred_payment_method) {
      throw new ValidationError({ preferred_payment_method: 'Payment method is required.' });
    }

    const { venmo_handle, cashapp_handle, paypal_url, preferred_name } = req.body;

    // Normalize handles BEFORE the method-vs-handle requirement check so
    // (a) bad formats fail loudly with a clear message instead of being silently
    // stored and then rendered into the public tip page's payment buttons, and
    // (b) the "handle required" check sees the cleaned value (e.g. user typed
    // "@bartender" — strip the @ first, then check non-empty).
    const normalizedVenmoHandle = normalizeVenmoHandle(venmo_handle);
    const normalizedCashappHandle = normalizeCashappHandle(cashapp_handle);
    const normalizedPaypalUrl = normalizePaypalUrl(paypal_url);

    // Validate payroll method matches handle requirement (per Task 5 spec)
    const methodToHandleField = {
      venmo: { value: normalizedVenmoHandle, name: 'Venmo handle' },
      cashapp: { value: normalizedCashappHandle, name: 'Cash App handle' },
      paypal: { value: normalizedPaypalUrl, name: 'PayPal URL' },
    };
    const reqHandle = methodToHandleField[preferred_payment_method];
    if (reqHandle && !reqHandle.value) {
      throw new ValidationError(
        `${reqHandle.name} is required when "${preferred_payment_method}" is your payroll preference.`
      );
    }

    let w9_url = null, w9_name = null;

    step = 'load_existing_profile';
    const existing = await pool.query('SELECT id, w9_file_url, w9_filename FROM payment_profiles WHERE user_id = $1', [req.user.id]);

    if (req.files?.w9) {
      const file = req.files.w9;
      step = 'validate_w9_upload';
      if (!isValidUpload(file)) {
        throw new ValidationError({ w9: 'Invalid file type. Use PDF, JPEG, or PNG only.' });
      }
      // Mobile Safari has been observed to drop the filename on File-from-Blob uploads —
      // path.extname(undefined) throws TypeError. Guard with a sane default.
      const originalName = (typeof file.name === 'string' && file.name.length > 0) ? file.name : 'w9.pdf';
      const ext = path.extname(originalName) || '.pdf';
      const filename = `${req.user.id}_w9_${uuidv4()}${ext}`;
      step = 'upload_w9_to_r2';
      await uploadFile(file.data, filename);
      w9_url = `/files/${filename}`;
      w9_name = originalName;
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

      step = existing.rows[0] ? 'update_payment_profile' : 'insert_payment_profile';
      if (existing.rows[0]) {
        await client.query(
          `UPDATE payment_profiles
           SET preferred_payment_method=$1, payment_username=$2, routing_number=$3, account_number=$4,
               w9_file_url=$5, w9_filename=$6
           WHERE user_id=$7`,
          [preferred_payment_method, payment_username || null, routing_number ? encrypt(routing_number) : null, account_number ? encrypt(account_number) : null,
           w9_url, w9_name, req.user.id]
        );
      } else {
        await client.query(
          `INSERT INTO payment_profiles
             (user_id, preferred_payment_method, payment_username, routing_number, account_number, w9_file_url, w9_filename)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [req.user.id, preferred_payment_method, payment_username || null,
           routing_number ? encrypt(routing_number) : null, account_number ? encrypt(account_number) : null, w9_url, w9_name]
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
      // an off-funnel state.
      await client.query(
        "UPDATE users SET onboarding_status='approved' WHERE id=$1 AND onboarding_status IN ('hired','in_progress','submitted','reviewed')",
        [req.user.id]
      );

      // New for tip page (2026-05-08): persist payment handles + payroll preference
      step = 'upsert_tip_handles';
      // (direct_deposit/check/other require no specific handle here)

      // Persist preferred_name on contractor_profiles (existing column)
      const preferredNameForTip = String(preferred_name || '').trim() || null;
      if (preferredNameForTip) {
        await client.query(
          'UPDATE contractor_profiles SET preferred_name = $1, updated_at = NOW() WHERE user_id = $2',
          [preferredNameForTip, req.user.id]
        );
      }

      // Upsert tip handles onto payment_profiles (row already exists from above).
      // COALESCE so a re-submit that leaves a previously-set handle blank can't
      // silently null it — staff edit handles via /me/tip-page after onboarding.
      await client.query(`
        UPDATE payment_profiles
        SET venmo_handle = COALESCE($1, payment_profiles.venmo_handle),
            cashapp_handle = COALESCE($2, payment_profiles.cashapp_handle),
            paypal_url = COALESCE($3, payment_profiles.paypal_url),
            tip_page_active = COALESCE(payment_profiles.tip_page_active, TRUE),
            updated_at = NOW()
        WHERE user_id = $4
      `, [
        normalizedVenmoHandle,
        normalizedCashappHandle,
        normalizedPaypalUrl,
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
      const { url, id: linkId } = await createTipPaymentLink({
        userId: req.user.id,
        displayName: req.body.preferred_name,
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
