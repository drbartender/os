require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { pool } = require('../db');
const { seedContractorProfileFromApplication } = require('./contractorSeed');

// Regression suite for the document-wipe the submit-gate-relax lane exposed.
//
// The seed's ON CONFLICT DO UPDATE assigns the six document columns from the
// APPLICATION row. That was safe only while POST /api/application refused a
// submission with no resume or certification, which guaranteed those columns
// were non-null whenever the seed ran for a pre-hire.
//
// Once a pre-hire may submit without files, an application row with NULL file
// columns seeds over a contractor_profiles row that already holds uploaded
// documents and destroys them. The user is then told, by the very notice this
// project added, to re-upload what they already uploaded.
//
// The fix mirrors the COALESCE shape already used for hire_date in the same
// statement: never let a NULL from the application erase a stored value.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const ids = {};

async function mkUser(tag) {
  const hash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version, pre_hired)
     VALUES ($1, $2, 'staff', 'in_progress', 0, true) RETURNING id`,
    [`cseed-${tag}-${NONCE}@example.com`, hash]
  );
  return r.rows[0].id;
}

async function mkApplication(userId, files = {}) {
  await pool.query(
    `INSERT INTO applications
       (user_id, full_name, phone, city, state, travel_distance, reliable_transportation,
        positions_interested, why_dr_bartender,
        resume_file_url, resume_filename, basset_file_url, basset_filename,
        headshot_file_url, headshot_filename)
     VALUES ($1, 'Seed Test', '3125550000', 'Chicago', 'Illinois', '30 minutes', 'Yes',
             '["Bartender"]', 'testing', $2, $3, $4, $5, $6, $7)`,
    [userId, files.resume || null, files.resumeName || null,
     files.basset || null, files.bassetName || null,
     files.headshot || null, files.headshotName || null]
  );
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'cseed-%'");
  ids.wipe = await mkUser('wipe');
  ids.fill = await mkUser('fill');
});

after(async () => {
  const all = Object.values(ids);
  await pool.query('DELETE FROM applications WHERE user_id = ANY($1)', [all]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1)', [all]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [all]);
  await pool.end();
});

test('a fileless application never erases documents already on the profile', async () => {
  // The recruit uploaded to /contractor-profile first, which a pre-hire can
  // reach: RequireHired's allow-list includes 'in_progress'.
  await pool.query(
    `INSERT INTO contractor_profiles
       (user_id, preferred_name, resume_file_url, resume_filename,
        alcohol_certification_file_url, alcohol_certification_filename,
        headshot_file_url, headshot_filename)
     VALUES ($1, 'Already Uploaded', '/files/mine_resume.pdf', 'mine_resume.pdf',
             '/files/mine_cert.pdf', 'mine_cert.pdf',
             '/files/mine_head.jpg', 'mine_head.jpg')`,
    [ids.wipe]
  );
  // Then they submit the application with no files at all.
  await mkApplication(ids.wipe);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedContractorProfileFromApplication(client, ids.wipe, null);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const r = await pool.query(
    `SELECT resume_file_url, resume_filename,
            alcohol_certification_file_url, alcohol_certification_filename,
            headshot_file_url, headshot_filename
     FROM contractor_profiles WHERE user_id = $1`, [ids.wipe]);
  const row = r.rows[0];

  assert.equal(row.resume_file_url, '/files/mine_resume.pdf', 'resume URL was erased');
  assert.equal(row.resume_filename, 'mine_resume.pdf', 'resume filename was erased');
  assert.equal(row.alcohol_certification_file_url, '/files/mine_cert.pdf', 'certification URL was erased');
  assert.equal(row.alcohol_certification_filename, 'mine_cert.pdf', 'certification filename was erased');
  // Headshot was always optional, so this half could be wiped even before the
  // gate relaxed. Same fix closes it.
  assert.equal(row.headshot_file_url, '/files/mine_head.jpg', 'headshot URL was erased');
  assert.equal(row.headshot_filename, 'mine_head.jpg', 'headshot filename was erased');
});

test('an application WITH files still populates an empty profile', async () => {
  // The ordinary path must keep working: the seed is how a cold applicant's
  // uploads reach their contractor profile in the first place.
  await mkApplication(ids.fill, {
    resume: '/files/app_resume.pdf', resumeName: 'app_resume.pdf',
    basset: '/files/app_cert.pdf', bassetName: 'app_cert.pdf',
    headshot: '/files/app_head.jpg', headshotName: 'app_head.jpg',
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedContractorProfileFromApplication(client, ids.fill, null);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const r = await pool.query(
    `SELECT resume_file_url, alcohol_certification_file_url, headshot_file_url, preferred_name
     FROM contractor_profiles WHERE user_id = $1`, [ids.fill]);
  const row = r.rows[0];
  assert.equal(row.resume_file_url, '/files/app_resume.pdf');
  assert.equal(row.alcohol_certification_file_url, '/files/app_cert.pdf');
  assert.equal(row.headshot_file_url, '/files/app_head.jpg');
  assert.equal(row.preferred_name, 'Seed Test', 'non-document fields still seed normally');
});

test('an application file still WINS over an empty profile column', async () => {
  // COALESCE(EXCLUDED, existing) must prefer the incoming value when present,
  // otherwise a re-submit could never update a document.
  await pool.query(
    `UPDATE contractor_profiles SET resume_file_url = NULL, resume_filename = NULL
     WHERE user_id = $1`, [ids.fill]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedContractorProfileFromApplication(client, ids.fill, null);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const r = await pool.query(
    'SELECT resume_file_url FROM contractor_profiles WHERE user_id = $1', [ids.fill]);
  assert.equal(r.rows[0].resume_file_url, '/files/app_resume.pdf');
});
