// The comp line for a waived Drink Plan Extras invoice: a protected, visible discount line whose
// amount is DERIVED at every pricing from the current price of the items it comps (add-ons by
// catalog id, the bar, syrups by flavor), written to proposals.adjustments and the pricing snapshot
// in the same UPDATE that lowers total_price, so a comped item stays free while it is on the booking
// and the comp leaves with it (audit PRC-01, rounds 1 to 3).
'use strict';
// Comping an extras invoice (invoiceExtras.js voidExtrasInvoiceWithReconcile,
// reached from the admin PATCH /api/invoices/:id) waives what the client bought
// through the drink plan: the proposal_addons row, the bar and the syrups stay,
// the client still receives them, and their money leaves total_price. Until
// 2026-11-05 that was a bare `total_price = total_price - $1`, which left
// pricing_snapshot.total and the add-on row behind, so the proposal page and
// the client portal disagreed, every invoice rebuild folded the gap and paged
// Sentry, and the next re-price billed the comped add-on again.
//
// A comp is "these items are free": a property of the items, never a fixed
// number of cents. The line is { type: 'discount', label: COMP_LABEL (invoice
// number), amount, visible: true, source: 'comp', comped: { addons: [catalog
// ids], bar: true|false, syrups: [flavor ids] } }. `source` is what protects
// it (adjustmentRules.js ADJUSTMENT_SOURCES, lineItemCancel.js
// isProtectedAdjustment); the editor may drop it, which is how a comp is
// undone, and a comp cannot be partial: its amount is overwritten at the next
// pricing. `comped` is the identity each kind carries on the booking, read
// off the waived invoice's own line items (an addon line's source_id is
// service_addons.id, as proposal_addons.addon_id is; a bar line is the one
// the drink plan added; the syrup flavors come from the drink plan, since a
// syrup line carries no ids), so the breakdown can match it at every price.
//
// The amount: applyCompLines(lines, priced) reads the engine's own output
// for the booking as it is now and sets each comp line to the price of its
// comped items that are still present: an add-on's line_total; a bar at its
// marginal price in the current bar count (the first bar's fee when it is the
// only one, the additional fee above it; several comped bars take the top of
// the count one after another, so two comps never claim the same fee); the
// comped syrup flavors at their marginal price in the current selection (the
// engine prices flavors as a set with a 3-pack discount, so "what these
// flavors cost" is the set's price less the set's price without them, which
// is exactly what the fold added for them). An absent item contributes
// nothing; a line whose items are all absent is dropped. The stored amount is
// refreshed to that figure, so the column and the snapshot show the current
// comp. Every pricer that prices lines against a booking's items applies it
// through calculateProposalWithComps: the fold's After leg (cancel-line, the
// lab save, the submit; the Before leg keeps the stored line, it prices what
// the booking was), computeCatalogSnapshot, the editor PATCH, /calculate and
// changeRequests.priceProposedState (the options quote, the switch, the change
// request). Before this (round 2) the comp's cents were frozen at comp time
// while the comped items kept re-pricing with the booking: a headcount change
// moved the toast and not the comp, the panel offered a refund of money never
// paid or minted an Additional Services invoice for a comped add-on, and a
// comped bar or syrup had no identity at all, so cancelling one netted the
// comp a second time and fired a Stripe refund.
//
// One UPDATE moves all four places or none: proposals.adjustments (what the
// next price starts from), pricing_snapshot.adjustments and .breakdown (what
// every view and the invoice builder draw) with snapshot.total lowered by the
// comp's cents, total_price lowered by the same cents (the 0 floor it has),
// and total_price_override lowered by the same cents when one exists, because
// the engine substitutes an override for the whole calculated total, lines
// included (refundHelpers.js applyRefundReconciliation does the same). The
// cents at comp time are derived the same way from the row's snapshot when it
// carries the engine's item shapes; a legacy row's snapshot is {} (the column
// is JSONB NOT NULL DEFAULT '{}'), carries none, and takes the invoice's folded
// cents with the identity, so the next price derives from the rebuilt
// snapshot; a snapshot that carries the shapes but none of the comped items
// is refused, the invoice is then a correction (reconcile_total false), not a
// comp. A legacy {} snapshot takes the line into its adjustments and nothing
// else is invented, no total where there was none (a total that is not money
// is left as it was, never NaN, never negative) and no breakdown row where
// there is no breakdown; only a snapshot that is not an object at all is left
// untouched, the line still reaching the column.
//
// Unlike the refund writer it THROWS instead of skipping: nothing external has
// happened when a comp runs, so a row whose line lists cannot be read is
// refused with a client-visible ConflictError and the caller's transaction
// rolls the void back. A held booking is refused the same way (isLegalHold
// fails closed). The caller runs it inside its transaction; the SELECT below
// takes the proposals row lock so a concurrent editor save cannot lose the line.

