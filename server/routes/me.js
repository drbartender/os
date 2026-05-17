const express = require('express');
const path = require('path');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');
const { PUBLIC_SITE_URL } = require('../utils/urls');
const { getSignedUrl } = require('../utils/storage');
const { normalizeTipHandlesInPlace } = require('../utils/tipHandleValidation');

const router = express.Router();
router.use(auth);

router.get('/tip-page', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      cp.preferred_name,
      cp.headshot_file_url,
      pp.tip_page_token,
      pp.tip_page_active,
      pp.venmo_handle,
      pp.cashapp_handle,
      pp.paypal_url,
      pp.preferred_payment_method,
      pp.stripe_payment_link_url,
      (SELECT COUNT(*)::int FROM tips WHERE target_user_id = $1
        AND tipped_at >= date_trunc('month', NOW())) AS tips_this_month_count,
      (SELECT COALESCE(SUM(amount_cents), 0)::int FROM tips WHERE target_user_id = $1
        AND tipped_at >= date_trunc('month', NOW())) AS tips_this_month_cents
    FROM users u
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    LEFT JOIN payment_profiles pp ON pp.user_id = u.id
    WHERE u.id = $1
  `, [req.user.id]);

  const row = rows[0] || {};
  const url = row.tip_page_token
    ? `${PUBLIC_SITE_URL}/tip/${row.tip_page_token}`
    : null;

  // Headshot is stored as `/files/<filename>`; that route is admin-only, so
  // mirror publicTip.js and hand the staff print page a short-lived signed R2
  // URL. Intentional local duplication — see 2026-05-17-little-fixes-batch
  // spec (deduping would refactor the live tip-collection path).
  let headshotUrl = null;
  if (row.headshot_file_url) {
    if (row.headshot_file_url.startsWith('/files/')) {
      try {
        headshotUrl = await getSignedUrl(path.basename(row.headshot_file_url));
      } catch (err) {
        Sentry.captureException(err, { tags: { route: 'me.tip-page', op: 'sign_headshot' } });
      }
    } else {
      headshotUrl = row.headshot_file_url;
    }
  }

  res.json({
    url,
    headshot_url: headshotUrl,
    active: !!row.tip_page_active,
    has_stripe_link: !!row.stripe_payment_link_url,
    preferred_name: row.preferred_name || null,
    venmo_handle: row.venmo_handle || null,
    cashapp_handle: row.cashapp_handle || null,
    paypal_url: row.paypal_url || null,
    preferred_payment_method: row.preferred_payment_method || null,
    tips_this_month_count: row.tips_this_month_count || 0,
    tips_this_month_cents: row.tips_this_month_cents || 0,
  });
}));

const ALLOWED_PATCH_FIELDS = new Set([
  'preferred_name',
  'venmo_handle',
  'cashapp_handle',
  'paypal_url',
  'preferred_payment_method',
]);
const ALLOWED_PAYMENT_METHODS = ['venmo', 'cashapp', 'paypal', 'check', 'direct_deposit', 'other'];

router.patch('/tip-page', asyncHandler(async (req, res) => {
  // Allowlist filter — silently ignore any field not in ALLOWED_PATCH_FIELDS.
  const updates = {};
  for (const k of Object.keys(req.body || {})) {
    if (ALLOWED_PATCH_FIELDS.has(k)) updates[k] = req.body[k];
  }

  if ('preferred_name' in updates) {
    const t = String(updates.preferred_name || '').trim();
    if (!t) throw new ValidationError('preferred_name cannot be blank');
    updates.preferred_name = t;
  }
  // preferred_payment_method: '' from the form means "not picked" (radio inputs
  // can't be unselected) — treat as no-op rather than silent clear of a
  // previously-set value. To explicitly clear, send null.
  if ('preferred_payment_method' in updates && updates.preferred_payment_method === '') {
    delete updates.preferred_payment_method;
  }
  if ('preferred_payment_method' in updates && updates.preferred_payment_method
      && !ALLOWED_PAYMENT_METHODS.includes(updates.preferred_payment_method)) {
    throw new ValidationError('invalid preferred_payment_method');
  }

  // Validate + normalize handle formats so a malformed paypal_url can't land
  // in the DB and end up as a phishing link target on the public tip page.
  normalizeTipHandlesInPlace(updates);

  // preferred_name lives on contractor_profiles
  if ('preferred_name' in updates) {
    await pool.query(
      'UPDATE contractor_profiles SET preferred_name = $1, updated_at = NOW() WHERE user_id = $2',
      [updates.preferred_name, req.user.id]
    );
    delete updates.preferred_name;
  }

  // remaining fields live on payment_profiles
  if (Object.keys(updates).length > 0) {
    const cols = Object.keys(updates);
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(`
      INSERT INTO payment_profiles (user_id, ${cols.join(', ')})
      VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
      ON CONFLICT (user_id) DO UPDATE SET
        ${setClause},
        updated_at = NOW()
    `, [req.user.id, ...cols.map(c => updates[c] || null)]);
  }

  res.json({ ok: true });
}));

router.get('/tips', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const cursor = parseInt(req.query.cursor, 10) || null;

  const { rows } = await pool.query(`
    SELECT id, amount_cents, tipped_at
    FROM tips
    WHERE target_user_id = $1
      ${cursor ? 'AND id < $3' : ''}
    ORDER BY id DESC
    LIMIT $2
  `, cursor ? [req.user.id, limit, cursor] : [req.user.id, limit]);

  res.json({
    tips: rows,
    next_cursor: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}));

module.exports = router;
