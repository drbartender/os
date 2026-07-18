require('dotenv').config();
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  buildEmailLogEntry, buildSmsLogEntry, logClientMessage, getMessageLogForProposal,
} = require('./messageLog');

const TEST_EMAIL = 'msglog-test@example.com';
let clientId, proposalId;

before(async () => {
  // Clean any leftovers from a crashed prior run (clients.email is uniquely indexed).
  await pool.query('DELETE FROM message_log WHERE recipient = $1', [TEST_EMAIL]);
  await pool.query('DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1)', [TEST_EMAIL]);
  await pool.query('DELETE FROM clients WHERE email = $1', [TEST_EMAIL]);

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('MsgLog Test', $1, '3125550199') RETURNING id",
    [TEST_EMAIL]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'birthday-party', 100000, 10000, CURRENT_DATE + INTERVAL '14 days', false)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

// Start each test with an empty ledger for this proposal so a mid-suite failure
// does not leave stale rows that confuse the next assertion.
beforeEach(async () => {
  await pool.query('DELETE FROM message_log WHERE proposal_id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM message_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('buildEmailLogEntry maps a successful send', () => {
  const e = buildEmailLogEntry({ to: 'a@b.com', subject: 'Hi', meta: { proposalId: 5, messageType: 'proposal_sent' }, result: { id: 're_123' } });
  assert.equal(e.channel, 'email');
  assert.equal(e.status, 'sent');
  assert.equal(e.providerId, 're_123');
  assert.equal(e.recipient, 'a@b.com');
  assert.equal(e.messageType, 'proposal_sent');
});

test('buildEmailLogEntry returns null for a dev-skipped result', () => {
  assert.equal(buildEmailLogEntry({ to: 'a@b.com', subject: 'x', result: { id: 'dev-skipped' } }), null);
});

test('buildEmailLogEntry marks skipLog entries', () => {
  assert.equal(buildEmailLogEntry({ to: 'a@b.com', meta: { skipLog: true }, result: { id: 're_1' } }).skipLog, true);
});

test('buildEmailLogEntry uses the first address for a multi-recipient send', () => {
  const e = buildEmailLogEntry({ to: ['first@b.com', 'second@b.com'], subject: 'x', result: { id: 're_1' } });
  assert.equal(e.recipient, 'first@b.com');
});

test('buildEmailLogEntry maps an error to failed', () => {
  const e = buildEmailLogEntry({ to: 'a@b.com', subject: 'x', error: new Error('quota reached') });
  assert.equal(e.status, 'failed');
  assert.match(e.error, /quota/);
  assert.equal(e.providerId, null);
});

test('buildSmsLogEntry returns null for a dev-skipped sid', () => {
  assert.equal(buildSmsLogEntry({ to: '+13125550199', body: 'hi', result: { sid: 'dev-skipped-1' } }), null);
});

test('logClientMessage resolves client by email + most-recent proposal and inserts', async () => {
  await logClientMessage(buildEmailLogEntry({ to: TEST_EMAIL, subject: 'Proposal', meta: { messageType: 'proposal_sent' }, result: { id: 're_abc' } }));
  const rows = await getMessageLogForProposal(proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'email');
  assert.equal(rows[0].message_type, 'proposal_sent');
  assert.equal(rows[0].status, 'sent');
});

test('logClientMessage resolves client by phone last-10', async () => {
  await logClientMessage(buildSmsLogEntry({ to: '+13125550199', body: 'reminder', meta: { messageType: 'drink_plan_nudge' }, result: { sid: 'SM_x' } }));
  const rows = await getMessageLogForProposal(proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'sms');
});

test('logClientMessage writes nothing for an unknown recipient', async () => {
  await logClientMessage(buildEmailLogEntry({ to: 'nobody@nowhere.test', subject: 'x', result: { id: 're_1' } }));
  assert.equal((await getMessageLogForProposal(proposalId)).length, 0);
});

test('logClientMessage writes nothing for a skipLog entry', async () => {
  await logClientMessage(buildEmailLogEntry({ to: TEST_EMAIL, meta: { skipLog: true }, result: { id: 're_1' } }));
  assert.equal((await getMessageLogForProposal(proposalId)).length, 0);
});

test('logClientMessage never throws on a bad entry', async () => {
  await assert.doesNotReject(() => logClientMessage({ channel: 'email', recipient: null, status: 'sent' }));
});

test('unknown recipient WITH proposalId still logs, client_id NULL (Brandon 7/16 fix)', async () => {
  // The stale-address case: recipient matches no client row, but the caller
  // knows the proposal. The ledger row must exist so the send is never
  // invisible again; client_id stays NULL.
  await logClientMessage(buildEmailLogEntry({
    to: 'stale-relay@privaterelay.example', subject: 'list ready',
    meta: { proposalId, messageType: 'shopping_list_ready' },
    result: { id: 're_brandon_fix' },
  }));
  const rows = await getMessageLogForProposal(proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipient, 'stale-relay@privaterelay.example');
  const raw = await pool.query('SELECT client_id, provider_id FROM message_log WHERE proposal_id = $1', [proposalId]);
  assert.equal(raw.rows[0].client_id, null);
  assert.equal(raw.rows[0].provider_id, 're_brandon_fix');
});

test('sent_by and body_edited persist through entry and meta paths', async () => {
  await logClientMessage({
    channel: 'email', recipient: TEST_EMAIL, clientId, proposalId,
    status: 'sent', messageType: 'shopping_list_ready', subject: 'edited copy',
    sentBy: null, bodyEdited: true,
  });
  await logClientMessage(buildEmailLogEntry({
    to: TEST_EMAIL, subject: 'meta path',
    meta: { proposalId, clientId, messageType: 'other', sentBy: null, bodyEdited: false },
    result: { id: 're_meta' },
  }));
  const raw = await pool.query(
    'SELECT subject, sent_by, body_edited FROM message_log WHERE proposal_id = $1 ORDER BY id',
    [proposalId]
  );
  assert.equal(raw.rows.length, 2);
  assert.equal(raw.rows[0].body_edited, true);
  assert.equal(raw.rows[1].body_edited, false);
  assert.equal(raw.rows[0].sent_by, null);
});

test('failed status persists with error message (failure rows are never skipped)', async () => {
  await logClientMessage(buildEmailLogEntry({
    to: TEST_EMAIL, subject: 'boom',
    meta: { proposalId, clientId, messageType: 'shopping_list_ready' },
    error: new Error('FetchError: network down'),
  }));
  const raw = await pool.query('SELECT status, error_message FROM message_log WHERE proposal_id = $1', [proposalId]);
  assert.equal(raw.rows[0].status, 'failed');
  assert.match(raw.rows[0].error_message, /network down/);
});

test('getMessageLogForProposal returns newest first', async () => {
  await logClientMessage({ channel: 'email', recipient: TEST_EMAIL, clientId, proposalId, status: 'sent', messageType: 'first', subject: 'a' });
  await logClientMessage({ channel: 'email', recipient: TEST_EMAIL, clientId, proposalId, status: 'sent', messageType: 'second', subject: 'b' });
  const rows = await getMessageLogForProposal(proposalId);
  assert.equal(rows[0].message_type, 'second'); // id DESC tiebreaker makes this deterministic
});
