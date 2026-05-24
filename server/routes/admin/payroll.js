/**
 * Admin-only payroll portal routes mounted at /api/admin/payroll/*.
 *
 * Auth: every route below is gated by `auth` + `adminOnly` (Section 13:
 * Payroll is admin-only in this version; managers do not have access).
 * Money-touching endpoints wrap multi-statement work in a transaction.
 */
const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError, ValidationError, ConflictError } = require('../../utils/errors');
const { findOpenPeriodForDate, recomputePayoutTotal, maybeFinalizePeriod } = require('../../utils/payrollProcessing');
const { accruePayoutsForProposal } = require('../../utils/payrollAccrual');

const router = express.Router();

// Cheap liveness probe. Real endpoints follow in subsequent tasks.
router.get('/payroll/healthcheck', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json({ ok: true, ts: Date.now() });
}));

// Reusable: hydrate a period with its payouts and each payout's events.
async function loadPeriodWithPayouts(periodRow) {
  const payoutsRes = await pool.query(
    `SELECT po.id, po.contractor_id, po.status, po.total_cents,
            po.payment_method, po.payment_handle, po.paid_at, po.paystub_storage_key,
            COALESCE(cp.preferred_name, u.email) AS contractor_name,
            pp.preferred_payment_method, pp.venmo_handle, pp.cashapp_handle, pp.paypal_url
       FROM payouts po
       JOIN users u ON u.id = po.contractor_id
  LEFT JOIN contractor_profiles cp ON cp.user_id = po.contractor_id
  LEFT JOIN payment_profiles pp ON pp.user_id = po.contractor_id
      WHERE po.pay_period_id = $1
      ORDER BY COALESCE(cp.preferred_name, u.email) ASC`,
    [periodRow.id]
  );
  const payoutIds = payoutsRes.rows.map(p => p.id);
  const eventsByPayout = {};
  if (payoutIds.length > 0) {
    const eventsRes = await pool.query(
      `SELECT pe.id, pe.payout_id, pe.shift_id,
              pe.contracted_hours, pe.hours, pe.rate_cents, pe.wage_cents, pe.late,
              pe.gratuity_share_cents,
              pe.card_tip_gross_cents, pe.card_tip_fee_cents, pe.card_tip_net_cents,
              pe.adjustment_cents, pe.adjustment_note, pe.line_total_cents,
              p.event_date, p.event_type, p.event_type_custom
         FROM payout_events pe
         JOIN shifts s ON s.id = pe.shift_id
    LEFT JOIN proposals p ON p.id = s.proposal_id
        WHERE pe.payout_id = ANY($1::int[])
        ORDER BY p.event_date ASC, pe.id ASC`,
      [payoutIds]
    );
    for (const ev of eventsRes.rows) {
      (eventsByPayout[ev.payout_id] ||= []).push(ev);
    }
  }
  const payouts = payoutsRes.rows.map(p => ({ ...p, events: eventsByPayout[p.id] || [] }));
  return { period: periodRow, payouts };
}

