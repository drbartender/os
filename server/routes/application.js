const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { isValidUpload } = require('../utils/fileValidation');
const { uploadFile } = require('../utils/storage');

const router = express.Router();

// Get current user's application
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications WHERE user_id = $1', [req.user.id]);
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Submit application
router.post('/', auth, async (req, res) => {
  const {
    full_name, phone, favorite_color,
    street_address, city, state, zip_code,
    birth_month, birth_day, birth_year,
    travel_distance, reliable_transportation,
    has_bartending_experience, bartending_experience_description,
    last_bartending_time, bartending_years, experience_types, positions_interested,
    available_saturdays, other_commitments,
    tools_none_will_start, tools_mixing_tins, tools_strainer,
    tools_ice_scoop, tools_bar_spoon, tools_tongs,
    tools_ice_bin, tools_bar_mats, tools_bar_towels,
    equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
    equipment_none_but_open, equipment_no_space,
    setup_confidence, comfortable_working_alone,
    customer_service_approach, why_dr_bartender, additional_info,
    emergency_contact_name, emergency_contact_phone, emergency_contact_relationship
  } = req.body;

  // Validation
  if (!full_name || !phone || !city || !state || !travel_distance || !reliable_transportation || !positions_interested || !why_dr_bartender) {
    return res.status(400).json({ error: 'Please fill in all required fields.' });
  }

  // Age validation (must be 21+)
  if (birth_month && birth_day && birth_year) {
    const today = new Date();
    const birthDate = new Date(birth_year, birth_month - 1, birth_day);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    if (age < 21) {
      return res.status(400).json({ error: 'You must be at least 21 years old to apply.' });
    }
  } else {
    return res.status(400).json({ error: 'Date of birth is required.' });
  }

  try {
    // Check if already applied
    const existing = await pool.query('SELECT id FROM applications WHERE user_id = $1', [req.user.id]);
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'You have already submitted an application.' });
    }

    // Handle file uploads
    let resume_url = null, resume_name = null;
    let headshot_url = null, headshot_name = null;
    let basset_url = null, basset_name = null;

    if (req.files?.resume) {
      const file = req.files.resume;
      if (!isValidUpload(file)) return res.status(400).json({ error: 'Invalid resume file type. Use PDF, JPEG, or PNG only.' });
      const ext = path.extname(file.name);
      const filename = `${req.user.id}_app_resume_${uuidv4()}${ext}`;
      await uploadFile(file.data, filename);
      resume_url = `/files/${filename}`;
      resume_name = file.name;
    }

    if (req.files?.headshot) {
      const file = req.files.headshot;
      if (!isValidUpload(file)) return res.status(400).json({ error: 'Invalid headshot file type. Use JPEG or PNG only.' });
      const ext = path.extname(file.name);
      const filename = `${req.user.id}_headshot_${uuidv4()}${ext}`;
      await uploadFile(file.data, filename);
      headshot_url = `/files/${filename}`;
      headshot_name = file.name;
    }

    if (req.files?.basset) {
      const file = req.files.basset;
      if (!isValidUpload(file)) return res.status(400).json({ error: 'Invalid BASSET cert file type. Use PDF, JPEG, or PNG only.' });
      const ext = path.extname(file.name);
      const filename = `${req.user.id}_basset_${uuidv4()}${ext}`;
      await uploadFile(file.data, filename);
      basset_url = `/files/${filename}`;
      basset_name = file.name;
    }

    if (!resume_url) {
      return res.status(400).json({ error: 'Please upload your resume.' });
    }
    if (!basset_url) {
      return res.status(400).json({ error: 'Please upload your BASSET / alcohol certification.' });
    }

    const toBool = v => v === 'true' || v === true || v === 'Yes';

    await pool.query(
      `INSERT INTO applications (
        user_id, full_name, phone, favorite_color,
        street_address, city, state, zip_code,
        birth_month, birth_day, birth_year,
        travel_distance, reliable_transportation,
        has_bartending_experience, bartending_experience_description,
        last_bartending_time, bartending_years, experience_types, positions_interested,
        available_saturdays, other_commitments,
        tools_none_will_start, tools_mixing_tins, tools_strainer,
        tools_ice_scoop, tools_bar_spoon, tools_tongs,
        tools_ice_bin, tools_bar_mats, tools_bar_towels,
        equipment_portable_bar, equipment_cooler, equipment_table_with_spandex,
        equipment_none_but_open, equipment_no_space,
        setup_confidence, comfortable_working_alone,
        customer_service_approach, why_dr_bartender, additional_info,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
        resume_file_url, resume_filename,
        headshot_file_url, headshot_filename,
        basset_file_url, basset_filename
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,
        $40,$41,$42,$43,$44,$45,$46,$47,$48,$49
      )`,
      [
        req.user.id, full_name, phone, favorite_color,
        street_address, city, state, zip_code,
        parseInt(birth_month), parseInt(birth_day), parseInt(birth_year),
        travel_distance, reliable_transportation,
        toBool(has_bartending_experience), bartending_experience_description || null,
        last_bartending_time || null, bartending_years || null, experience_types || null, positions_interested,
        available_saturdays || null, other_commitments || null,
        toBool(tools_none_will_start), toBool(tools_mixing_tins), toBool(tools_strainer),
        toBool(tools_ice_scoop), toBool(tools_bar_spoon), toBool(tools_tongs),
        toBool(tools_ice_bin), toBool(tools_bar_mats), toBool(tools_bar_towels),
        toBool(equipment_portable_bar), toBool(equipment_cooler), toBool(equipment_table_with_spandex),
        toBool(equipment_none_but_open), toBool(equipment_no_space),
        parseInt(setup_confidence) || null, comfortable_working_alone || null,
        customer_service_approach || null, why_dr_bartender, additional_info || null,
        emergency_contact_name || null, emergency_contact_phone || null, emergency_contact_relationship || null,
        resume_url, resume_name,
        headshot_url, headshot_name,
        basset_url, basset_name
      ]
    );

    // Update user status to 'applied'
    await pool.query("UPDATE users SET onboarding_status = 'applied' WHERE id = $1", [req.user.id]);

    const result = await pool.query('SELECT * FROM applications WHERE user_id = $1', [req.user.id]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
