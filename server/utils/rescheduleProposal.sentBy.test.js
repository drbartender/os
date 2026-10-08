'use strict';

// The event-details notice ledgers the admin who sent it (Inbox spec
// 2026-10-06, section 9) on BOTH halves, and its SMS half now names its own
// proposal instead of falling back to the client's newest. sendEmail is
// replaced before rescheduleProposal.js loads (it destructures it at require
// time); the SMS half goes through sendAndLogSms's own seam. Runs ALONE against
// the shared dev DB:
//   node --test server/utils/rescheduleProposal.sentBy.test.js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const emailCalls = [];
require('./email').sendEmail = (args) => {
  emailCalls.push(args);
  return Promise.resolve({ id: `lane-b-rs-${emailCalls.length}` });
};
const sms = require('./sms');
const smsCalls = [];
sms.__setSmsDeps({
  sendSMS: (args) => { smsCalls.push(args); return Promise.resolve({ sid: `SMlanebrs${Date.now()}${smsCalls.length}` }); },
});

const { pool } = require('../db');
const { sendRescheduleEmail } = require('./rescheduleProposal');

const TAG = 'lane-b-rs';
let clientId;
let proposalId;

async function purge() {
  await pool.query(
    'DELETE FROM sms_messages WHERE client_id IN (SELECT id FROM clients WHERE name LIKE $1)', [`${TAG} %`]);
  await pool.query(
    'DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE name LIKE $1)', [`${TAG} %`]);
  await pool.query('DELETE FROM clients WHERE name LIKE $1', [`${TAG} %`]);
}

before(async () => {
  await purge();
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+13125550103') RETURNING id`,
    [`${TAG} Sam Fixture`, `${TAG}-${Date.now()}@example.test`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price)
     VALUES ($1, 'deposit_paid', '2099-09-09', 900) RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

after(async () => {
  sms.__setSmsDeps({ sendSMS: sms._realSendSMS });
  await purge();
  await pool.end();
});

const MESSAGE = {
  email: { subject: 'Updated details for your event', bodyText: 'Your start time moved to 7 PM.' },
  sms: { body: 'Dr. Bartender: your event now starts at 7 PM.' },
};

test('an admin-sent notice carries sentBy on the email and the SMS, each naming its proposal', async () => {
  emailCalls.length = 0;
  smsCalls.length = 0;
  const r = await sendRescheduleEmail({ proposalId, channels: ['email', 'sms'], message: MESSAGE, sentBy: 4242 });
  assert.equal(r.email, 'sent');
  assert.equal(r.sms, 'sent');
  assert.deepEqual(emailCalls[0].meta, { proposalId, clientId, messageType: 'reschedule', sentBy: 4242 });
  assert.deepEqual(smsCalls[0].meta, { proposalId, clientId, messageType: 'reschedule', sentBy: 4242 });
});

test('a caller with no sentBy ledgers NULL on both halves', async () => {
  emailCalls.length = 0;
  smsCalls.length = 0;
  await sendRescheduleEmail({ proposalId, channels: ['email', 'sms'], message: MESSAGE });
  assert.equal(emailCalls[0].meta.sentBy, null);
  assert.equal(smsCalls[0].meta.sentBy, null);
});
