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
const { rollForwardLateTip } = require('../../utils/payrollLateTip');
const { retryDeferredTips, MAX_DEFER_ATTEMPTS } = require('../../utils/payrollDeferredRetry');
const { logAdminAction } = require('../../utils/adminAuditLog');
const { chicagoTodayYmd } = require('../../utils/businessTime');
const Sentry = require('@sentry/node');

const router = express.Router();

// Cheap liveness probe. Real endpoints follow in subsequent tasks.
router.get('/payroll/healthcheck', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json({ ok: true, ts: Date.now() });
}));

// Reusable: hydrate a period with its payouts and each payout's events.
async function loadPeriodWithPayouts(periodRow) {
  const payoutsRes = await pool.query(
    `SELECT po.id, po.contractor_id, po.status, po.total_cents,
            po.payment_method, po.payment_handle, po.payment_reference,
            po.paid_at, po.paystub_storage_key,
            COALESCE(cp.preferred_name, u.email) AS contractor_name,
            pp.preferred_payment_method, pp.venmo_handle, pp.cashapp_handle,
            pp.paypal_url, pp.zelle_handle
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
              pe.held_state,
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
            COUNT(po.id) FILTER (WHERE po.status = 'pending') AS pending_count,
            COALESCE(SUM(po.total_cents) FILTER (WHERE po.status = 'paid'), 0) AS paid_cents,
            COALESCE(SUM(po.total_cents) FILTER (WHERE po.status = 'pending'), 0) AS owed_cents
       FROM pay_periods pp
  LEFT JOIN payouts po ON po.pay_period_id = pp.id
   GROUP BY pp.id
   ORDER BY pp.start_date DESC`
  );
  res.json({ periods: rows });
}));

