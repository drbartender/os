require('dotenv').config();

// Tests for the onboarding promotion gate (spec 2026-07-22).
//
// These drive the REAL helper the payment route calls, against real Postgres,
// so the rule cannot pass here and differ in production. The alternative —
// re-writing the predicate in the test — is exactly the drift this file exists
// to prevent.
//
// The security case under test: POST /api/auth/register is public and mints a
// live JWT for a `role='staff', onboarding_status='in_progress'` row. If that
// account can reach 'approved', it clears requireOnboarded and everything
// behind it. It must not be promotable.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { pool } = require('../db');
const { promoteOnboardingIfEligible } = require('./onboardingPromotion');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const createdUserIds = [];

async function mkUser(status, { withApplication = false, preHired = false } = {}) {
  const passwordHash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, pre_hired)
     VALUES ($1, $2, 'staff', $3, $4) RETURNING id`,
    [`onbgate-${status}-${createdUserIds.length}-${NONCE}@example.com`, passwordHash, status, preHired]
  );
  const id = r.rows[0].id;
  createdUserIds.push(id);
  if (withApplication) {
    await pool.query(
      `INSERT INTO applications
         (user_id, full_name, phone, city, state, travel_distance,
          reliable_transportation, positions_interested, why_dr_bartender)
       VALUES ($1, 'Test Applicant', '+15555551234', 'Chicago', 'IL', '25',
               'yes', 'Bartender', 'Test')`,
      [id]
    );
  }
  return id;
}

async function statusOf(id) {
  const r = await pool.query('SELECT onboarding_status FROM users WHERE id = $1', [id]);
  return r.rows[0].onboarding_status;
}

/** Run the helper the way the route does: inside a transaction on one client. */
async function promote(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await promoteOnboardingIfEligible(client, userId);
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

before(async () => {
  // Scoped to THIS run's nonce: an unscoped 'onbgate-%' wipe would delete a
  // concurrent run's fixtures mid-flight (and cascade their applications rows).
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`onbgate-%${NONCE}@example.com`]);
});

after(async () => {
  if (createdUserIds.length) {
    await pool.query('DELETE FROM applications WHERE user_id = ANY($1::int[])', [createdUserIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]);
  }
  await pool.end();
});

// ─── The hole this closes ──────────────────────────────────────────────────

test('a self-registered account (in_progress, no application) is NOT promoted', async () => {
  const id = await mkUser('in_progress');
  const rows = await promote(id);
  assert.strictEqual(rows, 0, 'no row updated');
  assert.strictEqual(await statusOf(id), 'in_progress', 'still cannot clear requireOnboarded');
});

test('pre_hired does not substitute for an application', async () => {
  // register-pre-hired is public by design, so the flag is self-assertable.
  // Accepting it as evidence would reopen the same hole one route over.
  const id = await mkUser('in_progress', { preHired: true });
  const rows = await promote(id);
  assert.strictEqual(rows, 0);
  assert.strictEqual(await statusOf(id), 'in_progress');
});

// ─── The legitimate path this must keep working ────────────────────────────

test('an admin-advanced account (in_progress WITH an application) IS promoted', async () => {
  const id = await mkUser('in_progress', { withApplication: true });
  const rows = await promote(id);
  assert.strictEqual(rows, 1);
  assert.strictEqual(await statusOf(id), 'approved');
});

for (const status of ['hired', 'submitted', 'reviewed']) {
  test(`'${status}' still promotes without an application (admin-conferred / import)`, async () => {
    const id = await mkUser(status);
    const rows = await promote(id);
    assert.strictEqual(rows, 1, `${status} must stay promotable`);
    assert.strictEqual(await statusOf(id), 'approved');
  });
}

// ─── No-ops ────────────────────────────────────────────────────────────────

test('an already-approved user is a clean no-op (idempotent re-submit)', async () => {
  const id = await mkUser('approved');
  const rows = await promote(id);
  assert.strictEqual(rows, 0);
  assert.strictEqual(await statusOf(id), 'approved');
});

for (const status of ['applied', 'interviewing', 'rejected', 'deactivated']) {
  test(`'${status}' is never promoted, even with an application on file`, async () => {
    const id = await mkUser(status, { withApplication: true });
    const rows = await promote(id);
    assert.strictEqual(rows, 0, `${status} must not self-elevate`);
    assert.strictEqual(await statusOf(id), status);
  });
}

test('promotion touches only the target user', async () => {
  const target = await mkUser('in_progress', { withApplication: true });
  const bystander = await mkUser('in_progress', { withApplication: true });
  await promote(target);
  assert.strictEqual(await statusOf(bystander), 'in_progress', 'no collateral update');
});
