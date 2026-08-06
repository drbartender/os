'use strict';

/**
 * Service-area geometry for the Out-of-Area Bonus and the Remote Staffing Fee
 * (spec 2026-08-06-contractor-duty-pay-design.md §6).
 *
 * PUBLISHED-AMBIGUITY RULE: the suggestion bands live HERE and only here. The
 * field guide says only "shifts outside our normal service area may include an
 * Out-of-Area Bonus, at company discretion, based on staffing needs" and the
 * client-facing copy says only that travel costs may apply. No band, threshold,
 * or schedule may ever reach the browser as a literal: the CRA bundle is shared
 * with the public marketing site, so the client renders `suggested_*_cents`
 * straight off an API payload and never computes one.
 *
 * Also owns a Nominatim throttle for ITS OWN callers. `geocode.js` deliberately
 * ships no built-in rate limiting (it only exports a `delay` helper), so the
 * out-of-area callers queue behind one module-level promise chain at 1 req/sec.
 * NOTE the queue serializes only callers that go through `geocodeThrottled`:
 * six pre-existing sites call `geocodeAddress` directly and are unaffected
 * (pre-existing main behavior, out of scope for this lane). `geocode.js` now
 * carries an 8s per-request timeout so one hung lookup cannot wedge the chain.
 */

const Sentry = require('@sentry/node');
const { geocodeAddress, delay } = require('./geocode');

// Pilsen storage area, PROVISIONAL: Dallas confirms exact coordinates before push
const HOME_BASE = { lat: 41.8570, lng: -87.6560 };

// Hard cap on a single Out-of-Area Bonus, in integer cents. Mirrors the DB
// CHECK `shifts_out_of_area_bonus_cap_check` (0 < x <= 25000): the bands top
// out at $35 and a Madison-class custom is ~$100, so the cap only bounds the
// blast radius of the irreversible lock.
const OUT_OF_AREA_MAX_CENTS = 25000;

// Fewer than this many active staff homes within RADIUS miles of the venue is
// what makes an event "remote" for the client-side fee prompt (spec §6).
const REMOTE_STAFF_RADIUS_MILES = 40;
const REMOTE_STAFF_MIN_COUNT = 3;

// Nominatim's usage policy is 1 request/second from a single source.
const GEOCODE_MIN_INTERVAL_MS = 1100;

/**
 * Suggested Out-of-Area Bonus for a venue distance, in integer cents.
 * Bands: [40,60) = $10, [60,90) = $20, [90,120) = $35. Under 40 miles is not
 * out of area at all and beyond 120 is a custom judgment call (Madison-class),
 * so both return null: "no suggestion", never "no bonus".
 *
 * @param {number} miles
 * @returns {1000|2000|3500|null}
 */
function suggestOutOfAreaCents(miles) {
  const m = Number(miles);
  if (!Number.isFinite(m)) return null;
  if (m >= 40 && m < 60) return 1000;
  if (m >= 60 && m < 90) return 2000;
  if (m >= 90 && m < 120) return 3500;
  return null;
}

/** Coerce to a finite number, or null. Tolerates pg NUMERIC strings. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Great-circle miles between two points, or null when either side lacks
 * coordinates. `haversineDistance` is required lazily: autoAssign.js requires
 * THIS module back (for the approval lock stamp), and a top-level require on
 * both sides would hand one of them a half-built exports object.
 */
function milesBetween(lat1, lng1, lat2, lng2) {
  const a = num(lat1), b = num(lng1), c = num(lat2), d = num(lng2);
  if (a === null || b === null || c === null || d === null) return null;
  const { haversineDistance } = require('./autoAssign');
  return haversineDistance(a, b, c, d);
}

/** Miles from the Pilsen home base to a point, or null without coordinates. */
function milesFromHomeBase(lat, lng) {
  return milesBetween(HOME_BASE.lat, HOME_BASE.lng, lat, lng);
}

/** Display rounding: one decimal, null-safe. */
function roundMiles(miles) {
  const m = num(miles);
  return m === null ? null : Math.round(m * 10) / 10;
}

// ─── Nominatim queue ──────────────────────────────────────────────

let geocodeChain = Promise.resolve();

/**
 * Geocode behind the shared 1 req/sec queue. Resolves to {lat,lng} or null;
 * never throws (geocodeAddress already swallows its own errors, and the chain
 * absorbs a rejection so one failure cannot wedge the queue).
 */
