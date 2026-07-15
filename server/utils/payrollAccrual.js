/**
 * Accrue payout records for a completed event. Idempotent: re-running
 * recomputes the system-owned money fields rather than duplicating rows,
 * and never clobbers an admin's edits to hours, rate, late, or adjustments.
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { payPeriodForDate, computePayday } = require('./payrollPeriods');
const {
  contractedHours, wageCents, splitEvenly,
  extractGratuityCents, proRataFeeCents,
} = require('./payrollMath');
const { captureProposalPaymentFees, captureTipFeesForProposal } = require('./payrollTips');
const { isLegacyCcParticipant } = require('./payrollGuards');
const { isBartender } = require('./staffingRoles');
const { readSnapshot } = require('./pricingSnapshot');

// Invoice labels whose dollars are part of the contract total_price. Canonical
// definition lives in ./proposalMoneyShared (shared with refundHelpers.js
// applyRefundReconciliation — same classification, same reason).
const { CONTRACT_LABELS } = require('./proposalMoneyShared');

// HOLD semantics for the roster sweeps (fix #4, 2026-07-13; reworked to
// structural state after review; extended to negative-adjustment wage lines
// 2026-07-14, B13). When a roster sweep finds an off-roster worker's line, its
// treatment keys on the STRUCTURE of the line, never on adjustment provenance.
// The one system invariant shared with the clawback/late-tip upserts is:
//
//   held row => line_total_cents = payable components + LEAST(adjustment_cents, 0)
//
// Two structurally different rows are HELD, because in both cases the payable
// components must stop paying (worker off roster) while the adjustment must be
// preserved for the admin decision:
//   (a) a POSITIVE reimbursement (entered by hand, confirmed at payroll) — a
//       missed roster flag must never silently auto-pay one; and
//   (b) a real wage line whose adjustment_cents went NEGATIVE (an admin dock via
//       the payout-event PATCH, or a same-period clawback merged into the wage
//       line via the ON CONFLICT arm) — dropping it is either an H1 re-leak or a
//       silently forgiven dock.
// The hold zeroes hours + every payable component (wage/gratuity/card-tip
// gross+fee+net) and sets line_total_cents = LEAST(adjustment_cents, 0). For a
// positive hold LEAST = 0, so the line is non-payable exactly as before the B13
// change. For a negative hold the debt stays inside line_total, so it keeps
// collecting through the payout-level GREATEST(0, SUM(line_total)) clamp and the
// sign-scoped paystub/portal readers keep footing against the payout total.
// adjustment_cents stays the tracked number and the note is NOT touched: hold
// semantics live in the column, never in admin-editable free text (the
// review-caught failure: an admin cleaning a marker note disarmed the old
// idempotency guard and the next accrual re-zeroed a confirmed reimbursement).
//
// Pure clawback debt stubs (all payables zero, negative adjustment: the
// payrollClawback INSERT shape) are NOT held and NOT deleted; they survive
// verbatim (H1: the tip's refunded_amount_cents marker has already advanced, so
// destroying the debt line permanently un-collects it).
//
// Lifecycle: NULL -> 'held' (sweep) -> 'confirmed' (admin PATCH re-arms
// line_total; see routes/admin/payroll.js) -> NULL (worker rejoins the roster;
// the worker loop below re-seeds hours from contracted and clears the state).
// Sweeps never re-touch 'held' rows and NEVER re-hold 'confirmed' rows: the
// admin explicitly decided the off-roster line's fate, and that decision is
// sticky regardless of note edits or re-accruals.
//
// Zeroing hours is load-bearing: the PATCH recomputes wage = hours x rate, and a
// surviving non-zero hours would resurrect wage for a worker who was removed
// from the roster. Zero-adjustment orphan lines (no payable to preserve, no debt
// to keep) are still deleted.

// Hold the given payout_event lines (by id). Only lines with held_state IS NULL
// are touched, so a re-accrual never re-zeroes a held line's tracked adjustment
// nor an admin's confirmed reimbursement. line_total_cents becomes
// LEAST(adjustment_cents, 0): 0 for a positive (reimbursement) hold, the
// negative debt itself for a negative (docked/clawed) hold, so the debt keeps
// collecting through the payout-level clamp. Returns the distinct payout ids
// actually held this call (for the caller's recompute set).
async function holdReimbursementLines(client, eventIds) {
  if (!eventIds.length) return [];
  const { rows } = await client.query(
    `UPDATE payout_events
        SET held_state = 'held',
            hours = 0, wage_cents = 0, gratuity_share_cents = 0,
            card_tip_gross_cents = 0, card_tip_fee_cents = 0, card_tip_net_cents = 0,
            line_total_cents = LEAST(payout_events.adjustment_cents, 0)
      WHERE id = ANY($1)
        AND held_state IS NULL
      RETURNING payout_id`,
    [eventIds]
  );
  return [...new Set(rows.map(r => r.payout_id))];
}

// Safe calendar date of a pg DATE value as 'YYYY-MM-DD'. node-postgres parses
// a DATE at local midnight, so .toISOString() drifts the day on positive-offset
// servers; read the local components instead. Mirrors toCalendarYmd in
// preEventScheduling.js.
function toCalendarYmd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * Ensure the pay_periods row for an event date exists; return { id, status }.
 * Runs on the caller's transaction client. `end_date` and `payday` are pure
 * functions of `start_date`, so the ON CONFLICT update is a no-op write whose
 * only job is to make RETURNING fire for an already-existing row.
 */
