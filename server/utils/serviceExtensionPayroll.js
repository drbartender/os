'use strict';

/**
 * Get a settled extension's extra time into payroll (spec section 9).
 *
 * payrollAccrual seeds contracted_hours from proposals.event_duration_hours on
 * FIRST accrual and then treats hours as admin-owned. First accrual mid-event
 * is the NORM, not the exception: matchTipToEvent accrues on any card tip while
 * the period is open, and auto-completion fires at the contracted end, which is
 * inside the request window itself. So an extension frequently lands AFTER a
 * line already exists, and re-accrual would preserve the old hours and silently
 * underpay.
 *
 * Rule: re-seed only when hours = contracted_hours, meaning the admin has
 * demonstrably not touched the line. When they differ the admin owns it, so we
 * refuse and report a locked line for the caller to surface. Frozen pay periods
 * are never written (the late-tip deferral precedent); they are reported too.
 *
 * Wages are recomputed from the new hours because wage_cents is a stored,
 * JS-computed column in this schema.
 */

const { pool } = require('../db');
// THE seeding helper, not a local reimplementation. contractedHours(d) =
// d + 1h setup + 0.5h breakdown, so a 4h event's contracted_hours is 5.5. A
// local helper returning the bare duration would REWRITE 5.5 down to 4.5 on a
// 30-minute extension and cut an hour of pay per line.
const { contractedHours, wageCents } = require('./payrollMath');

