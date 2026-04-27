const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { isValidUpload } = require('../utils/fileValidation');
const { uploadFile } = require('../utils/storage');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError } = require('../utils/errors');
const { validatePhone } = require('../utils/phone');

const router = express.Router();

// Get current user's application
router.get('/', auth, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM applications WHERE user_id = $1', [req.user.id]);
  res.json(result.rows[0] || {});
}));

// Submit application
router.post('/', auth, asyncHandler(async (req, res) => {
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

  // Validation — collect all required-field errors at once
  const fieldErrors = {};
  if (!full_name) fieldErrors.full_name = 'Full name is required';
  const phoneCheck = validatePhone(phone, { required: true });
  if (phoneCheck.error) fieldErrors.phone = phoneCheck.error;
  const ecPhoneCheck = validatePhone(emergency_contact_phone);
  if (ecPhoneCheck.error) fieldErrors.emergency_contact_phone = ecPhoneCheck.error;
  if (!city) fieldErrors.city = 'City is required';
  if (!state) fieldErrors.state = 'State is required';
  if (!travel_distance) fieldErrors.travel_distance = 'Travel distance is required';
  if (!reliable_transportation) fieldErrors.reliable_transportation = 'Please answer the transportation question';
  if (!positions_interested) fieldErrors.positions_interested = 'Please select at least one position';
  if (!why_dr_bartender) fieldErrors.why_dr_bartender = 'Please tell us why you want to join';

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
      fieldErrors.birth_year = 'You must be at least 21 years old to apply';
    }
  } else {
    fieldErrors.birth_year = 'Date of birth is required';
  }

  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  // Check if already applied
  const existing = await pool.query('SELECT id FROM applications WHERE user_id = $1', [req.user.id]);
  if (existing.rows[0]) {
    throw new ConflictError('You already submitted an application', 'DUPLICATE_APPLICATION');
  }

  // Handle file uploads
  let resume_url = null, resume_name = null;
  let headshot_url = null, headshot_name = null;
  let basset_url = null, basset_name = null;

  if (req.files?.resume) {
    const file = req.files.resume;
    if (!isValidUpload(file)) {
      throw new ValidationError({ resume: 'Invalid resume file type. Use PDF, JPEG, or PNG only.' });
    }
    const ext = path.extname(file.name);
    const filename = `${req.user.id}_app_resume_${uuidv4()}${ext}`;
    await uploadFile(file.data, filename);
    resume_url = `/files/${filename}`;
    resume_name = file.name;
  }

  if (req.files?.headshot) {
    const file = req.files.headshot;
    if (!isValidUpload(file)) {
      throw new ValidationError({ headshot: 'Invalid headshot file type. Use JPEG or PNG only.' });
    }
    const ext = path.extname(file.name);
    const filename = `${req.user.id}_headshot_${uuidv4()}${ext}`;
    await uploadFile(file.data, filename);
    headshot_url = `/files/${filename}`;
    headshot_name = file.name;
  }

  if (req.files?.basset) {
    const file = req.files.basset;
    if (!isValidUpload(file)) {
      throw new ValidationError({ basset: 'Invalid BASSET cert file type. Use PDF, JPEG, or PNG only.' });
    }
    const ext = path.extname(file.name);
    const filename = `${req.user.id}_basset_${uuidv4()}${ext}`;
    await uploadFile(file.data, filename);
    basset_url = `/files/${filename}`;
    basset_name = file.name;
  }

  const fileFieldErrors = {};
  if (!resume_url) fileFieldErrors.resume = 'Please upload your resume';
  if (!basset_url) fileFieldErrors.basset = 'Please upload your BASSET / alcohol certification';
  if (Object.keys(fileFieldErrors).length > 0) throw new ValidationError(fileFieldErrors);

  const toBool = v => v === 'true' || v === true || v === 'Yes';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
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
      req.user.id, full_name, phoneCheck.value, favorite_color,
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
      emergency_contact_name || null, ecPhoneCheck.value, emergency_contact_relationship || null,
      resume_url, resume_name,
      headshot_url, headshot_name,
      basset_url, basset_name
    ]
  );

    // Update user status to 'applied'
    await client.query("UPDATE users SET onboarding_status = 'applied' WHERE id = $1", [req.user.id]);

    await client.query('COMMIT');
  } catch (txErr) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw txErr;
  } finally {
    client.release();
  }

  // Email notifications (non-blocking)
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
    if (adminEmail) {
      const tpl = emailTemplates.newApplicationAdmin({ applicantName: full_name, applicantEmail: req.user.email, adminUrl: `${clientUrl}/admin/staff` });
      await sendEmail({ to: adminEmail, ...tpl });
    }
    if (req.user.email) {
      const tpl = emailTemplates.applicationReceivedConfirmation({ applicantName: full_name });
      await sendEmail({ to: req.user.email, ...tpl });
    }
  } catch (emailErr) {
    console.error('Application email failed (non-blocking):', emailErr);
  }

  const result = await pool.query('SELECT * FROM applications WHERE user_id = $1', [req.user.id]);
  res.status(201).json(result.rows[0]);
}));

module.exports = router;
