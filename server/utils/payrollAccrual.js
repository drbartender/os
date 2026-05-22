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
    `SELECT id, event_date, status, event_duration_hours, total_price, pricing_snapshot
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal || !proposal.event_date) return;
  // Accrual is for completed events only, so it is a safe no-op when called
  // before the event has run (e.g. defensively from elsewhere).
  if (proposal.status !== 'completed') return;
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const payPeriod = await ensurePayPeriod(client, eventDate);
    // Never write into a frozen period. Once Phase 2 introduces processing/paid
    // periods, a late accrual into a closed period would corrupt settled
    // payroll; rolling it into the open period is a Phase 2 concern.
    if (payPeriod.status !== 'open') {
      await client.query('COMMIT');
      return;
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
       WHERE s.proposal_id = $1 AND sr.status = 'approved'
       ORDER BY sr.user_id`,
      [proposalId]
    );
    if (!workers.rows.length) {
      await client.query('COMMIT');
      return;
    }

    // Bartenders share gratuity and card tips; barbacks/servers do not.
    // Case-insensitive: production seeds the position as 'Bartender'.
    const bartenders = workers.rows.filter(
      w => (w.position || '').toLowerCase() === 'bartender'
    );

    // Gratuity pool, net of the card fee. Per spec section 4.2 the fee
    // denominator is the proposal's full contracted price (proposals.total_price),
    // of which the gratuity is always a part — so the ratio cannot exceed 1.
    const grossGratuity = extractGratuityCents(proposal.pricing_snapshot);
    const proposalTotalCents = Math.round(Number(proposal.total_price || 0) * 100);
    const feeRes = await client.query(
      `SELECT COALESCE(SUM(fee_cents), 0) AS fee
       FROM proposal_payments WHERE proposal_id = $1 AND status = 'succeeded'`,
      [proposalId]
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
    // recomputes only the system-owned money fields.
    const existingRes = await client.query(
      `SELECT pe.*, po.contractor_id
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
      // First accrual seeds contracted_hours/hours/rate from the contract;
      // afterwards the admin owns them, so re-accrual preserves the prior row.
      const contractedHrs = prior
        ? Number(prior.contracted_hours)
        : contractedHours(Number(proposal.event_duration_hours) || 0);
      const hours = prior ? Number(prior.hours) : contractedHrs;
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
      const lineTotal = Math.max(0, wage + share.gratuity + tipNet + adjustment);

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

      // Upsert the payout_event line. Every column is set from EXCLUDED, so the
      // recompute uses the same JS-computed values as the insert.
      await client.query(
        `INSERT INTO payout_events
           (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
            late, gratuity_share_cents, card_tip_gross_cents, card_tip_fee_cents,
            card_tip_net_cents, adjustment_cents, adjustment_note, line_total_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
           line_total_cents = EXCLUDED.line_total_cents`,
        [payoutId, w.shift_id, contractedHrs, hours, rateCents, wage,
         late, share.gratuity, share.tipGross, share.tipFee,
         tipNet, adjustment, adjustmentNote, lineTotal]
      );
    }

    // Recompute every touched payout's total from its line items.
    await client.query(
      `UPDATE payouts po SET total_cents = COALESCE((
         SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
       ), 0)
       WHERE po.id = ANY($1)`,
      [Array.from(touchedPayoutIds)]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { accruePayoutsForProposal, ensurePayPeriod };
