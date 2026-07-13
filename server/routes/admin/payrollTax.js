/**
 * Admin-only 1099 / payment-history read surfaces, mounted at
 * /api/admin/payroll/* (staff-payment-import spec 2026-07-10, §8).
 *
 * Extracted from payroll.js (which is already at the file-size soft cap): these
 * three endpoints are one coherent "historical earnings + tax" concern and are
 * pure read/one-flag-write, distinct from payroll.js's money-moving flows.
 *
 * Auth: every route is `auth` + `adminOnly` (payroll is admin-only, matching
 * payroll.js). SELECTs are parameterized; the one PATCH flips a single boolean.
 *
 * Source-of-truth rule (spec §3): historical pay is read from
 * `staff_payment_history` ONLY. `legacy_cc_payouts` is superseded / write-only
 * and is NEVER read or summed here. Blended totals = this ledger + PAID payouts
 * (zero overlap by the June-2 boundary construction, spec §4).
 *
 * Tax-year grouping is pinned (spec §4): ledger by `paid_on` year, payouts by
 * `paid_at` year (constructive receipt) — NEVER `pay_periods.payday`.
 */
const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError, ValidationError } = require('../../utils/errors');

const router = express.Router();

// pg returns DATE columns as JS Date objects; String(Date) yields a long
// "Fri May 29 2026 …" string. Normalize to YYYY-MM-DD (mirrors ymd() in
// server/routes/admin/payroll.js + staffPortal/payouts.js).
function ymd(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

// Sum of PAID OS payouts for a contractor, in integer cents. COALESCE so an
// empty result is 0, never NULL. Reused by both the admin and (mirrored in)
// the staff blended totals.
async function paidPayoutCents(contractorId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(total_cents), 0)::bigint AS cents
       FROM payouts
      WHERE contractor_id = $1 AND status = 'paid'`,
    [contractorId]
  );
  return Number(rows[0].cents);
}

// Validate a ?year= query param. Absent → current calendar year (the January
// filing workflow default). Present → must be an integer in [2024, 2100].
function resolveYear(raw) {
  if (raw === undefined || raw === null || raw === '') return new Date().getFullYear();
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2024 || year > 2100) {
    throw new ValidationError(null, 'year must be an integer between 2024 and 2100');
  }
  return year;
}

// ─── GET /api/admin/payroll/contractors/:userId/payment-history ────────────
// All-time imported payment history for one contractor + a blended all-time
// total (imported ledger + PAID OS payouts). staff_payment_history ONLY.
router.get('/payroll/contractors/:userId/payment-history', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) throw new ValidationError(null, 'invalid userId');

  const { rows } = await pool.query(
    `SELECT id, paid_on, amount_cents, platform, source_account, memo, event_label
       FROM staff_payment_history
      WHERE contractor_id = $1
      ORDER BY paid_on DESC, id DESC`,
    [userId]
  );

  const ledgerCents = rows.reduce((sum, r) => sum + Number(r.amount_cents), 0);
  const paidCents = await paidPayoutCents(userId);

  res.json({
    history: rows.map((r) => ({
      id: r.id,
      paid_on: ymd(r.paid_on),
      amount_cents: Number(r.amount_cents),
      platform: r.platform,
      source_account: r.source_account,
      memo: r.memo,
      event_label: r.event_label,
    })),
    total_cents: ledgerCents,
    blended_total_cents: ledgerCents + paidCents,
  });
}));

// ─── GET /api/admin/payroll/tax-totals?year=2026 ───────────────────────────
// Per-contractor calendar-year totals for 1099 season. Ledger grouped by
// paid_on year; payouts grouped by paid_at year (constructive receipt, spec
// §4 — never payday). A user appears if they have EITHER a ledger row OR a
// paid payout in the year (union of the two id sets = the "full outer on
// user" behaviour the spec calls for). platforms = per-platform ledger cents.
router.get('/payroll/tax-totals', auth, adminOnly, asyncHandler(async (req, res) => {
  const year = resolveYear(req.query.year);

  const { rows } = await pool.query(
    `WITH ledger AS (
       SELECT contractor_id AS user_id, platform, SUM(amount_cents)::bigint AS cents
         FROM staff_payment_history
        WHERE EXTRACT(YEAR FROM paid_on) = $1
        GROUP BY contractor_id, platform
     ),
     ledger_agg AS (
       SELECT user_id,
              SUM(cents)::bigint AS ledger_cents,
              jsonb_object_agg(platform, cents) AS platforms
         FROM ledger
        GROUP BY user_id
     ),
     payout_agg AS (
       SELECT contractor_id AS user_id, SUM(total_cents)::bigint AS payout_cents
         FROM payouts
        WHERE status = 'paid'
          AND paid_at IS NOT NULL
          AND EXTRACT(YEAR FROM paid_at) = $1
        GROUP BY contractor_id
     ),
     combined AS (
       SELECT user_id FROM ledger_agg
       UNION
       SELECT user_id FROM payout_agg
     )
     SELECT c.user_id,
            COALESCE(cp.preferred_name, u.email) AS name,
            COALESCE(u.exclude_from_1099, false) AS exclude_from_1099,
            COALESCE(la.ledger_cents, 0)::bigint AS ledger_cents,
            COALESCE(pa.payout_cents, 0)::bigint AS payout_cents,
            (COALESCE(la.ledger_cents, 0) + COALESCE(pa.payout_cents, 0))::bigint AS total_cents,
            COALESCE(la.platforms, '{}'::jsonb) AS platforms
       FROM combined c
       JOIN users u ON u.id = c.user_id
  LEFT JOIN contractor_profiles cp ON cp.user_id = c.user_id
  LEFT JOIN ledger_agg la ON la.user_id = c.user_id
  LEFT JOIN payout_agg pa ON pa.user_id = c.user_id
      ORDER BY total_cents DESC, name ASC`,
    [year]
  );

  res.json({
    year,
    rows: rows.map((r) => ({
      user_id: r.user_id,
      name: r.name,
      exclude_from_1099: r.exclude_from_1099,
      ledger_cents: Number(r.ledger_cents),
      payout_cents: Number(r.payout_cents),
      total_cents: Number(r.total_cents),
      platforms: r.platforms || {},
    })),
  });
}));

// ─── PATCH /api/admin/payroll/tax-totals/:userId/exclude ───────────────────
// Toggle the per-person 1099 exclusion flag (foreign contractors on W-8BEN,
// e.g. Zul). Admin-toggleable post-import — not set-once.
router.patch('/payroll/tax-totals/:userId/exclude', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) throw new ValidationError(null, 'invalid userId');

  const exclude = req.body && req.body.exclude;
  if (typeof exclude !== 'boolean') throw new ValidationError(null, 'exclude must be a boolean');

  const { rows } = await pool.query(
    `UPDATE users SET exclude_from_1099 = $1
      WHERE id = $2
      RETURNING id AS user_id, exclude_from_1099`,
    [exclude, userId]
  );
  if (!rows[0]) throw new NotFoundError('User not found');
  res.json(rows[0]);
}));

module.exports = router;
