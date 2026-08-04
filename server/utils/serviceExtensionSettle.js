'use strict';

/**
 * Settle or close a service extension.
 *
 * Spec: docs/superpowers/specs/2026-07-25-service-extension-design.md section 7.
 *
 * settleExtension is the ONE place the contract changes, and the only column it
 * moves is proposals.event_duration_hours (plus the linked shift's denormalized
 * duration and end_time). total_price, pricing_snapshot, amount_paid, and
 * status are NEVER touched: extension money is side money and rides the
 * off-ledger invoice label instead (D12).
 *
 * The claim UPDATE (... WHERE status = 'pending') is the race gate shared by
 * settle, expiry, override, and cancel: exactly one wins, and a replayed
 * webhook cannot double-bump the duration.
 *
 * Deliberately does NOT send messages or touch payroll. The caller sequences
 * those AFTER this returns, so a Twilio or payroll failure can never roll back
 * a settled payment. Deliberately does NOT call syncShiftsFromProposal: that
 * full sync also rewrites location, setup minutes, and the staffing roster,
 * none of which should move mid-event, and it no-ops on multi-shift events.
 *
 * addHoursToTime is not used (not exported, and it needs 24-hour input while
 * event_start_time is free text like "8:00 PM"). The display string is derived
 * in SQL; to_char(..., 'FMHH12:MI AM') reproduces addHoursToTime's exact format
 * (verified 2026-07-26: 11:00 PM, 12:30 AM, 9:30 AM, 12:00 AM).
 */

const { pool } = require('../db');

const SETTLE_OUTCOMES = new Set(['paid', 'overridden']);
const CLOSE_OUTCOMES = new Set(['expired', 'cancelled']);

const ACTION_BY_OUTCOME = Object.freeze({
  paid: 'extension_paid',
  overridden: 'extension_overridden',
  expired: 'extension_expired',
  cancelled: 'extension_cancelled',
});

/** Every staffer still on the event's roster, so a two-bartender job tells both. */
async function assignedStaffUserIds(client, proposalId) {
  const { rows } = await client.query(
    `SELECT DISTINCT sr.user_id
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
      WHERE s.proposal_id = $1
        AND sr.status = 'approved'
        AND sr.dropped_at IS NULL`,
    [proposalId]
  );
  return rows.map((r) => r.user_id);
}

/** Claim the row for one outcome. Returns the row, or null when someone else won. */
async function claim(client, extensionId, outcome, actorUserId, overrideReason) {
  const { rows } = await client.query(
    `UPDATE service_extensions
        SET status = $2,
            override_by_user_id = COALESCE($3, override_by_user_id),
            override_reason = COALESCE($4, override_reason),
            updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING id, proposal_id, shift_id, invoice_id, gratuity_cents, amount_cents,
                contracted_duration_hours, requested_duration_hours`,
    [
      extensionId,
      outcome,
      Number.isInteger(actorUserId) ? actorUserId : null,
      overrideReason || null,
    ]
  );
  return rows[0] || null;
}

