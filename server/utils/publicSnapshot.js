// server/utils/publicSnapshot.js
'use strict';
// The public copy of a pricing snapshot: what a token holder may see (spec
// 2026-10-16 section 4.3, plan decision 11). Pure: no DB, no Sentry.
//
// A DENYLIST over the engine's snapshot shape (pricingEngine.calculateProposal;
// every writer persists that shape). It removes `subtotal` (the pre-fold sum),
// `breakdown` (it lists every adjustment, hidden ones included),
// `total_price_override`, and every hidden adjustment; keeps each visible line
// with only the four keys a page reads (type, label, amount, visible; the
// `source` and `refund_id` markers stay home); and replaces `package.base_cost`
// so base_cost + staffing.total equals the folded package row the server sent.
// A browser still running the old bundle during a deploy then draws folded rows
// that add up when the fold went into the package row; in a fallback it cannot
// draw the "Pricing adjustment" row, so those few bookings do not add up for
// the minutes of a deploy (they never did on the old page). Everything else is
// kept. Anything that is not a snapshot object fails closed to null: a
// denylist must never hand over an unknown shape whole.
//
// Public readers of the fields this removes or rewrites (grep 2026-10-17, plan
// Task C3 Step 1, catching optional chaining and camelCase names across
// client/src/pages/proposal, pages/plan, pages/public, components and utils):
// only the proposal page's old lineItems memo (ProposalView.js L584
// package.base_cost, L604 adjustments), which the server's rows replace
// (client/src/pages/proposal/proposalView/pageRows.js). The admin
// PricingBreakdown component reads `breakdown` but mounts only on admin pages.
// Fields the public pages do read, all kept: total; gratuity (total,
// staff_count, hours, staff_noun, floor_rate); display_labels
// (client/src/utils/gratuityLabels.js); floor_reason and billed_guests
// (ProposalPricingBreakdown.js); staffing.actual and inputs.durationHours
// (ProposalView.js); bar_rental (the drink plan's LogisticsStep.js and
// ConfirmationStep.js); syrups.selections (PotionPlanningLab.js).

const { adjVisible } = require('./adjustmentRules');
const { buildClientPriceRows, snapshotServiceCents, moneyToCents } = require('./clientPriceLines');

/**
 * @param {object} snapshot  proposals.pricing_snapshot as read
 * @param {{ packageRowAmount?: number }} opts  the folded package row's amount
 *   in dollars (clientPriceLines), or undefined when there is no package row
 * @returns {object|null} a new object; the input is never mutated
 */
function sanitizeSnapshotForPublic(snapshot, { packageRowAmount } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const out = structuredClone(snapshot);
  delete out.subtotal;
  delete out.breakdown;
  delete out.total_price_override;
  if (Array.isArray(out.adjustments)) {
    // A visible line keeps only what a page reads: type, label, amount, visible.
    out.adjustments = out.adjustments.filter(adjVisible).map((adj) => {
      const line = {};
      if ('type' in adj) line.type = adj.type;
      if ('label' in adj) line.label = adj.label;
      if ('amount' in adj) line.amount = adj.amount;
      if ('visible' in adj) line.visible = adj.visible;
      return line;
    });
  } else {
    delete out.adjustments;
  }
  if (out.package && typeof out.package === 'object') {
    if (typeof packageRowAmount === 'number' && Number.isFinite(packageRowAmount)) {
      out.package.base_cost = (Math.round(packageRowAmount * 100)
        - moneyToCents(out.staffing && out.staffing.total)) / 100;
    } else {
      // No package row (no usable total): nothing to fold into, and the
      // catalog price would show an unfolded figure. Nothing is invented.
      delete out.package.base_cost;
    }
  }
  return out;
}

/**
 * The public price view of one booking, the one call every public route makes
 * (spec 4.2, 4.3): the folded service rows for the page, and the public
 * snapshot whose package price is that same folded row. One builder call feeds
 * both, so the proposal page, the switch response and the drink plan page can
 * never disagree on the package row. The target is the page's own: the
 * snapshot total less its client gratuity. `fold` is for the caller's report
 * only and never leaves the server (decision 6).
 *
 * @param {object} snapshot  proposals.pricing_snapshot as read
 * @param {{ packageName?: string|null }} opts  the package name the page shows
 * @returns {{ rows: Array<{ key, label, amount }>, fold: object, snapshot: object|null }}
 */
function publicPriceView(snapshot, { packageName } = {}) {
  const { rows, fold } = buildClientPriceRows(snapshot, {
    targetCents: snapshotServiceCents(snapshot),
    packageName,
  });
  const packageRow = rows.find((r) => r.key === 'package');
  return {
    rows,
    fold,
    snapshot: sanitizeSnapshotForPublic(snapshot, { packageRowAmount: packageRow ? packageRow.amount : undefined }),
  };
}

module.exports = { sanitizeSnapshotForPublic, publicPriceView };
