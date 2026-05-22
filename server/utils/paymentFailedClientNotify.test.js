require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { notifyClientPaymentFailed } = require('./paymentFailedClientNotify');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('PayFail Test', 'payfail-test@example.com', '3125550170') RETURNING id"
  );
  clientId = c.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM sms_messages WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('notifyClientPaymentFailed > sends the failure SMS once and never throws', async () => {
  const { __setSmsDeps } = require('./sms');
  let smsCalls = 0;
  __setSmsDeps({ sendSMS: async () => { smsCalls += 1; return { sid: `stub-${Date.now()}-${smsCalls}` }; } });
  await assert.doesNotReject(() => notifyClientPaymentFailed({ proposalId, paymentIntentId: 'pi_test_1' }));
  // The email send hits Resend; in dev with no key it logs and is best-effort.
  // We only assert the SMS half here.
  const { rows } = await pool.query(
    "SELECT message_type, status FROM sms_messages WHERE client_id = $1",
    [clientId]
  );
  assert.strictEqual(rows.length, 1, 'exactly one payment-failure SMS row');
  assert.strictEqual(rows[0].message_type, 'payment_failure');
  assert.strictEqual(smsCalls, 1);
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});

test('notifyClientPaymentFailed > the 24h claim makes a second call a no-op', async () => {
  const { __setSmsDeps } = require('./sms');
  let smsCalls = 0;
  __setSmsDeps({ sendSMS: async () => { smsCalls += 1; return { sid: `stub-${Date.now()}-${smsCalls}` }; } });
  await notifyClientPaymentFailed({ proposalId, paymentIntentId: 'pi_test_1' });
  await notifyClientPaymentFailed({ proposalId, paymentIntentId: 'pi_test_2' });
  assert.strictEqual(smsCalls, 1, 'second call must not re-send (claim already held)');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});
