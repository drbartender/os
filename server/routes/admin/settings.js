const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly, requireAdminOrManager } = require('../../middleware/auth');
const { sendEmail } = require('../../utils/email');
const { geocodeAddress, buildAddressString, delay } = require('../../utils/geocode');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError } = require('../../utils/errors');
const { getStripPayload } = require('../../utils/presenceStore');
// THE shift-visibility predicate, shared with GET /api/shifts/unstaffed-upcoming.
const { shiftNotFinishedSql } = require('../../utils/shiftEndInstant');

const router = express.Router();

// ─── Test Email ──────────────────────────────────────────────────

router.post('/test-email', auth, adminOnly, asyncHandler(async (req, res) => {
  const { to } = req.body;
  if (!to) throw new ValidationError({ to: 'Recipient email (to) is required.' });

  const result = await sendEmail({
    to,
    subject: 'Dr. Bartender - Test Email',
    html: `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h1 style="color: #2d1810; text-align: center;">Dr. Bartender</h1>
        <p style="color: #333; font-size: 16px; text-align: center;">
          If you're reading this, email sending is working!
        </p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;" />
        <p style="color: #999; font-size: 12px; text-align: center;">
          This is a test email from drbartender.com
        </p>
      </div>
    `,
  });
  res.json({ success: true, id: result.id });
}));

// ─── App Settings ────────────────────────────────────────────────

router.get('/settings', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT key, value FROM app_settings');
  const settings = {};
  for (const row of result.rows) {
    settings[row.key] = row.value;
  }
  res.json(settings);
}));

router.put('/settings', auth, adminOnly, asyncHandler(async (req, res) => {
  const entries = Object.entries(req.body);
  if (entries.length === 0) throw new ValidationError({ _form: 'No settings provided.' });

  await pool.query(`
    INSERT INTO app_settings (key, value, updated_at)
    SELECT k, v, NOW() FROM unnest($1::text[], $2::text[]) AS t(k, v)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [entries.map((e) => e[0]), entries.map((e) => String(e[1]))]);

  const result = await pool.query('SELECT key, value FROM app_settings');
  const settings = {};
  for (const row of result.rows) {
    settings[row.key] = row.value;
  }
  res.json(settings);
}));

// ─── Backfill Geocodes ──────────────────────────────────────────

router.post('/backfill-geocodes', auth, adminOnly, asyncHandler(async (req, res) => {
  // Backfill contractor_profiles
  const profiles = await pool.query(`
    SELECT user_id, street_address, city, state, zip_code
    FROM contractor_profiles
    WHERE lat IS NULL AND (street_address IS NOT NULL OR city IS NOT NULL)
  `);

  let profileCount = 0;
  for (const p of profiles.rows) {
    const addr = buildAddressString(p);
    if (!addr) continue;
    const coords = await geocodeAddress(addr);
    if (coords) {
      await pool.query('UPDATE contractor_profiles SET lat = $1, lng = $2 WHERE user_id = $3', [coords.lat, coords.lng, p.user_id]);
      profileCount++;
    }
    await delay(1100); // Nominatim rate limit
  }

  // Backfill shifts
  const shifts = await pool.query(`
    SELECT id, location FROM shifts WHERE lat IS NULL AND location IS NOT NULL
  `);

  let shiftCount = 0;
  for (const s of shifts.rows) {
    const coords = await geocodeAddress(s.location);
    if (coords) {
      await pool.query('UPDATE shifts SET lat = $1, lng = $2 WHERE id = $3', [coords.lat, coords.lng, s.id]);
      shiftCount++;
    }
    await delay(1100);
  }

  // Backfill hire_date for hired staff without one
  const hireResult = await pool.query(`
    UPDATE contractor_profiles cp
    SET hire_date = u.created_at::date
    FROM users u
    WHERE cp.user_id = u.id
      AND cp.hire_date IS NULL
      AND u.onboarding_status IN ('hired', 'submitted', 'reviewed', 'approved')
  `);

  res.json({
    profiles_geocoded: profileCount,
    shifts_geocoded: shiftCount,
    hire_dates_backfilled: hireResult.rowCount,
  });
}));

// ─── Badge Counts ───────────────────────────────────────────────

/** GET /api/admin/badge-counts - sidebar notification counts.
 *  Managers share the admin dashboard, so they may read these counts. The two
 *  exceptions are new_applications and pending_reviews: the Hiring and Reviews
 *  surfaces are adminOnly, so both counts are zeroed for managers below. */
router.get('/badge-counts', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM proposals WHERE status IN ('sent', 'viewed', 'modified'))::int AS pending_proposals,
      -- unstaffed_events is the COUNT for the LIST rendered by
      -- GET /api/shifts/unstaffed-upcoming, and both measure "upcoming" with
      -- THE shift-visibility predicate: the shift's end instant has not passed
      -- (server/utils/shiftEndInstant.js). One imported fragment, so the badge
      -- and the modal cannot disagree. On CURRENT_DATE (the GMT day on this
      -- session) this badge read zero from 19:00 Chicago while the list it
      -- counts still showed tonight's short-staffed shift; a later round then
      -- moved one side to the Chicago day and left the other, which is the same
      -- divergence wearing a different hat. Change one, change both.
      -- The LEFT JOIN is what supplies event_timezone (a shift may have no
      -- proposal; the fragment falls back to America/Chicago).
      (SELECT COUNT(*) FROM shifts s
         LEFT JOIN proposals p ON p.id = s.proposal_id
       WHERE ${shiftNotFinishedSql('s', 'p')} AND s.status = 'open'
         -- IS JSON ARRAY, byte-for-byte the guard GET /shifts/unstaffed-upcoming
         -- uses, NOT jsonb_typeof(...::jsonb). positions_needed is TEXT, so the
         -- CAST raises 22P02 on malformed content BEFORE jsonb_typeof can
         -- classify it: one bad row 500s this badge while the list it counts
         -- shrugs and carries on. Same divergence the comment above forbids,
         -- one layer down from the date predicate.
         AND s.positions_needed IS JSON ARRAY
         AND jsonb_array_length(s.positions_needed::jsonb) > 0
         AND (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = s.id AND sr.status = 'approved' AND sr.dropped_at IS NULL)
             < jsonb_array_length(s.positions_needed::jsonb)
      )::int AS unstaffed_events,
      (SELECT COUNT(*) FROM applications a
         JOIN users u ON u.id = a.user_id
         WHERE u.onboarding_status = 'applied')::int AS new_applications,
      (SELECT COUNT(*) FROM drink_plans
         WHERE shopping_list_status = 'pending_review')::int AS pending_shopping_lists,
      (SELECT COUNT(*) FROM sms_messages
         WHERE direction = 'inbound' AND read_at IS NULL AND client_id IS NOT NULL)::int AS unread_sms,
      (SELECT COUNT(*) FROM staff_reviews WHERE status = 'pending')::int AS pending_reviews
  `);
  const counts = result.rows[0];
  // Hiring is admin-only; don't surface the applicant count to managers.
  if (req.user.role !== 'admin') counts.new_applications = 0;
  // Reviews is admin-only too; a manager must not see a decision they cannot open.
  if (req.user.role !== 'admin') counts.pending_reviews = 0;
  // Presence strip block rides the existing 60s poll (spec: Fetch and display).
  // Non-fatal by design: a presence failure must never break badge counts.
  try {
    counts.presence = await getStripPayload();
  } catch (err) {
    console.warn('[badge-counts] presence block failed:', err.message);
    counts.presence = null;
  }
  res.json(counts);
}));

module.exports = router;