router.get('/payroll/periods/current', auth, adminOnly, asyncHandler(async (req, res) => {
  // Today in the business timezone (America/Chicago), then fall back to the most
  // recent open period if today is not inside any open one (e.g., between the
  // freeze of one period and the accrual of the first event in the next). Using
  // the Chicago day (not the server's UTC/GMT day) keeps a late-evening admin
  // load on the current Tue-Mon period instead of jumping to next week's.
  const todayYmd = chicagoTodayYmd();
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
const ALLOWED_PAY_METHODS = new Set(['venmo', 'cashapp', 'paypal', 'zelle', 'check', 'direct_deposit', 'other']);

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
        FOR UPDATE OF pe, po, pp`,
      [eventId]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('payout_event not found');
    }
    const row = rows[0];
    // 'processing' is also frozen: mark-paid copies the stored total_cents, so an
    // edit during processing would make the recorded payout differ from what was
    // sent.
    if (
      row.payout_status === 'paid'
      || row.period_status === 'paid'
      || row.period_status === 'processing'
    ) {
      await client.query('ROLLBACK');
      throw new ConflictError('payout or period is paid or processing; edits are frozen');
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
    // No line-level floor (H1): editing a synthetic clawback line (negative
    // adjustment, zero hours) must not re-floor its debt to 0. The payout-level
    // recompute clamps the payable total at 0.
    const lineTotal =
      wage + Number(row.gratuity_share_cents) + Number(row.card_tip_net_cents) + next.adjustment_cents;
    // Held-reimbursement re-arm (fix #4): this recompute already makes a held
    // line payable again (line_total = wage + gratuity + card_tip + adjustment),
    // so any admin PATCH on a 'held' line IS the confirmation. Flip it to
    // 'confirmed' in the same UPDATE — a structural state the accrual sweeps
    // respect (never re-held), sticky regardless of later note edits.
    const nextHeldState = row.held_state === 'held' ? 'confirmed' : row.held_state;

    await client.query(
      `UPDATE payout_events
          SET hours = $1, rate_cents = $2, late = $3,
              adjustment_cents = $4, adjustment_note = $5,
              wage_cents = $6, line_total_cents = $7, held_state = $8
        WHERE id = $9`,
      [next.hours, next.rate_cents, next.late,
       next.adjustment_cents, next.adjustment_note,
       wage, lineTotal, nextHeldState, eventId]
    );
    const payoutTotal = await recomputePayoutTotal(client, row.payout_id);
    await client.query('COMMIT');

    // Post-COMMIT refresh on the client we already hold: pool.query() would take a
    // SECOND pooled connection while this one is still checked out (released in the
    // finally below). One connection per request, connect to release.
    const refreshed = await client.query(
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

// Card tips matched into THIS period's payouts whose Stripe fee was unavailable
// at accrual (fee_cents NULL). Accrual COALESCEs a null fee to 0, so these lines
// pay GROSS and the business silently eats the fee. Returns one row per such tip
// with the proposal it belongs to. Scoped through payout_events so only tips that
// actually landed on a payout in this period are considered.
async function nullFeeTipsForPeriod(periodId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT t.id AS tip_id, s.proposal_id
       FROM tips t
       JOIN payout_events pe ON pe.shift_id = t.shift_id
       JOIN payouts po ON po.id = pe.payout_id
       JOIN shifts s ON s.id = t.shift_id
      WHERE po.pay_period_id = $1
        AND t.fee_cents IS NULL
        AND t.stripe_payment_intent_id IS NOT NULL`,
    [periodId]
  );
  return rows;
}

// L5: before a period is frozen for processing, heal any tip whose Stripe fee
// was unavailable at accrual. Re-capture the fee and re-accrue the affected
// proposals so the captured fee flows into the payout lines (accrual itself calls
// captureTipFeesForProposal before recomputing). Best-effort and self-contained:
// a Stripe outage must never blockade payroll, so anything still null after the
// retry is warned and left to pay gross. Returns a small summary for observability.
async function recaptureNullTipFeesForPeriod(periodId) {
  const before = await nullFeeTipsForPeriod(periodId);
  const proposalIds = [...new Set(before.map(r => r.proposal_id).filter(Boolean))];
  // Proposals whose own pay period is frozen: accrual captures the tip's fee
  // (fee capture runs before the period check) but SKIPS the payout rewrite,
  // so a late-tip ROLL-FORWARD line in THIS period still pays gross. Those
  // tips must not be reported as healed just because fee_cents went non-null.
  const frozenProposals = new Set();
  for (const proposalId of proposalIds) {
    try {
      const res = await accruePayoutsForProposal(proposalId);
      if (res && res.skipped && res.reason === 'pay_period_not_open') {
        frozenProposals.add(proposalId);
      }
    } catch (err) {
      Sentry.captureException(err, {
        tags: { route: 'payroll_process', step: 'fee_recapture_reaccrue' },
        extra: { periodId, proposalId },
      });
    }
  }
  const lineUnhealed = before.filter(r => frozenProposals.has(r.proposal_id));
  if (lineUnhealed.length) {
    Sentry.captureMessage(
      'payroll process: fee captured but roll-forward line still pays gross (origin period frozen); adjust manually',
      {
        level: 'warning',
        tags: { route: 'payroll_process', step: 'fee_recapture_line_unhealed' },
        extra: {
          periodId,
          tip_ids: lineUnhealed.map(r => r.tip_id),
          proposal_ids: [...frozenProposals],
        },
      }
    );
  }
  const after = proposalIds.length ? await nullFeeTipsForPeriod(periodId) : before;
  if (after.length) {
    Sentry.captureMessage(
      'payroll process: tips still missing a Stripe fee after recapture; proceeding (pays gross)',
      {
        level: 'warning',
        tags: { route: 'payroll_process', step: 'fee_recapture_residual' },
        extra: {
          periodId,
          tip_ids: after.map(r => r.tip_id),
          proposal_ids: [...new Set(after.map(r => r.proposal_id).filter(Boolean))],
        },
      }
    );
  }
  return {
    tips_null_before: before.length,
    proposals_reaccrued: proposalIds.length,
    tips_null_after: after.length,
    tips_line_unhealed: lineUnhealed.length,
  };
}

router.post('/payroll/periods/:id/process', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new NotFoundError('Period not found');

  // Confirm the period is processable before any fee-recapture work; keeps the
  // same 404/409 semantics and avoids Stripe calls for a period that cannot be
  // flipped. 'reopened' re-processes after an "I fucked up" line fix.
  const periodRes = await pool.query('SELECT status, end_date FROM pay_periods WHERE id = $1', [id]);
  if (!periodRes.rows[0]) throw new NotFoundError('Period not found');
  if (periodRes.rows[0].status !== 'open' && periodRes.rows[0].status !== 'reopened') {
    throw new ConflictError(`Period is ${periodRes.rows[0].status}, not processable`);
  }
  // Processing a period whose week has not ended silently blackholes wages:
  // events completing later that week accrue nothing (accrual's
  // pay_period_not_open skip has no retry and no marker). Require an explicit
  // force from the confirm dialog.
  if (ymd(periodRes.rows[0].end_date) >= chicagoTodayYmd() && req.body?.force !== true) {
    throw new ConflictError('period is still in progress; pass force to process anyway');
  }

  // L5: heal gross-paying tips (null Stripe fee) BEFORE freezing the period.
  // On a re-process from 'reopened' the re-accrue step is refused by accrual
  // (pay_period_not_open), so affected lines stay gross and the existing
  // fee_recapture_line_unhealed Sentry warning fires; that is what protects
  // already-paid gross payouts from being silently rewritten.
  const feeRecapture = await recaptureNullTipFeesForPeriod(id);

  const { rows } = await pool.query(
    `UPDATE pay_periods SET status = 'processing'
      WHERE id = $1 AND status IN ('open', 'reopened')
      RETURNING id, start_date, end_date, payday, status`,
    [id]
  );
  if (!rows[0]) {
    // Lost a race: another request flipped the period between our check and here.
    const existing = await pool.query(
      'SELECT status FROM pay_periods WHERE id = $1', [id]
    );
    if (!existing.rows[0]) throw new NotFoundError('Period not found');
    throw new ConflictError(`Period is ${existing.rows[0].status}, not processable`);
  }
  // A period with zero pending payouts (all paid pre-reopen, or none at all)
  // finalizes immediately; mark-paid can never run on it, so this is the only
  // place the flip can happen. The response reflects the outcome so the client
  // drops the card instead of stranding a phantom processing period.
  const finalized = await maybeFinalizePeriod(pool, id);
  if (finalized) {
    rows[0].status = 'paid'; // keep the embedded period object consistent with period_status
    Sentry.addBreadcrumb({
      category: 'payroll',
      message: 'process_finalized_immediately',
      data: { period_id: id },
    });
  }
  res.json({
    period: rows[0],
    period_status: finalized ? 'paid' : 'processing',
    fee_recapture: feeRecapture,
  });
}));

