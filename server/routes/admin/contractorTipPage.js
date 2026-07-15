const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db');
const { auth, adminOnly, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError, PermissionError } = require('../../utils/errors');
const {
  createTipPaymentLink,
  deactivateTipPaymentLink,
} = require('../../utils/tipPaymentLinks');
const { activateTipPage, deactivateTipPage } = require('../../utils/tipPageLifecycle');
const { normalizeTipHandlesInPlace } = require('../../utils/tipHandleValidation');
const { logAdminAction } = require('../../utils/adminAuditLog');

const router = express.Router();

// ─── Per-Contractor Tip Page Actions ─────────────────────────────
// Admin/manager surface for managing a contractor's tip page: edit handles,
// rotate or generate the Stripe Payment Link, and toggle the page on/off.
// `regenerate-stripe` preserves tip_page_token so existing printed QRs keep
// working — only the Stripe link rotates.

const ALLOWED_PAYMENT_METHODS = ['venmo', 'cashapp', 'paypal', 'zelle', 'check', 'direct_deposit', 'other'];

// Managers shouldn't be able to mutate an admin's tip page (rotate their Stripe
// link, change their handles, or deactivate them). Admins can mutate anyone.
async function ensureNonAdminTargetForManager(req, userId) {
  if (req.user.role === 'admin') return;
  const r = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
  if (r.rows[0]?.role === 'admin') {
    throw new PermissionError('Managers cannot modify an admin user tip page');
  }
}

// PATCH — admin override of handles + payroll preference + preferred_name
router.patch('/contractors/:userId/tip-page', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);

  const fields = {};
  for (const k of ['venmo_handle', 'cashapp_handle', 'paypal_url', 'preferred_payment_method']) {
    if (k in req.body) fields[k] = req.body[k];
  }

  // Empty-string preferred_payment_method = "form left this blank" → no-op,
  // not silent clear. Explicit null clears (consistent with /api/me/tip-page).
  if ('preferred_payment_method' in fields && fields.preferred_payment_method === '') {
    delete fields.preferred_payment_method;
  }
  if ('preferred_payment_method' in fields && fields.preferred_payment_method
      && !ALLOWED_PAYMENT_METHODS.includes(fields.preferred_payment_method)) {
    throw new ValidationError('invalid preferred_payment_method');
  }

  // Validate + normalize handle formats (paypal_url especially — flows into an
  // <a href> on the public tip page so anything off paypal.me is rejected).
  normalizeTipHandlesInPlace(fields);

  if ('preferred_name' in req.body) {
    await pool.query(
      'UPDATE contractor_profiles SET preferred_name = $1, updated_at = NOW() WHERE user_id = $2',
      [String(req.body.preferred_name || '').trim() || null, userId]
    );
  }

  if (Object.keys(fields).length > 0) {
    const cols = Object.keys(fields);
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(`
      INSERT INTO payment_profiles (user_id, ${cols.join(', ')})
      VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
      ON CONFLICT (user_id) DO UPDATE SET ${setClause}, updated_at = NOW()
    `, [userId, ...cols.map(c => fields[c] || null)]);
  }
  res.json({ ok: true });
}));

// POST — emergency rotation: issue a NEW tip_page_token AND a new Stripe link.
// Use only when the existing public URL is compromised (printed QR card was
// photographed, screenshot leaked, etc.). Customers with the old QR can no
// longer pay through it. In-flight Stripe sessions on the old link will fail
// or, if completed in the brief gap, get dropped at the webhook because the
// metadata token won't match the rotated DB token.
router.post('/contractors/:userId/tip-page/rotate-token', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);

  const { rows } = await pool.query(`
    SELECT pp.tip_page_token, pp.stripe_payment_link_id, cp.preferred_name
    FROM payment_profiles pp
    LEFT JOIN contractor_profiles cp ON cp.user_id = pp.user_id
    WHERE pp.user_id = $1
  `, [userId]);
  const row = rows[0];
  if (!row || !row.tip_page_token) throw new NotFoundError('contractor has no tip page');

  // Best-effort retire of the old Stripe link FIRST so the leaked URL stops
  // accepting new payments immediately. The webhook drops any in-flight
  // session whose old token no longer matches DB after the rotation below.
  if (row.stripe_payment_link_id) {
    try { await deactivateTipPaymentLink(row.stripe_payment_link_id); }
    catch (err) { console.error('[tip-admin] retire old link on rotate failed', err.message); }
  }

  const newToken = uuidv4();
  const { url, id } = await createTipPaymentLink({
    userId,
    displayName: row.preferred_name,
    token: newToken,
  });

  await pool.query(`
    UPDATE payment_profiles
    SET tip_page_token = $1,
        stripe_payment_link_url = $2,
        stripe_payment_link_id = $3,
        updated_at = NOW()
    WHERE user_id = $4
  `, [newToken, url, id, userId]);

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: userId,
    action: 'tip_token_rotate',
    metadata: {
      oldTokenPrefix: row.tip_page_token.slice(0, 8),
      newTokenPrefix: newToken.slice(0, 8),
      oldStripeLinkId: row.stripe_payment_link_id || null,
      newStripeLinkId: id,
    },
  });

  res.json({ ok: true, token: newToken, url });
}));

