require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { refreshDisplayName } = require('./refreshDisplayName');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `refresh-dn-${NONCE}@example.com`;
let userId;

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id",
    [EMAIL]
  );
  userId = u.rows[0].id;
  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)', [userId, 'Joey']);
  await pool.query('INSERT INTO agreements (user_id, full_name, email) VALUES ($1, $2, $3)', [userId, 'Joseph Key', EMAIL]);
});

after(async () => {
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('writes preferred name plus legal last initial', async () => {
  assert.equal(await refreshDisplayName(userId, pool), 'Joey K.');
  const { rows } = await pool.query('SELECT display_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].display_name, 'Joey K.');
});

test('is idempotent', async () => {
  await refreshDisplayName(userId, pool);
  assert.equal(await refreshDisplayName(userId, pool), await refreshDisplayName(userId, pool));
});

// The `= pool` default was removed deliberately: a helper that quietly checks
// out a second connection while its caller is holding one is the house
// pool-deadlock bug (CLAUDE.md > Coding patterns). Omitting the client has to
// fail loudly at the call site rather than starve the pool under load.
test('refuses to run without an explicit client', async () => {
  await assert.rejects(() => refreshDisplayName(userId), TypeError);
  await assert.rejects(() => refreshDisplayName(userId, null), TypeError);
});

test('prefers the signed agreement over the application for the surname', async () => {
  // positions_interested AND why_dr_bartender are both NOT NULL with no default
  // (schema.sql); omitting either is a 23502 before the assertion ever runs.
  await pool.query(
    `INSERT INTO applications (user_id, full_name, phone, city, state, travel_distance, reliable_transportation, positions_interested, why_dr_bartender)
     VALUES ($1, 'Joseph Wrongsurname', '3125550100', 'Chicago', 'IL', '25', 'yes', '["Bartender"]', 'fixture')`,
    [userId]
  );
  assert.equal(await refreshDisplayName(userId, pool), 'Joey K.');
});

test('clears the review stamp when the preferred name changed value', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  await pool.query("UPDATE contractor_profiles SET preferred_name = 'Joe' WHERE user_id = $1", [userId]);
  await refreshDisplayName(userId, pool, { previousPreferredName: 'Joey' });
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].preferred_name_reviewed_at, null);
});

test('leaves the review stamp alone when the preferred name did not change', async () => {
  // An admin editing a phone number, or an agreement landing and changing only
  // the initial, must not re-raise a notice about a name nobody touched.
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  await refreshDisplayName(userId, pool, { previousPreferredName: 'Joe' });
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.notEqual(rows[0].preferred_name_reviewed_at, null);
});

test('omitting previousPreferredName never clears the stamp', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  await refreshDisplayName(userId, pool);
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.notEqual(rows[0].preferred_name_reviewed_at, null);
});

// GUARD (spec §2): the notice must never become a gate.
test('display_name is identical whether the row is reviewed or not', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NULL WHERE user_id = $1', [userId]);
  const unreviewed = await refreshDisplayName(userId, pool);
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  assert.equal(await refreshDisplayName(userId, pool), unreviewed);
});

test('returns null for a user with no contractor_profiles row', async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id",
    [`refresh-dn-noprofile-${NONCE}@example.com`]
  );
  try {
    assert.equal(await refreshDisplayName(u.rows[0].id, pool), null);
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [u.rows[0].id]);
  }
});
