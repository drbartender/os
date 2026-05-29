// Staff portal API — composite + account-management endpoints (spec
// docs/superpowers/specs/2026-05-27-staff-portal-redesign-design.md).
//
// Mounted at /api/me, AFTER server/routes/me.js so existing paths win on any
// path collision. Verified no overlap at write time: me.js owns /tip-page,
// /tips, /notification-preferences; this router owns /staff-home,
// /payment-methods, /preferred-payment-method, /tip-card-order, /profile,
// /ui-preferences, /staff-notifications, /push-subscriptions, /documents/...,
// /request-email-change, /cancel-pending-email-change.

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');
const { encrypt, decrypt } = require('../utils/encryption');
const {
  normalizeVenmoHandle, normalizeCashappHandle, normalizePaypalUrl, normalizeZelleHandle,
} = require('../utils/tipHandleValidation');

const router = express.Router();
router.use(auth);

// ─── Task 12: GET /staff-home (composite home payload) ─────────────────────
//
// One round-trip for the redesigned HomePage. Four parallel queries via
// Promise.all (none depend on each other's results):
//   1. Next upcoming approved shift, with BEO finalize + ack projection.
//   2. Pending shift_requests for this user.
//   3. Cover broadcasts visible to this user (any shift_request with
//      cover_requested_at NOT NULL, requester != this user). Each broadcast
//      carries `you_are_on_team` derived from same-proposal approved requests.
//   4. Current pay-period summary (projected payout total + event count +
//      payday + status). Mirrors the payoutAccrual / payouts pattern.
//
// Open-shifts teaser is intentionally a hardcoded empty array for now —
// spec §6.2 lists it as a section but the wire-up to /api/shifts open list
// lands in a later task; this route projects an empty list so the client can
// render the section with an "All →" link with no crash.
router.get('/staff-home', asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const [nextShift, pendingRequests, coverBroadcasts, currentPeriod] = await Promise.all([
    pool.query(`
      SELECT s.id AS shift_id, s.event_date, s.start_time, s.end_time, s.location,
             s.positions_needed,
             sr.id AS request_id, sr.status AS request_status, sr.position,
             sr.beo_acknowledged_at,
             p.id AS proposal_id, p.event_type, p.event_type_custom,
             p.event_timezone, p.event_duration_hours,
             c.name AS client_name,
             dp.finalized_at AS drink_plan_finalized_at,
             dp.id AS drink_plan_id
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
        LEFT JOIN drink_plans dp ON dp.proposal_id = p.id
       WHERE sr.user_id = $1
         AND sr.status = 'approved'
         AND sr.dropped_at IS NULL
         AND s.event_date >= CURRENT_DATE
       ORDER BY s.event_date ASC, s.start_time ASC
       LIMIT 1
    `, [userId]),

    pool.query(`
      SELECT sr.id AS request_id, sr.created_at, sr.position,
             s.id AS shift_id, s.event_date, s.start_time, s.end_time, s.location,
             p.id AS proposal_id, p.event_type, p.event_type_custom,
             c.name AS client_name
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
       WHERE sr.user_id = $1
         AND sr.status = 'pending'
         AND s.event_date >= CURRENT_DATE
       ORDER BY s.event_date ASC
    `, [userId]),

    pool.query(`
      SELECT sr.id AS request_id, sr.cover_requested_at, sr.cover_reason,
             sr.user_id AS requester_id,
             s.id AS shift_id, s.event_date, s.start_time, s.end_time, s.location,
             p.id AS proposal_id, p.event_type, p.event_type_custom,
             c.name AS client_name,
             u.email AS requester_email,
             cp.preferred_name AS requester_preferred_name,
             EXISTS (
               SELECT 1 FROM shift_requests sr2
                WHERE sr2.shift_id = sr.shift_id
                  AND sr2.user_id = $1
                  AND sr2.status = 'approved'
                  AND sr2.dropped_at IS NULL
             ) AS you_are_on_team
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
        LEFT JOIN users u ON u.id = sr.user_id
        LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
       WHERE sr.cover_requested_at IS NOT NULL
         AND sr.user_id <> $1
         AND sr.status = 'approved'
         AND sr.dropped_at IS NULL
         AND s.event_date >= CURRENT_DATE
       ORDER BY s.event_date ASC
       LIMIT 20
    `, [userId]),

    pool.query(`
      SELECT pp.id AS pay_period_id, pp.start_date, pp.end_date,
             pp.payday, pp.status,
             po.id AS payout_id, COALESCE(po.total_cents, 0) AS total_cents,
             COALESCE((
               SELECT COUNT(*)::int FROM payout_events pe WHERE pe.payout_id = po.id
             ), 0) AS event_count
        FROM pay_periods pp
        LEFT JOIN payouts po ON po.pay_period_id = pp.id AND po.contractor_id = $1
       WHERE CURRENT_DATE BETWEEN pp.start_date AND pp.end_date
       ORDER BY pp.start_date DESC
       LIMIT 1
    `, [userId]),
  ]);

  res.json({
    next_shift: nextShift.rows[0] || null,
    pending_requests: pendingRequests.rows,
    cover_broadcasts: coverBroadcasts.rows,
    current_period: currentPeriod.rows[0] || null,
    open_shifts_teaser: [],
  });
}));

