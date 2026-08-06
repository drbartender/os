/**
 * Remote Staffing Fee support (spec 2026-08-06-contractor-duty-pay-design.md §6).
 *
 * Carved out of crud.js rather than added to it: crud.js sits at 879 lines and
 * these two endpoints would push it against the 1000-line hard cap, which is
 * exactly the pressure that produced getOne.js and list.js. Mounted from
 * index.js BEFORE getOne.js, which owns the greedy `/:id`.
 *
 * The Remote Staffing Fee is a CLIENT-side object and is never linked to the
 * staff-side Out-of-Area Bonus: an unpriced remote event just means DRB absorbs
 * the bonus, by design. This file only answers "is this venue remote, and who
 * could realistically staff it?"; the fee itself lands as an ordinary surcharge
 * in `proposals.adjustments` through the existing editor PATCH, so no new money
 * path exists here.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { composeVenueMapQuery, isVenueComplete } = require('../../utils/venueAddress');
// Namespace import on purpose: the geocode call is reached as
// `serviceArea.geocodeThrottled(...)` so a suite can stub it without any
// network, and so the bands stay in exactly one module.
const serviceArea = require('../../utils/serviceArea');

const router = express.Router();

/**
 * GET /api/proposals/:id/remote-staffing-check
 *
 * Answers the admin send surfaces: how far out is this venue, and how many
 * active staffers actually live near it? Geocodes the venue ON DEMAND (once,
 * persisted to proposals.venue_lat/lng) when it carries a street address.
 *
 * Street-less venues are NOT geocoded: Nominatim returns a city centroid for
 * those with no confidence signal, and a guessed centroid would drive a real
 * client charge. No street means `venue_distance_miles: null`, which disables
 * the popup entirely. Never guess.
 *
 * Counting rules (spec §6): "active staff" is `onboarding_status = 'approved'`,
 * one definition. A staffer with no geocoded home address is surfaced in
 * `staff_uncounted` and is NEVER silently counted as far away.
 */
router.get('/:id/remote-staffing-check', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError({ id: 'Invalid proposal id.' });

  const { rows } = await pool.query(
    `SELECT id, venue_name, venue_street, venue_city, venue_state, venue_zip,
            venue_lat, venue_lng, remote_fee_prompted_at, accepted_at
       FROM proposals WHERE id = $1`,
    [id]
  );
  if (!rows[0]) throw new NotFoundError('Proposal not found');
  const proposal = rows[0];

  let lat = proposal.venue_lat === null || proposal.venue_lat === undefined ? null : Number(proposal.venue_lat);
  let lng = proposal.venue_lng === null || proposal.venue_lng === undefined ? null : Number(proposal.venue_lng);

  if ((lat === null || lng === null) && isVenueComplete(proposal)) {
    const address = composeVenueMapQuery(proposal);
    if (address) {
      // Throttled through the shared 1 req/sec Nominatim queue. A failure
      // resolves null and simply leaves the venue uncoordinated: a geocode
      // hiccup must never block a send.
      const coords = await serviceArea.geocodeThrottled(address);
      if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
        lat = coords.lat;
        lng = coords.lng;
        await pool.query(
          'UPDATE proposals SET venue_lat = $1, venue_lng = $2 WHERE id = $3',
          [lat, lng, id]
        );
      }
    }
  }

  const venueMiles = serviceArea.milesFromHomeBase(lat, lng);

  // Active staff = approved onboarding AND a WORKER role. Managers are a worker
  // class everywhere else in this codebase (`coverBroadcast.js` fans cover
  // requests to role IN ('staff','manager'), and `assignShiftHandler` accepts
  // the same set), so the question "who could actually work this venue?" has to
  // use the same definition here. Excluding a nearby manager would under-report
  // staff_within_40, over-fire the prompt, and push toward billing a client for
  // travel we do not have.
  //
  // The ADMIN/owner is the one deliberate exclusion: Dallas is always
  // available, so counting him would put a body within 40 miles of every
  // Chicago-area venue and mask exactly the roster shortage this detector
  // exists to find.
  const staffRes = await pool.query(
    `SELECT cp.lat, cp.lng
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.onboarding_status = 'approved' AND u.role IN ('staff', 'manager')`
  );

  let staffWithin = 0;
  let staffUncounted = 0;
  for (const row of staffRes.rows) {
    // "Uncounted" is a property of the STAFFER (no geocoded home address), not
    // of the venue: a staffer we cannot place is reported, never assumed far.
    if (row.lat === null || row.lat === undefined || row.lng === null || row.lng === undefined) {
      staffUncounted += 1;
      continue;
    }
    const miles = serviceArea.milesBetween(row.lat, row.lng, lat, lng);
    if (miles !== null && miles < serviceArea.REMOTE_STAFF_RADIUS_MILES) staffWithin += 1;
  }

  const prompted = !!proposal.remote_fee_prompted_at;
  const accepted = !!proposal.accepted_at;
  res.json({
    proposal_id: id,
    venue_distance_miles: serviceArea.roundMiles(venueMiles),
    staff_within_40: staffWithin,
    staff_uncounted: staffUncounted,
    suggested_fee_cents: serviceArea.suggestOutOfAreaCents(venueMiles),
    prompted,
    accepted,
    // The whole trigger lives server-side with the bands, so the client renders
    // a decision instead of making one. Four gates:
    //   - the venue has coordinates at all;
    //   - it is genuinely FAR (>= 40 mi). Under that it is a normal local job:
    //     the premise of the fee is travel, and prompting at 5 miles would also
    //     print "this venue is about 5 miles out", which reads as a bug;
    //   - fewer than 3 active staffers live near it;
    //   - nobody has answered for this proposal yet;
    //   - AND the client has not already signed. Billed at proposal time or
    //     never: adding a surcharge behind an ACCEPTED proposal would change
    //     the number a client already agreed to (spec §6).
    should_prompt: venueMiles !== null
      && venueMiles >= serviceArea.REMOTE_STAFF_RADIUS_MILES
      && staffWithin < serviceArea.REMOTE_STAFF_MIN_COUNT
      && !prompted
      && !accepted,
  });
}));

/**
 * POST /api/proposals/:id/remote-fee-prompt-answered
 *
 * Answered once per proposal: EVERY choice (add suggested, add custom, send
 * without) stamps this, so a repeat send never re-nags the admin about a
 * decision they already made.
 */
router.post('/:id/remote-fee-prompt-answered', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError({ id: 'Invalid proposal id.' });
  const { rows } = await pool.query(
    'UPDATE proposals SET remote_fee_prompted_at = NOW() WHERE id = $1 RETURNING remote_fee_prompted_at',
    [id]
  );
  if (!rows[0]) throw new NotFoundError('Proposal not found');
  res.json({ prompted: true, prompted_at: rows[0].remote_fee_prompted_at });
}));

module.exports = router;