router.post('/payroll/periods/:id/reopen', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new NotFoundError('Period not found');

  // The "I fucked up" path: flip processing -> 'reopened' (NEVER back to
  // 'open'). Every payroll money writer freezes on status !== 'open', so
  // 'reopened' is inert to accrual / late-tip / clawback / fee recapture for
  // free, while PATCH line edits (which block only paid/processing) come back
  // for PENDING payouts. Paid payouts stay locked by their own status checks.
  // Race safety: mark-paid holds FOR UPDATE OF po, pp until COMMIT with
  // maybeFinalizePeriod inside that transaction, so this single guarded UPDATE
  // serializes behind a concurrent final mark-paid + finalize and re-evaluates
  // to zero rows (409). Do not "improve" this into check-then-act.
  const { rows } = await pool.query(
    `UPDATE pay_periods SET status = 'reopened'
      WHERE id = $1 AND status = 'processing'
      RETURNING id, start_date, end_date, payday, status`,
    [id]
  );
  if (!rows[0]) {
    const existing = await pool.query('SELECT status FROM pay_periods WHERE id = $1', [id]);
    if (!existing.rows[0]) throw new NotFoundError('Period not found');
    throw new ConflictError(`Period is ${existing.rows[0].status}, not processing`);
  }

  const counts = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'paid') AS paid,
            COUNT(*) FILTER (WHERE status = 'pending') AS pending
       FROM payouts WHERE pay_period_id = $1`,
    [id]
  );
  // logAdminAction is best-effort and never throws (it self-routes failures to Sentry).
  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: 'payroll_period_reopen',
    metadata: {
      period_id: id,
      paid_count: Number(counts.rows[0].paid),
      pending_count: Number(counts.rows[0].pending),
    },
  });
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
  const prRaw = req.body && req.body.payment_reference;
  // Whitespace-only collapses to NULL, never an empty string in the column.
  const reference = (prRaw !== null && prRaw !== undefined) ? (String(prRaw).trim() || null) : null;
  if (reference !== null && reference.length > 200) {
    throw new ValidationError(null, 'payment_reference exceeds 200 chars');
  }
  // Drift guard: the pay panel locks the payout total when it generates the
  // QR/link and sends it back here. Presence check is strict (!== undefined):
  // a $0 payout total is a designed state under the H1 debt clamp, so no
  // truthiness shortcuts.
  const expectedTotal = req.body ? req.body.expected_total_cents : undefined;
  if (expectedTotal !== undefined && (!Number.isInteger(expectedTotal) || expectedTotal < 0)) {
    throw new ValidationError(null, 'expected_total_cents must be a non-negative integer');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT po.id, po.status AS payout_status, po.pay_period_id,
              po.total_cents, pp.status AS period_status
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
    // Compare against total_cents read under the same row lock: a reopen +
    // line edit in another tab between generate and this click can never be
    // recorded at the stale amount. No amounts in the breadcrumb.
    if (expectedTotal !== undefined && Number(rows[0].total_cents) !== expectedTotal) {
      await client.query('ROLLBACK');
      Sentry.addBreadcrumb({
        category: 'payroll',
        message: 'mark_paid_drift_409',
        data: { payout_id: id },
      });
      throw new ConflictError('payout total changed since the code was generated; regenerate');
    }
    if (expectedTotal === undefined) {
      // Scripted/legacy mark-paids skip the drift guard; keep them visible.
      Sentry.addBreadcrumb({
        category: 'payroll',
        message: 'mark_paid_without_expected_total',
        data: { payout_id: id },
      });
    }

    await client.query(
      `UPDATE payouts
          SET status = 'paid', payment_method = $1, payment_handle = $2,
              payment_reference = $3, paid_at = NOW(), paid_by = $4
        WHERE id = $5`,
      [method, handle, reference, req.user.id, id]
    );

    const finalized = await maybeFinalizePeriod(client, rows[0].pay_period_id);
    await client.query('COMMIT');

    // Post-COMMIT refresh on the client we already hold — see the note above.
    const refreshed = await client.query(
      `SELECT id, contractor_id, status, total_cents,
              payment_method, payment_handle, payment_reference,
              paid_at, paystub_storage_key
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
        AND sr.dropped_at IS NULL
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

  // On the open path the standard accrual refreshes the tip pool. On the
  // frozen path roll forward so the tip lands on a bartender payout next period.
  try {
    if (frozen) {
      await rollForwardLateTip(tipId);
    } else if (proposalId) {
      await accruePayoutsForProposal(proposalId);
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: 'tip_assign', step: frozen ? 'roll_forward' : 'reaccrue' },
    });
  }

  res.json({ tip: updated.rows[0], frozen_period: frozen });
}));

