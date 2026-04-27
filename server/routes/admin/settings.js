const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const { sendEmail } = require('../../utils/email');
const { geocodeAddress, buildAddressString, delay } = require('../../utils/geocode');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError } = require('../../utils/errors');

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

  for (const [key, value] of entries) {
    await pool.query(`
      INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, String(value)]);
  }

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

/** GET /api/admin/badge-counts — sidebar notification counts */
router.get('/badge-counts', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM proposals WHERE status IN ('sent', 'viewed', 'modified'))::int AS pending_proposals,
      (SELECT COUNT(*) FROM shifts
       WHERE event_date >= CURRENT_DATE AND status = 'open'
         AND jsonb_typeof(positions_needed::jsonb) = 'array'
         AND jsonb_array_length(positions_needed::jsonb) > 0
         AND (SELECT COUNT(*) FROM shift_requests sr WHERE sr.shift_id = shifts.id AND sr.status = 'approved')
             < jsonb_array_length(positions_needed::jsonb)
      )::int AS unstaffed_events,
      (SELECT COUNT(*) FROM applications a
         JOIN users u ON u.id = a.user_id
         WHERE u.onboarding_status = 'applied')::int AS new_applications,
      (SELECT COUNT(*) FROM drink_plans
         WHERE shopping_list_status = 'pending_review')::int AS pending_shopping_lists
  `);
  res.json(result.rows[0]);
}));

module.exports = router;