async function applyExtensionHours({ proposalId, newDurationHours, shiftId: _shiftId = null }) {
  const target = contractedHours(Number(newDurationHours) || 0);
  if (!Number.isFinite(target) || target <= 0) {
    return { updatedLines: 0, lockedLines: 0, frozenLines: 0, multiShiftSkipped: false, payoutIds: [] };
  }

  // Multi-shift guard. contracted_hours derives from the PROPOSAL's duration, so
  // on an event with several shift rows a proposal-wide UPDATE would bump hours
  // for staff on shifts that were never extended (a Day 2 crew paid for Day 1's
  // extra hour). settleExtension already refuses to sync shift end_times in that
  // shape and alerts instead; payroll takes the same line. When the event has
  // exactly one shift we proceed; otherwise nothing is written and the caller
  // reports it so an admin fixes the right lines by hand.
  const shiftCountRes = await pool.query(
    'SELECT COUNT(*)::int AS n FROM shifts WHERE proposal_id = $1',
    [proposalId]
  );
  if ((shiftCountRes.rows[0]?.n || 0) !== 1) {
    return { updatedLines: 0, lockedLines: 0, frozenLines: 0, multiShiftSkipped: true, payoutIds: [] };
  }

  // ONE transaction for the whole rewrite. The per-line UPDATEs and the payout
  // header recompute must land together: a failure between them leaves
  // payout_events disagreeing with payouts.total_cents, i.e. a paystub whose
  // lines do not add up to its total, on the code path that changes staff pay.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyInTx(client, { proposalId, target });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

async function applyInTx(client, { proposalId, target }) {
  // Lock pay_periods FIRST, ordered, before any payout_events row lock.
  // payrollAccrual's first lock is its pay-period upsert; taking pp first here
  // serializes the two writers and dissolves the po/pe ABBA the merge-gate
  // database review traced (accrual holds payouts and waits on payout_events
  // while this transaction held payout_events and waited on payouts: 40P01 on
  // a settle landing mid-accrual). Locking pp also freezes period status for
  // the lifetime of this transaction, closing the open-to-processing race on
  // the freeze check below.
  await client.query(
    `SELECT id FROM pay_periods
      WHERE id IN (SELECT po.pay_period_id
                     FROM payouts po
                     JOIN payout_events pe ON pe.payout_id = po.id
                     JOIN shifts s ON s.id = pe.shift_id
                    WHERE s.proposal_id = $1)
      ORDER BY id
      FOR UPDATE`,
    [proposalId]
  );
  const { rows } = await client.query(
    // held_state IS NULL is REQUIRED, mirroring payrollAccrual.js:228. A held
    // line belongs to an off-roster worker and carries hours = contracted_hours
    // = 0 with line_total_cents = 0 deliberately. Both guards below would pass
    // on it (0 === 0, and 0 !== target), so without this filter a settle would
    // resurrect a deliberately non-payable line into a payable one and pay
    // someone who was taken off the job.
    `SELECT pe.payout_id, pe.shift_id, pe.hours, pe.contracted_hours, pe.rate_cents,
            pe.gratuity_share_cents, pe.card_tip_net_cents, pe.adjustment_cents,
            pp.status AS period_status
       FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
       JOIN pay_periods pp ON pp.id = po.pay_period_id
       JOIN shifts s ON s.id = pe.shift_id
      WHERE s.proposal_id = $1
        AND pe.held_state IS NULL
      FOR UPDATE OF pe`,
    [proposalId]
  );

  let updatedLines = 0;
  let lockedLines = 0;
  let frozenLines = 0;
  const touchedPayoutIds = new Set();

  for (const line of rows) {
    // Only an 'open' period is writable, matching payrollAccrual.js:186 (the
    // "if (payPeriod.status !== 'open')" line) exactly.
    // 'processing', 'reopened' and 'paid' all count as frozen here; the caller
    // MUST surface frozenLines, because a reopened-period extension that is
    // silently skipped is an underpay nobody is told about.
    if (line.period_status !== 'open') {
      frozenLines += 1;
      continue;
    }
    // Admin-edited hours are admin-owned.
    if (Number(line.hours) !== Number(line.contracted_hours)) {
      lockedLines += 1;
      continue;
    }
    // Already at the new duration (a replay, or accrual ran after the bump).
    if (Number(line.contracted_hours) === target) continue;

    const wage = wageCents(target, Number(line.rate_cents));
    const lineTotal = wage
      + Number(line.gratuity_share_cents || 0)
      + Number(line.card_tip_net_cents || 0)
      + Number(line.adjustment_cents || 0);

    await client.query(
      `UPDATE payout_events
          SET contracted_hours = $3, hours = $3, wage_cents = $4, line_total_cents = $5
        WHERE payout_id = $1 AND shift_id = $2`,
      [line.payout_id, line.shift_id, target, wage, lineTotal]
    );
    updatedLines += 1;
    touchedPayoutIds.add(line.payout_id);
  }

  // Recompute the payout HEADER total, exactly as every sibling writer does
  // (payrollAccrual.js:261). Without this the line is right but the payout and
  // the paystub still show the pre-extension total, so the bartender is paid the
  // old amount and the line-level fix is invisible.
  const payoutIds = [...touchedPayoutIds];
  if (payoutIds.length > 0) {
    await client.query(
      `UPDATE payouts po SET total_cents = GREATEST(0, COALESCE((
         SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
       ), 0))
       WHERE po.id = ANY($1)`,
      [payoutIds]
    );
  }

  return { updatedLines, lockedLines, frozenLines, multiShiftSkipped: false, payoutIds };
}

/**
 * The shared post-settle payroll alert. All three settle paths (webhook,
 * zero-delta accept, admin override) call this with applyExtensionHours' result
 * so they report identically.
 *
 * frozenLines MUST be reported, not just lockedLines: a 'processing' or
 * 'reopened' pay period is skipped silently otherwise, which is an underpay
 * nobody is told about (spec section 9, the late-tip deferral precedent). This
 * is alert-only by design; no deferral marker is written, because wages have no
 * deferral mechanism the way tips do, so a human has to move the line.
 *
 * `notify` is injected rather than required at module load so this module stays
 * free of the notification dependency and is trivially stubbable in tests.
 */
async function maybeAlertPayroll(notify, proposalId, payroll) {
  if (!payroll) return;
  const parts = [];
  if (payroll.lockedLines > 0) {
    parts.push(`${payroll.lockedLines} payout line(s) were edited by hand`);
  }
  if (payroll.frozenLines > 0) {
    parts.push(`${payroll.frozenLines} payout line(s) sit in a pay period that is not open`);
  }
  if (payroll.multiShiftSkipped) {
    parts.push('this event has multiple shift rows, so payroll hours were not touched at all (bumping them proposal-wide would overpay staff on the shifts that were not extended)');
  }
  if (parts.length === 0) return;
  await notify.alertAdminsProblem({
    proposalId,
    kind: 'payroll_hours_locked',
    detail: `${parts.join(' and ')}, so the extra time was NOT added to payroll automatically. Update the payout line(s) yourself.`,
  });
}

/**
 * Stamp a settled extension as fully finalized. Call this LAST on every settle
 * path, after payroll and the staff greenlight have both returned. An unstamped
 * settled row is exactly what the Task 13 heal hunts for, so stamping early
 * silently disables the crash recovery.
 */
async function finalizeExtension(extensionId) {
  await pool.query(
    'UPDATE service_extensions SET finalized_at = NOW(), updated_at = NOW() WHERE id = $1',
    [extensionId]
  );
}

module.exports = { applyExtensionHours, maybeAlertPayroll, finalizeExtension };