async function loadDeferredTips() {
  const { rows } = await pool.query(
    `SELECT t.id, t.defer_kind, t.amount_cents, t.defer_target_cents, t.deferred_at, t.defer_attempts,
            t.shift_id, s.event_date, p.event_type, p.event_type_custom,
            ARRAY(SELECT COALESCE(cp.preferred_name, u.email)
                    FROM shift_requests sr
                    JOIN users u ON u.id = sr.user_id
               LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
                   WHERE sr.shift_id = t.shift_id AND sr.status = 'approved'
                     AND sr.dropped_at IS NULL AND LOWER(TRIM(sr.position)) = 'bartender'
                   ORDER BY u.id) AS staff,
            ARRAY(SELECT u.id
                    FROM shift_requests sr
                    JOIN users u ON u.id = sr.user_id
               LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
                   WHERE sr.shift_id = t.shift_id AND sr.status = 'approved'
                     AND sr.dropped_at IS NULL AND LOWER(TRIM(sr.position)) = 'bartender'
                   ORDER BY u.id) AS staff_ids,
            (t.shift_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM shift_requests sr2 JOIN users u2 ON u2.id = sr2.user_id
                          WHERE sr2.shift_id = t.shift_id AND sr2.status = 'approved'
                            AND sr2.dropped_at IS NULL AND LOWER(TRIM(sr2.position)) = 'bartender')
             AND NOT EXISTS (SELECT 1 FROM shift_requests sr3 JOIN users u3 ON u3.id = sr3.user_id
                              WHERE sr3.shift_id = t.shift_id AND sr3.status = 'approved'
                                AND sr3.dropped_at IS NULL AND LOWER(TRIM(sr3.position)) = 'bartender'
                                AND u3.cc_id NOT LIKE 'legacy_cc:%')) AS all_stubs
       FROM tips t
  LEFT JOIN shifts s ON s.id = t.shift_id
  LEFT JOIN proposals p ON p.id = s.proposal_id
      WHERE t.deferred_at IS NOT NULL
      ORDER BY t.deferred_at ASC`
  );
  return rows.map(t => ({
    ...t,
    // 'stubs' = every approved bartender on the shift is a legacy_cc stub (Retry can't help;
    // a de-stub is needed). 'max_attempts' = stuck past the auto-retry cap (stays on the list,
    // dropped from auto-retry). Else: waiting for a period to open.
    stuck_reason: t.all_stubs ? 'stubs'
      : (t.defer_attempts >= MAX_DEFER_ATTEMPTS ? 'max_attempts' : 'frozen_period'),
  }));
}

