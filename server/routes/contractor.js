const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { isValidUpload } = require('../utils/fileValidation');
const { uploadFile } = require('../utils/storage');
const { geocodeAddress, buildAddressString } = require('../utils/geocode');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');
const { validatePhone } = require('../utils/phone');

const router = express.Router();

// Fields the contractor is allowed to see in their own profile response.
// Excludes internal columns like `seniority_adjustment` (admin-only auto-assign weight).
function sanitizeProfile(profile) {
  if (!profile) return null;
  const { seniority_adjustment, ...safe } = profile; // eslint-disable-line no-unused-vars
  return safe;
}

// Get contractor profile (falls back to application data for auto-fill if profile is empty)
router.get('/', auth, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM contractor_profiles WHERE user_id = $1', [req.user.id]);
  const profile = result.rows[0];

  // A profile is "filled in" once the user has saved their preferred_name.
  // Admin-on-hire creates a skeleton row with only hire_date — treat that as empty.
  if (profile && profile.preferred_name) {
    return res.json(sanitizeProfile(profile));
  }

  // Empty or missing profile — fall back to application data for auto-fill.
  // Only the hire_date from the skeleton row is preserved; we don't spread the
  // whole profile to avoid leaking internal columns.
  const appResult = await pool.query('SELECT * FROM applications WHERE user_id = $1', [req.user.id]);
  if (appResult.rows[0]) {
    const app = appResult.rows[0];
    return res.json({
      hire_date: profile?.hire_date || null,
      _from_application: true,
      preferred_name: app.full_name,
      phone: app.phone,
      email: req.user.email,
      birth_month: app.birth_month,
      birth_day: app.birth_day,
      birth_year: app.birth_year,
      street_address: app.street_address,
      city: app.city,
      state: app.state,
      zip_code: app.zip_code,
      travel_distance: app.travel_distance,
      reliable_transportation: app.reliable_transportation,
      equipment_portable_bar: app.equipment_portable_bar,
      equipment_cooler: app.equipment_cooler,
      equipment_table_with_spandex: app.equipment_table_with_spandex,
      equipment_none_but_open: app.equipment_none_but_open,
      equipment_no_space: app.equipment_no_space,
      emergency_contact_name: app.emergency_contact_name,
      emergency_contact_phone: app.emergency_contact_phone,
      emergency_contact_relationship: app.emergency_contact_relationship,
      alcohol_certification_filename: app.basset_filename,
      alcohol_certification_file_url: app.basset_file_url,
      resume_filename: app.resume_filename,
      resume_file_url: app.resume_file_url,
      headshot_filename: app.headshot_filename,
      headshot_file_url: app.headshot_file_url,
    });
  }

  res.json(sanitizeProfile(profile) || {});
}));