// ─── Task 13: Payment methods ───────────────────────────────────────────────
//
// Spec §6.11. Loaded with rules; lift them all into named helpers so each one
// is the single source of truth for both the GET projection and the PATCH /
// PUT mutation flows.

// Whitelist of fields the PATCH route accepts. Hardcoded (NOT derived from
// Object.keys) so a payload like `{user_id: 99}` smuggles nothing. Validated
// BEFORE any DB read — see route handler.
const PAYMENT_METHOD_ALLOWED_KEYS = new Set([
  'venmo_handle', 'cashapp_handle', 'paypal_url', 'zelle_handle',
  'routing_number', 'account_number', 'payment_username',
]);

const PAYMENT_METHOD_VALUES = new Set([
  'venmo', 'cashapp', 'paypal', 'zelle', 'direct_deposit', 'check',
]);

// ABA routing-number checksum. 9 digits, weighted sum mod 10 == 0.
function isValidRoutingNumber(s) {
  if (typeof s !== 'string' || !/^\d{9}$/.test(s)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(s[i]) * w[i];
  return sum % 10 === 0;
}

function isValidAccountNumber(s) {
  return typeof s === 'string' && /^\d{4,17}$/.test(s);
}

// Safe decrypt that swallows the error and returns null, capturing the
// failure to Sentry so admin tooling can repair the row later. Spec §6.11:
// "if decrypt fails, return null with a Sentry breadcrumb, don't 500 the GET."
function safeDecryptOrNull(cipher, userId, column) {
  if (!cipher) return null;
  try {
    return decrypt(cipher);
  } catch (err) {
    try {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, {
          tags: { route: 'staffPortal.payment-methods', column },
          extra: { user_id: userId },
        });
      }
    } catch (_) { /* never let logging break a response */ }
    return null;
  }
}

function last4OrNull(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return null;
  if (plaintext.length <= 4) return plaintext;
  return plaintext.slice(-4);
}

// Single resolver shared by PATCH (auto-NULL after a handle clear) and PUT
// (eligibility check). Returns true if the user has the data needed to use
// `method` as their preferred payroll target.
function isPreferredEligible(method, row) {
  if (!row) return false;
  switch (method) {
    case 'venmo':         return !!row.venmo_handle;
    case 'cashapp':       return !!row.cashapp_handle;
    case 'paypal':        return !!row.paypal_url;
    case 'zelle':         return !!row.zelle_handle;
    case 'check':         return true;
    case 'direct_deposit': return !!row.routing_number && !!row.account_number;
    default: return false;
  }
}

// Project the payment_profiles row into the wire shape. Last-4-only for the
// bank fields; handles plaintext as-stored (per spec §6.11).
function projectPaymentMethods(row, userId) {
  if (!row) {
    return {
      preferred_payment_method: null,
      venmo_handle: null,
      cashapp_handle: null,
      paypal_url: null,
      zelle_handle: null,
      routing_number_last4: null,
      account_number_last4: null,
      payment_username: null,
    };
  }
  const routing = safeDecryptOrNull(row.routing_number, userId, 'routing_number');
  const account = safeDecryptOrNull(row.account_number, userId, 'account_number');
  return {
    preferred_payment_method: row.preferred_payment_method || null,
    venmo_handle: row.venmo_handle || null,
    cashapp_handle: row.cashapp_handle || null,
    paypal_url: row.paypal_url || null,
    zelle_handle: row.zelle_handle || null,
    routing_number_last4: last4OrNull(routing),
    account_number_last4: last4OrNull(account),
    payment_username: row.payment_username || null,
  };
}