router.get('/payroll/deferred-tips', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json({ tips: await loadDeferredTips() });
}));

router.post('/payroll/deferred-tips/retry', auth, adminOnly, asyncHandler(async (req, res) => {
  const summary = await retryDeferredTips();
  // logAdminAction is best-effort and never throws (it self-routes failures to Sentry).
  await logAdminAction({ actorUserId: req.user.id, targetUserId: null,
    action: 'payroll_deferred_tips_retry', metadata: summary });
  res.json({ summary, tips: await loadDeferredTips() });
}));

router.get('/payroll/contractors/:userId/payouts', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) throw new ValidationError(null, 'invalid userId');
  const { rows } = await pool.query(
    `SELECT po.id, po.status, po.total_cents,
            po.payment_method, po.payment_handle, po.payment_reference,
            po.paid_at, po.paystub_storage_key,
            pp.id AS period_id, pp.start_date, pp.end_date, pp.payday, pp.status AS period_status,
            COALESCE(ec.event_count, 0) AS event_count
       FROM payouts po
       JOIN pay_periods pp ON pp.id = po.pay_period_id
       LEFT JOIN (
         SELECT payout_id, COUNT(*) AS event_count
           FROM payout_events
          GROUP BY payout_id
       ) ec ON ec.payout_id = po.id
      WHERE po.contractor_id = $1
      ORDER BY pp.start_date DESC`,
    [userId]
  );
  res.json({
    payouts: rows.map(r => ({
      id: r.id, status: r.status, total_cents: r.total_cents,
      payment_method: r.payment_method, payment_handle: r.payment_handle,
      payment_reference: r.payment_reference,
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