async function ensurePayPeriod(client, eventDate) {
  const { startDate, endDate } = payPeriodForDate(eventDate);
  const payday = computePayday(endDate);
  const { rows } = await client.query(
    `INSERT INTO pay_periods (start_date, end_date, payday)
     VALUES ($1, $2, $3)
     ON CONFLICT (start_date) DO UPDATE SET
       end_date = EXCLUDED.end_date,
       payday = EXCLUDED.payday
     RETURNING id, status`,
    [startDate, endDate, payday]
  );
  return rows[0];
}

/**
 * Compute and upsert payout_events (and their parent payouts) for every
 * contractor who worked the given proposal's event. Safe to call repeatedly.
 */
async function accruePayoutsForProposal(proposalId) {
  const propRes = await pool.query(
    `SELECT id, event_date, status, event_duration_hours, total_price, amount_paid, pricing_snapshot
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal || !proposal.event_date) {
    return { skipped: true, reason: 'proposal_missing_or_no_event_date' };
  }
  // Accrual is for completed events only, so it is a safe no-op when called
  // before the event has run (e.g. defensively from elsewhere).
  if (proposal.status !== 'completed') {
    return { skipped: true, reason: 'not_completed', status: proposal.status };
  }
  // cc-import: never accrue payouts for an event where any participating
  // bartender is a legacy CC stub. Fires BEFORE any DB writes — we never want
  // to INSERT into payouts referencing a stub user (we cannot pay them
  // through Stripe Connect anyway). See specs/2026-05-25-checkcherry-import-design.md.
  if (await isLegacyCcParticipant(proposalId)) {
    // Surface to Sentry at info so the cc-import review queue can show
    // "needs operator action" alongside the late-tip / clawback stub-skips
    // (sibling pattern in payrollLateTip.js and payrollClawback.js).
    Sentry.captureMessage(
      `payrollAccrual: skipping proposal with legacy CC stub participant`,
      {
        level: 'info',
        tags: { component: 'payrollAccrual', reason: 'legacy_cc_stub_participant' },
        extra: { proposalId },
      }
    );
    return { skipped: true, reason: 'legacy_cc_stub_participant' };
  }
  const eventDate = toCalendarYmd(proposal.event_date);

  // Capture any missing Stripe fees BEFORE opening the transaction: these are
  // network calls and must not hold a DB transaction open. Best-effort — if
  // Stripe is unreachable, accrue with the fees already on record and let a
  // later re-accrual backfill. A Stripe outage must never block payroll.
  try {
    await captureProposalPaymentFees(proposalId);
    await captureTipFeesForProposal(proposalId);
  } catch (err) {
    Sentry.captureException(err);
  }

  let payoutsCreatedCount = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const payPeriod = await ensurePayPeriod(client, eventDate);
    // Never write into a frozen period. Once Phase 2 introduces processing/paid
    // periods, a late accrual into a closed period would corrupt settled
    // payroll; rolling it into the open period is a Phase 2 concern.
    if (payPeriod.status !== 'open') {
      await client.query('COMMIT');
      // Observability only (payroll-redesign spec, the one accrual exception):
      // this skip is silent success to every caller, and wages, unlike tips,
      // have no deferral marker to retry from.
      Sentry.captureMessage('accrual skipped: pay period not open', {
        level: 'warning',
        tags: { route: 'payroll_accrual', step: 'pay_period_not_open_skip' },
        extra: { proposalId, pay_period_status: payPeriod.status },
      });
      return { skipped: true, reason: 'pay_period_not_open', pay_period_status: payPeriod.status };
    }
    const payPeriodId = payPeriod.id;

    // Everyone who worked this event, with their shift, position, and rate.
    // ORDER BY user_id makes the even-split remainder distribution deterministic.
    const workers = await client.query(
      `SELECT sr.user_id, sr.position, s.id AS shift_id,
              COALESCE(cp.hourly_rate, 20.00) AS hourly_rate
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
       WHERE s.proposal_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL
       ORDER BY sr.user_id`,
      [proposalId]
    );
    if (!workers.rows.length) {
      // Nobody left on this event's roster. Prior accruals may have left payable
      // lines for this proposal in the open period; the main roster-correction
      // sweep below is unreachable from here, so sweep inline. Positive
      // reimbursements AND negative-adjustment wage lines WITH payables are HELD
      // (kept + tracked, zeroed to non-payable, line_total = LEAST(adj,0));
      // zero-adjustment lines are deleted; pure negative clawback debt stubs (no
      // payables) are preserved untouched (H1). Same structural discriminator as
      // the main orphan sweep below. Removing the LAST worker is the common
      // single-bartender case.
      const holdCandidates = await client.query(
        `SELECT pe.id
           FROM payout_events pe
           JOIN payouts po ON po.id = pe.payout_id
           JOIN shifts s ON s.id = pe.shift_id
          WHERE s.proposal_id = $1 AND po.pay_period_id = $2
            AND pe.held_state IS NULL
            AND (pe.adjustment_cents > 0
                 OR (pe.adjustment_cents < 0
                     AND (pe.wage_cents > 0 OR pe.gratuity_share_cents > 0
                          OR pe.card_tip_net_cents <> 0 OR pe.hours > 0)))`,
        [proposalId, payPeriodId]
      );
      const heldPayoutIds = await holdReimbursementLines(
        client, holdCandidates.rows.map(r => r.id)
      );
      const swept = await client.query(
        `DELETE FROM payout_events pe
          USING payouts po, shifts s
          WHERE pe.payout_id = po.id AND pe.shift_id = s.id
            AND s.proposal_id = $1 AND po.pay_period_id = $2
            AND COALESCE(pe.adjustment_cents, 0) = 0
          RETURNING pe.payout_id, po.contractor_id, pe.shift_id, pe.adjustment_cents, pe.adjustment_note`,
        [proposalId, payPeriodId]
      );
      if (swept.rowCount || heldPayoutIds.length) {
        const affectedPayoutIds = [...new Set([
          ...swept.rows.map(r => r.payout_id),
          ...heldPayoutIds,
        ])];
        // A held line keeps its payout non-empty; only a payout emptied of every
        // line is a phantom pending stub to delete.
        await client.query(
          `DELETE FROM payouts po
            WHERE po.id = ANY($1) AND po.status = 'pending'
              AND NOT EXISTS (SELECT 1 FROM payout_events WHERE payout_id = po.id)`,
          [affectedPayoutIds]
        );
        await client.query(
          `UPDATE payouts po SET total_cents = GREATEST(0, COALESCE((
             SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
           ), 0))
           WHERE po.id = ANY($1)`,
          [affectedPayoutIds]
        );
        Sentry.captureMessage('payrollAccrual: roster emptied; swept remaining payable lines', {
          level: 'warning',
          tags: { component: 'payrollAccrual', reason: 'empty_roster_sweep' },
          extra: {
            proposalId, payPeriodId, preserved: true,
            deleted: swept.rows, held_payout_ids: heldPayoutIds,
          },
        });
      }
      await client.query('COMMIT');
      return {
        skipped: true, reason: 'no_approved_workers',
        swept: swept.rowCount, held: heldPayoutIds.length,
      };
    }

    // Bartenders share gratuity and card tips; barbacks/servers do not.
    // Case-insensitive: production seeds the position as 'Bartender'.
    // Route through the canonical isBartender helper so a position with
    // stray whitespace still counts (it trims before comparing).
    const bartenders = workers.rows.filter(w => isBartender(w.position));

    // Gratuity pool, net of the card fee. Per spec section 4.2 the fee
    // denominator is the proposal's full contracted price (proposals.total_price),
    // of which the gratuity is always a part — so the ratio cannot exceed 1.
    // Funded-gratuity-accrual gate (§8): the gratuity pool only accrues when the
    // proposal is paid in full. Wages are NEVER gated (staff worked → staff paid).
    // Covers BOTH the auto-complete and manual (lifecycle.js) completion paths —
    // both funnel through this function.
    const proposalTotalCents = Math.round(Number(proposal.total_price || 0) * 100);
    const proposalPaidCents = Math.round(Number(proposal.amount_paid || 0) * 100);
    const gratuityFunded = proposalPaidCents >= proposalTotalCents;
    const grossGratuity = gratuityFunded
      ? extractGratuityCents(readSnapshot(proposal.pricing_snapshot, { context: 'payrollAccrual' }))
      : 0;
    // Fee numerator (seam-sweep M4, decided 2026-07-02: exact pro-ration): only
    // fees on dollars INSIDE the total_price denominator may net against the
    // gratuity. Extra charges (Additional Services invoices, drink-plan extras)
    // sit outside total_price, so their card fees were over-netting the pool
    // and underpaying staff. Classification is link-driven: a payment's fee
    // counts by the share of it that landed on CONTRACT invoices; linkless
    // payments fall back to payment_type (deposit/balance/full = contract).
    // Any misclassification errs toward staff (less netting), never toward
    // the business keeping gratuity.
    const feeRes = await client.query(
      `SELECT COALESCE(SUM(
         CASE
           WHEN links.linked_cents > 0 THEN
             LEAST(pp.fee_cents,
               ROUND(pp.fee_cents * LEAST(pp.amount,
                 links.contract_cents
                 + CASE WHEN pp.payment_type IN ('deposit', 'balance', 'full')
                        THEN GREATEST(0, pp.amount - links.linked_cents) ELSE 0 END
               )::numeric / NULLIF(pp.amount, 0)))
           WHEN pp.payment_type IN ('deposit', 'balance', 'full') THEN pp.fee_cents
           ELSE 0
         END), 0) AS fee
       FROM proposal_payments pp
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(ip.amount), 0) AS linked_cents,
                COALESCE(SUM(ip.amount) FILTER (WHERE i.label = ANY($2)), 0) AS contract_cents
           FROM invoice_payments ip
           JOIN invoices i ON i.id = ip.invoice_id
          WHERE ip.payment_id = pp.id AND ip.amount > 0
       ) links ON TRUE
       WHERE pp.proposal_id = $1 AND pp.status = 'succeeded'`,
      [proposalId, CONTRACT_LABELS]
    );
    const gratuityFee = proRataFeeCents(
      grossGratuity, proposalTotalCents, Number(feeRes.rows[0].fee)
    );
    const netGratuity = Math.max(0, grossGratuity - gratuityFee);

    // Card-tip pools (gross and fee) from tips matched to this event's shifts.
    const tipRes = await client.query(
      `SELECT COALESCE(SUM(t.amount_cents), 0) AS gross,
              COALESCE(SUM(t.fee_cents), 0) AS fee
       FROM tips t JOIN shifts s ON s.id = t.shift_id
       WHERE s.proposal_id = $1`,
      [proposalId]
    );
    const tipGross = Number(tipRes.rows[0].gross);
    const tipFee = Number(tipRes.rows[0].fee);

    const n = bartenders.length;
    const gratuityShares = splitEvenly(netGratuity, n);
    const tipGrossShares = splitEvenly(tipGross, n);
    const tipFeeShares = splitEvenly(tipFee, n);
    const bartenderShare = {};
    bartenders.forEach((b, i) => {
      bartenderShare[b.user_id] = {
        gratuity: gratuityShares[i],
        tipGross: tipGrossShares[i],
        tipFee: tipFeeShares[i],
      };
    });

    // Existing line items for this event, keyed by contractor+shift, so a
    // re-accrual preserves admin edits (hours, rate, late, adjustment) and
    // recomputes only the system-owned money fields. pay_period_id is carried so
    // the roster-correction sweep below can scope its deletes to THIS open period.
    const existingRes = await client.query(
      `SELECT pe.*, po.contractor_id, po.pay_period_id
       FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
       JOIN shifts s ON s.id = pe.shift_id
       WHERE s.proposal_id = $1`,
      [proposalId]
    );
    const existing = new Map(
      existingRes.rows.map(r => [`${r.contractor_id}:${r.shift_id}`, r])
    );

    const touchedPayoutIds = new Set();

    for (const w of workers.rows) {
      const prior = existing.get(`${w.user_id}:${w.shift_id}`);
      // A held/confirmed prior line belongs to a worker who was off the roster
      // and is now BACK on it. Its hours=0 came from the hold, not from an
      // admin — treating them as admin-owned would silently accrue wage = 0
      // for a worker who is actually working (the review-caught defect). Re-seed
      // hours from contracted exactly as a first accrual would, and clear the
      // held state below (the upsert writes held_state = NULL); the tracked
      // adjustment and note ride along untouched.
      const priorHeld = !!(prior && prior.held_state);
      // First accrual seeds contracted_hours/hours/rate from the contract;
      // afterwards the admin owns them, so re-accrual preserves the prior row.
      const contractedHrs = prior
        ? Number(prior.contracted_hours)
        : contractedHours(Number(proposal.event_duration_hours) || 0);
      const hours = prior && !priorHeld ? Number(prior.hours) : contractedHrs;
      const rateCents = prior
        ? Number(prior.rate_cents)
        : Math.round(Number(w.hourly_rate) * 100);
      const late = prior ? prior.late : false;
      const adjustment = prior ? Number(prior.adjustment_cents) : 0;
      const adjustmentNote = prior ? prior.adjustment_note : null;

      // All money is computed here, in JS, and written identically on INSERT
      // and on UPDATE — the two paths can never disagree.
      const wage = wageCents(hours, rateCents);
      const share = bartenderShare[w.user_id] || { gratuity: 0, tipGross: 0, tipFee: 0 };
      const tipNet = share.tipGross - share.tipFee;
      // No line-level floor (H1): a same-period clawback merged into this line
      // may legitimately exceed the line's earnings; flooring here would drop
      // the excess debt on re-accrual. The payout-level recompute clamps at 0.
      const lineTotal = wage + share.gratuity + tipNet + adjustment;

      // Upsert the contractor's payout for this period.
      const payoutRes = await client.query(
        `INSERT INTO payouts (pay_period_id, contractor_id)
         VALUES ($1, $2)
         ON CONFLICT (pay_period_id, contractor_id) DO UPDATE
           SET pay_period_id = EXCLUDED.pay_period_id
         RETURNING id`,
        [payPeriodId, w.user_id]
      );
      const payoutId = payoutRes.rows[0].id;
      touchedPayoutIds.add(payoutId);
      payoutsCreatedCount += 1;

      // Upsert the payout_event line. Every column is set from EXCLUDED, so the
      // recompute uses the same JS-computed values as the insert. held_state is
      // always NULL here: a line being accrued for an on-roster worker is by
      // definition not held, and this write is exactly what clears a prior
      // hold/confirm when the worker rejoins the roster.
      await client.query(
        `INSERT INTO payout_events
           (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
            late, gratuity_share_cents, card_tip_gross_cents, card_tip_fee_cents,
            card_tip_net_cents, adjustment_cents, adjustment_note, line_total_cents,
            held_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL)
         ON CONFLICT (payout_id, shift_id) DO UPDATE SET
           contracted_hours = EXCLUDED.contracted_hours,
           hours = EXCLUDED.hours,
           rate_cents = EXCLUDED.rate_cents,
           wage_cents = EXCLUDED.wage_cents,
           late = EXCLUDED.late,
           gratuity_share_cents = EXCLUDED.gratuity_share_cents,
           card_tip_gross_cents = EXCLUDED.card_tip_gross_cents,
           card_tip_fee_cents = EXCLUDED.card_tip_fee_cents,
           card_tip_net_cents = EXCLUDED.card_tip_net_cents,
           adjustment_cents = EXCLUDED.adjustment_cents,
           adjustment_note = EXCLUDED.adjustment_note,
           line_total_cents = EXCLUDED.line_total_cents,
           held_state = EXCLUDED.held_state`,
        [payoutId, w.shift_id, contractedHrs, hours, rateCents, wage,
         late, share.gratuity, share.tipGross, share.tipFee,
         tipNet, adjustment, adjustmentNote, lineTotal]
      );
    }

    // Roster corrections: remove orphaned payout lines. A worker approved at a
    // prior accrual may since have been denied, unassigned (dropped_at set), or
    // deleted; the worker query above already excludes them, so they are absent
    // from `workers.rows`. Their payout_events line for this proposal's shifts
    // would otherwise stay payable forever; no other code path deletes
    // payout_events. Remove any existing line for THIS proposal's shifts, in THIS
    // open period, whose (contractor, shift) pair is no longer a current worker.
    // Scoping is deliberately tight: `existingRes` rows are already limited to
    // this proposal's shifts (the JOIN), and we filter to payPeriodId (proven
    // open above), so rows in other (frozen) periods and other proposals' shifts
    // are never touched. A late-tip roll-forward line lives in a different period
    // than payPeriodId, so it is likewise left alone.
    const currentKeys = new Set(workers.rows.map(w => `${w.user_id}:${w.shift_id}`));
    // Structural discriminator (B13): a line is HELD, not paid, whenever the
    // worker is off the roster and the line either carries a POSITIVE
    // reimbursement OR is a real wage line whose adjustment went NEGATIVE (an
    // admin dock or a same-period clawback merged into the wage line). Both must
    // stop paying the worker's wage while the adjustment stays live for the admin
    // decision; holdReimbursementLines sets line_total = LEAST(adjustment, 0) so
    // a positive hold is non-payable and a negative hold keeps collecting the
    // debt. Pure clawback debt stubs (all payables zero, negative adjustment) are
    // NEVER swept: the person owes that money regardless of roster status and the
    // tip's refunded_amount_cents marker has already advanced, so a swept debt
    // line would be permanently un-collected (H1's leak in a new guise) — they
    // are excluded from `orphans` below by !hasPayable and survive verbatim. Only
    // zero-adjustment orphan lines are deleted. Lines already 'held' are left
    // alone, and 'confirmed' lines are NEVER re-held or deleted: the admin
    // explicitly decided that off-roster line's fate.
    const hasPayable = (r) =>
      Number(r.wage_cents || 0) > 0
      || Number(r.gratuity_share_cents || 0) > 0
      || Number(r.card_tip_net_cents || 0) !== 0
      || Number(r.hours || 0) > 0;
    const orphans = existingRes.rows.filter(
      r => Number(r.pay_period_id) === Number(payPeriodId)
        && !currentKeys.has(`${r.contractor_id}:${r.shift_id}`)
        && (Number(r.adjustment_cents || 0) >= 0 || hasPayable(r))
    );
    if (orphans.length) {
      const toHold = orphans.filter(
        o => (Number(o.adjustment_cents || 0) > 0
              || (Number(o.adjustment_cents || 0) < 0 && hasPayable(o)))
          && !o.held_state
      );
      const toDelete = orphans.filter(o => Number(o.adjustment_cents || 0) === 0);

      // HOLD (kept + tracked, zeroed to non-payable / debt-collecting). An admin
      // PATCH later re-arms line_total = wage + gratuity + card_tip + adjustment
      // and flips to 'confirmed'. One UPDATE handles both signs (LEAST). Two
      // distinct breadcrumbs so the auditable reason is precise: a positive hold
      // parks a reimbursement pending confirm; a negative hold keeps collecting a
      // dock/clawback off a worker who is no longer on the roster (closes the old
      // "survives silently, fully payable" gap).
      await holdReimbursementLines(client, toHold.map(o => o.id));
      const heldPositive = toHold.filter(o => Number(o.adjustment_cents || 0) > 0);
      const heldNegative = toHold.filter(o => Number(o.adjustment_cents || 0) < 0);
      const heldExtra = (bucket) => bucket.map(o => ({
        payout_event_id: o.id,
        payout_id: o.payout_id,
        shift_id: o.shift_id,
        contractor_id: o.contractor_id,
        adjustment_cents: Number(o.adjustment_cents),
        adjustment_note: o.adjustment_note,
      }));
      if (heldPositive.length) {
        Sentry.captureMessage(
          'payrollAccrual: holding off-roster payout lines with reimbursements (confirm or zero at payroll)',
          {
            level: 'warning',
            tags: { component: 'payrollAccrual', reason: 'orphan_reimbursement_held', preserved: true },
            extra: { proposalId, payPeriodId, held: heldExtra(heldPositive) },
          }
        );
      }
      if (heldNegative.length) {
        Sentry.captureMessage(
          'payrollAccrual: holding off-roster payout lines with a negative adjustment (debt still collecting; confirm or zero at payroll)',
          {
            level: 'warning',
            tags: { component: 'payrollAccrual', reason: 'orphan_negative_adjustment_held', preserved: true },
            extra: { proposalId, payPeriodId, held: heldExtra(heldNegative) },
          }
        );
      }

      // Zero-adjustment orphans are deleted. A deleted line that still carried a
      // note is logged for audit (the note text is lost with the row).
      if (toDelete.length) {
        const withNote = toDelete.filter(
          o => o.adjustment_note !== null && o.adjustment_note !== ''
        );
        if (withNote.length) {
          Sentry.captureMessage(
            'payrollAccrual: removing zero-adjustment off-roster payout lines that carried a note',
            {
              level: 'warning',
              tags: { component: 'payrollAccrual', reason: 'orphan_noted_line_removed' },
              extra: {
                proposalId,
                payPeriodId,
                removed: withNote.map(o => ({
                  payout_event_id: o.id,
                  payout_id: o.payout_id,
                  shift_id: o.shift_id,
                  contractor_id: o.contractor_id,
                  adjustment_cents: Number(o.adjustment_cents),
                  adjustment_note: o.adjustment_note,
                })),
              },
            }
          );
        }
        await client.query(
          'DELETE FROM payout_events WHERE id = ANY($1)',
          [toDelete.map(o => o.id)]
        );
      }

      // A payout emptied of every line is a $0 pending stub for a worker no longer
      // on any event this period. It would show as a phantom pending payout on the
      // period list and block period finalization (maybeFinalizePeriod waits for
      // every payout to be paid). Delete any such now-empty pending payout. A held
      // line keeps its payout non-empty, so those survive and are recomputed below
      // (a positive hold's line_total is 0; a negative hold's is the debt, which
      // the GREATEST(0, SUM) clamp floors to a $0 payable total). A paid payout is
      // never removed.
      const orphanPayoutIds = [...new Set(orphans.map(o => o.payout_id))];
      const emptied = await client.query(
        `DELETE FROM payouts po
           WHERE po.id = ANY($1) AND po.status = 'pending'
             AND NOT EXISTS (SELECT 1 FROM payout_events WHERE payout_id = po.id)
           RETURNING id`,
        [orphanPayoutIds]
      );
      const deletedPayoutIds = new Set(emptied.rows.map(r => r.id));
      for (const pid of orphanPayoutIds) {
        if (!deletedPayoutIds.has(pid)) touchedPayoutIds.add(pid);
      }
    }

    // Recompute every touched payout's total from its line items. GREATEST(0,)
    // matches every sibling recompute (clawback, lateTip, recomputePayoutTotal):
    // H1 allows negative clawback lines, and a payable total must never go
    // negative even when a debt line exceeds the period's fresh earnings.
    await client.query(
      `UPDATE payouts po SET total_cents = GREATEST(0, COALESCE((
         SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
       ), 0))
       WHERE po.id = ANY($1)`,
      [Array.from(touchedPayoutIds)]
    );

    await client.query('COMMIT');
    // Best-effort, off the response path: a successful accrual proves an open period
    // exists, so resolve any tips that deferred while a period was frozen. Never throws,
    // never blocks the caller. The sweep is single-flight, so a batch of accruals
    // (e.g. balanceScheduler) triggers at most one.
    setImmediate(() => {
      require('./payrollDeferredRetry').retryDeferredTips().catch(err =>
        Sentry.captureException(err, { tags: { util: 'payrollAccrual', step: 'deferred_sweep' } }));
    });
    return { skipped: false, accrued: payoutsCreatedCount };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back or connection dropped */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { accruePayoutsForProposal, ensurePayPeriod };
