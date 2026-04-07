const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { isValidUpload } = require('../utils/fileValidation');
const { uploadFile } = require('../utils/storage');

const router = express.Router();

// Get payment profile
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM payment_profiles WHERE user_id = $1', [req.user.id]);
    const profile = result.rows[0] || {};
    if (profile.routing_number) {
      profile.routing_number = '****' + profile.routing_number.slice(-4);
    }
    if (profile.account_number) {
      profile.account_number = '****' + profile.account_number.slice(-4);
    }
    res.json(profile);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Save payment profile
router.post('/', auth, async (req, res) => {
  const { preferred_payment_method, payment_username, routing_number, account_number } = req.body;

  if (!preferred_payment_method) {
    return res.status(400).json({ error: 'Payment method required' });
  }

  try {
    let w9_url = null, w9_name = null;

    // Fetch existing record first so we can fall back to the saved W-9 if no new file
    const existing = await pool.query('SELECT id, w9_file_url, w9_filename FROM payment_profiles WHERE user_id = $1', [req.user.id]);

    if (req.files?.w9) {
      const file = req.files.w9;
      if (!isValidUpload(file)) return res.status(400).json({ error: 'Invalid file type. Use PDF, JPEG, or PNG only.' });
      const ext = path.extname(file.name);
      const filename = `${req.user.id}_w9_${uuidv4()}${ext}`;
      await uploadFile(file.data, filename);
      w9_url = `/files/${filename}`;
      w9_name = file.name;
    } else if (existing.rows[0]?.w9_file_url) {
      // Reuse previously uploaded W-9
      w9_url = existing.rows[0].w9_file_url;
      w9_name = existing.rows[0].w9_filename;
    }

    // Enforce W-9 requirement on the backend (not just the frontend)
    if (!w9_url) {
      return res.status(400).json({ error: 'A signed W-9 is required.' });
    }

    await pool.query('BEGIN');

    if (existing.rows[0]) {
      await pool.query(
        `UPDATE payment_profiles
         SET preferred_payment_method=$1, payment_username=$2, routing_number=$3, account_number=$4,
             w9_file_url=$5, w9_filename=$6
         WHERE user_id=$7`,
        [preferred_payment_method, payment_username || null, routing_number || null, account_number || null,
         w9_url, w9_name, req.user.id]
      );
    } else {
      await pool.query(
        `INSERT INTO payment_profiles
           (user_id, preferred_payment_method, payment_username, routing_number, account_number, w9_file_url, w9_filename)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.id, preferred_payment_method, payment_username || null,
         routing_number || null, account_number || null, w9_url, w9_name]
      );
    }

    // Mark payday protocols and full onboarding complete
    await pool.query(
      `UPDATE onboarding_progress SET payday_protocols_completed=true, onboarding_completed=true, last_completed_step='onboarding_completed' WHERE user_id=$1`,
      [req.user.id]
    );

    // Update user onboarding status
    await pool.query("UPDATE users SET onboarding_status='submitted' WHERE id=$1", [req.user.id]);

    await pool.query('COMMIT');

    const result = await pool.query('SELECT * FROM payment_profiles WHERE user_id = $1', [req.user.id]);
    const profile = result.rows[0];
    if (profile.routing_number) {
      profile.routing_number = '****' + profile.routing_number.slice(-4);
    }
    if (profile.account_number) {
      profile.account_number = '****' + profile.account_number.slice(-4);
    }
    res.json(profile);
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