function geocodeThrottled(address) {
  if (!address || !String(address).trim()) return Promise.resolve(null);
  const run = geocodeChain.then(async () => {
    await delay(GEOCODE_MIN_INTERVAL_MS);
    return geocodeAddress(address);
  });
  geocodeChain = run.then(() => {}, () => {});
  return run;
}

// ─── Out-of-Area lock lifecycle ───────────────────────────────────

/**
 * Stamp the out-of-area lock the moment a shift_request becomes APPROVED on a
 * shift carrying an unlocked bonus. There is no separate staffer "accept"
 * event in this system, so approval IS acceptance: admin approve, manager
 * approve, auto-assign, and cover-swap approval all call this.
 *
 * The rule lives entirely in the WHERE clause, which makes the call
 * unconditional and idempotent: a second call, a concurrent one, or a call on
 * a shift with no bonus all no-op, and an existing lock is never re-homed.
 *
 * @param {{query: Function}} executor pool or in-transaction client
 * @returns {Promise<boolean>} true when this call actually stamped the lock
 */
async function stampOutOfAreaLock(executor, shiftId, userId) {
  // `> 0` matters, not just isInteger: Number(null) is 0, which would otherwise
  // sail through as a valid id.
  const sid = Number(shiftId), uid = Number(userId);
  if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(uid) || uid <= 0) return false;
  const { rowCount } = await executor.query(
    `UPDATE shifts
        SET out_of_area_locked_at = NOW(),
            out_of_area_locked_user_id = $2
      WHERE id = $1
        AND out_of_area_bonus_cents IS NOT NULL
        AND out_of_area_locked_at IS NULL`,
    [sid, uid]
  );
  return rowCount > 0;
}

/**
 * Release the lock when its holder leaves the shift (drop, emergency drop,
 * admin deny, cover swap). The AMOUNT deliberately stays attached: the bonus
 * re-arms for whoever is approved next (spec §6).
 *
 * Pass `userId` to scope the release to that holder, so a drop by a teammate
 * can never release a lock they do not hold.
 *
 * @returns {Promise<boolean>} true when a lock was actually released
 */
async function releaseOutOfAreaLock(executor, shiftId, userId = null) {
  const sid = Number(shiftId);
  if (!Number.isInteger(sid) || sid <= 0) return false;
  const uid = Number(userId);
  const scoped = Number.isInteger(uid) && uid > 0;
  const { rowCount } = await executor.query(
    `UPDATE shifts
        SET out_of_area_locked_at = NULL,
            out_of_area_locked_user_id = NULL
      WHERE id = $1
        AND out_of_area_locked_at IS NOT NULL
        ${scoped ? 'AND out_of_area_locked_user_id = $2' : ''}`,
    scoped ? [sid, uid] : [sid]
  );
  return rowCount > 0;
}

/**
 * Duty re-derivation after an out-of-area amount or lock change. Same shape as
 * the other reversal hooks (menuPrint.js, cancelLineItem.js): fire-and-forget,
 * post-commit, its own pooled connection, never on the response path.
 *
 * `maybeReaccrueForDuty` no-ops on anything but a recently-completed proposal,
 * so a pre-event lock change costs exactly one cheap SELECT — which is the
 * common case, since bonuses are attached and locked long before the event.
 */
function reaccrueDutyForProposal(proposalId) {
  // Standalone shifts carry a NULL proposal_id, and Number(null) is 0, so the
  // positivity check is what actually keeps those out.
  const pid = Number(proposalId);
  if (!Number.isInteger(pid) || pid <= 0) return;
  setImmediate(() => {
    require('./payrollAccrual').maybeReaccrueForDuty(pid).catch((err) => {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, {
          tags: { feature: 'out-of-area', step: 'duty_reaccrual' },
          extra: { proposalId: pid },
        });
      }
      console.error('[serviceArea] duty re-accrual failed (non-blocking):', err.message);
    });
  });
}

module.exports = {
  HOME_BASE,
  OUT_OF_AREA_MAX_CENTS,
  REMOTE_STAFF_RADIUS_MILES,
  REMOTE_STAFF_MIN_COUNT,
  GEOCODE_MIN_INTERVAL_MS,
  suggestOutOfAreaCents,
  milesFromHomeBase,
  milesBetween,
  roundMiles,
  geocodeThrottled,
  stampOutOfAreaLock,
  releaseOutOfAreaLock,
  reaccrueDutyForProposal,
};
