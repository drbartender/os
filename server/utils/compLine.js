// The comp line for a waived Drink Plan Extras invoice: the comped cents come off total_price, the
// override and the snapshot total as one protected, visible discount line written to
// proposals.adjustments and the pricing snapshot in the same UPDATE, so the next re-price nets the
// comp instead of billing the waived add-on again (audit PRC-01).
'use strict';
// Comping an extras invoice (invoiceExtras.js voidExtrasInvoiceWithReconcile,
// reached from the admin PATCH /api/invoices/:id) waives the add-on the client
// bought through the drink plan: the proposal_addons row stays, the client
// still receives it, and the money leaves total_price. Until 2026-11-05 that
// was a bare `total_price = total_price - $1`, which left pricing_snapshot.total
// and the add-on row behind, so the proposal page and the client portal
// disagreed, every invoice rebuild folded the gap and paged Sentry, and the
// next re-price (an editor save, a drink-plan fold, cancel-line) billed the
// comped add-on again and minted an Additional Services invoice for it.
//
// This is the refundLine.js pattern (spec 2026-10-16 section 6) for a comp:
// the same cents, written where every re-price reads them. The line is
// { type: 'discount', label: COMP_LABEL (invoice number), amount, visible:
// true, source: 'comp' }; `source` is what protects it (adjustmentRules.js
// ADJUSTMENT_SOURCES, lineItemCancel.js isProtectedAdjustment) and the editor
// may still edit or drop it, which is how a comp is undone, or retired after
// the add-on itself is cancelled. The engine ignores the marker and nets the
// line like any discount, so an editor save or a fold that re-bills the add-on
// nets the comp against it and the total stays where the comp left it.
//
// One UPDATE moves all four places or none: proposals.adjustments (what the
// engine nets on the next save), pricing_snapshot.adjustments and .breakdown
// (what every view and the invoice builder draw) with snapshot.total lowered by
// the same cents, total_price lowered by the same cents (the 0 floor it has),
// and total_price_override lowered by the same cents when one exists, because
// the engine substitutes an override for the whole calculated total, lines
// included (refundHelpers.js applyRefundReconciliation does the same). A
// snapshot that is not an object (a legacy row) is left as it is: the line
// still reaches the adjustments column, and the next re-price rebuilds the
// snapshot from the engine with the comp netted.
//
// Unlike the refund writer it THROWS instead of skipping: nothing external has
// happened when a comp runs (no Stripe object, no money moved), so a row whose
// line lists cannot be read is refused with a client-visible ConflictError and
// the caller's transaction rolls the void back. Falling back to the bare
// subtraction would recreate the drift this file exists to end. A held
// booking is refused the same way (isLegalHold fails closed).
//
// The caller runs it inside its transaction; the SELECT below takes the
// proposals row lock so a concurrent editor save (FOR UPDATE on the same row)
// cannot lose the line.

const { isLegalHold } = require('./legalHold');
const { ConflictError, NotFoundError } = require('./errors');
const {
  COMP_LABEL, validateAdjustments, insertAdjustmentBreakdownRow,
} = require('./adjustmentRules');

// A stored list: absent reads as empty, anything but an array is a shape this
// writer will not overwrite (null).
const listOf = (v) => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : null));
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// A snapshot total the engine wrote (a number) or a legacy numeric string.
const totalCentsOf = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** The line the comp writes, exactly as the editor's validator reads it on every later save. */
function compLineFor({ compCents, invoiceNumber }) {
  const label = invoiceNumber ? `${COMP_LABEL} (${invoiceNumber})` : COMP_LABEL;
  const { value, error } = validateAdjustments([{
    type: 'discount', label, amount: compCents / 100, visible: true, source: 'comp',
  }]);
  if (error) throw new Error(`compLine: ${error}`); // whole cents by construction; a throw here is a bug
  return value[0];
}

/**
 * Append the comp line for one waived extras invoice and lower the totals by
 * the same cents, in one UPDATE on the locked proposals row.
 *
 * @param {object} dbClient  the caller's transaction client
 * @param {object} a
 * @param {number} a.proposalId
 * @param {number} a.compCents       the folded cents the comp takes off total_price (> 0)
 * @param {string} [a.invoiceNumber] printed in the line's label
 * @returns {Promise<{ line: object, proposal: { status, amount_paid, total_price } }>}
 *   the written line and the row's post-write money columns (for the payment ladder)
 * @throws {NotFoundError} no such proposal
 * @throws {ConflictError} LEGAL_HOLD, or COMP_LINE_UNWRITABLE when a stored line list is not a list
 */
async function appendCompLine(dbClient, { proposalId, compCents, invoiceNumber = null } = {}) {
  if (!Number.isInteger(compCents) || compCents <= 0) {
    throw new Error('compLine: compCents must be a positive integer number of cents');
  }
  const line = compLineFor({ compCents, invoiceNumber });

  const { rows } = await dbClient.query(
    'SELECT id, adjustments, pricing_snapshot FROM proposals WHERE id = $1 FOR UPDATE',
    [proposalId]
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('Proposal not found.');
  // Bound to the id of the row just loaded, never the caller's raw value.
  if (isLegalHold(row.id)) {
    throw new ConflictError('This booking is on legal hold and cannot be edited.', 'LEGAL_HOLD');
  }

  const adjustments = listOf(row.adjustments);
  const snap = row.pricing_snapshot;
  const snapIsObject = isPlainObject(snap);
  const snapAdjustments = snapIsObject ? listOf(snap.adjustments) : [];
  const snapBreakdownReadable = !snapIsObject || listOf(snap.breakdown) !== null;
  if (!adjustments || !snapAdjustments || !snapBreakdownReadable) {
    throw new ConflictError(
      "This booking's price lines cannot be read, so the comp was not applied. Comp it from the proposal editor instead.",
      'COMP_LINE_UNWRITABLE'
    );
  }

  let nextSnap = null;
  if (snapIsObject) {
    nextSnap = { ...snap, adjustments: [...snapAdjustments, line] };
    if (Array.isArray(snap.breakdown)) {
      nextSnap.breakdown = insertAdjustmentBreakdownRow(snap, { label: line.label, amount: -line.amount, visible: true });
    }
    const totalCents = totalCentsOf(snap.total);
    if (totalCents !== null) nextSnap.total = Math.max(0, totalCents - compCents) / 100;
  }

  // proposals.total_price and total_price_override are NUMERIC DOLLARS: the
  // cents divide here, in SQL, exactly as the refund reconciliation does.
  const upd = await dbClient.query(
    `UPDATE proposals
        SET adjustments = $2::jsonb,
            pricing_snapshot = COALESCE($3::jsonb, pricing_snapshot),
            total_price = GREATEST(total_price - ($4 / 100.0), 0),
            total_price_override = CASE
              WHEN total_price_override IS NULL THEN NULL
              ELSE GREATEST(total_price_override - ($4 / 100.0), 0)
            END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING status, amount_paid, total_price`,
    [row.id, JSON.stringify([...adjustments, line]), nextSnap ? JSON.stringify(nextSnap) : null, compCents]
  );
  return { line, proposal: upd.rows[0] || null };
}

module.exports = { appendCompLine, compLineFor };
