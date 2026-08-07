/**
 * Admin duty-line endpoints (spec 2026-08-06 §3.6), sibling to payroll.js
 * (which sits over the soft cap; payrollTax.js set the extraction precedent).
 * Mounted from ./index.js; routes declare FULL paths under /api/admin.
 *
 * Auth: admin-only, matching the rest of payroll. Every mutation audit-logs
 * and ends by recomputing the payout total via the single writer.
 * Freeze rule mirrors the payout-event PATCH: payout paid, or period
 * paid/processing, refuses edits; 'reopened' is editable.
 */
const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError, ValidationError, ConflictError } = require('../../utils/errors');
const { recomputePayoutTotal } = require('../../utils/payrollProcessing');
const { accruePayoutsForProposal } = require('../../utils/payrollAccrual');
const {
  DUTY_KIND_LABELS, ATTRIBUTED_KINDS, EVENT_KINDS,
  listUnattributedDuties, eligibleWorkers, loadProposalDutyContext,
} = require('../../utils/dutyLines');
const { logAdminAction } = require('../../utils/adminAuditLog');

const router = express.Router();

const MAX_DUTY_CENTS = 100000; // +/- $1,000, matching the adjustment cap

function validAmount(n) {
  return Number.isInteger(n) && n !== 0 && Math.abs(n) <= MAX_DUTY_CENTS;
}

/**
 * Pin a duty line + its payout + period FOR UPDATE and enforce the freeze
 * rule. Returns the pinned row. Caller owns the transaction.
 */
async function pinLine(client, lineId) {
  const { rows } = await client.query(
    `SELECT d.*, po.status AS payout_status, po.pay_period_id,
            pp.status AS period_status
       FROM payout_duty_lines d
       JOIN payouts po ON po.id = d.payout_id
       JOIN pay_periods pp ON pp.id = po.pay_period_id
      WHERE d.id = $1
      FOR UPDATE OF d, po, pp`,
    [lineId]
  );
  if (!rows[0]) throw new NotFoundError('duty line not found');
  const row = rows[0];
  if (
    row.payout_status === 'paid'
    || row.period_status === 'paid'
    || row.period_status === 'processing'
  ) {
    throw new ConflictError('payout or period is paid or processing; edits are frozen');
  }
  return row;
}

// POST /payroll/duty-lines — admin manual line.
router.post('/payroll/duty-lines', auth, adminOnly, asyncHandler(async (req, res) => {
  const payoutId = Number(req.body.payout_id);
  const shiftId = req.body.shift_id === null || req.body.shift_id === undefined
    ? null : Number(req.body.shift_id);
  const amount = Number(req.body.amount_cents);
  const kind = String(req.body.kind || '');
  const note = req.body.note === null || req.body.note === undefined
    ? null : String(req.body.note);
  if (!Number.isInteger(payoutId)) throw new ValidationError(null, 'invalid payout_id');
  // Review kinds are NEVER manually creatable: their idempotency keys
  // (staff_review_id / contest_quarter) only exist on the materializer path,
  // so a manual row would be uncapped and double-payable (review B2).
  if (!EVENT_KINDS.includes(kind)) {
    throw new ValidationError(null, 'kind must be an event duty kind (review money flows from the reviews surface)');
  }
  if (shiftId !== null && !Number.isInteger(shiftId)) {
    throw new ValidationError(null, 'shift_id must be an integer');
  }
  if (!validAmount(amount)) {
    throw new ValidationError(null, 'amount_cents must be a nonzero integer within +/-100000');
  }
  if (note !== null && note.length > 500) throw new ValidationError(null, 'note exceeds 500 chars');

  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    const po = await client.query(
      `SELECT po.id, po.contractor_id, po.status AS payout_status, pp.status AS period_status
         FROM payouts po JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE po.id = $1 FOR UPDATE OF po, pp`,
      [payoutId]
    );
    if (!po.rows[0]) throw new NotFoundError('payout not found');
    if (
      po.rows[0].payout_status === 'paid'
      || po.rows[0].period_status === 'paid'
      || po.rows[0].period_status === 'processing'
    ) {
      throw new ConflictError('payout or period is paid or processing; edits are frozen');
    }
    if (shiftId !== null) {
      // The shift must belong to a proposal whose event date sits in this
      // payout's pay period, or the line becomes visible to an unrelated
      // proposal's reconcile (review W4).
      const sh = await client.query(
        `SELECT 1
           FROM shifts s
           JOIN payouts po2 ON po2.id = $2
           JOIN pay_periods pp2 ON pp2.id = po2.pay_period_id
          WHERE s.id = $1 AND s.event_date BETWEEN pp2.start_date AND pp2.end_date`,
        [shiftId, payoutId]
      );
      if (!sh.rowCount) {
        throw new ValidationError(null, 'shift does not belong to this payout\'s pay period');
      }
    }
    // Explicit duplicate guard: the partial unique index cannot fire for
    // NULL shift_id (NULLs are distinct), so check actively (review B2/W2).
    const dup = await client.query(
      `SELECT 1 FROM payout_duty_lines
        WHERE payout_id = $1 AND kind = $2 AND removed_at IS NULL
          AND shift_id IS NOT DISTINCT FROM $3`,
      [payoutId, kind, shiftId]
    );
    if (dup.rowCount) {
      throw new ConflictError('a line of this kind already exists for that payout and shift');
    }
    const ins = await client.query(
      `INSERT INTO payout_duty_lines
         (payout_id, contractor_id, shift_id, kind, amount_cents, origin, admin_owned, note)
       VALUES ($1, $2, $3, $4, $5, 'admin', TRUE, $6)
       ON CONFLICT (payout_id, shift_id, kind)
         WHERE kind NOT IN ('review_bounty','review_contest')
       DO NOTHING
       RETURNING *`,
      [payoutId, po.rows[0].contractor_id, shiftId, kind, amount, note]
    );
    if (!ins.rowCount) {
      throw new ConflictError('a line of this kind already exists for that payout and shift');
    }
    const payoutTotal = await recomputePayoutTotal(client, payoutId);
    await client.query('COMMIT');
    out = {
      contractorId: po.rows[0].contractor_id,
      body: {
        duty_line: { ...ins.rows[0], label: DUTY_KIND_LABELS[kind] },
        payout_total_cents: payoutTotal,
      },
      audit: { duty_line_id: ins.rows[0].id, kind, amount_cents: amount, payout_id: payoutId },
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
  // Audit AFTER release (one-pooled-connection rule) and AWAITED before the
  // response, so the row is committed by the time the caller can read it
  // (security re-review B2: an un-awaited audit write on an admin money
  // mutation can lose the row on restart and races any immediate reader).
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: out.contractorId,
    action: 'duty_line_create', metadata: out.audit,
  });
  res.json(out.body);
}));

