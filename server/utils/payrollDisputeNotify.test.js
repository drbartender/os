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

  test('single failure: attempts=1, no flags set, no captureMessage', async () => {
    const id = TEST_TIP_PREFIX - 5;
    await seedTip({ id, dispute_email_attempts: 0 });
    sendEmailMock.mock.mockImplementationOnce(() => Promise.reject(new Error('resend boom')));

    const result = await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    assert.strictEqual(result.abandoned, false);
    assert.strictEqual(captureExceptionMock.mock.callCount(), 1);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 1);
    assert.strictEqual(after.dispute_won_at, null);
    assert.strictEqual(after.dispute_email_failed_at, null);
  });

  test('bailout: attempts=2 + failure → attempts=3, both timestamps set and equal, captureMessage fires with full payload', async () => {
    const id = TEST_TIP_PREFIX - 6;
    await seedTip({ id, dispute_email_attempts: 2 });
    sendEmailMock.mock.mockImplementationOnce(() => Promise.reject(new Error('still down')));

    const result = await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    assert.strictEqual(result.abandoned, true);
    assert.strictEqual(captureMessageMock.mock.callCount(), 1);

    const callArgs = captureMessageMock.mock.calls[0].arguments;
    assert.match(callArgs[0], /permanently abandoned/);
    assert.strictEqual(callArgs[1].level, 'error');
    assert.strictEqual(callArgs[1].tags.step, 'max_attempts_exceeded');
    assert.strictEqual(callArgs[1].extra.tipId, id);
    assert.strictEqual(callArgs[1].extra.attempts, 3);
    assert.strictEqual(callArgs[1].extra.reinstatedAmountCents, 3000);
    assert.ok(Array.isArray(callArgs[1].extra.bartenderIds));

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 3);
    assert.notStrictEqual(after.dispute_won_at, null);
    assert.notStrictEqual(after.dispute_email_failed_at, null);
    // Both NOW() in the same UPDATE → equal timestamps.
    assert.strictEqual(new Date(after.dispute_won_at).getTime(), new Date(after.dispute_email_failed_at).getTime());
  });

  test('throw before transaction: counter unchanged, dispute_won_at null, no Sentry from inside notify', async () => {
    const id = TEST_TIP_PREFIX - 7;
    await seedTip({ id, dispute_email_attempts: 0 });

    // Verifies the invariant that errors before the failure UPDATE do NOT
    // increment the counter. The simplest unambiguous mock is to throw at
    // pool.connect() itself, ensuring the throw happens before any DB work.
    // (An earlier attempt to throw mid-transaction via a query wrapper
    // wedged pg's client state and hung; the spec's intent is covered here
    // by exercising the same "no increment on pre-finalize throw" path.)
    __setDeps({
      sendEmail: sendEmailMock,
      Sentry: { captureException: captureExceptionMock, captureMessage: captureMessageMock },
      sendTimeoutMs: 100,
      pool: {
        connect: async () => {
          throw new Error('pool connect boom');
        },
      },
    });

    await assert.rejects(
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
      /pool connect boom/
    );

    assert.strictEqual(captureExceptionMock.mock.callCount(), 0);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 0);
    assert.strictEqual(after.dispute_won_at, null);
    assert.strictEqual(after.dispute_email_failed_at, null);
  });

  test('concurrency bailout race: at attempts=2, first call bails out, second short-circuits', async () => {
    const id = TEST_TIP_PREFIX - 8;
    await seedTip({ id, dispute_email_attempts: 2 });
    sendEmailMock.mock.mockImplementation(() => Promise.reject(new Error('still down')));

    const results = await Promise.all([
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
    ]);

    // One bailout, one short-circuit.
    const abandonedCount = results.filter(r => r && r.abandoned === true).length;
    const nullCount = results.filter(r => r === null).length;
    assert.strictEqual(abandonedCount, 1);
    assert.strictEqual(nullCount, 1);

    assert.strictEqual(captureExceptionMock.mock.callCount(), 1);
    assert.strictEqual(captureMessageMock.mock.callCount(), 1);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 3);
    assert.notStrictEqual(after.dispute_won_at, null);
    assert.notStrictEqual(after.dispute_email_failed_at, null);
  });

  test('concurrency below-threshold race: both increment serially via row lock', async () => {
    const id = TEST_TIP_PREFIX - 9;
    await seedTip({ id, dispute_email_attempts: 0 });
    sendEmailMock.mock.mockImplementation(() => Promise.reject(new Error('flapping')));

    await Promise.all([
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
    ]);

    assert.strictEqual(captureExceptionMock.mock.callCount(), 2);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 2);
    assert.strictEqual(after.dispute_won_at, null);
    assert.strictEqual(after.dispute_email_failed_at, null);
  });

  test('send-timeout: Promise.race rejects within bound, counter increments', async () => {
    const id = TEST_TIP_PREFIX - 10;
    await seedTip({ id, dispute_email_attempts: 0 });

    __setDeps({
      sendEmail: () => new Promise(resolve => setTimeout(() => resolve({ id: 'late' }), 500)),
      Sentry: { captureException: captureExceptionMock, captureMessage: captureMessageMock },
      sendTimeoutMs: 50,
      pool,
    });

    const startedAt = Date.now();
    await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 400, `expected < 400ms, got ${elapsed}ms`);
    assert.strictEqual(captureExceptionMock.mock.callCount(), 1);
    const errArg = captureExceptionMock.mock.calls[0].arguments[0];
    assert.match(errArg.message, /timed out/);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 1);
    assert.strictEqual(after.dispute_won_at, null);
  });

  test('post-commit Sentry capture failure: DB committed, console.error fired', async () => {
    const id = TEST_TIP_PREFIX - 11;
    await seedTip({ id, dispute_email_attempts: 2 });

    const throwingCaptureMessage = mock.fn(() => { throw new Error('sentry boom'); });
    __setDeps({
      sendEmail: sendEmailMock,
      Sentry: { captureException: captureExceptionMock, captureMessage: throwingCaptureMessage },
      sendTimeoutMs: 100,
      pool,
    });
    sendEmailMock.mock.mockImplementationOnce(() => Promise.reject(new Error('still down')));

    consoleErrorOriginal = console.error;
    const consoleErrorMock = mock.fn();
    console.error = consoleErrorMock;

    const result = await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    assert.strictEqual(result.abandoned, true);
    assert.strictEqual(throwingCaptureMessage.mock.callCount(), 1);

    const consoleErrorCalls = consoleErrorMock.mock.calls;
    assert.ok(consoleErrorCalls.length >= 1, 'console.error should have been called');
    const firstArg = consoleErrorCalls[0].arguments[0];
    assert.match(firstArg, /BAILOUT_ALERT_FAILED/);
    assert.match(firstArg, new RegExp(`tipId=${id}`));

    const after = await readTip(id);
    assert.notStrictEqual(after.dispute_won_at, null);
    assert.notStrictEqual(after.dispute_email_failed_at, null);
    assert.strictEqual(after.dispute_email_attempts, 3);
  });
});