router.get('/payment-methods', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT preferred_payment_method, payment_username,
            routing_number, account_number,
            venmo_handle, cashapp_handle, paypal_url, zelle_handle
       FROM payment_profiles WHERE user_id = $1`,
    [req.user.id]
  );
  res.json(projectPaymentMethods(rows[0], req.user.id));
}));

router.patch('/payment-methods', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const keys = Object.keys(body);
  // Allowlist check FIRST — before any DB work — so a payload like
  // `{user_id: 99, ...}` rejects with no read.
  for (const k of keys) {
    if (!PAYMENT_METHOD_ALLOWED_KEYS.has(k)) {
      throw new ValidationError({ body: `Unknown field: ${k}` }, `Unknown field: ${k}`);
    }
  }
  if (keys.length === 0) {
    throw new ValidationError({ _form: 'No fields to update.' }, 'No fields to update.');
  }

  // Validate + normalize handles (throws ValidationError on bad shape).
  const updates = {};
  if ('venmo_handle' in body)   updates.venmo_handle   = normalizeVenmoHandle(body.venmo_handle);
  if ('cashapp_handle' in body) updates.cashapp_handle = normalizeCashappHandle(body.cashapp_handle);
  if ('paypal_url' in body)     updates.paypal_url     = normalizePaypalUrl(body.paypal_url);
  if ('zelle_handle' in body)   updates.zelle_handle   = normalizeZelleHandle(body.zelle_handle);

  // payment_username — free text, 100 char cap.
  if ('payment_username' in body) {
    if (body.payment_username === null || body.payment_username === '') {
      updates.payment_username = null;
    } else if (typeof body.payment_username !== 'string' || body.payment_username.length > 100) {
      throw new ValidationError({ payment_username: 'must be a string up to 100 chars' });
    } else {
      updates.payment_username = body.payment_username.trim();
    }
  }

  // Bank fields. Null = clear (no encryption). String = validate BEFORE
  // encryption. Anything else rejects.
  if ('routing_number' in body) {
    if (body.routing_number === null || body.routing_number === '') {
      updates.routing_number = null;
    } else if (!isValidRoutingNumber(String(body.routing_number).trim())) {
      throw new ValidationError({ routing_number: 'must be a 9-digit ABA routing number' });
    } else {
      updates.routing_number = String(body.routing_number).trim();
    }
  }
  if ('account_number' in body) {
    if (body.account_number === null || body.account_number === '') {
      updates.account_number = null;
    } else if (!isValidAccountNumber(String(body.account_number).trim())) {
      throw new ValidationError({ account_number: 'must be 4 to 17 digits' });
    } else {
      updates.account_number = String(body.account_number).trim();
    }
  }

  const fieldsChanged = [];
  const cleared = [];
  let preferredCleared = false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure a payment_profiles row exists, then re-select FOR UPDATE.
    await client.query(
      'INSERT INTO payment_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [req.user.id]
    );
    const existingRes = await client.query(
      'SELECT * FROM payment_profiles WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );
    const existing = existingRes.rows[0];

    // Build the SET clause incrementally — only fields that actually changed
    // get written; bank fields go through encrypt() now that validation passed.
    const setCols = [];
    const setVals = [];
    for (const k of Object.keys(updates)) {
      const v = updates[k];
      if (k === 'routing_number' || k === 'account_number') {
        if (v === null) {
          setCols.push(`${k} = NULL`);
          cleared.push(k);
          fieldsChanged.push(k);
        } else {
          // Encrypt the plaintext. Only changed bank fields get re-encrypted;
          // the OTHER bank field's ciphertext is left untouched (no
          // decrypt-then-encrypt churn on the unchanged side).
          setVals.push(encrypt(v));
          setCols.push(`${k} = $${setVals.length + 1}`);
          fieldsChanged.push(k);
        }
      } else {
        if (v === null) cleared.push(k);
        setVals.push(v);
        setCols.push(`${k} = $${setVals.length + 1}`);
        fieldsChanged.push(k);
      }
    }

    if (setCols.length > 0) {
      await client.query(
        `UPDATE payment_profiles SET ${setCols.join(', ')}, updated_at = NOW() WHERE user_id = $1`,
        [req.user.id, ...setVals]
      );
    }

    // Auto-NULL preferred_payment_method if the user just cleared the field
    // their preferred target depends on. Examine the prospective post-update
    // state by merging `updates` onto `existing`.
    const merged = { ...existing, ...updates };
    if (existing && existing.preferred_payment_method
        && !isPreferredEligible(existing.preferred_payment_method, merged)) {
      await client.query(
        'UPDATE payment_profiles SET preferred_payment_method = NULL, updated_at = NOW() WHERE user_id = $1',
        [req.user.id]
      );
      preferredCleared = true;
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }

  // Audit log AFTER the commit. A failed audit insert must not roll back the
  // user-facing change; capture to Sentry and move on.
  if (fieldsChanged.length > 0) {
    try {
      await pool.query(
        `INSERT INTO staff_audit_log (user_id, actor_type, actor_id, action, details)
         VALUES ($1, 'staff', $1, 'payment_method_change', $2)`,
        [req.user.id, JSON.stringify({ fields_changed: fieldsChanged, cleared })]
      );
    } catch (err) {
      try {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(err, {
            tags: { route: 'staffPortal.payment-methods', op: 'audit_insert' },
            extra: { user_id: req.user.id, fieldsChanged, cleared },
          });
        }
      } catch (_) { /* swallow */ }
    }
  }

  // Re-project to return the new state. New SELECT (not in tx) is fine —
  // the user only sees their own row.
  const { rows } = await pool.query(
    `SELECT preferred_payment_method, payment_username,
            routing_number, account_number,
            venmo_handle, cashapp_handle, paypal_url, zelle_handle
       FROM payment_profiles WHERE user_id = $1`,
    [req.user.id]
  );
  res.json({
    ...projectPaymentMethods(rows[0], req.user.id),
    preferred_cleared: preferredCleared,
  });
}));

router.put('/preferred-payment-method', asyncHandler(async (req, res) => {
  const method = req.body?.method;
  if (method !== null && !PAYMENT_METHOD_VALUES.has(method)) {
    throw new ValidationError(
      { method: `must be one of ${[...PAYMENT_METHOD_VALUES].join(', ')} or null` },
      'Invalid payment method.'
    );
  }

  const { rows } = await pool.query(
    `SELECT preferred_payment_method, venmo_handle, cashapp_handle, paypal_url, zelle_handle,
            routing_number, account_number
       FROM payment_profiles WHERE user_id = $1`,
    [req.user.id]
  );
  const row = rows[0];

  if (method !== null && !isPreferredEligible(method, row)) {
    // Construct a friendly field error per method.
    const fieldMap = {
      venmo: 'venmo_handle', cashapp: 'cashapp_handle', paypal: 'paypal_url',
      zelle: 'zelle_handle', direct_deposit: 'routing_number',
    };
    const f = fieldMap[method] || 'method';
    throw new ValidationError(
      { [f]: `Add a ${method} handle before setting it as preferred.` },
      `Add a ${method} handle before setting it as preferred.`
    );
  }

  const from = (row && row.preferred_payment_method) || null;
  await pool.query(
    `INSERT INTO payment_profiles (user_id, preferred_payment_method)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET preferred_payment_method = $2, updated_at = NOW()`,
    [req.user.id, method]
  );

  // Audit row. Same Sentry-on-failure pattern as PATCH.
  try {
    await pool.query(
      `INSERT INTO staff_audit_log (user_id, actor_type, actor_id, action, details)
       VALUES ($1, 'staff', $1, 'preferred_payment_method_change', $2)`,
      [req.user.id, JSON.stringify({ from, to: method })]
    );
  } catch (err) {
    try {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, {
          tags: { route: 'staffPortal.preferred-payment-method', op: 'audit_insert' },
          extra: { user_id: req.user.id, from, to: method },
        });
      }
    } catch (_) { /* swallow */ }
  }

  res.json({ preferred_payment_method: method });
}));

module.exports = router;
