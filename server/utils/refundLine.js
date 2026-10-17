// server/utils/refundLine.js
'use strict';
// The Refund line (spec 2026-10-16 section 6, plan Task R1). A contract-scope
// refund lowers proposals.total_price by its contract portion
// (refundHelpers.js applyRefundReconciliation). This writes the same money as
// a visible discount line, { type: 'discount', label: 'Refund', amount,
// visible: true, source: 'refund', refund_id }, so the next re-price (an
// editor save, a drink-plan fold, cancel-line) nets the refund instead of
// billing it again. Until the conversion (spec 8.4) it is the only writer of
// a refund line.
//
// It writes both places or neither: proposals.adjustments (what the engine
// nets) and pricing_snapshot (what every view draws): the same line appended
// to snapshot.adjustments, its row placed where the engine would put it
// (insertAdjustmentBreakdownRow), and snapshot.total lowered by the same cents
// with the 0 floor total_price has. It never creates a breakdown or a total a
// snapshot lacks: the admin views draw a breakdown whenever one exists, and
// one holding only the Refund row would read as the whole booking. The next
// re-price rebuilds both from the engine, with the line netted.
//
// The caller runs it inside its own transaction, on the proposals row it
// already locked (the reconciliation locks before its already-applied check),
// so a refund's line is written once. The SELECT below re-takes that lock,
// which is free inside the same transaction.
//
// It never throws on the row's data or on a hold check that fails. A throw
// here would roll back the money reconciliation of a refund Stripe already
// made, and every retry (the sweep, the webhook) would fail the same way.
// Anything it cannot write cleanly is skipped and returned as a reason, and
// every skip but the two expected ones is reported. Database errors still
// propagate, like every other query in the reconciliation.

const Sentry = require('@sentry/node');
const { isLegalHold } = require('./legalHold');
const {
  REFUND_LABEL, validateAdjustments, insertAdjustmentBreakdownRow,
} = require('./adjustmentRules');

// A stored list: absent reads as empty, anything but an array is a shape this
// writer will not overwrite (null).
const listOf = (v) => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : null));
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const namesRefund = (list, refundId) => list.some(
  (a) => !!a && a.refund_id !== undefined && a.refund_id !== null && Number(a.refund_id) === refundId
);

function skipped(reason, proposalId, refundId, detail) {
  console.error(`refundLine: no Refund line for proposal ${proposalId}, refund ${refundId}: ${reason}${detail ? ` (${detail})` : ''}`);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(`refund_line_skipped: ${reason}`, {
      level: 'error',
      tags: { util: 'refundLine', reason },
      extra: { proposalId, refundId, detail },
    });
  }
  return { written: false, reason };
}

/**
 * Append the Refund line for one contract-scope refund.
 *
 * @param {object} dbClient  the caller's transaction client, holding the row lock
 * @param {object} a
 * @param {number} a.proposalId
 * @param {number} a.refundId      proposal_refunds.id exactly as pg returned it (int4)
 * @param {number} a.contractCents the contract portion total_price dropped by
 * @returns {Promise<{written: boolean, reason?: string}>} reason on a skip:
 *   no_contract_amount, legal_hold (expected, silent); already_written,
 *   legal_hold_unknown, invalid_line, not_found, unreadable (reported)
 */
async function appendRefundLine(dbClient, { proposalId, refundId, contractCents } = {}) {
  if (typeof contractCents !== 'number' || !(contractCents > 0)) {
    return { written: false, reason: 'no_contract_amount' };
  }
  // The line exactly as the editor's validator reads it on every later save:
  // refund_id the integer pg returned (a string would be refused there and
  // block every save), whole cents, under the bound. Checked here, so this
  // writer can never store a line the editor refuses.
  const { value, error } = validateAdjustments([{
    type: 'discount', label: REFUND_LABEL, amount: contractCents / 100,
    visible: true, source: 'refund', refund_id: refundId,
  }]);
  if (error) return skipped('invalid_line', proposalId, refundId, error);
  const line = value[0];

  const { rows } = await dbClient.query(
    'SELECT id, adjustments, pricing_snapshot FROM proposals WHERE id = $1 FOR UPDATE',
    [proposalId]
  );
  const row = rows[0];
  if (!row) return skipped('not_found', proposalId, refundId);
  // Bound to the id of the row just loaded (an integer from pg), never to the
  // caller's raw value. A check that throws (the list moved or broke) counts
  // as held: no line, reported, and the caller's money still reconciles.
  let held;
  try {
    held = isLegalHold(row.id);
  } catch (err) {
    return skipped('legal_hold_unknown', row.id, refundId, err && err.message);
  }
  if (held) return { written: false, reason: 'legal_hold' };

  const adjustments = listOf(row.adjustments);
  const snap = row.pricing_snapshot;
  const snapAdjustments = isPlainObject(snap) ? listOf(snap.adjustments) : null;
  if (!adjustments || !snapAdjustments || !listOf(snap.breakdown)) {
    return skipped('unreadable', row.id, refundId);
  }
  // No real path reaches this: the reconciler returns before the writer on a
  // repeat, and its refund row was pending and unadopted or just inserted. A
  // line already naming this refund (planted, or an id reused) is reported,
  // never silent.
  if (namesRefund(adjustments, line.refund_id) || namesRefund(snapAdjustments, line.refund_id)) {
    return skipped('already_written', row.id, refundId);
  }

  const next = { ...snap, adjustments: [...snapAdjustments, line] };
  if (Array.isArray(snap.breakdown)) {
    next.breakdown = insertAdjustmentBreakdownRow(snap, { label: line.label, amount: -line.amount, visible: true });
  }
  if (typeof snap.total === 'number' && Number.isFinite(snap.total)) {
    next.total = Math.max(0, Math.round(snap.total * 100) - contractCents) / 100;
  }
  const upd = await dbClient.query(
    'UPDATE proposals SET adjustments = $2::jsonb, pricing_snapshot = $3::jsonb WHERE id = $1',
    [row.id, JSON.stringify([...adjustments, line]), JSON.stringify(next)]
  );
  return { written: upd.rowCount === 1 };
}

module.exports = { appendRefundLine };
