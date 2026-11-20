// The legal-hold exclusion a shared read takes, checked before it reaches SQL.
//
// A shared read (server/utils/reads/) takes an optional `exclude` of
// { proposalIds, clientIds }, the lists legalHold.holdExclusion() returns
// (spec 2026-11-19 law 1). Absent (undefined or null), the read answers the
// admin screen exactly as before. Present, it must be exactly that shape with
// every id a positive integer in the Postgres integer range: anything else
// throws rather than reading as "nothing to exclude", because a malformed
// exclusion that quietly excluded nothing would hand the held booking to the
// connector (fails closed). The lists are bound as two int[] parameters in the
// SQL that picks the rows, so a cap or a group limit never shows a gap.

const PG_INT_MAX = 2147483647;
const PLAIN_DIGITS = /^[0-9]+$/;

function readId(id) {
  let n = NaN;
  if (typeof id === 'number') n = id;
  else if (typeof id === 'string' && PLAIN_DIGITS.test(id)) n = Number(id);
  return Number.isSafeInteger(n) && n > 0 && n <= PG_INT_MAX ? n : null;
}

function readList(list, name) {
  if (!Array.isArray(list)) throw new TypeError(`hold exclusion: ${name} must be a list of ids`);
  const ids = list.map(readId);
  if (ids.some((n) => n === null)) throw new TypeError(`hold exclusion: ${name} holds an id that is not a positive integer`);
  return [...new Set(ids)];
}

/**
 * The exclusion as two clean int lists, or null when none was given.
 * @param {{proposalIds: number[], clientIds: number[]}|null|undefined} exclude
 * @returns {{proposalIds: number[], clientIds: number[]}|null}
 * @throws {TypeError} on any other shape (fails closed)
 */
function readExclusion(exclude) {
  if (exclude === undefined || exclude === null) return null;
  if (typeof exclude !== 'object' || Array.isArray(exclude)) {
    throw new TypeError('hold exclusion: pass { proposalIds, clientIds } or nothing');
  }
  return { proposalIds: readList(exclude.proposalIds, 'proposalIds'), clientIds: readList(exclude.clientIds, 'clientIds') };
}

/**
 * An id a by-id lookup was handed, read strictly: a positive integer, or null
 * for anything else (a lookup under an exclusion answers not-found then, never
 * lets Postgres read '6_00' as 600).
 */
function readLookupId(id) {
  return readId(id);
}

module.exports = { readExclusion, readLookupId };
