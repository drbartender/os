// server/utils/legalHold.js
'use strict';
// The legal-hold seam (spec 2026-10-16 section 5.3, plan decision 7; Task A2
// amended 2026-10-17 from the lane review): the one function the legal-hold
// guards this spec adds call, at the writer each protects, before it touches
// a booking. A held booking keeps the price it has; a guard that gets `true`
// refuses and writes nothing.
//
// It FAILS CLOSED. An id is read only as a positive safe integer or a string
// of plain decimal digits; anything else reads as held. Postgres 17 reads
// '6_00' and '+0x258' as 600 where Number() gives NaN, so an id the seam
// cannot read the way the database will must never answer "not held".
//
// The ids are LEGAL_HOLD_PROPOSAL_IDS (staleProposalSweep.js), read at CALL
// time, never destructured at load: the sweep's load-time require graph
// already pulls in about 50 modules (the pricing engine among them), so a
// guard added to any of them would form a require cycle, and a load-time
// read inside it would keep the sweep's half-built exports for good. A
// missing list throws rather than answering "not held".
//
// Suites ADD synthetic ids through __setLegalHoldIdsForTest. A test list
// never replaces the real one, so no process can read a real hold as unheld
// through the seam, and no suite reads or writes a real held booking.

const PLAIN_DIGITS = /^[0-9]+$/;

let testIds = null; // ids added by a suite; null = none

// The id as a positive safe integer, or null when it is anything else.
function readId(id) {
  let n = NaN;
  if (typeof id === 'number') n = id;
  else if (typeof id === 'string' && PLAIN_DIGITS.test(id)) n = Number(id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function heldIds() {
  const real = require('./staleProposalSweep').LEGAL_HOLD_PROPOSAL_IDS;
  if (!Array.isArray(real)) {
    throw new Error('legalHold: LEGAL_HOLD_PROPOSAL_IDS is missing from staleProposalSweep.js');
  }
  return testIds ? [...real, ...testIds] : real;
}

/**
 * True when proposal `id` is on legal hold, and true for any id that is not a
 * positive safe integer or a string of plain decimal digits (fails closed).
 */
function isLegalHold(id) {
  const n = readId(id);
  if (n === null) return true;
  return heldIds().some((held) => Number(held) === n);
}

/**
 * Test-only: ADD these ids to the real held list (each call replaces the ids
 * a previous call added), or clear them with null. Each id must read the way
 * isLegalHold reads one. Refuses under NODE_ENV=production.
 */
function __setLegalHoldIdsForTest(ids) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setLegalHoldIdsForTest refuses to run in production');
  }
  if (ids === null) {
    testIds = null;
    return;
  }
  if (!Array.isArray(ids)) {
    throw new TypeError('__setLegalHoldIdsForTest takes an array of ids to add, or null to clear them');
  }
  const read = ids.map(readId);
  if (read.some((n) => n === null)) {
    throw new TypeError('__setLegalHoldIdsForTest takes positive integer ids (a number or plain decimal digits)');
  }
  testIds = Object.freeze(read);
}

module.exports = { isLegalHold, __setLegalHoldIdsForTest };
