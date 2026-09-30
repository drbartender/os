'use strict';
/**
 * Contract hours vs worked hours after an on-site extension.
 *
 * Spec: docs/superpowers/specs/2026-09-30-extension-contract-duration-design.md
 *
 * proposals.event_duration_hours is the duration the bar WORKS. Before an
 * on-site extension it is also the duration the contract was PRICED at; a
 * settled extension moves the first and leaves the second (its money lives on
 * its own invoice, off the contract). Every re-price of the contract, and
 * every inversion of a stored add-on quantity, needs the priced duration:
 *
 *   contract hours = row hours
 *                    minus the hours settled extensions added
 *                    but never below the hours the first settled extension
 *                    found contracted.
 *
 * The lower bound covers the hand revert the runbook permits after a refund:
 * a row reverted to 4h with a paid extension row still counted would derive
 * 3h and under-price every hourly line. When the clamp binds, or the result
 * is below MIN_HOURS (corrupt data), the caller is told and Sentry is paged;
 * the corrupt case falls back to the row's hours, never to a silent
 * under-bill. Nothing is stored; the value is derived from rows that already
 * exist, so there is nothing to backfill and nothing to roll back.
 *
 * Callers inside a transaction pass their held client (one pooled connection
 * per request). Preview paths may pass the pool.
 */
const Sentry = require('@sentry/node');
const { SETTLE_OUTCOMES } = require('./serviceExtensionOutcomes');

const MIN_HOURS = 0.5;
// Durations are NUMERIC(4,1); keep the arithmetic on that grid so 5.0 - 1.0
// can never come back as 3.9999999.
const tenths = (n) => Math.round(Number(n) * 10) / 10;

/**
 * The rule on its aggregate inputs. Pure.
 * @param {number|string} rowHours     proposals.event_duration_hours
 * @param {number|string} addedHours   sum of (requested - contracted) over settled rows
 * @param {number|string|null} minContractedHours  MIN(contracted) over settled rows, null when none
 * @returns {{ hours: number, settled: number, clamped: boolean, corrupt: boolean }}
 *   hours: the contract's hours; settled: row hours minus that (what a client
 *   payload reports as settled_extension_hours, consistent even when clamped).
 */
function contractHoursFromAggregate(rowHours, addedHours, minContractedHours) {
  const row = Number(rowHours);
  const none = { hours: row, settled: 0, clamped: false, corrupt: false };
  if (!Number.isFinite(row) || row <= 0) return none;
  const added = tenths(addedHours);
  if (!(added > 0)) return none;

  let hours = tenths(row - added);
  let clamped = false;
  const floor = minContractedHours === null || minContractedHours === undefined
    ? null : Number(minContractedHours);
  if (Number.isFinite(floor) && floor > 0 && hours < floor) {
    hours = tenths(floor);
    clamped = true;
  }
  if (!(hours >= MIN_HOURS)) {
    return { hours: row, settled: 0, clamped, corrupt: true };
  }
  return { hours, settled: tenths(row - hours), clamped, corrupt: false };
}

/**
 * The rule on service_extensions rows. Pure. Rows carry `status`,
 * `contracted_duration_hours`, `requested_duration_hours` (pg strings are
 * fine); anything whose status is not a settle outcome is ignored.
 */
function contractHoursFrom(rowHours, settledRows) {
  let added = 0;
  let minContracted = null;
  for (const r of settledRows || []) {
    if (!r || !SETTLE_OUTCOMES.has(r.status)) continue;
    const c = Number(r.contracted_duration_hours);
    const q = Number(r.requested_duration_hours);
    if (!Number.isFinite(c) || !Number.isFinite(q)) continue;
    added += Math.max(0, q - c);
    minContracted = minContracted === null ? c : Math.min(minContracted, c);
  }
  return contractHoursFromAggregate(rowHours, added, minContracted);
}

/** The settled rows for one proposal, on the caller's client. */
async function loadSettledExtensions(db, proposalId) {
  const { rows } = await db.query(
    `SELECT status, contracted_duration_hours, requested_duration_hours
       FROM service_extensions
      WHERE proposal_id = $1 AND status = ANY($2)`,
    [proposalId, [...SETTLE_OUTCOMES]]
  );
  return rows;
}

function report(proposalId, result, rowHours) {
  if (!result.clamped && !result.corrupt) return;
  const line = result.corrupt
    ? `contractDuration: proposal ${proposalId} row ${rowHours}h derives under ${MIN_HOURS}h; using the row's hours`
    : `contractDuration: proposal ${proposalId} row ${rowHours}h is below what its extension started from; contract held at ${result.hours}h`;
  console.warn('[contractDuration]', line);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(line, {
      level: 'warning',
      tags: { feature: 'service-extension', issue: result.corrupt ? 'contract_hours_corrupt' : 'contract_hours_clamped' },
    });
  }
}

/**
 * The contract's hours for a proposal, as a number. Loads the settled rows on
 * `db` and reports a clamp or a corrupt derivation.
 */
async function contractDurationHours(db, proposalId, rowHours) {
  const result = contractHoursFrom(rowHours, await loadSettledExtensions(db, proposalId));
  report(proposalId, result, rowHours);
  return result.hours;
}

// For the one query that inverts stored add-on quantities in SQL
// (proposalExtrasFold.REPRICE_ADDON_SQL): the two aggregates the rule needs,
// as columns on an aliased `proposals p`. COALESCE so a proposal with no
// extension rows sums to 0, not NULL (a NULL divisor would null every count).
// The status list is an internal constant, never user input.
const settledIn = [...SETTLE_OUTCOMES].map((s) => `'${s}'`).join(', ');
const SETTLED_EXTENSION_COLUMNS = `
         COALESCE((SELECT SUM(GREATEST(se.requested_duration_hours - se.contracted_duration_hours, 0))
                     FROM service_extensions se
                    WHERE se.proposal_id = p.id AND se.status IN (${settledIn})), 0) AS pa_settled_added_hours,
         (SELECT MIN(se.contracted_duration_hours)
            FROM service_extensions se
           WHERE se.proposal_id = p.id AND se.status IN (${settledIn})) AS pa_min_contracted_hours`;

module.exports = {
  contractHoursFrom,
  contractHoursFromAggregate,
  loadSettledExtensions,
  contractDurationHours,
  reportContractHours: report,
  SETTLED_EXTENSION_COLUMNS,
  MIN_HOURS,
};