const { isLegalHold } = require('./legalHold');
const { ConflictError, NotFoundError } = require('./errors');
const {
  COMP_LABEL, validateAdjustments, insertAdjustmentBreakdownRow,
} = require('./adjustmentRules');
const { calculateProposal, calculateSyrupCost } = require('./pricingEngine');

// A stored list: absent reads as empty, anything but an array is a shape this
// writer will not overwrite (null).
const listOf = (v) => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : null));
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// A snapshot total the engine wrote (a number) or a legacy numeric string.
const totalCentsOf = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null;
};
const isCompLine = (line) => !!line && typeof line === 'object' && line.source === 'comp';
const compedOf = (line) => (isCompLine(line) && isPlainObject(line.comped) ? line.comped : null);
const namesAnything = (c) => isPlainObject(c) && ((Array.isArray(c.addons) && c.addons.length > 0)
  || c.bar === true || (Array.isArray(c.syrups) && c.syrups.length > 0));

/**
 * The line the comp writes, exactly as the editor's validator reads it on every
 * later save. `comped` is { addons: [catalog ids], bar: boolean, syrups:
 * [flavor ids] }; a comp that names nothing carries no marker.
 */
function compLineFor({ compCents, invoiceNumber, comped = null }) {
  const label = invoiceNumber ? `${COMP_LABEL} (${invoiceNumber})` : COMP_LABEL;
  const marker = namesAnything(comped) ? { comped } : {};
  const { value, error } = validateAdjustments([{
    type: 'discount', label, amount: compCents / 100, visible: true, source: 'comp', ...marker,
  }]);
  if (error) throw new Error(`compLine: ${error}`); // whole cents by construction; a throw here is a bug
  return value[0];
}

/**
 * The lines with every comp line at the current price of its comped items,
 * read off `priced`, the engine's output for the booking as it stands
 * (calculateProposal): pure, and the ONE rule every pricer applies. A comp
 * line without a `comped` marker (an admin's own line) and every other line
 * pass through. The input is never mutated; `lines` is the same array when
 * nothing changed.
 *
 * @param {Array} lines   proposals.adjustments as stored (anything else reads as none)
 * @param {object} priced the engine snapshot the lines were priced in
 * @returns {{ lines: Array, changed: boolean }}
 */
function applyCompLines(lines, priced) {
  const list = Array.isArray(lines) ? lines : [];
  const snap = isPlainObject(priced) ? priced : {};
  const addonCents = new Map();
  for (const a of Array.isArray(snap.addons) ? snap.addons : []) {
    const id = Number(a && a.id);
    if (!Number.isInteger(id)) continue;
    addonCents.set(id, (addonCents.get(id) || 0) + Math.round((Number(a.line_total) || 0) * 100));
  }
  const bar = isPlainObject(snap.bar_rental) ? snap.bar_rental : {};
  const firstFee = Number(bar.first_bar_fee) || 0;
  const additionalFee = Number(bar.additional_bar_fee) || 0;
  const barRentalCents = (n) => (n <= 0 ? 0 : Math.round((firstFee + Math.max(0, n - 1) * additionalFee) * 100));
  let barsLeft = Math.max(0, Math.floor(Number(bar.num_bars) || 0));
  const guestCount = Number(snap.inputs && snap.inputs.guestCount) || 0;
  const selections = isPlainObject(snap.syrups) && Array.isArray(snap.syrups.selections) ? snap.syrups.selections : [];
  let syrupsLeft = [...new Set(selections)];
  const syrupCents = (ids) => Math.round(calculateSyrupCost(ids, guestCount).total * 100);

  let changed = false;
  const out = [];
  for (const line of list) {
    const comped = compedOf(line);
    if (!comped) { out.push(line); continue; }
    let cents = 0;
    let present = false;
    for (const id of Array.isArray(comped.addons) ? comped.addons : []) {
      const n = Number(id);
      if (addonCents.has(n)) { present = true; cents += addonCents.get(n); }
    }
    if (comped.bar === true && barsLeft >= 1) {
      present = true;
      cents += barRentalCents(barsLeft) - barRentalCents(barsLeft - 1);
      barsLeft -= 1;
    }
    const flavors = (Array.isArray(comped.syrups) ? comped.syrups : []).filter((id) => syrupsLeft.includes(id));
    if (flavors.length > 0) {
      present = true;
      const remaining = syrupsLeft.filter((id) => !flavors.includes(id));
      cents += syrupCents(syrupsLeft) - syrupCents(remaining);
      syrupsLeft = remaining;
    }
    if (!present) { changed = true; continue; } // every comped item is gone: the comp leaves with them
    if (Math.round((Math.abs(Number(line.amount)) || 0) * 100) === cents) { out.push(line); continue; }
    changed = true;
    out.push({ ...line, amount: cents / 100 });
  }
  return { lines: changed ? out : list, changed };
}