router.get('/payroll/periods', auth, adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pp.id, pp.start_date, pp.end_date, pp.payday, pp.status,
            COALESCE(SUM(po.total_cents), 0) AS total_cents,
            COUNT(po.id) FILTER (WHERE po.status = 'paid') AS paid_count,
            COUNT(po.id) FILTER (WHERE po.status = 'pending') AS pending_count
       FROM pay_periods pp
  LEFT JOIN payouts po ON po.pay_period_id = pp.id
   GROUP BY pp.id
   ORDER BY pp.start_date DESC`
  );
  res.json({ periods: rows });
}));

router.get('/payroll/periods/current', auth, adminOnly, asyncHandler(async (req, res) => {
  // Today in the server's local tz, then fall back to the most recent open
  // period if today is not inside any open one (e.g., between the freeze of
  // one period and the accrual of the first event in the next).
  const todayYmd = new Date().toISOString().slice(0, 10);
  let period = await findOpenPeriodForDate(pool, todayYmd);
  if (!period) {
    const { rows } = await pool.query(
      `SELECT id, start_date, end_date, payday, status
         FROM pay_periods WHERE status = 'open'
        ORDER BY start_date DESC LIMIT 1`
    );
    period = rows[0] || null;
  }
  if (!period) return res.json({ period: null, payouts: [] });
  res.json(await loadPeriodWithPayouts(period));
}));

router.get('/payroll/periods/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new NotFoundError('Period not found');
  const { rows } = await pool.query(
    `SELECT id, start_date, end_date, payday, status FROM pay_periods WHERE id = $1`,
    [id]
  );
  if (!rows[0]) throw new NotFoundError('Period not found');
  res.json(await loadPeriodWithPayouts(rows[0]));
}));

const EDITABLE_FIELDS = ['hours', 'rate_cents', 'late', 'adjustment_cents', 'adjustment_note'];
const ALLOWED_PAY_METHODS = new Set(['venmo', 'cashapp', 'paypal', 'check', 'direct_deposit', 'other']);

// pg returns DATE columns as JS Date objects. String(Date) yields
// "Fri May 29 2026 ..." which breaks both `.slice(0,10)` formatting and
// PG date casts downstream. Normalize to a YYYY-MM-DD string.
function ymd(eventDate) {
  if (!eventDate) return null;
  if (eventDate instanceof Date) return eventDate.toISOString().slice(0, 10);
  return String(eventDate).slice(0, 10);
}

router.patch('/payroll/payout-events/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const eventId = Number(req.params.id);
  if (!Number.isInteger(eventId)) throw new ValidationError(null, 'invalid event id');

  // Pick only the editable keys actually present in the body.
  const patch = {};
  for (const k of EDITABLE_FIELDS) {
    if (k in req.body) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) throw new ValidationError(null, 'no editable fields supplied');

  // Validate field-by-field.
  if ('hours' in patch) {
    const n = Number(patch.hours);
    if (!Number.isFinite(n) || n < 0 || n > 24) {
      throw new ValidationError(null, 'hours must be between 0 and 24');
    }
    patch.hours = n;
  }
  if ('rate_cents' in patch) {
    const n = Number(patch.rate_cents);
    if (!Number.isInteger(n) || n < 0 || n > 100000) {
      throw new ValidationError(null, 'rate_cents must be an integer between 0 and 100000');
    }
    patch.rate_cents = n;
  }
  if ('late' in patch) {
    if (typeof patch.late !== 'boolean') throw new ValidationError(null, 'late must be a boolean');
  }
  if ('adjustment_cents' in patch) {
    const n = Number(patch.adjustment_cents);
    if (!Number.isInteger(n) || Math.abs(n) > 100000) {
      throw new ValidationError(null, 'adjustment_cents must be an integer within +/-100000');
    }
    patch.adjustment_cents = n;
  }
  if ('adjustment_note' in patch) {
    const s = patch.adjustment_note === null ? null : String(patch.adjustment_note);
    if (s !== null && s.length > 500) {
      throw new ValidationError(null, 'adjustment_note exceeds 500 chars');
    }
    patch.adjustment_note = s;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Pin the row + its parent payout + its period for the update.
    const { rows } = await client.query(
      `SELECT pe.*, po.id AS payout_id, po.status AS payout_status,
              pp.id AS pay_period_id, pp.status AS period_status
         FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
         JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE pe.id = $1
        FOR UPDATE OF pe, po`,
      [eventId]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('payout_event not found');
    }
    const row = rows[0];
    if (row.payout_status === 'paid' || row.period_status === 'paid') {
      await client.query('ROLLBACK');
      throw new ConflictError('payout or period is paid; edits are frozen');
    }

    // Apply the patch on top of the current row.
    const next = {
      hours: 'hours' in patch ? patch.hours : Number(row.hours),
      rate_cents: 'rate_cents' in patch ? patch.rate_cents : Number(row.rate_cents),
      late: 'late' in patch ? patch.late : row.late,
      adjustment_cents: 'adjustment_cents' in patch ? patch.adjustment_cents : Number(row.adjustment_cents),
      adjustment_note: 'adjustment_note' in patch ? patch.adjustment_note : row.adjustment_note,
    };
    const wage = Math.round(next.hours * next.rate_cents);
    const lineTotal = Math.max(
      0,
      wage + Number(row.gratuity_share_cents) + Number(row.card_tip_net_cents) + next.adjustment_cents
    );

    await client.query(
      `UPDATE payout_events
          SET hours = $1, rate_cents = $2, late = $3,
              adjustment_cents = $4, adjustment_note = $5,
              wage_cents = $6, line_total_cents = $7
        WHERE id = $8`,
      [next.hours, next.rate_cents, next.late,
       next.adjustment_cents, next.adjustment_note,
       wage, lineTotal, eventId]
    );
    const payoutTotal = await recomputePayoutTotal(client, row.payout_id);
    await client.query('COMMIT');

    const refreshed = await pool.query(
      `SELECT * FROM payout_events WHERE id = $1`, [eventId]
    );
    res.json({ event: refreshed.rows[0], payout_total_cents: payoutTotal });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignored on already-rolled-back */ }
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/payroll/periods/:id/process', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new NotFoundError('Period not found');
  const { rows } = await pool.query(
    `UPDATE pay_periods SET status = 'processing'
      WHERE id = $1 AND status = 'open'
      RETURNING id, start_date, end_date, payday, status`,
    [id]
  );
  if (!rows[0]) {
    // Either the period doesn't exist or it's not open.
    const existing = await pool.query(
      'SELECT status FROM pay_periods WHERE id = $1', [id]
    );
    if (!existing.rows[0]) throw new NotFoundError('Period not found');
    throw new ConflictError(`Period is ${existing.rows[0].status}, not open`);
  }
  res.json({ period: rows[0] });
}));

router.post('/payroll/payouts/:id/mark-paid', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ValidationError(null, 'invalid payout id');

  const method = req.body && req.body.payment_method;
  if (!method || !ALLOWED_PAY_METHODS.has(method)) {
    throw new ValidationError(null, `payment_method must be one of ${[...ALLOWED_PAY_METHODS].join(', ')}`);
  }
  const phRaw = req.body && req.body.payment_handle;
  const handle = (phRaw !== null && phRaw !== undefined) ? String(phRaw) : null;
  if (handle !== null && handle.length > 200) {
    throw new ValidationError(null, 'payment_handle exceeds 200 chars');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT po.id, po.status AS payout_status, po.pay_period_id,
              pp.status AS period_status
         FROM payouts po
         JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE po.id = $1
        FOR UPDATE OF po, pp`,
      [id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('payout not found');
    }
    if (rows[0].payout_status !== 'pending') {
      await client.query('ROLLBACK');
      throw new ConflictError('payout is already paid');
    }
    if (rows[0].period_status !== 'processing') {
      await client.query('ROLLBACK');
      throw new ConflictError(`period is ${rows[0].period_status}; mark-paid requires processing`);
    }

    await client.query(
      `UPDATE payouts
          SET status = 'paid', payment_method = $1, payment_handle = $2,
              paid_at = NOW(), paid_by = $3
        WHERE id = $4`,
      [method, handle, req.user.id, id]
    );

    const finalized = await maybeFinalizePeriod(client, rows[0].pay_period_id);
    await client.query('COMMIT');

    const refreshed = await pool.query(
      `SELECT id, contractor_id, status, total_cents,
              payment_method, payment_handle, paid_at, paystub_storage_key
         FROM payouts WHERE id = $1`,
      [id]
    );
    res.json({
      payout: refreshed.rows[0],
      period_status: finalized ? 'paid' : 'processing',
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/payroll/unassigned-tips', auth, adminOnly, asyncHandler(async (req, res) => {
  // List recent unassigned tips. The dispatcher already retries matching, so
  // these are the genuine failures (no service window matched).
  const tipsRes = await pool.query(
    `SELECT t.id, t.target_user_id, t.amount_cents, t.tipped_at,
            COALESCE(cp.preferred_name, u.email) AS contractor_name
       FROM tips t
       JOIN users u ON u.id = t.target_user_id
  LEFT JOIN contractor_profiles cp ON cp.user_id = t.target_user_id
      WHERE t.shift_id IS NULL
        AND t.tipped_at > NOW() - INTERVAL '90 days'
      ORDER BY t.tipped_at DESC
      LIMIT 200`
  );
  if (tipsRes.rows.length === 0) return res.json({ tips: [] });

  // For each tip, the bartender's approved shifts within ±14 days are candidates.
  const userIds = [...new Set(tipsRes.rows.map(t => t.target_user_id))];
  const candidatesRes = await pool.query(
    `SELECT sr.user_id, s.id AS shift_id, s.event_date,
            p.event_type, p.event_type_custom
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
  LEFT JOIN proposals p ON p.id = s.proposal_id
      WHERE sr.user_id = ANY($1::int[])
        AND sr.status = 'approved'
        AND s.event_date > NOW() - INTERVAL '120 days'
      ORDER BY s.event_date DESC`,
    [userIds]
  );
  const byUser = {};
  for (const c of candidatesRes.rows) (byUser[c.user_id] ||= []).push(c);

  const tips = tipsRes.rows.map(t => {
    const all = byUser[t.target_user_id] || [];
    const tipDate = new Date(t.tipped_at);
    const within = all.filter(c => {
      const ed = new Date(`${ymd(c.event_date)}T12:00:00Z`);
      return Math.abs(ed - tipDate) <= 14 * 24 * 3600 * 1000;
    });
    return { ...t, candidate_shifts: within };
  });
  res.json({ tips });
}));