// Save contractor profile
router.post('/', auth, asyncHandler(async (req, res) => {
  const {
    preferred_name, phone, email, birth_month, birth_day, birth_year,
    street_address, city, state, zip_code,
    travel_distance, reliable_transportation,
    equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
    equipment_none_but_open, equipment_no_space, equipment_will_pickup,
    emergency_contact_name, emergency_contact_phone, emergency_contact_relationship
  } = req.body;

  const fieldErrors = {};
  const phoneCheck = validatePhone(phone);
  if (phoneCheck.error) fieldErrors.phone = phoneCheck.error;
  const ecPhoneCheck = validatePhone(emergency_contact_phone);
  if (ecPhoneCheck.error) fieldErrors.emergency_contact_phone = ecPhoneCheck.error;
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  let alcohol_cert_url = null, alcohol_cert_name = null;
  let resume_url = null, resume_name = null;
  let headshot_url = null, headshot_name = null;

  // Handle file uploads
  if (req.files?.alcohol_certification) {
    const file = req.files.alcohol_certification;
    if (!isValidUpload(file)) {
      throw new ValidationError({ alcohol_certification: 'Invalid file type. Use PDF, JPEG, or PNG only.' });
    }
    const ext = path.extname(file.name);
    const filename = `${req.user.id}_alcohol_${uuidv4()}${ext}`;
    await uploadFile(file.data, filename);
    alcohol_cert_url = `/files/${filename}`;
    alcohol_cert_name = file.name;
  }

  if (req.files?.resume) {
    const file = req.files.resume;
    if (!isValidUpload(file)) {
      throw new ValidationError({ resume: 'Invalid file type. Use PDF, JPEG, or PNG only.' });
    }
    const ext = path.extname(file.name);
    const filename = `${req.user.id}_resume_${uuidv4()}${ext}`;
    await uploadFile(file.data, filename);
    resume_url = `/files/${filename}`;
    resume_name = file.name;
  }

  if (req.files?.headshot) {
    const file = req.files.headshot;
    if (!isValidUpload(file)) {
      throw new ValidationError({ headshot: 'Invalid file type. Use JPEG or PNG only.' });
    }
    const ext = path.extname(file.name);
    const filename = `${req.user.id}_headshot_${uuidv4()}${ext}`;
    await uploadFile(file.data, filename);
    headshot_url = `/files/${filename}`;
    headshot_name = file.name;
  }

  const toBool = v => v === 'true' || v === true;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, alcohol_certification_file_url, alcohol_certification_filename, resume_file_url, resume_filename, headshot_file_url, headshot_filename FROM contractor_profiles WHERE user_id = $1',
      [req.user.id]
    );

    // Keep existing file URLs if no new upload
    if (existing.rows[0]) {
      if (!alcohol_cert_url) { alcohol_cert_url = existing.rows[0].alcohol_certification_file_url; alcohol_cert_name = existing.rows[0].alcohol_certification_filename; }
      if (!resume_url) { resume_url = existing.rows[0].resume_file_url; resume_name = existing.rows[0].resume_filename; }
      if (!headshot_url) { headshot_url = existing.rows[0].headshot_file_url; headshot_name = existing.rows[0].headshot_filename; }

      await client.query(
        `UPDATE contractor_profiles SET preferred_name=$1, phone=$2, email=$3, birth_month=$4, birth_day=$5,
         birth_year=$6, street_address=$7, city=$8, state=$9, zip_code=$10,
         travel_distance=$11, reliable_transportation=$12,
         equipment_portable_bar=$13, equipment_cooler=$14, equipment_table_with_spandex=$15,
         equipment_none_but_open=$16, equipment_no_space=$17, equipment_will_pickup=$18,
         emergency_contact_name=$19, emergency_contact_phone=$20, emergency_contact_relationship=$21,
         alcohol_certification_file_url=$22, alcohol_certification_filename=$23,
         resume_file_url=$24, resume_filename=$25,
         headshot_file_url=$26, headshot_filename=$27
         WHERE user_id=$28`,
        [preferred_name, phoneCheck.value, email, birth_month, birth_day, birth_year,
         street_address, city, state, zip_code,
         travel_distance, reliable_transportation,
         toBool(equipment_portable_bar), toBool(equipment_cooler), toBool(equipment_table_with_spandex),
         toBool(equipment_none_but_open), toBool(equipment_no_space), toBool(equipment_will_pickup),
         emergency_contact_name || null, ecPhoneCheck.value, emergency_contact_relationship || null,
         alcohol_cert_url, alcohol_cert_name, resume_url, resume_name,
         headshot_url, headshot_name, req.user.id]
      );
    } else {
      await client.query(
        `INSERT INTO contractor_profiles (user_id, preferred_name, phone, email, birth_month, birth_day,
         birth_year, street_address, city, state, zip_code,
         travel_distance, reliable_transportation,
         equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
         equipment_none_but_open, equipment_no_space, equipment_will_pickup,
         emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
         alcohol_certification_file_url, alcohol_certification_filename,
         resume_file_url, resume_filename,
         headshot_file_url, headshot_filename)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
        [req.user.id, preferred_name, phoneCheck.value, email, birth_month, birth_day, birth_year,
         street_address, city, state, zip_code,
         travel_distance, reliable_transportation,
         toBool(equipment_portable_bar), toBool(equipment_cooler), toBool(equipment_table_with_spandex),
         toBool(equipment_none_but_open), toBool(equipment_no_space), toBool(equipment_will_pickup),
         emergency_contact_name || null, ecPhoneCheck.value, emergency_contact_relationship || null,
         alcohol_cert_url, alcohol_cert_name, resume_url, resume_name,
         headshot_url, headshot_name]
      );
    }

    // Mark step complete
    await client.query(
      `UPDATE onboarding_progress SET contractor_profile_completed=true, last_completed_step='contractor_profile_completed' WHERE user_id=$1`,
      [req.user.id]
    );

    await client.query('COMMIT');
  } catch (txErr) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw txErr;
  } finally {
    client.release();
  }

  // Geocode address in background (don't block the response)
  if (street_address || city || state || zip_code) {
    geocodeAddress(buildAddressString({ street_address, city, state, zip_code }))
      .then(coords => {
        if (coords) {
          pool.query(
            'UPDATE contractor_profiles SET lat = $1, lng = $2 WHERE user_id = $3',
            [coords.lat, coords.lng, req.user.id]
          );
        }
      })
      .catch(err => console.error('[Contractor] Geocode error:', err.message));
  }

  const result = await pool.query('SELECT * FROM contractor_profiles WHERE user_id = $1', [req.user.id]);
  res.json(result.rows[0]);
}));

module.exports = router;
