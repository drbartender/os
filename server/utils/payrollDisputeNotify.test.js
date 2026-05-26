// Serial execution required. This suite mutates process.env.ADMIN_EMAIL and
// reassigns console.error in some tests; running concurrently would corrupt
// other tests in the same process. Do NOT enable --test-concurrency.

require('dotenv').config();
const { test, describe, before, beforeEach, afterEach, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const Sentry = require('@sentry/node');
const { notifyDisputeWon, __setDeps } = require('./payrollDisputeNotify');

// Negative ids guaranteed unique vs. SERIAL prod rows; deterministic
// stripe_payment_intent_id values keyed off the test id avoid collisions
// across this file's tests.
const TEST_TIP_PREFIX = -990000000;
const ADMIN_EMAIL_DEFAULT = 'test@example.com';
const FIXTURE_USER_EMAIL = 'payroll-dispute-notify-test@example.com';

let sendEmailMock, captureExceptionMock, captureMessageMock, consoleErrorOriginal, adminEmailOriginal;
let fixtureUserId;

async function purgeTestRows() {
  // Tips first (FK to users via target_user_id with ON DELETE RESTRICT).
  await pool.query(
    `DELETE FROM tips
       WHERE id <= $1
          OR stripe_payment_intent_id LIKE 'pi_test_%'
          OR stripe_payment_intent_id = 'pi_disp_won_test'`,
    [TEST_TIP_PREFIX]
  );
}

async function ensureFixtureUser() {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, 'x', 'staff')
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role
     RETURNING id`,
    [FIXTURE_USER_EMAIL]
  );
  return r.rows[0].id;
}

async function dropFixtureUser() {
  await pool.query('DELETE FROM users WHERE email = $1', [FIXTURE_USER_EMAIL]);
}

async function seedTip({ id, amount_cents = 5000, fee_cents = 100, dispute_won_at = null, dispute_email_attempts = 0, dispute_email_failed_at = null, shift_id = null, target_user_id = null }) {
  // tips.tip_page_token and tips.target_user_id are NOT NULL. Default the
  // token to a fresh UUID per row and the user to the file-level fixture
  // when callers don't supply one, so test bodies stay focused on the
  // columns they actually care about.
  const targetUserId = target_user_id ?? fixtureUserId;
  await pool.query(
    `INSERT INTO tips (id, tip_page_token, amount_cents, fee_cents, dispute_won_at, dispute_email_attempts, dispute_email_failed_at, shift_id, target_user_id, stripe_payment_intent_id, tipped_at)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (id) DO UPDATE SET
       amount_cents = EXCLUDED.amount_cents,
       fee_cents = EXCLUDED.fee_cents,
       dispute_won_at = EXCLUDED.dispute_won_at,
       dispute_email_attempts = EXCLUDED.dispute_email_attempts,
       dispute_email_failed_at = EXCLUDED.dispute_email_failed_at,
       shift_id = EXCLUDED.shift_id,
       target_user_id = EXCLUDED.target_user_id`,
    [id, amount_cents, fee_cents, dispute_won_at, dispute_email_attempts, dispute_email_failed_at, shift_id, targetUserId, `pi_test_${Math.abs(id)}`]
  );
}

async function readTip(id) {
  const r = await pool.query(
    `SELECT id, dispute_won_at, dispute_email_attempts, dispute_email_failed_at
       FROM tips WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

describe('notifyDisputeWon', () => {
  before(async () => {
    await purgeTestRows();
    fixtureUserId = await ensureFixtureUser();
  });

  after(async () => {
    await purgeTestRows();
    await dropFixtureUser();
  });

  beforeEach(() => {
    sendEmailMock = mock.fn(async () => ({ id: 'msg_test' }));
    captureExceptionMock = mock.fn();
    captureMessageMock = mock.fn();
    adminEmailOriginal = process.env.ADMIN_EMAIL;
    process.env.ADMIN_EMAIL = ADMIN_EMAIL_DEFAULT;
    __setDeps({
      sendEmail: sendEmailMock,
      Sentry: { captureException: captureExceptionMock, captureMessage: captureMessageMock },
      sendTimeoutMs: 100,
      pool,
    });
  });

  afterEach(async () => {
    // Reset deps to harmless no-ops, NOT the real sendEmail/Sentry, so that
    // any orphan invocation from a misbehaving test cannot hit production
    // Resend or pollute Sentry. pool is restored to the real pool.
    __setDeps({
      sendEmail: async () => ({ id: 'noop' }),
      Sentry: { captureException: () => {}, captureMessage: () => {} },
      sendTimeoutMs: 10_000,
      pool,
    });
    if (typeof adminEmailOriginal === 'string') process.env.ADMIN_EMAIL = adminEmailOriginal;
    else delete process.env.ADMIN_EMAIL;
    if (consoleErrorOriginal) {
      console.error = consoleErrorOriginal;
      consoleErrorOriginal = null;
    }
    await purgeTestRows();
  });

  test('success path: marks dispute_won_at, resets attempts, returns abandoned=false', async () => {
    const id = TEST_TIP_PREFIX - 1;
    await seedTip({ id, dispute_email_attempts: 0 });

    const result = await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    assert.strictEqual(result.abandoned, false);
    assert.strictEqual(result.reinstatedAmountCents, 3000);
    assert.strictEqual(sendEmailMock.mock.callCount(), 1);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.notStrictEqual(after.dispute_won_at, null);
    assert.strictEqual(after.dispute_email_attempts, 0);
    assert.strictEqual(after.dispute_email_failed_at, null);
  });

  test('counter reset: prior failures zeroed on success', async () => {
    const id = TEST_TIP_PREFIX - 2;
    await seedTip({ id, dispute_email_attempts: 2 });

    await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 0);
    assert.notStrictEqual(after.dispute_won_at, null);
  });

  test('already-completed: returns null, does not touch state or send', async () => {
    const id = TEST_TIP_PREFIX - 3;
    await seedTip({ id, dispute_won_at: new Date('2026-01-01') });

    const result = await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    assert.strictEqual(result, null);
    assert.strictEqual(sendEmailMock.mock.callCount(), 0);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);
    assert.strictEqual(captureExceptionMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 0);
  });

  test('ADMIN_EMAIL unset: increments counter, fires captureException', async () => {
    const id = TEST_TIP_PREFIX - 4;
    await seedTip({ id, dispute_email_attempts: 0 });

    const saved = process.env.ADMIN_EMAIL;
    try {
      delete process.env.ADMIN_EMAIL;
      await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });
    } finally {
      if (typeof saved === 'string') process.env.ADMIN_EMAIL = saved;
      else delete process.env.ADMIN_EMAIL;
    }

    assert.strictEqual(captureExceptionMock.mock.callCount(), 1);
    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 1);
    assert.strictEqual(after.dispute_won_at, null);
  });
});
