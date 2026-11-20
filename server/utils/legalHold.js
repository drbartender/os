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
//
// heldProposalIds() is the same list for a job's SQL (money law 15; plan
// 2026-11-05 lane legal-hold-auto): every automatic job and bulk script binds
// it as ONE int[] parameter at the query that picks its rows, and calls it
// before its first write, so a missing list, or an id it cannot bind as a
// Postgres integer, stops the run before it touches a row. A per-id check
// stays isLegalHold.
//
// heldClientIds() is the held proposals' clients and holdExclusion() both
// lists together (spec 2026-11-19 law 1): what a Claude connector read binds
// to leave out the held booking, its client and that client's every other
// booking. Both read the list through heldProposalIds and fail closed alike.

const PLAIN_DIGITS = /^[0-9]+$/;
const PG_INT_MAX = 2147483647; // proposals.id is a Postgres integer

let testIds = null; // ids added by a suite; null = none

// The id as a positive safe integer, or null when it is anything else.
function readId(id) {
  let n = NaN;
  if (typeof id === 'number') n = id;
  else if (typeof id === 'string' && PLAIN_DIGITS.test(id)) n = Number(id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// The held list (the real one plus any test ids) as positive safe integers.
// Every real entry is read the way an id is read, and one it cannot read
// throws: a malformed list never answers "not held", so isLegalHold and
// heldProposalIds fail closed alike.
function heldIds() {
  const real = require('./staleProposalSweep').LEGAL_HOLD_PROPOSAL_IDS;
  if (!Array.isArray(real)) {
    throw new Error('legalHold: LEGAL_HOLD_PROPOSAL_IDS is missing from staleProposalSweep.js');
  }
  const ids = real.map(readId);
  if (ids.some((n) => n === null)) {
    throw new Error('legalHold: LEGAL_HOLD_PROPOSAL_IDS holds an id that is not a positive integer');
  }
  return testIds ? [...ids, ...testIds] : ids;
}

/**
 * True when proposal `id` is on legal hold, and true for any id that is not a
 * positive safe integer or a string of plain decimal digits (fails closed).
 */
function isLegalHold(id) {
  const n = readId(id);
  if (n === null) return true;
  return heldIds().some((held) => held === n);
}

/**
 * The held proposal ids (the real list plus any test ids) as positive
 * integers, read at call time, each once: bind them as one int[] parameter.
 * Throws when the list is missing or holds an id that does not read as a
 * positive integer within the Postgres integer range (fails closed).
 */
function heldProposalIds() {
  const ids = heldIds();
  if (ids.some((n) => n > PG_INT_MAX)) {
    throw new Error('legalHold: LEGAL_HOLD_PROPOSAL_IDS holds an id that is not a positive integer');
  }
  return [...new Set(ids)];
}

// The held proposals' clients (spec 2026-11-19 law 1), as the Inbox hold
// derives them (inbox/engine.js HELD_KEYS_SQL, its `held` arm).
const HELD_CLIENT_IDS_SQL = `
  SELECT DISTINCT client_id FROM proposals
   WHERE id = ANY($1::int[]) AND client_id IS NOT NULL
   ORDER BY client_id`;

/**
 * The client ids of the held proposals (spec 2026-11-19 law 1): every booking
 * of such a client is held from a connector answer. Reads the held list
 * through heldProposalIds, so a missing or malformed list throws before any
 * query; a failed query throws; and a client id the database hands back that
 * does not read as a positive integer throws (fails closed, as its siblings
 * do). A held id with no proposals row has no client to hold. `db` is any
 * object with pg's query(); the pool when none is given (required at call
 * time, so this file adds nothing to the sweep's load-time graph).
 */
async function heldClientIds(db) {
  const ids = heldProposalIds();
  if (ids.length === 0) return [];
  const conn = db || require('../db').pool;
  const { rows } = await conn.query(HELD_CLIENT_IDS_SQL, [ids]);
  if (!Array.isArray(rows)) throw new Error('legalHold: the held clients could not be read');
  const clients = rows.map((r) => readId(r && r.client_id));
  if (clients.some((n) => n === null || n > PG_INT_MAX)) {
    throw new Error('legalHold: a held proposal names a client id that is not a positive integer');
  }
  return [...new Set(clients)];
}

/**
 * The exclusion a connector read binds (spec 2026-11-19 law 1): the held
 * proposal ids and the held client ids, each a list of positive integers, read
 * at call time through the two fail-closed functions above. Throws as they do.
 */
async function holdExclusion(db) {
  const proposalIds = heldProposalIds();
  const clientIds = await heldClientIds(db);
  return { proposalIds, clientIds };
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

module.exports = {
  isLegalHold, heldProposalIds, heldClientIds, holdExclusion, HELD_CLIENT_IDS_SQL, __setLegalHoldIdsForTest,
};
