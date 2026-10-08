'use strict';

// sendAndLogSms carries an optional sentBy into the ledger meta (Inbox spec
// 2026-10-06, section 9): the human-click SMS halves ("Send to client", the
// event-details notice) ride this automated primitive, so it takes the
// clicking admin as a VALUE and defaults to NULL for every scheduler caller.
// It never writes sms_messages.sender_id: that column marks a hand-typed text,
// and Inbox counts every outbound client row carrying it as a reply whatever
// its type. Runs ALONE against the shared dev DB:
//   node --test server/utils/sendAndLogSms.sentBy.test.js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const sms = require('./sms');
const { buildSmsLogEntry } = require('./messageLog');

const TYPE = 'lane_b_sentby_probe';
let calls = [];

before(async () => {
  await pool.query('DELETE FROM sms_messages WHERE message_type = $1', [TYPE]);
  sms.__setSmsDeps({
    sendSMS: (args) => { calls.push(args); return Promise.resolve({ sid: `SMlaneb${Date.now()}${calls.length}` }); },
  });
});

after(async () => {
  sms.__setSmsDeps({ sendSMS: sms._realSendSMS });
  await pool.query('DELETE FROM sms_messages WHERE message_type = $1', [TYPE]);
  await pool.end();
});

test('a human caller hands sentBy to the ledger meta with its proposal and client', async () => {
  calls = [];
  const r = await sms.sendAndLogSms({
    to: '3125550100', body: 'probe', clientId: null, proposalId: 7, messageType: TYPE, sentBy: 4242,
  });
  assert.equal(r.status, 'sent');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].meta, { proposalId: 7, clientId: null, messageType: TYPE, sentBy: 4242 });
});

test('a scheduler caller (no sentBy) ledgers sentBy null', async () => {
  calls = [];
  await sms.sendAndLogSms({ to: '3125550101', body: 'probe', messageType: TYPE });
  assert.equal(calls[0].meta.sentBy, null);
});

test('sms_messages.sender_id stays NULL even when a human triggered the send', async () => {
  calls = [];
  await sms.sendAndLogSms({ to: '3125550102', body: 'probe', messageType: TYPE, sentBy: 4242 });
  const { rows } = await pool.query(
    'SELECT sender_id FROM sms_messages WHERE message_type = $1 AND recipient_phone = $2', [TYPE, '+13125550102']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sender_id, null);
});

// The next link, pure (no DB, no send): sendSMS hands that meta whole to
// buildSmsLogEntry, and its entry is the message_log row. Never through the
// real sendSMS, whose ledger write would land on whatever dev proposal has id 7.
test('the SMS ledger entry built from that meta keeps sentBy, its type and its proposal', () => {
  const entry = buildSmsLogEntry({
    to: '+13125550100',
    body: 'probe',
    meta: { proposalId: 7, clientId: null, messageType: TYPE, sentBy: 4242 },
    result: { sid: 'SMlanebledger1' },
  });
  assert.equal(entry.sentBy, 4242);
  assert.equal(entry.messageType, TYPE);
  assert.equal(entry.proposalId, 7);
});
