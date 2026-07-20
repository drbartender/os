/**
 * Fold client-driven extras (add-ons / syrups / bars) into a proposal's
 * contract: recompute the pricing snapshot, move any negotiated override by
 * the CATALOG delta of what changed, persist total_price + snapshot, and
 * re-evaluate payment status. Extracted VERBATIM from the drink-plan submit
 * financial path (2026-07-20, pp2-lab-fold) so the Enhancement Lab folds
 * additions through the exact same battle-tested sequence — one money path,
 * two callers. Callers own: proposal_addons upserts/deletes BEFORE calling,
 * the before/after legs, invoice refresh AFTER (refreshUnlockedInvoices +
 * createAdditionalInvoiceIfNeeded), and their own activity-log entries.
 *
 * MUST run inside the caller's transaction with `proposal` selected FOR
 * UPDATE; every query uses the passed `client` (one-pooled-connection rule).
 * Mutates `proposal.status` in memory on a payment-status demotion so the
 * caller's post-commit reporting sees the real state.
 *
 * @param {object} args
 * @param {object} args.client        transaction client (required)
 * @param {object} args.proposal      FOR-UPDATE proposals row (SELECT *)
 * @param {object} args.pkg           service_packages row
 * @param {Array}  args.addonsBefore  service_addons-shaped rows (pre-change)
 * @param {Array}  args.addonsAfter   service_addons-shaped rows (post-change)
 * @param {Array}  args.syrupsBefore  syrup id array (self-provided filtered)
 * @param {Array}  args.syrupsAfter   syrup id array (self-provided filtered)
 * @param {number} args.numBarsBefore pre-change bar count
 * @param {number} args.numBarsAfter  post-change bar count
 * @param {string} args.statusChangeReason activity-log reason on a demotion
 * @returns {Promise<{snapshot: object, statusChanged: boolean}>}
 */

'use strict';

const { calculateProposal } = require('./pricingEngine');
const { reconcileProposalPaymentStatus } = require('./proposalStatus');

async function foldExtrasIntoProposal({
  client,
  proposal,
  pkg,
  addonsBefore,
  addonsAfter,
  syrupsBefore,
  syrupsAfter,
  numBarsBefore,
  numBarsAfter,
  statusChangeReason,
}) {
  const adjustments = proposal.adjustments || [];

  // A total_price_override is a CONTRACT, not a catalog computation:
  // the engine's serviceTotal REPLACES the whole calculated total with
  // it. So we can neither drop it (the client's negotiated price
  // evaporates and they get billed at catalog, which overbilled Jack
  // Van Dyke by $627) nor pass it through untouched (the extras they
  // just bought become free). Price the delta at catalog with the
  // override OFF and move the contract by it. Anything this change did
  // not touch sits on both sides and cancels, including the CC-era
  // bundled first bar. Native proposals (no override) keep the plain
  // catalog recompute; the only change reaching them is `adjustments`,
  // which the submit handler used to drop on the floor (silently erasing
  // an admin's discount on submit — the same bug's sibling). No prod row
  // has adjustments without an override, so no live native moves.
  const hasOverride = proposal.total_price_override !== null
    && proposal.total_price_override !== undefined;
  let effectiveOverride = null;

  if (hasOverride) {
    const catalogArgs = {
      pkg,
      guestCount: proposal.guest_count,
      durationHours: Number(proposal.event_duration_hours),
      numBartenders: proposal.num_bartenders,
      adjustments,
      totalPriceOverride: null, // price the delta at CATALOG
      gratuityRate: proposal.gratuity_rate,
      tipJar: proposal.tip_jar,
    };
    const catalogBefore = calculateProposal({
      ...catalogArgs,
      numBars: numBarsBefore,
      addons: addonsBefore,
      syrupSelections: syrupsBefore,
    });
    const catalogAfter = calculateProposal({
      ...catalogArgs,
      numBars: numBarsAfter,
      addons: addonsAfter,
      syrupSelections: syrupsAfter,
    });
    // Difference the SERVICE portion, not `.total`. The override is a
    // service-level contract: the engine substitutes it for
    // calculatedTotal and then layers the client-gratuity line on top
    // (pricingEngine serviceTotal/total). Differencing `.total` folds
    // any gratuity movement into the contract, and the final snapshot
    // then charges that same gratuity AGAIN on top of the new override.
    // With gratuity_rate = 0 (every override'd row today) the two are
    // identical; with a rate set, an addon that moves the gratuity
    // staff basis overcharged by rate x hours and permanently polluted
    // total_price_override with gratuity dollars.
    const serviceOf = (s) => Math.round((s.total - (s.gratuity?.total || 0)) * 100) / 100;
    const extrasDelta = Math.round((serviceOf(catalogAfter) - serviceOf(catalogBefore)) * 100) / 100;
    effectiveOverride = Math.round((Number(proposal.total_price_override) + extrasDelta) * 100) / 100;
  }

  const snapshot = calculateProposal({
    pkg,
    guestCount: proposal.guest_count,
    durationHours: Number(proposal.event_duration_hours),
    numBars: numBarsAfter,
    numBartenders: proposal.num_bartenders,
    addons: addonsAfter,
    syrupSelections: syrupsAfter,
    adjustments,
    totalPriceOverride: effectiveOverride,
    gratuityRate: proposal.gratuity_rate, tipJar: proposal.tip_jar, // §5 preserve stored gratuity
  });

  // Write the override alongside the total so the two can never drift
  // apart again (the stranded-column state that made Jack's row
  // inconsistent). For a native proposal effectiveOverride is null and
  // the column is already null, so this is a no-op there.
  await client.query(
    'UPDATE proposals SET total_price = $1, pricing_snapshot = $2, total_price_override = $4, updated_at = NOW() WHERE id = $3',
    [snapshot.total, JSON.stringify(snapshot), proposal.id, effectiveOverride]
  );

  // F2 (CLAUDE.md cross-cutting: price up -> re-evaluate payment status).
  // The extras just raised total_price; a fully-paid proposal that now
  // owes must not keep showing "Paid in Full". Mirror crud.js: demote
  // balance_paid -> deposit_paid and disarm autopay only on the
  // was-fully-paid transition. reconcile is pure; the UPDATE uses the
  // SAME tx client (one-connection rule). Keep proposal.status honest in
  // memory so the caller's post-commit reporting sees the real state.
  const rec = reconcileProposalPaymentStatus({
    status: proposal.status, amountPaid: proposal.amount_paid, totalPrice: snapshot.total,
  });
  if (rec.changed) {
    const priorStatus = proposal.status;
    await client.query(
      rec.autopayDisarmed
        ? 'UPDATE proposals SET status = $1, autopay_enrolled = false, autopay_status = NULL WHERE id = $2'
        : 'UPDATE proposals SET status = $1 WHERE id = $2',
      [rec.status, proposal.id]
    );
    proposal.status = rec.status;
    await client.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'status_changed', 'client', $2)`,
      [proposal.id, JSON.stringify({
        from: priorStatus, to: rec.status,
        reason: statusChangeReason, new_total: snapshot.total,
      })]
    );
  }

  return { snapshot, statusChanged: rec.changed };
}

module.exports = { foldExtrasIntoProposal };