// POST — rotate the Stripe Payment Link (deactivate old, create new). Token unchanged.
router.post('/contractors/:userId/tip-page/regenerate-stripe', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);

  const { rows } = await pool.query(`
    SELECT pp.tip_page_token, pp.stripe_payment_link_id, cp.preferred_name
    FROM payment_profiles pp
    LEFT JOIN contractor_profiles cp ON cp.user_id = pp.user_id
    WHERE pp.user_id = $1
  `, [userId]);
  const row = rows[0];
  if (!row || !row.tip_page_token) throw new NotFoundError('contractor has no tip page');

  if (row.stripe_payment_link_id) {
    try { await deactivateTipPaymentLink(row.stripe_payment_link_id); }
    catch (err) { console.error('[tip-admin] deactivate old link failed', err.message); }
  }

  const { url, id } = await createTipPaymentLink({
    userId,
    displayName: row.preferred_name,
    token: row.tip_page_token,
  });
  await pool.query(
    'UPDATE payment_profiles SET stripe_payment_link_url = $1, stripe_payment_link_id = $2 WHERE user_id = $3',
    [url, id, userId]
  );

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: userId,
    action: 'tip_stripe_regenerate',
    metadata: {
      tokenPrefix: row.tip_page_token.slice(0, 8),
      oldStripeLinkId: row.stripe_payment_link_id || null,
      newStripeLinkId: id,
    },
  });

  res.json({ ok: true, url });
}));

// POST — create a Stripe link when one is missing (and ensure a token exists).
// Fails 409 if a link already exists — forces an explicit regenerate call.
router.post('/contractors/:userId/tip-page/generate-stripe', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);

  const { rows } = await pool.query(`
    SELECT pp.tip_page_token, pp.stripe_payment_link_url, cp.preferred_name
    FROM payment_profiles pp
    LEFT JOIN contractor_profiles cp ON cp.user_id = pp.user_id
    WHERE pp.user_id = $1
  `, [userId]);
  const row = rows[0];

  if (row && row.stripe_payment_link_url) {
    throw new ConflictError('Stripe link already exists; use regenerate', 'STRIPE_LINK_EXISTS');
  }

  let token = row && row.tip_page_token;
  if (!token) {
    token = uuidv4();
    await pool.query(`
      INSERT INTO payment_profiles (user_id, tip_page_token, tip_page_active)
      VALUES ($1, $2, TRUE)
      ON CONFLICT (user_id) DO UPDATE SET tip_page_token = COALESCE(payment_profiles.tip_page_token, $2)
    `, [userId, token]);
  }

  const displayName = (row && row.preferred_name) || 'your bartender';
  const { url, id } = await createTipPaymentLink({ userId, displayName, token });
  await pool.query(
    'UPDATE payment_profiles SET stripe_payment_link_url = $1, stripe_payment_link_id = $2 WHERE user_id = $3',
    [url, id, userId]
  );
  res.json({ ok: true, url });
}));

// POST — disable the page + deactivate Stripe link
router.post('/contractors/:userId/tip-page/deactivate', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);
  await deactivateTipPage(userId);
  res.json({ ok: true });
}));

// POST — re-enable the page + reactivate Stripe link
router.post('/contractors/:userId/tip-page/activate', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) throw new ValidationError('invalid userId');
  await ensureNonAdminTargetForManager(req, userId);
  await activateTipPage(userId);
  res.json({ ok: true });
}));

// ─── Tips Activity + Feedback Queue ──────────────────────────────

// All tips activity (admin-only — exposes customer emails + tip amounts)
router.get('/tips', auth, adminOnly, asyncHandler(async (req, res) => {
  const { bartender_id, from, to } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const cursor = parseInt(req.query.cursor, 10) || null;

  const filters = ['1=1'];
  const params = [];
  if (bartender_id) {
    filters.push(`t.target_user_id = $${params.length + 1}`);
    params.push(parseInt(bartender_id, 10));
  }
  if (from) {
    filters.push(`t.tipped_at >= $${params.length + 1}`);
    params.push(from);
  }
  if (to) {
    filters.push(`t.tipped_at <= $${params.length + 1}`);
    params.push(to);
  }
  if (cursor) {
    filters.push(`t.id < $${params.length + 1}`);
    params.push(cursor);
  }

  params.push(limit);
  const { rows } = await pool.query(`
    SELECT t.id, t.amount_cents, t.tipped_at, t.customer_email,
           cp.preferred_name AS bartender_name, t.target_user_id
    FROM tips t
    LEFT JOIN contractor_profiles cp ON cp.user_id = t.target_user_id
    WHERE ${filters.join(' AND ')}
    ORDER BY t.id DESC
    LIMIT $${params.length}
  `, params);

  res.json({
    tips: rows,
    next_cursor: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}));

// Feedback queue (admin-only — exposes submitter emails + comments)
router.get('/tip-feedback', auth, adminOnly, asyncHandler(async (req, res) => {
  const status = req.query.status === 'reviewed' ? 'reviewed'
              : req.query.status === 'all' ? 'all' : 'unreviewed';

  let where = 'reviewed_at IS NULL';
  if (status === 'reviewed') where = 'reviewed_at IS NOT NULL';
  if (status === 'all') where = '1=1';

  const { rows } = await pool.query(`
    SELECT f.id, f.target_user_id, f.rating, f.comment, f.submitter_email,
           f.created_at, f.reviewed_at,
           cp.preferred_name AS bartender_name
    FROM tip_page_feedback f
    LEFT JOIN contractor_profiles cp ON cp.user_id = f.target_user_id
    WHERE ${where}
    ORDER BY f.created_at DESC
    LIMIT 200
  `);
  res.json({ feedback: rows });
}));

// Mark feedback reviewed (admin-only — mirrors the feedback view's gate)
router.post('/tip-feedback/:id/review', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ValidationError('invalid id');

  await pool.query(`
    UPDATE tip_page_feedback
    SET reviewed_at = NOW(), reviewed_by = $1
    WHERE id = $2
  `, [req.user.id, id]);
  res.json({ ok: true });
}));

module.exports = router;
