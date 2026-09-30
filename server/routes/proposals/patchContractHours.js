'use strict';
// The two durations an admin PATCH works with, resolved in one place so
// crud.js (at its line cap) cannot cross them:
//
//   workedHours   what the row STORES: the body's event_duration_hours, else
//                 the stored value. The curfew gate, syncShiftsFromProposal and
//                 the end-time display read it.
//   contractHours what the contract is PRICED at: workedHours minus the hours
//                 settled on-site extensions added (contractDuration.js).
//                 calculateProposal and resolveGratuityForPatch read it.
//
// Spec: docs/superpowers/specs/2026-09-30-extension-contract-duration-design.md
//
// The guard: a duration CHANGE while an extension request is pending is
// refused. settleExtension writes the row to the request's absolute
// requested_duration_hours, so an edit made underneath a pending request is
// silently overwritten at settle, and it would also break the subtraction.
// The comparison is by value: the editor sends event_duration_hours on every
// save, so presence means nothing, and a start-time fix that unblocks a
// curfew refusal must go through.
const { ValidationError } = require('../../utils/errors');
const { loadSettledExtensions, contractHoursFrom, reportContractHours } = require('../../utils/contractDuration');

const PENDING_MESSAGE = 'An extension request is pending for this event. Override or cancel it from the event page first.';

function durationChanged(bodyValue, storedValue) {
  if (bodyValue === undefined || bodyValue === null) return false;
  const next = Number(bodyValue);
  const prev = Number(storedValue);
  if (!Number.isFinite(next) || !Number.isFinite(prev)) return next !== prev;
  return Math.abs(next - prev) > 1e-9;
}

/**
 * @param {import('pg').PoolClient} dbClient  the PATCH's held transaction client
 * @param {{ proposalId: number|string, old: object, bodyDuration: any }} args
 * @returns {Promise<{ workedHours: number, contractHours: number }>}
 */
async function resolvePatchHours(dbClient, { proposalId, old, bodyDuration }) {
  const workedHours = bodyDuration ?? Number(old.event_duration_hours);

  if (durationChanged(bodyDuration, old.event_duration_hours)) {
    const pending = await dbClient.query(
      "SELECT id FROM service_extensions WHERE proposal_id = $1 AND status = 'pending' LIMIT 1",
      [proposalId]
    );
    if (pending.rowCount > 0) {
      throw new ValidationError({ event_duration_hours: PENDING_MESSAGE });
    }
  }

  const settled = await loadSettledExtensions(dbClient, proposalId);
  const result = contractHoursFrom(workedHours, settled);
  reportContractHours(proposalId, result, workedHours);
  return { workedHours, contractHours: result.hours };
}

module.exports = { resolvePatchHours, durationChanged, PENDING_MESSAGE };