router.patch('/payroll/tips/:id/assign', auth, adminOnly, asyncHandler(async (req, res) => {
  const tipId = Number(req.params.id);
  const shiftId = Number(req.body && req.body.shift_id);
  if (!Number.isInteger(tipId) || !Number.isInteger(shiftId)) {
    throw new ValidationError(null, 'tipId and shift_id must be integers');
  }

  // Resolve the shift's proposal and the period that proposal accrued into.
  const shiftRes = await pool.query(
    `SELECT s.id, s.proposal_id, p.event_date FROM shifts s
       LEFT JOIN proposals p ON p.id = s.proposal_id WHERE s.id = $1`,
    [shiftId]
  );
  if (!shiftRes.rows[0]) throw new NotFoundError('shift not found');
  const { proposal_id: proposalId, event_date: eventDate } = shiftRes.rows[0];

  // Look up the period this event falls in (it may not exist yet if no event
  // has accrued; in that case there's nothing frozen).
  let frozen = false;
  if (eventDate) {
    const dateStr = ymd(eventDate);
    const periodRes = await pool.query(
      `SELECT status FROM pay_periods WHERE $1::date BETWEEN start_date AND end_date`,
      [dateStr]
    );
    frozen = !!periodRes.rows[0] && periodRes.rows[0].status !== 'open';
  }

  // Assign the tip.
  const updated = await pool.query(
    `UPDATE tips SET shift_id = $1 WHERE id = $2 RETURNING id, shift_id, amount_cents, tipped_at`,
    [shiftId, tipId]
  );
  if (!updated.rows[0]) throw new NotFoundError('tip not found');

  // Re-accrue for the affected proposal. Phase 1's accrual no-ops on a frozen
  // period, so this is safe to call regardless — it only updates the payout
  // line items when the period is still open.
  if (proposalId) {
    try {
      await accruePayoutsForProposal(proposalId);
    } catch (err) {
      // Mirror the lifecycle hook's best-effort pattern. Do not fail the
      // admin's assignment because of an accrual hiccup.
      require('@sentry/node').captureException(err, {
        tags: { route: 'tip_assign', step: 'reaccrue' },
      });
    }
  }

  res.json({ tip: updated.rows[0], frozen_period: frozen });
}));

router.get('/payroll/contractors/:userId/payouts', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) throw new ValidationError(null, 'invalid userId');
  const { rows } = await pool.query(
    `SELECT po.id, po.status, po.total_cents,
            po.payment_method, po.payment_handle, po.paid_at, po.paystub_storage_key,
            pp.id AS period_id, pp.start_date, pp.end_date, pp.payday, pp.status AS period_status,
            (SELECT COUNT(*) FROM payout_events WHERE payout_id = po.id) AS event_count
       FROM payouts po
       JOIN pay_periods pp ON pp.id = po.pay_period_id
      WHERE po.contractor_id = $1
      ORDER BY pp.start_date DESC`,
    [userId]
  );
  res.json({
    payouts: rows.map(r => ({
      id: r.id, status: r.status, total_cents: r.total_cents,
      payment_method: r.payment_method, payment_handle: r.payment_handle,
      paid_at: r.paid_at, paystub_storage_key: r.paystub_storage_key,
      event_count: r.event_count,
      period: {
        id: r.period_id, start_date: r.start_date, end_date: r.end_date,
        payday: r.payday, status: r.period_status,
      },
    })),
  });
}));

module.exports = router;