async function logAction(client, proposalId, outcome, details) {
  await client.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
     VALUES ($1, $2, 'system', $3::jsonb)`,
    [proposalId, ACTION_BY_OUTCOME[outcome], JSON.stringify(details || {})]
  );
}

async function settleExtension({ extensionId, outcome, actorUserId = null, overrideReason = null }) {
  if (!SETTLE_OUTCOMES.has(outcome)) {
    throw new Error(`settleExtension: invalid outcome '${outcome}'`);
  }
  // Own transaction: claim + duration bump + shift sync + log are ONE atomic
  // unit, and every query goes through the held client (CLAUDE.md one-pooled-
  // connection rule). A first draft ran these as four separate pool statements,
  // so a failure after the claim left a row marked paid on an event that was
  // never extended.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await settleInTx(client, { extensionId, outcome, actorUserId, overrideReason });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

async function settleInTx(client, { extensionId, outcome, actorUserId, overrideReason }) {
  // LOCK ORDER, load-bearing: proposals FIRST, then service_extensions.
  //
  // The create route (Task 7) locks `proposals` FOR UPDATE and then inserts into
  // service_extensions. If this function claimed the extension row first and then
  // updated proposals, the two paths would take the same two locks in opposite
  // orders, which is an ABBA deadlock: create holds the proposal lock and waits
  // on the pending-row unique index, while settle holds the extension row and
  // waits on the proposal. Postgres would abort one with 40P01. Reading
  // proposal_id unlocked first is safe because an extension row's proposal_id
  // never changes.
  const idRes = await client.query(
    'SELECT proposal_id FROM service_extensions WHERE id = $1',
    [extensionId]
  );
  if (!idRes.rows[0]) return { ok: false, reason: 'not_pending' };
  await client.query('SELECT id FROM proposals WHERE id = $1 FOR UPDATE', [idRes.rows[0].proposal_id]);

  const row = await claim(client, extensionId, outcome, actorUserId, overrideReason);
  if (!row) return { ok: false, reason: 'not_pending' };

  const proposalId = row.proposal_id;
  const newDuration = Number(row.requested_duration_hours);
  const previousDuration = Number(row.contracted_duration_hours);

  // The ONE contract mutation. The RETURNING expression parses the free-text
  // event_start_time, so an unparseable value raises 22007 and the whole
  // transaction rolls back, releasing the claim. That is the outcome we want:
  // better an unsettled request the sweep can expire than a row marked paid on
  // an event whose duration never moved. Task 7 refuses to CREATE a request on
  // an unparseable event, so reaching this is a data-drift case.
  const { rows: durRows } = await client.query(
    `UPDATE proposals
        SET event_duration_hours = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING to_char(((event_date::text || ' ' || event_start_time)::timestamp
                   + ($2::numeric * INTERVAL '1 hour')), 'FMHH12:MI AM') AS new_end_display`,
    [proposalId, newDuration]
  );
  const newEndDisplay = durRows[0] ? durRows[0].new_end_display : null;

  // Targeted shift sync, only when the event has exactly one shift row (the
  // same guard syncShiftsFromProposal uses). A multi-shift event is flagged for
  // the admin instead of guessing which shift the extra time belongs to.
  const { rows: countRows } = await client.query(
    'SELECT COUNT(*)::int AS n FROM shifts WHERE proposal_id = $1',
    [proposalId]
  );
  const shiftCount = countRows[0] ? countRows[0].n : 0;
  const multiShift = shiftCount !== 1;

  if (!multiShift) {
    await client.query(
      `UPDATE shifts
          SET event_duration_hours = $2,
              end_time = COALESCE($3, end_time)
        WHERE proposal_id = $1`,
      [proposalId, newDuration, newEndDisplay]
    );
  }

  const staffUserIds = await assignedStaffUserIds(client, proposalId);

  await logAction(client, proposalId, outcome, {
    extension_id: row.id,
    previous_duration_hours: previousDuration,
    new_duration_hours: newDuration,
    new_end: newEndDisplay,
    amount_cents: row.amount_cents,
    gratuity_cents: row.gratuity_cents,
    multi_shift: multiShift,
    override_by_user_id: outcome === 'overridden' ? actorUserId : undefined,
  });

  return {
    ok: true,
    outcome,
    proposalId,
    shiftId: row.shift_id,
    invoiceId: row.invoice_id,
    staffUserIds,
    previousDurationHours: previousDuration,
    newDurationHours: newDuration,
    newEndDisplay,
    multiShift,
    gratuityCents: Number(row.gratuity_cents) || 0,
    amountCents: Number(row.amount_cents) || 0,
  };
}

async function closeExtension({ extensionId, outcome, actorUserId = null, overrideReason = null }) {
  if (!CLOSE_OUTCOMES.has(outcome)) {
    throw new Error(`closeExtension: invalid outcome '${outcome}'`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // LOCK ORDER: proposals FIRST, exactly like settleInTx (see the comment
    // there). Claiming first inverts the order against settle and the create
    // route: logAction's activity-log FK takes FOR KEY SHARE on the proposal,
    // which conflicts with their FOR UPDATE, and the cycle is a 40P01 on
    // precisely the settle-vs-expiry race this module exists to serialize.
    const idRes = await client.query(
      'SELECT proposal_id FROM service_extensions WHERE id = $1',
      [extensionId]
    );
    if (!idRes.rows[0]) {
      await client.query('COMMIT');
      return { ok: false, reason: 'not_pending' };
    }
    await client.query('SELECT id FROM proposals WHERE id = $1 FOR UPDATE', [idRes.rows[0].proposal_id]);
    const row = await claim(client, extensionId, outcome, actorUserId, overrideReason);
    if (!row) {
      await client.query('COMMIT');
      return { ok: false, reason: 'not_pending' };
    }
    const staffUserIds = await assignedStaffUserIds(client, row.proposal_id);
    await logAction(client, row.proposal_id, outcome, {
      extension_id: row.id,
      requested_duration_hours: Number(row.requested_duration_hours),
      amount_cents: row.amount_cents,
    });
    await client.query('COMMIT');
    return {
      ok: true,
      outcome,
      proposalId: row.proposal_id,
      shiftId: row.shift_id,
      invoiceId: row.invoice_id,
      staffUserIds,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { settleExtension, closeExtension, ACTION_BY_OUTCOME };