/**
 * calculateProposal with the comp lines derived from the booking it prices:
 * one engine pass for the items, the comp lines set from it, and a second
 * pass with the refreshed lines when any moved. The per-item prices never
 * depend on an adjustment, so both passes price the same items. The pricers
 * call this instead of calculateProposal wherever the lines are a booking's
 * own (never for a quote that carries none).
 *
 * @param {object} args  calculateProposal's arguments
 * @returns {{ snapshot: object, lines: Array, changed: boolean }}  the final
 *   snapshot, the lines it was priced with (the ones to store), and whether
 *   they differ from the lines given
 */
function calculateProposalWithComps(args) {
  const first = calculateProposal(args);
  const applied = applyCompLines(args.adjustments, first);
  if (!applied.changed) return { snapshot: first, lines: applied.lines, changed: false };
  return { snapshot: calculateProposal({ ...args, adjustments: applied.lines }), lines: applied.lines, changed: true };
}

// Whether a stored snapshot carries the engine's item shapes a comp derives
// from (the fold wrote it); {} and other legacy shapes do not.
const carriesItems = (snap) => isPlainObject(snap)
  && (Array.isArray(snap.addons) || isPlainObject(snap.bar_rental) || isPlainObject(snap.syrups));

/**
 * Append the comp line for one waived extras invoice and lower the totals by
 * its cents, in one UPDATE on the locked proposals row.
 *
 * @param {object} dbClient  the caller's transaction client
 * @param {object} a
 * @param {number} a.proposalId
 * @param {number} a.compCents       the invoice's folded cents (> 0): the line's cents on a
 *                                   legacy row; derived from the snapshot otherwise
 * @param {string} [a.invoiceNumber] printed in the line's label
 * @param {{addons?: number[], bar?: boolean, syrups?: string[]}} [a.comped]  what the invoice
 *                                   charged for, by the identity each kind carries on the booking
 * @returns {Promise<{ line: object, compCents: number, proposal: { status, amount_paid, total_price } }>}
 *   the written line, the cents the totals moved by, and the row's post-write money columns
 * @throws {NotFoundError} no such proposal
 * @throws {ConflictError} LEGAL_HOLD; COMP_LINE_UNWRITABLE when a stored line list is not a
 *   list; COMP_ITEMS_NOT_PRICED when the snapshot prices none of the comped items
 */
async function appendCompLine(dbClient, { proposalId, compCents, invoiceNumber = null, comped = null } = {}) {
  if (!Number.isInteger(compCents) || compCents <= 0) {
    throw new Error('compLine: compCents must be a positive integer number of cents');
  }

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

  // The comped syrups are the flavors the booking carries: the drink plan may
  // name a flavor the admin had put on the proposal before the plan, which the
  // invoice never charged for.
  const identity = isPlainObject(comped) ? { ...comped } : null;
  if (identity && Array.isArray(identity.syrups) && snapIsObject
      && isPlainObject(snap.syrups) && Array.isArray(snap.syrups.selections)) {
    identity.syrups = identity.syrups.filter((id) => snap.syrups.selections.includes(id));
  }
  let line = compLineFor({ compCents, invoiceNumber, comped: identity });
  let cents = compCents;
  if (line.comped && carriesItems(snap)) {
    const applied = applyCompLines([line], snap);
    if (applied.lines.length === 0) {
      throw new ConflictError(
        "The items this invoice charged for are not on the booking's price, so there is nothing to comp. Void it as a correction instead.",
        'COMP_ITEMS_NOT_PRICED'
      );
    }
    line = applied.lines[0];
    cents = Math.round(line.amount * 100);
  }

  let nextSnap = null;
  if (snapIsObject) {
    nextSnap = { ...snap, adjustments: [...snapAdjustments, line] };
    if (Array.isArray(snap.breakdown)) {
      nextSnap.breakdown = insertAdjustmentBreakdownRow(snap, { label: line.label, amount: -line.amount, visible: true });
    }
    // A total that is money moves by the comp's cents and floors at 0; one
    // that is absent or not money is left exactly as it was.
    const totalCents = totalCentsOf(snap.total);
    if (totalCents !== null) nextSnap.total = Math.max(0, totalCents - cents) / 100;
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
    [row.id, JSON.stringify([...adjustments, line]), nextSnap ? JSON.stringify(nextSnap) : null, cents]
  );
  return { line, compCents: cents, proposal: upd.rows[0] || null };
}

module.exports = { appendCompLine, compLineFor, applyCompLines, calculateProposalWithComps };