// PATCH /payroll/duty-lines/:id — amount and note edits stamp admin_owned and
// confirm a held line (the admin decision, mirroring the payout-event PATCH).
router.patch('/payroll/duty-lines/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const lineId = Number(req.params.id);
  if (!Number.isInteger(lineId)) throw new ValidationError(null, 'invalid line id');
  const hasAmount = 'amount_cents' in req.body;
  const hasNote = 'note' in req.body;
  if (!hasAmount && !hasNote) throw new ValidationError(null, 'no editable fields supplied');
  let amount = null;
  if (hasAmount) {
    amount = Number(req.body.amount_cents);
    // Edits may set $0 ("confirm or zero" on a held line is a real admin
    // decision, distinct from removal — spec §3.1); creates stay nonzero.
    if (!Number.isInteger(amount) || Math.abs(amount) > MAX_DUTY_CENTS) {
      throw new ValidationError(null, 'amount_cents must be an integer within +/-100000');
    }
  }
  const note = hasNote
    ? (req.body.note === null || req.body.note === undefined ? null : String(req.body.note))
    : undefined;
  if (typeof note === 'string' && note.length > 500) {
    throw new ValidationError(null, 'note exceeds 500 chars');
  }

  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    const row = await pinLine(client, lineId);
    // admin_owned stamps ONLY on an amount edit (spec §3.1: "set on any admin
    // amount edit") — a note-only tweak must not opt the line out of auto
    // amount propagation (review W7). A held line confirms on any PATCH.
    const upd = await client.query(
      `UPDATE payout_duty_lines
          SET amount_cents = CASE WHEN $5 THEN $2 ELSE amount_cents END,
              note = CASE WHEN $3 THEN $4 ELSE note END,
              admin_owned = CASE WHEN $5 THEN TRUE ELSE admin_owned END,
              held_state = CASE WHEN held_state = 'held' THEN 'confirmed' ELSE held_state END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [lineId, amount, hasNote, note ?? null, hasAmount]
    );
    const payoutTotal = await recomputePayoutTotal(client, row.payout_id);
    await client.query('COMMIT');
    out = {
      contractorId: row.contractor_id,
      body: {
        duty_line: { ...upd.rows[0], label: DUTY_KIND_LABELS[upd.rows[0].kind] },
        payout_total_cents: payoutTotal,
      },
      audit: { duty_line_id: lineId, amount_cents: amount, note_changed: hasNote },
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
  // Release, then AWAIT the audit, then respond (security re-review B2).
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: out.contractorId,
    action: 'duty_line_edit', metadata: out.audit,
  });
  res.json(out.body);
}));

// POST /payroll/duty-lines/:id/remove and /restore — the pay-time checkbox.
// Restore keeps the stored amount (no re-derive). An admin removal is FINAL to
// derivation: reconcile never resurrects removed_by IS NOT NULL rows.
for (const [suffix, removing] of [['remove', true], ['restore', false]]) {
  router.post(`/payroll/duty-lines/:id/${suffix}`, auth, adminOnly, asyncHandler(async (req, res) => {
    const lineId = Number(req.params.id);
    if (!Number.isInteger(lineId)) throw new ValidationError(null, 'invalid line id');
    const client = await pool.connect();
    let out;
    try {
      await client.query('BEGIN');
      const row = await pinLine(client, lineId);
      if (removing && row.removed_at) throw new ConflictError('line is already removed');
      if (!removing && !row.removed_at) throw new ConflictError('line is not removed');
      const upd = await client.query(
        removing
          ? `UPDATE payout_duty_lines
                SET removed_at = NOW(), removed_by = $2, updated_at = NOW()
              WHERE id = $1 RETURNING *`
          : `UPDATE payout_duty_lines
                SET removed_at = NULL, removed_by = NULL, admin_owned = TRUE, updated_at = NOW()
              WHERE id = $1 RETURNING *`,
        removing ? [lineId, req.user.id] : [lineId]
      );
      const payoutTotal = await recomputePayoutTotal(client, row.payout_id);
      await client.query('COMMIT');
      out = {
        contractorId: row.contractor_id,
        body: {
          duty_line: { ...upd.rows[0], label: DUTY_KIND_LABELS[upd.rows[0].kind] },
          payout_total_cents: payoutTotal,
        },
        audit: { duty_line_id: lineId, kind: row.kind, amount_cents: Number(row.amount_cents) },
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      client.release();
    }
    // Release, then AWAIT the audit, then respond (security re-review B2).
    await logAdminAction({
      actorUserId: req.user.id, targetUserId: out.contractorId,
      action: removing ? 'duty_line_remove' : 'duty_line_restore',
      metadata: out.audit,
    });
    res.json(out.body);
  }));
}

// PUT /payroll/duty-attributions — set or move who gets an attributed duty.
// Validates against the CURRENT approved roster inside the transaction, then
// re-derives through the one shared code path (accrual), which materializes
// the new line, system-removes the old contractor's, and recomputes both
// totals. Derivation runs AFTER release on its own connection (accrual
// manages its own transaction; one-pooled-connection rule).
router.put('/payroll/duty-attributions', auth, adminOnly, asyncHandler(async (req, res) => {
  const proposalId = Number(req.body.proposal_id);
  const userId = Number(req.body.user_id);
  const kind = String(req.body.kind || '');
  if (!Number.isInteger(proposalId)) throw new ValidationError(null, 'invalid proposal_id');
  if (!Number.isInteger(userId)) throw new ValidationError(null, 'invalid user_id');
  if (!ATTRIBUTED_KINDS.includes(kind)) throw new ValidationError(null, 'not an attributed duty kind');

  const client = await pool.connect();
  let contractorId = null;
  try {
    await client.query('BEGIN');
    const ctx = await loadProposalDutyContext(client, proposalId);
    if (!ctx) throw new NotFoundError('proposal not found');
    const eligible = eligibleWorkers(kind, ctx.workers);
    if (!eligible.some((w) => Number(w.user_id) === userId)) {
      throw new ConflictError('user is not an eligible approved worker for this duty');
    }
    contractorId = userId;
    await client.query(
      `INSERT INTO duty_attributions (proposal_id, kind, user_id, attributed_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (proposal_id, kind) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             attributed_by = EXCLUDED.attributed_by,
             attributed_at = NOW()`,
      [proposalId, kind, userId, req.user.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }

  // Materialize/move through the single derivation path; synchronous so the
  // caller (attribution modal) sees the result before re-firing Process.
  const accrual = await accruePayoutsForProposal(proposalId);
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: contractorId,
    action: 'duty_attribution_set',
    metadata: { proposal_id: proposalId, kind, user_id: userId, accrual_skipped: !!accrual.skipped },
  });
  res.json({ attributed: { proposal_id: proposalId, kind, user_id: userId }, accrual });
}));

// GET /payroll/periods/:id/unattributed-duties — what blocks Process, plus
// display names for the modal.
router.get('/payroll/periods/:id/unattributed-duties', auth, adminOnly, asyncHandler(async (req, res) => {
  const periodId = Number(req.params.id);
  if (!Number.isInteger(periodId)) throw new NotFoundError('Period not found');
  const items = await listUnattributedDuties(pool, periodId);
  const userIds = [...new Set(items.flatMap((i) => i.eligible_user_ids))];
  let users = {};
  if (userIds.length) {
    const { rows } = await pool.query(
      `SELECT u.id, COALESCE(cp.display_name, cp.preferred_name, u.email) AS name
         FROM users u LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
        WHERE u.id = ANY($1)`,
      [userIds]
    );
    users = Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }
  const proposalIds = [...new Set(items.map((i) => i.proposal_id))];
  let proposals = {};
  if (proposalIds.length) {
    const { rows } = await pool.query(
      `SELECT p.id, p.event_date, p.event_type, COALESCE(c.name, '') AS client_name
         FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = ANY($1)`,
      [proposalIds]
    );
    proposals = Object.fromEntries(rows.map((r) => [r.id, r]));
  }
  res.json({
    items: items.map((i) => ({ ...i, label: DUTY_KIND_LABELS[i.kind] })),
    users,
    proposals,
  });
}));

module.exports = router;
