require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { pool } = require('../db');
const { outstandingFor, listUncertifiedStaffable } = require('./outstandingDocuments');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const ids = {};
let shiftId;

async function mkUser(tag, status) {
  const hash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', $3, 0) RETURNING id`,
    [`odoc-${tag}-${NONCE}@example.com`, hash, status]
  );
  return r.rows[0].id;
}

// applications has eight NOT NULL columns with no default; supply them all.
async function mkApplication(userId, name, { resume = null, basset = null } = {}) {
  await pool.query(
    `INSERT INTO applications
       (user_id, full_name, phone, city, state, travel_distance, reliable_transportation,
        positions_interested, why_dr_bartender, resume_file_url, basset_file_url)
     VALUES ($1, $2, '3125550000', 'Chicago', 'Illinois', '30 minutes', 'Yes',
             '["Bartender"]', 'testing', $3, $4)`,
    [userId, name, resume, basset]
  );
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'odoc-%'");

  // Owes both, no application row at all. The direct-hire case an INNER JOIN drops.
  ids.bare = await mkUser('bare', 'in_progress');

  // Owes nothing; both documents on the APPLICATION only.
  ids.viaApp = await mkUser('viaapp', 'approved');
  await mkApplication(ids.viaApp, 'Via App', { resume: '/files/r.pdf', basset: '/files/b.pdf' });

  // Owes nothing; both on the CONTRACTOR PROFILE only. The pair that diverged
  // when the two surfaces computed the predicate separately.
  ids.viaProfile = await mkUser('viaprofile', 'approved');
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, resume_file_url, alcohol_certification_file_url)
     VALUES ($1, 'Via Profile', '/files/r.pdf', '/files/c.pdf')`, [ids.viaProfile]);

  // STAFFABLE and uncertified, not booked. Belongs in the alert.
  ids.riskIdle = await mkUser('riskidle', 'approved');
  await mkApplication(ids.riskIdle, 'Risk Idle', { resume: '/files/r.pdf' });

  // STAFFABLE, uncertified, AND booked on an upcoming shift. Highest priority.
  ids.riskBooked = await mkUser('riskbooked', 'approved');
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, resume_file_url)
     VALUES ($1, 'Risk Booked', '/files/r.pdf')`, [ids.riskBooked]);
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, location, positions_needed, status, client_name)
     VALUES (CURRENT_DATE + 5, '3:00 PM', '7:00 PM', 'Test', '["Bartender"]', 'open', $1) RETURNING id`,
    [`odoc-client-${NONCE}`]);
  shiftId = sh.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1, $2, 'Bartender', 'approved')`,
    [shiftId, ids.riskBooked]);

  // STAFFABLE, certified, but MISSING A RESUME. The fixture that makes the
  // certification-only scoping falsifiable: without it, widening the predicate
  // back to (CERT_MISSING OR RESUME_MISSING) passes every other test in this
  // file while re-introducing the 50-row blowup on production.
  ids.resumeGapOnly = await mkUser('resumegap', 'approved');
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, alcohol_certification_file_url)
     VALUES ($1, 'Resume Gap', '/files/c.pdf')`, [ids.resumeGapOnly]);

  // Uncertified but NOT staffable: mid-onboarding, cannot be assigned.
  ids.notYet = await mkUser('notyet', 'in_progress');

  // Uncertified and 'applied'. The submit gate still applies to this cohort, so
  // they cannot normally reach a fileless state; fixtured anyway to pin that
  // they stay OUT of the staffable alert whatever their documents look like.
  ids.applied = await mkUser('applied', 'applied');
  await mkApplication(ids.applied, 'Applied Person');

  // Off-funnel entirely.
  ids.gone = await mkUser('gone', 'deactivated');
});

after(async () => {
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`odoc-%${NONCE}@example.com`]);
  await pool.end();
});

// ── outstandingFor: the recruit's own to-do, both documents, broad statuses ──

test('a user with no application row owes both documents', async () => {
  assert.deepEqual(await outstandingFor(ids.bare), ['resume', 'alcohol certification']);
});

test('documents on the application satisfy the requirement', async () => {
  assert.deepEqual(await outstandingFor(ids.viaApp), []);
});

test('documents on the contractor profile satisfy the requirement', async () => {
  assert.deepEqual(await outstandingFor(ids.viaProfile), []);
});

test('a partially complete user owes only what is missing', async () => {
  assert.deepEqual(await outstandingFor(ids.riskIdle), ['alcohol certification']);
});

test('an applicant is told what they owe even though they cannot be staffed', async () => {
  assert.deepEqual(await outstandingFor(ids.applied), ['resume', 'alcohol certification']);
});

test('an off-funnel user owes nothing', async () => {
  assert.deepEqual(await outstandingFor(ids.gone), []);
});

// ── listUncertifiedStaffable: the admin alert, certification only, staffable only ──

test('the alert names staffable people with no certification', async () => {
  const rows = await listUncertifiedStaffable();
  const listed = rows.map(r => r.user_id);
  assert.ok(listed.includes(ids.riskIdle), 'an approved, uncertified worker must be listed');
  assert.ok(listed.includes(ids.riskBooked), 'a booked, uncertified worker must be listed');
});

test('the alert excludes people who cannot be staffed', async () => {
  const listed = (await listUncertifiedStaffable()).map(r => r.user_id);
  for (const id of [ids.bare, ids.notYet, ids.applied, ids.gone]) {
    assert.equal(listed.includes(id), false,
      `user ${id} cannot be assigned to a shift and must not raise a compliance alert`);
  }
});

test('the alert ignores a missing resume', async () => {
  // THE scoping test. resumeGapOnly is staffable and certified but has no resume.
  // If the predicate ever widens to (CERT_MISSING OR RESUME_MISSING) this is the
  // only assertion in the file that fails, and it is what stops the 50-row
  // blowup from silently returning.
  const listed = (await listUncertifiedStaffable()).map(r => r.user_id);
  assert.equal(listed.includes(ids.resumeGapOnly), false,
    'a resume gap alone is not a compliance alert; the predicate has widened');
  assert.equal(listed.includes(ids.viaApp), false);
});

test('a resume gap still shows on that person own to-do', async () => {
  // The other half of the split: the recruit is still told, the admin is not alerted.
  assert.deepEqual(await outstandingFor(ids.resumeGapOnly), ['resume']);
});

test('a booked worker carries their next shift, an idle one carries null', async () => {
  const rows = await listUncertifiedStaffable();
  const booked = rows.find(r => r.user_id === ids.riskBooked);
  const idle = rows.find(r => r.user_id === ids.riskIdle);
  assert.equal(booked.next_shift_id, shiftId);
  assert.ok(booked.next_shift_date, 'a booked worker must expose the date so the row can escalate');
  assert.equal(idle.next_shift_id, null);
});

test('booked workers sort ahead of idle ones', async () => {
  const rows = await listUncertifiedStaffable();
  const iBooked = rows.findIndex(r => r.user_id === ids.riskBooked);
  const iIdle = rows.findIndex(r => r.user_id === ids.riskIdle);
  assert.ok(iBooked < iIdle, 'someone about to work uncertified outranks someone merely eligible');
});

test('names fall back through profile, application, then email', async () => {
  const rows = await listUncertifiedStaffable();
  assert.equal(rows.find(r => r.user_id === ids.riskBooked).name, 'Risk Booked');
  assert.equal(rows.find(r => r.user_id === ids.riskIdle).name, 'Risk Idle');
});
