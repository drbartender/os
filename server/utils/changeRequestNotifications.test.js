'use strict';

// notifyClientOfDecision ledgers its own type, its proposal, its client and the
// deciding admin (Inbox spec 2026-10-06, sections 2 and 9). It used to pass no
// meta, so every decision logged as 'other' against the client's newest
// proposal. Runs ALONE against the shared dev DB:
//   node --test server/utils/changeRequestNotifications.test.js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const notify = require('./changeRequestNotifications');

const TAG = 'lane-b-crn';
let clientId;
let proposal;
let sends = [];

// Installed per test, so the hooks stay pure DB work and the pre-change run
// fails test by test instead of in a hook.
function stubSend() {
  sends = [];
  notify.__setDeps({ sendEmail: (a) => { sends.push(a); return Promise.resolve({ id: 'stub' }); } });
}

async function purge() {
  await pool.query(
    'DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE name LIKE $1)', [`${TAG} %`]);
  await pool.query('DELETE FROM clients WHERE name LIKE $1', [`${TAG} %`]);
}

before(async () => {
  await purge();
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`${TAG} Jo Fixture`, `${TAG}-${Date.now()}@example.test`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_date, total_price, amount_paid)
     VALUES ($1, 'deposit_paid', 'wedding', '2099-09-09', 1200, 300) RETURNING *`,
    [clientId]
  );
  proposal = p.rows[0];
});

after(async () => {
  await purge();
  await pool.end();
});

test('an approval ledgers change_request_decision on its proposal with the deciding admin', async () => {
  stubSend();
  await notify.notifyClientOfDecision({ decision_note: null }, proposal, 'approved', { sentBy: 4242 });
  assert.equal(sends.length, 1);
  assert.match(sends[0].subject, /changes are confirmed/);
  assert.deepEqual(sends[0].meta, {
    proposalId: proposal.id, clientId, messageType: 'change_request_decision', sentBy: 4242,
  });
});

test('a decline ledgers the same type, and with no sentBy the admin is NULL', async () => {
  stubSend();
  await notify.notifyClientOfDecision({ decision_note: 'That date is already taken.' }, proposal, 'declined');
  assert.equal(sends.length, 1);
  assert.match(sends[0].subject, /About your requested change/);
  assert.deepEqual(sends[0].meta, {
    proposalId: proposal.id, clientId, messageType: 'change_request_decision', sentBy: null,
  });
});

test('a client with no email on file is sent nothing', async () => {
  stubSend();
  const c = await pool.query('INSERT INTO clients (name, email) VALUES ($1, NULL) RETURNING id', [`${TAG} No Email`]);
  await notify.notifyClientOfDecision({}, { ...proposal, client_id: c.rows[0].id }, 'approved', { sentBy: 4242 });
  assert.equal(sends.length, 0);
});
