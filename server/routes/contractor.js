const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { isValidUpload } = require('../utils/fileValidation');

const router = express.Router();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './server/uploads');

// Get contractor profile (falls back to application data for auto-fill if no profile exists)
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM contractor_profiles WHERE user_id = $1', [req.user.id]);
    if (result.rows[0]) {
      return res.json(result.rows[0]);
    }

    // No contractor profile yet — check for application data to auto-fill
    const appResult = await pool.query('SELECT * FROM applications WHERE user_id = $1', [req.user.id]);
    if (appResult.rows[0]) {
      const app = appResult.rows[0];
      return res.json({
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

    res.json({});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Save contractor profile
router.post('/', auth, async (req, res) => {
  const {
    preferred_name, phone, email, birth_month, birth_day, birth_year,
    street_address, city, state, zip_code,
    travel_distance, reliable_transportation,
    equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
    equipment_none_but_open, equipment_no_space,
    emergency_contact_name, emergency_contact_phone, emergency_contact_relationship
  } = req.body;

  try {
    let alcohol_cert_url = null, alcohol_cert_name = null;
    let resume_url = null, resume_name = null;
    let headshot_url = null, headshot_name = null;

    // Handle file uploads
    if (req.files?.alcohol_certification) {
      const file = req.files.alcohol_certification;
      if (!isValidUpload(file)) return res.status(400).json({ error: 'Invalid file type. Use PDF, JPEG, or PNG only.' });
      const ext = path.extname(file.name);
      const filename = `${req.user.id}_alcohol_${uuidv4()}${ext}`;
      await file.mv(path.join(UPLOAD_DIR, filename));
      alcohol_cert_url = `/files/${filename}`;
      alcohol_cert_name = file.name;
    }

    if (req.files?.resume) {
      const file = req.files.resume;
      if (!isValidUpload(file)) return res.status(400).json({ error: 'Invalid file type. Use PDF, JPEG, or PNG only.' });
      const ext = path.extname(file.name);
      const filename = `${req.user.id}_resume_${uuidv4()}${ext}`;
      await file.mv(path.join(UPLOAD_DIR, filename));
      resume_url = `/files/${filename}`;
      resume_name = file.name;
    }

    if (req.files?.headshot) {
      const file = req.files.headshot;
      if (!isValidUpload(file)) return res.status(400).json({ error: 'Invalid file type. Use JPEG or PNG only.' });
      const ext = path.extname(file.name);
      const filename = `${req.user.id}_headshot_${uuidv4()}${ext}`;
      await file.mv(path.join(UPLOAD_DIR, filename));
      headshot_url = `/files/${filename}`;
      headshot_name = file.name;
    }

    const toBool = v => v === 'true' || v === true;

    const existing = await pool.query(
      'SELECT id, alcohol_certification_file_url, alcohol_certification_filename, resume_file_url, resume_filename, headshot_file_url, headshot_filename FROM contractor_profiles WHERE user_id = $1',
      [req.user.id]
    );

    // Keep existing file URLs if no new upload
    if (existing.rows[0]) {
      if (!alcohol_cert_url) { alcohol_cert_url = existing.rows[0].alcohol_certification_file_url; alcohol_cert_name = existing.rows[0].alcohol_certification_filename; }
      if (!resume_url) { resume_url = existing.rows[0].resume_file_url; resume_name = existing.rows[0].resume_filename; }
      if (!headshot_url) { headshot_url = existing.rows[0].headshot_file_url; headshot_name = existing.rows[0].headshot_filename; }

      await pool.query(
        `UPDATE contractor_profiles SET preferred_name=$1, phone=$2, email=$3, birth_month=$4, birth_day=$5,
         birth_year=$6, street_address=$7, city=$8, state=$9, zip_code=$10,
         travel_distance=$11, reliable_transportation=$12,
         equipment_portable_bar=$13, equipment_cooler=$14, equipment_table_with_spandex=$15,
         equipment_none_but_open=$16, equipment_no_space=$17,
         emergency_contact_name=$18, emergency_contact_phone=$19, emergency_contact_relationship=$20,
         alcohol_certification_file_url=$21, alcohol_certification_filename=$22,
         resume_file_url=$23, resume_filename=$24,
         headshot_file_url=$25, headshot_filename=$26
         WHERE user_id=$27`,
        [preferred_name, phone, email, birth_month, birth_day, birth_year,
         street_address, city, state, zip_code,
         travel_distance, reliable_transportation,
         toBool(equipment_portable_bar), toBool(equipment_cooler), toBool(equipment_table_with_spandex),
         toBool(equipment_none_but_open), toBool(equipment_no_space),
         emergency_contact_name || null, emergency_contact_phone || null, emergency_contact_relationship || null,
         alcohol_cert_url, alcohol_cert_name, resume_url, resume_name,
         headshot_url, headshot_name, req.user.id]
      );
    } else {
      await pool.query(
        `INSERT INTO contractor_profiles (user_id, preferred_name, phone, email, birth_month, birth_day,
         birth_year, street_address, city, state, zip_code,
         travel_distance, reliable_transportation,
         equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
         equipment_none_but_open, equipment_no_space,
         emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
         alcohol_certification_file_url, alcohol_certification_filename,
         resume_file_url, resume_filename,
         headshot_file_url, headshot_filename)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
        [req.user.id, preferred_name, phone, email, birth_month, birth_day, birth_year,
         street_address, city, state, zip_code,
         travel_distance, reliable_transportation,
         toBool(equipment_portable_bar), toBool(equipment_cooler), toBool(equipment_table_with_spandex),
         toBool(equipment_none_but_open), toBool(equipment_no_space),
         emergency_contact_name || null, emergency_contact_phone || null, emergency_contact_relationship || null,
         alcohol_cert_url, alcohol_cert_name, resume_url, resume_name,
         headshot_url, headshot_name]
      );
    }

    // Mark step complete
    await pool.query(
      `UPDATE onboarding_progress SET contractor_profile_completed=true, last_completed_step='contractor_profile_completed' WHERE user_id=$1`,
      [req.user.id]
    );

    const result = await pool.query('SELECT * FROM contractor_profiles WHERE user_id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
