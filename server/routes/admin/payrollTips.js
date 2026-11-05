/**
 * Admin tip-placement endpoints, sibling to payroll.js (which sits over the
 * soft cap; payrollTax.js set the extraction precedent): the unplaced-tip
 * list, PATCH /payroll/tips/:id/assign, and the deferred-tip list and retry.
 * Mounted from ./index.js; routes declare FULL paths under /api/admin.
 *
 * Auth: admin-only, matching the rest of payroll. Moved verbatim out of
 * payroll.js on 2026-11-05, when the assign route's guards (audit POUT-07 and
 * its verify pass, M2) took that file past the 1000-line ratchet.
 */
const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { AppError, NotFoundError, ValidationError, ConflictError } = require('../../utils/errors');
const { findOpenPeriodForDate } = require('../../utils/payrollProcessing');
const { payPeriodForDate, computePayday } = require('../../utils/payrollPeriods');
const { accruePayoutsForProposal } = require('../../utils/payrollAccrual');
const { rollForwardLateTip } = require('../../utils/payrollLateTip');
const { clawbackTip } = require('../../utils/payrollClawback');
const { retryDeferredTips, MAX_DEFER_ATTEMPTS } = require('../../utils/payrollDeferredRetry');
const { logAdminAction } = require('../../utils/adminAuditLog');
const { chicagoTodayYmd } = require('../../utils/businessTime');
const Sentry = require('@sentry/node');

const router = express.Router();

// pg returns DATE columns as JS Date objects. String(Date) yields
// "Fri May 29 2026 ..." which breaks both `.slice(0,10)` formatting and
// PG date casts downstream. Normalize to a YYYY-MM-DD string. A copy of
// payroll.js's ymd(), like staffPortal/payouts.js and payrollTax.js carry
// (audit POUT-13 deferred the shared helper).
function ymd(eventDate) {
  if (!eventDate) return null;
  if (eventDate instanceof Date) return eventDate.toISOString().slice(0, 10);
  return String(eventDate).slice(0, 10);
}

