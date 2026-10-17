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
 * A legal-hold booking is refused before the first query (409 NOT_CHANGEABLE,
 * spec 2026-10-16 section 5.3); the caller rolls back its own earlier writes.
 * Mutates `proposal.status` in memory on a payment-status move (demote or
 * restore) so the caller's post-commit reporting sees the real state.
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
 * @param {number} [args.numBartendersBefore] pre-change bartender count; omit
 *                 (with After) to use proposal.num_bartenders on both legs
 * @param {number} [args.numBartendersAfter]  post-change bartender count
 * @param {Array}  [args.adjustmentsBefore]   pre-change adjustments; omit
 *                 (with After) to use proposal.adjustments on both legs
 * @param {Array}  [args.adjustmentsAfter]    post-change adjustments
 * @param {string} args.statusChangeReason activity-log reason on a status move
 * @returns {Promise<{snapshot: object, statusChanged: boolean}>}
 *
 * Leg contract (cancel-line, 2026-07-24): callers changing staffing or
 * adjustments pass BOTH legs AND persist the new num_bartenders/adjustments
 * column values themselves; the fold writes only total_price /
 * pricing_snapshot / total_price_override. The final snapshot always prices
 * at the After legs.
 *
 * computeCatalogSnapshot (below) prices a booking's current inputs at today's
 * catalog through the same engine-args builder the fold uses; the override
 * conversion calls it (plan 2026-10-16-price-override-removal, Task F2).
 */

'use strict';

const { Pool } = require('pg');
const { calculateProposal } = require('./pricingEngine');
const { ConflictError } = require('./errors');
const { isLegalHold } = require('./legalHold');
const { reconcileProposalPaymentStatus } = require('./proposalStatus');
const { storedToInputCount } = require('./addonQuantity');
const { readSnapshot } = require('./pricingSnapshot');
const { contractDurationHours, contractHoursFromAggregate, SETTLED_EXTENSION_COLUMNS } = require('./contractDuration');

// SQL to load reprice-ready addon rows: service_addons catalog columns PLUS the
// per-proposal stored quantity AND the event duration needed to convert it.
// The bare `SELECT sa.*` this replaced dropped pa.quantity, so calculateProposal
// priced every per_hour addon as quantity 1, silently under-billing the
// instant it repriced (cross-LLM push review, 2026-07-20). Passing that stored
// value straight back through was the OPPOSITE error: the stored figure is the
// engine's OUTPUT (hours x count for per_hour), so the engine multiplied by
// hours a second time (cross-LLM push review, 2026-07-26). service_addons has
// no `quantity` and proposals has no `minimum_hours`, so both aliases are
// unambiguous.
// pa_duration_hours is the ROW's (worked) hours; the stored quantity was
// computed at the CONTRACT's hours, which a settled on-site extension moves
// apart (contractDuration.js). The two aggregate columns let
// withRepriceQuantities derive the contract's hours with the one shared rule.
const REPRICE_ADDON_SQL = `
  SELECT sa.*, pa.quantity AS pa_quantity, pa.line_total AS pa_line_total, pa.rate AS pa_rate,
         p.event_duration_hours AS pa_duration_hours,${SETTLED_EXTENSION_COLUMNS}
    FROM proposal_addons pa
    JOIN service_addons sa ON sa.id = pa.addon_id
    JOIN proposals p ON p.id = pa.proposal_id
   WHERE pa.proposal_id = $1`;

/**
 * Attach the engine-facing input `quantity` to each reprice addon row.
 *
 * proposal_addons.quantity stores the engine's OUTPUT display quantity, which
 * is NOT the input count for any billing type except `flat`
 * (server/utils/addonQuantity.js explains the full table). Recover the count
 * through the shared conversion, passing the row's OWN persisted line_total and
 * rate: a per_guest count survives nowhere else. When the conversion cannot
 * express a count (per_guest_timed, per_staff, per_100_guests, and a per_guest
 * row whose line_total or rate is unusable) drop the field entirely and let
 * calculateProposal recompute from guestCount / staffCount, which is what this
 * function did for the whole per_guest pair before that recovery existed.
 * @param {Array} rows  rows from REPRICE_ADDON_SQL
 * @returns {Array} rows calculateProposal can price correctly
 */
function withRepriceQuantities(rows) {
  return (rows || []).map((r) => {
    const {
      pa_quantity, pa_duration_hours, pa_settled_added_hours, pa_min_contracted_hours,
      pa_line_total, pa_rate, ...addon
    } = r;
    // Invert at the hours the quantity was priced at, never the worked hours.
    const contractHours = contractHoursFromAggregate(
      pa_duration_hours, pa_settled_added_hours ?? 0, pa_min_contracted_hours ?? null
    ).hours;
    const count = storedToInputCount(addon, pa_quantity, contractHours, {
      lineTotal: pa_line_total, rate: pa_rate,
    });
    return count === null ? addon : { ...addon, quantity: count };
  });
}

/** Load reprice-ready addon rows for a proposal on the given client. */
async function loadRepriceAddons(client, proposalId) {
  const res = await client.query(REPRICE_ADDON_SQL, [proposalId]);
  return withRepriceQuantities(res.rows);
}

/**
 * The engine inputs for a booking at TODAY's catalog with no override: the
 * one builder behind every catalog compute in this module (the fold's legs
 * and final snapshot, and computeCatalogSnapshot), so the override conversion
 * prices a booking exactly the way the fold does. The gratuity rate, tip jar
 * and admin mandate floor come off the row: a snapshot that is persisted
 * without the floor strips the client-side checkout floor (spec 2026-08-10).
 */
function catalogEngineArgs({
  proposal, pkg, contractHours, numBars, numBartenders, addons, syrups, adjustments,
}) {
  return {
    pkg,
    guestCount: proposal.guest_count,
    durationHours: contractHours,
    numBars,
    numBartenders,
    addons,
    syrupSelections: syrups,
    adjustments,
    totalPriceOverride: null,
    gratuityRate: proposal.gratuity_rate,
    tipJar: proposal.tip_jar,
    gratuityFloorRate: Number(proposal.gratuity_floor_rate) > 0 ? Number(proposal.gratuity_floor_rate) : null,
  };
}

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
  numBartendersBefore = null,
  numBartendersAfter = null,
  adjustmentsBefore = null,
  adjustmentsAfter = null,
  statusChangeReason,
}) {
  // Legal hold (spec 2026-10-16 section 5.3): a held booking keeps the price
  // it has, so every client-triggered re-price stops here (drink-plan submit,
  // the Enhancement Lab and cancel-line all reach this fold). FIRST, before any
  // read or write, on the id of the row the caller locked; the caller's
  // rollback takes back its own earlier writes. The copy never names the hold
  // (plan decision 4).
  if (isLegalHold(proposal.id)) {
    throw new ConflictError("This booking can't be changed online right now.", 'NOT_CHANGEABLE');
  }

  const adjBefore = adjustmentsBefore ?? (proposal.adjustments || []);
  const adjAfter = adjustmentsAfter ?? (proposal.adjustments || []);
  const bartendersBefore = numBartendersBefore ?? proposal.num_bartenders;
  const bartendersAfter = numBartendersAfter ?? proposal.num_bartenders;

  // A total_price_override is a CONTRACT, not a catalog computation:
  // the engine's serviceTotal REPLACES the whole calculated total with
  // it. So we can neither drop it (the client's negotiated price
  // evaporates and they get billed at catalog, which overbilled one
  // client by $627 on 2026-07-16) nor pass it through untouched (the
  // extras they just bought become free). Price the delta at catalog with
  // the override OFF and move the contract by it. Anything this change did
  // not touch sits on both sides and cancels, including the CC-era
  // bundled first bar. Native proposals (no override) keep the plain
  // catalog recompute; the only change reaching them is `adjustments`,
  // which the submit handler used to drop on the floor (silently erasing
  // an admin's discount on submit, the same bug's sibling). No prod row
  // has adjustments without an override, so no live native moves.
  const hasOverride = proposal.total_price_override !== null
    && proposal.total_price_override !== undefined;
  let effectiveOverride = null;

  // The CONTRACT's hours, not the row's: a settled on-site extension moved
  // the row and left the contract (contractDuration.js). Loaded on the held
  // client, inside the caller's transaction.
  const contractHours = await contractDurationHours(client, proposal.id, proposal.event_duration_hours);

  // Every engine call here takes its inputs from catalogEngineArgs, the
  // builder computeCatalogSnapshot shares, so the override conversion prices
  // a booking exactly the way this fold does.
  const legArgs = (leg) => catalogEngineArgs({ proposal, pkg, contractHours, ...leg });
  const beforeLeg = {
    numBars: numBarsBefore, numBartenders: bartendersBefore,
    addons: addonsBefore, syrups: syrupsBefore, adjustments: adjBefore,
  };
  const afterLeg = {
    numBars: numBarsAfter, numBartenders: bartendersAfter,
    addons: addonsAfter, syrups: syrupsAfter, adjustments: adjAfter,
  };

  if (hasOverride) {
    // Both legs price at CATALOG: the builder never passes an override. They
    // carry the row's mandate floor like every other compute here; the engine
    // reads the floor into snapshot.gratuity.floor_rate only, never into a
    // total, so the delta below cannot move with it.
    const catalogBefore = calculateProposal(legArgs(beforeLeg));
    const catalogAfter = calculateProposal(legArgs(afterLeg));
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

  // The After legs at the contract price (null on a native proposal). The
  // stored gratuity rate, jar and mandate floor ride in from the row through
  // the builder (section 5 preserve stored gratuity).
  const snapshot = calculateProposal({ ...legArgs(afterLeg), totalPriceOverride: effectiveOverride });

  // Write the override alongside the total so the two can never drift
  // apart again (the stranded-column state that left that 2026-07-16 row
  // inconsistent). For a native proposal effectiveOverride is null and
  // the column is already null, so this is a no-op there.
  await client.query(
    'UPDATE proposals SET total_price = $1, pricing_snapshot = $2, total_price_override = $4, updated_at = NOW() WHERE id = $3',
    [snapshot.total, JSON.stringify(snapshot), proposal.id, effectiveOverride]
  );

  // F2 (CLAUDE.md cross-cutting: price moved -> re-evaluate payment status).
  // The extras just moved total_price; a fully-paid proposal that now owes
  // must not keep showing "Paid in Full", and a deposit_paid row whose paid
  // covers the new total (a lab add then remove, prod 823) must return to
  // balance_paid or it never auto-completes. Mirror crud.js: the shared
  // ladder moves both ways; autopay is disarmed only on the was-fully-paid
  // demotion. reconcile is pure; the UPDATE uses the
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

// The proposals columns computeCatalogSnapshot reads. A row without one of
// them (a column subset, such as an export row) would price silently wrong: a
// flat package with no guest count drops staffing and syrup volume, and the
// agreed-price line would absorb the error. So the compute refuses such a row
// before any query, naming the fields. Null is a real value for most of them,
// never for these three: nothing can be priced without them.
const CATALOG_ROW_FIELDS = Object.freeze([
  'id', 'package_id', 'guest_count', 'event_duration_hours', 'num_bars', 'num_bartenders',
  'gratuity_rate', 'tip_jar', 'gratuity_floor_rate', 'adjustments', 'pricing_snapshot',
]);
const CATALOG_ROW_VALUES = Object.freeze(['id', 'guest_count', 'event_duration_hours']);

/**
 * The engine output for a booking's CURRENT inputs at TODAY's catalog with no
 * override (plan 2026-10-16-price-override-removal, Task F2; spec section
 * 8.2): the package row, the reprice-ready add-ons, the stored syrup
 * selections as they are (already past the self-provided filter; there is no
 * request to filter with), the row's bars and bartenders, the contract's
 * hours, the row's gratuity rate, tip jar and mandate floor, and the row's
 * adjustment lines unless `adjustments` is given. It goes through the fold's
 * own catalogEngineArgs, so it equals what the fold computes for the same
 * inputs. It only reads.
 *
 * Run it on the transaction client that read (or locked) `proposal`, never
 * the pool: its three reads must see the same state as the row, or it prices
 * one state's add-ons against another's bars and lines. The pool is refused.
 * The override conversion runs it inside a rolled-back transaction on a
 * branch of prod.
 *
 * @param {object} client    the transaction client that read `proposal`
 * @param {object} proposal  the whole proposals row (SELECT *); a row missing
 *                           a field it reads is refused (CATALOG_ROW_FIELDS)
 * @param {{adjustments?: Array}} [options]  lines to price instead of the row's
 * @returns {Promise<object>} the pricing snapshot
 */
async function computeCatalogSnapshot(client, proposal, { adjustments } = {}) {
  if (client instanceof Pool) {
    throw new Error('computeCatalogSnapshot runs on the transaction client that read the proposal row, never the pool');
  }
  const values = new Map(Object.entries(proposal || {}));
  const missing = CATALOG_ROW_FIELDS.filter((f) => values.get(f) === undefined
    || (values.get(f) === null && CATALOG_ROW_VALUES.includes(f)));
  if (missing.length > 0) {
    throw new Error(`computeCatalogSnapshot needs the whole proposals row (SELECT *); missing: ${missing.join(', ')}`);
  }
  const pkg = (await client.query('SELECT * FROM service_packages WHERE id = $1', [proposal.package_id])).rows[0];
  if (!pkg) {
    throw new Error(`computeCatalogSnapshot: proposal ${proposal.id} has no package to price`);
  }
  const addons = await loadRepriceAddons(client, proposal.id);
  const contractHours = await contractDurationHours(client, proposal.id, proposal.event_duration_hours);
  const stored = readSnapshot(proposal.pricing_snapshot, { context: 'proposalExtrasFold.catalog' });
  return calculateProposal(catalogEngineArgs({
    proposal,
    pkg,
    contractHours,
    numBars: proposal.num_bars ?? 0,
    numBartenders: proposal.num_bartenders,
    addons,
    syrups: stored?.syrups?.selections || [],
    adjustments: adjustments ?? proposal.adjustments ?? [],
  }));
}

module.exports = { foldExtrasIntoProposal, loadRepriceAddons, withRepriceQuantities, computeCatalogSnapshot };