router.get('/payroll/unassigned-tips', auth, adminOnly, asyncHandler(async (req, res) => {
  // List recent unassigned tips. The dispatcher already retries matching, so
  // these are the genuine failures (no service window matched).
  const tipsRes = await pool.query(
    `SELECT t.id, t.target_user_id, t.amount_cents, t.tipped_at,
            COALESCE(cp.display_name, cp.preferred_name, u.email) AS contractor_name
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

  // Only an UNPLACED tip may be placed (audit 2026-11-05, POUT-07). A tip
  // already on a shift was summed into that shift's pool by accrual, or rolled
  // forward into a later period; placing it again sums it into a second pool
  // and pays it twice. A refunded tip has been clawed and must not be paid.
  // The list that feeds the screen shows only unplaced tips, but the route is
  // the gate (a stale tab, a replayed request, a script).
  const tipRes = await pool.query(
    `SELECT id, shift_id, rolled_forward_at, COALESCE(refunded_amount_cents, 0) AS refunded_amount_cents,
            amount_cents, target_user_id
       FROM tips WHERE id = $1`,
    [tipId]
  );
  const tip = tipRes.rows[0];
  if (!tip) throw new NotFoundError('tip not found');
  // A refund that landed while the tip was unplaced advanced the cumulative
  // marker without clawing anything (no line to claw from). A tip refunded
  // in full has nothing left to pay; a tip refunded in part is placed below
  // and the refunded cents are booked as a clawback at placement (verify
  // pass, M2: refusing it left the rest unpayable forever).
  const priorRefunded = Number(tip.refunded_amount_cents);
  const fullyRefunded = priorRefunded >= Number(tip.amount_cents);
  if (tip.shift_id !== null || tip.rolled_forward_at !== null || fullyRefunded) {
    throw new ConflictError('tip is already placed, rolled forward or refunded in full', 'TIP_ALREADY_PLACED');
  }
  // The recipient must have worked the target shift as an approved, non-dropped
  // bartender: accrual splits the shift's tip pool across exactly that set, so
  // a shift the recipient never worked pays their tip to other people. Same
  // predicate as the clawback's bartender set.
  const rosterRes = await pool.query(
    `SELECT 1 FROM shift_requests
      WHERE shift_id = $1 AND user_id = $2 AND status = 'approved' AND dropped_at IS NULL
        AND LOWER(TRIM(position)) = 'bartender'`,
    [shiftId, tip.target_user_id]
  );
  if (!rosterRes.rows[0]) {
    throw new AppError('the tip recipient is not an approved bartender on that shift', 422, 'RECIPIENT_NOT_ON_SHIFT');
  }

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

  // A partly refunded tip on a frozen event rolls its gross forward into
  // today's period and the claw nets into that same line right after, which
  // needs today's period open: a deferred roll-forward and a deferred claw
  // cannot both be remembered (one deferral marker per tip), so the placement
  // waits for the period instead. Resolved the way the roll-forward and the
  // clawback resolve it: the week's row is created open when it does not
  // exist yet (the first accrual of a week is what normally creates it, so a
  // Tuesday before any event has completed has no row at all), and only a
  // row that exists and is frozen refuses (round 3, M1: the bare lookup
  // answered 409 for a week with no row).
  if (priorRefunded > 0 && frozen) {
    const todayYmd = chicagoTodayYmd();
    let today = await findOpenPeriodForDate(pool, todayYmd);
    if (!today) {
      const { startDate, endDate } = payPeriodForDate(todayYmd);
      const payday = computePayday(endDate);
      const ins = await pool.query(
        `INSERT INTO pay_periods (start_date, end_date, payday, status)
         VALUES ($1, $2, $3, 'open')
         ON CONFLICT (start_date) DO UPDATE SET status = pay_periods.status
         RETURNING id, status`,
        [startDate, endDate, payday]
      );
      today = ins.rows[0];
    }
    if (today.status !== 'open') {
      throw new ConflictError(
        `the current pay period is ${today.status}; a partly refunded tip on a frozen event can be placed once it is open`,
        'PERIOD_NOT_OPEN'
      );
    }
  }

  // Assign the tip. The statement carries the same guards as the read above,
  // plus the refunded marker it read, so two admins placing one tip at once,
  // or a refund webhook landing in between, cannot both succeed. A partial
  // refund resets the cumulative marker to 0 in the same statement and writes
  // a clawback deferral for the refunded cents, so the claw booked right
  // below is replayed by the retry sweep should this process die first:
  // clawbackTip only ever moves the delta, so a concurrent webhook and the
  // replay converge on one claw.
  const updated = await pool.query(
    `UPDATE tips SET shift_id = $1,
            refunded_amount_cents = 0,
            deferred_at = CASE WHEN $3::int > 0 THEN NOW() ELSE deferred_at END,
            defer_kind = CASE WHEN $3::int > 0 THEN 'clawback' ELSE defer_kind END,
            defer_target_cents = CASE WHEN $3::int > 0 THEN $3::int ELSE defer_target_cents END,
            defer_attempts = CASE WHEN $3::int > 0 THEN 0 ELSE defer_attempts END
      WHERE id = $2 AND shift_id IS NULL AND rolled_forward_at IS NULL
        AND COALESCE(refunded_amount_cents, 0) = $3::int
      RETURNING id, shift_id, amount_cents, tipped_at`,
    [shiftId, tipId, priorRefunded]
  );
  if (!updated.rows[0]) {
    throw new ConflictError('tip was placed or refunded by another request; reload and try again', 'TIP_ALREADY_PLACED');
  }

  // The claw for the cents refunded before placement. clawbackTip takes its
  // own pooled connection; this handler holds none. Lands in the open period
  // containing today keyed by the shift (the clawback rule), netting into the
  // rolled-forward line on the frozen path; on the open path it precedes the
  // accrual, which never seeds hours from the stub it may leave.
  let refundClawedCents = 0;
  const bookRefundClaw = async () => {
    try {
      const claw = await clawbackTip(tipId, priorRefunded);
      if (claw && claw.period_id) {
        refundClawedCents = priorRefunded;
      } else {
        Sentry.captureMessage('tip_assign: refund claw deferred; the retry sweep replays it', {
          level: 'warning',
          tags: { route: 'tip_assign', step: 'refund_claw' },
          extra: { tipId, shiftId, priorRefunded },
        });
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { route: 'tip_assign', step: 'refund_claw' } });
    }
  };

  // On the open path the standard accrual refreshes the tip pool. On the
  // frozen path roll forward so the tip lands on a bartender payout next period.
  try {
    if (frozen) {
      const rolled = await rollForwardLateTip(tipId);
      if (priorRefunded > 0) {
        if (rolled && rolled.period_id) {
          await bookRefundClaw();
        } else {
          // The roll-forward did not land (deferred, or no payable bartender):
          // its own deferral now owns the marker, so the claw is not booked
          // here. Alerted by name for the admin to book by hand.
          Sentry.captureMessage('tip_assign: roll-forward did not land; the refund claw is not booked (book it by hand)', {
            level: 'warning',
            tags: { route: 'tip_assign', step: 'refund_claw_skipped' },
            extra: { tipId, shiftId, priorRefunded },
          });
        }
      }
    } else {
      if (priorRefunded > 0) await bookRefundClaw();
      if (proposalId) await accruePayoutsForProposal(proposalId);
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: 'tip_assign', step: frozen ? 'roll_forward' : 'reaccrue' },
    });
  }

  res.json({ tip: updated.rows[0], frozen_period: frozen, refund_clawed_cents: refundClawedCents });
}));

async function loadDeferredTips() {
  const { rows } = await pool.query(
    `SELECT t.id, t.defer_kind, t.amount_cents, t.defer_target_cents, t.deferred_at, t.defer_attempts,
            t.shift_id, s.event_date, p.event_type, p.event_type_custom,
            ARRAY(SELECT COALESCE(cp.display_name, cp.preferred_name, u.email)
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

// List tips deferred while the open pay period was frozen (with stuck-reason: `frozen_period`,
// `stubs`, or `max_attempts`).
router.get('/payroll/deferred-tips', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json({ tips: await loadDeferredTips() });
}));

// Manually run the deferred-tip sweep; audit-logged as `payroll_deferred_tips_retry` with the
// summary in `metadata`.
router.post('/payroll/deferred-tips/retry', auth, adminOnly, asyncHandler(async (req, res) => {
  const summary = await retryDeferredTips();
  // logAdminAction is best-effort and never throws (it self-routes failures to Sentry).
  await logAdminAction({ actorUserId: req.user.id, targetUserId: null,
    action: 'payroll_deferred_tips_retry', metadata: summary });
  res.json({ summary, tips: await loadDeferredTips() });
}));

module.exports = router;
