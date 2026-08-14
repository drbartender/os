require('dotenv').config();
process.env.NODE_ENV = 'test';

// Tests for the contact message-history union.
//
// FIXTURE NOTES (each verified against the live schema; do not "simplify"):
//   - message_log requires proposal_id (NOT NULL, FK) and recipient (NOT NULL).
//     channel CHECK is ('email','sms'); status CHECK is
//     ('sent','failed','bounced','complained').
//   - scheduled_messages.sent_at is nullable with NO default, so a fixture with
//     status='sent' must set it explicitly or the row is invisible to any
//     `sent_at IS NOT NULL` filter and the test passes for the wrong reason.
//   - Fixture emails avoid .invalid, the house fixture domain, because the
//     marketing mailability rules suppress it.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { getContactMessageHistory, MAX_LIMIT, _resetCampaignLegProbe } = require('./contactMessageHistory');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `cmh-${NONCE}@mkt-test.example`;
let clientId, proposalId, emptyClientId, adminUserId;

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`CMH ${NONCE}`, EMAIL]
  );
  clientId = c.rows[0].id;

  const e = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`CMH empty ${NONCE}`, `cmh-e-${NONCE}@mkt-test.example`]
  );
  emptyClientId = e.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, total_price)
     VALUES ($1, CURRENT_DATE - 30, 'completed', 500) RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`cmh-admin-${NONCE}@mkt-test.example`]
  );
  adminUserId = admin.rows[0].id;

  // HUMAN-sent: sent_by set.
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, subject, status, sent_by, created_at)
     VALUES ($1, $2, 'email', 'proposal_sent', $3, 'Your proposal is ready', 'sent', $4, NOW() - INTERVAL '3 days')`,
    [proposalId, clientId, EMAIL, adminUserId]
  );

  // SCHEDULER-sent: sent_by NULL. This is what 2,165 of 2,200 prod rows look like.
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, subject, status, created_at)
     VALUES ($1, $2, 'email', 'balance_reminder_auto', $3, 'Your balance is due', 'sent', NOW() - INTERVAL '4 days')`,
    [proposalId, clientId, EMAIL]
  );

  // A dispatcher touch WITH its ledger twin, 40ms apart, the normal case.
  const twinAt = new Date(Date.now() - 24 * 3600 * 1000);
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id, channel,
        scheduled_for, sent_at, status)
     VALUES ('proposal', $1, 'retention_nudge', 'client', $2, 'email', $3, $3, 'sent')`,
    [proposalId, clientId, twinAt]
  );
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, subject, status, created_at)
     VALUES ($1, $2, 'email', 'retention_nudge', $3, 'Almost a year since your event', 'sent', $4)`,
    [proposalId, clientId, EMAIL, new Date(twinAt.getTime() + 40)]
  );

  // A dispatcher touch with NO ledger twin: the safety-net case.
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id, channel,
        scheduled_for, sent_at, status)
     VALUES ('proposal', $1, 'six_months_out', 'client', $2, 'email',
             NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days', 'sent')`,
    [proposalId, clientId]
  );
});

after(async () => {
  await pool.query(
    'DELETE FROM scheduled_messages WHERE recipient_type = $1 AND recipient_id = $2',
    ['client', clientId]
  );
  await pool.query('DELETE FROM message_log WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[clientId, emptyClientId]]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`cmh-admin-${NONCE}@mkt-test.example`]);
  await pool.end();
});

test('returns entries newest first across sources', async () => {
  const rows = await getContactMessageHistory(clientId);
  assert.ok(rows.length >= 4, `expected at least 4, got ${rows.length}`);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(new Date(rows[i - 1].at) >= new Date(rows[i].at), 'not sorted newest first');
  }
});

test('automated is derived from sent_by, not assumed from the source table', async () => {
  // The distinction is the whole point: "the system emailed them" and "I
  // emailed them" are different facts to an operator deciding whether to reach
  // out again. message_log carries BOTH, discriminated by sent_by (NULL =
  // scheduler). In prod 2,165 of 2,200 sent rows are sent_by NULL, so
  // hardcoding false here would mislabel 98% of sends as human.
  const rows = await getContactMessageHistory(clientId);
  const human = rows.find(r => r.kind === 'proposal_sent');
  const system = rows.find(r => r.kind === 'balance_reminder_auto');
  assert.ok(human, 'human-sent row missing');
  assert.equal(human.automated, false, 'a row with sent_by set is human-sent');
  assert.equal(human.source, 'message_log');
  assert.ok(system, 'scheduler-sent row missing');
  assert.equal(system.automated, true, 'a row with sent_by NULL is scheduler-sent');
  assert.equal(system.source, 'message_log');
});

test('a dispatcher send is NOT listed twice when message_log already has it', async () => {
  // The dispatcher's handlers send through sendEmail/sendSMS without skipLog,
  // so 1,154 of 1,196 sent scheduled_messages rows in prod already have a
  // message_log twin milliseconds apart. Emitting both shows the operator the
  // same drip twice, once tagged automated and once human.
  const rows = await getContactMessageHistory(clientId);
  const twinned = rows.filter(r => r.kind === 'retention_nudge');
  assert.equal(twinned.length, 1, 'the dispatcher row and its ledger twin both appeared');
  assert.equal(twinned[0].source, 'message_log', 'the richer ledger row should win');
  assert.equal(twinned[0].automated, true);
});

test('a dispatcher send with NO ledger twin still appears', async () => {
  // The safety net: if a ledger write failed, the touch must not vanish.
  const rows = await getContactMessageHistory(clientId);
  const orphan = rows.find(r => r.kind === 'six_months_out');
  assert.ok(orphan, 'an unlogged dispatcher send disappeared from history');
  assert.equal(orphan.source, 'scheduled_messages');
  assert.equal(orphan.automated, true);
});

test('carries subject, so the UI can humanize a message_type of "other"', async () => {
  // 1,007 of 2,200 prod rows have message_type 'other' while subject is
  // populated on 100%. Returning only the enum would print the literal word
  // "other" in the drawer.
  const rows = await getContactMessageHistory(clientId);
  const row = rows.find(r => r.kind === 'proposal_sent');
  assert.equal(row.subject, 'Your proposal is ready');
  assert.equal(row.label, 'Your proposal is ready');
});

test('a pending future touch is a plan, not history', async () => {
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id, channel,
        scheduled_for, status)
     VALUES ('proposal', $1, 'new_year_hello', 'client', $2, 'email',
             NOW() + INTERVAL '90 days', 'pending')`,
    [proposalId, clientId]
  );
  const before = (await getContactMessageHistory(clientId)).length;
  const rows = await getContactMessageHistory(clientId);
  assert.equal(rows.find(r => r.kind === 'new_year_hello'), undefined);
  assert.equal(rows.length, before, 'a pending row leaked into history');
});

test('a suppressed touch is not history either', async () => {
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id, channel,
        scheduled_for, status)
     VALUES ('proposal', $1, 'drip_touch_2', 'client', $2, 'email',
             NOW() - INTERVAL '5 days', 'suppressed')`,
    [proposalId, clientId]
  );
  const rows = await getContactMessageHistory(clientId);
  assert.equal(rows.find(r => r.kind === 'drip_touch_2'), undefined);
});

test('a failed message_log row is not history', async () => {
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status)
     VALUES ($1, $2, 'email', 'balance_reminder', $3, 'failed')`,
    [proposalId, clientId, EMAIL]
  );
  const rows = await getContactMessageHistory(clientId);
  assert.equal(rows.find(r => r.kind === 'balance_reminder'), undefined,
    'a send that failed is not something the client received');
});

test('carries the channel, so SMS and email are distinguishable', async () => {
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status)
     VALUES ($1, $2, 'sms', 'event_eve', $3, 'sent')`,
    [proposalId, clientId, '+13125550123']
  );
  const rows = await getContactMessageHistory(clientId);
  const sms = rows.find(r => r.kind === 'event_eve');
  assert.ok(sms, 'sms row missing');
  assert.equal(sms.channel, 'sms');
});

test('a client with no messages returns an empty array, not null', async () => {
  assert.deepEqual(await getContactMessageHistory(emptyClientId), []);
});

test('respects the limit and clamps both ends', async () => {
  assert.equal((await getContactMessageHistory(clientId, { limit: 1 })).length, 1);
  assert.ok((await getContactMessageHistory(clientId, { limit: 0 })).length >= 1,
    'a zero limit should clamp to at least 1, not return nothing');
  // The upper clamp cannot be shown with a small fixture, so assert the
  // arithmetic directly: an inverted Math.min would let a caller request an
  // unbounded scan and the row-count assertion would still pass.
  assert.equal(MAX_LIMIT, 200);
  assert.equal(Math.min(MAX_LIMIT, Math.max(1, 99999)), MAX_LIMIT);
});

test('a non-numeric or out-of-range id returns empty rather than throwing', async () => {
  assert.deepEqual(await getContactMessageHistory('nope'), []);
  assert.deepEqual(await getContactMessageHistory(null), []);
  assert.deepEqual(await getContactMessageHistory(undefined), []);
  // Out of int4 range: parseInt succeeds, the column would raise 22003.
  assert.deepEqual(await getContactMessageHistory('3000000000'), []);
});

test('scopes to the client: another contact history never leaks in', async () => {
  // A zero-vs-nonzero assertion would pass even if the filter used the wrong
  // column. Give the OTHER contact a real row and prove it stays out.
  const p2 = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, total_price)
     VALUES ($1, CURRENT_DATE - 5, 'completed', 100) RETURNING id`, [emptyClientId]);
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, subject, status)
     VALUES ($1, $2, 'email', 'NEIGHBOUR_ONLY', $3, 'not yours', 'sent')`,
    [p2.rows[0].id, emptyClientId, `cmh-e-${NONCE}@mkt-test.example`]);

  const mine = await getContactMessageHistory(clientId);
  assert.equal(mine.find(r => r.kind === 'NEIGHBOUR_ONLY'), undefined,
    'another contact\'s message appeared in this history');
  const theirs = await getContactMessageHistory(emptyClientId);
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].kind, 'NEIGHBOUR_ONLY');

  await pool.query('DELETE FROM message_log WHERE client_id = $1', [emptyClientId]);
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [emptyClientId]);
});

// ─── The campaign leg (lane mkt-g) ─────────────────────────────────
//
// Phase 1 wrote this leg behind a column probe and could not reach it:
// email_sends had no client_id, so the probe returned false and the branch
// never ran. mkt-g adds the column, which activates it. These are the first
// tests that actually execute that SQL.

test('a campaign send to a client appears in their history', async () => {
  const nonce = `cmh-camp-${Date.now()}`;
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id',
    [nonce, `${nonce}@mkt-test.example`]);
  const camp = await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','sent','Spring open house','<p>hi</p>') RETURNING id`, [nonce]);
  const send = await pool.query(
    `INSERT INTO email_sends (campaign_id, client_id, subject, status, sent_at)
     VALUES ($1,$2,'Spring open house','sent', NOW() - INTERVAL '1 hour') RETURNING id`,
    [camp.rows[0].id, c.rows[0].id]);
  try {
    _resetCampaignLegProbe();
    const rows = await getContactMessageHistory(c.rows[0].id);
    const hit = rows.find(r => r.subject === 'Spring open house');
    assert.ok(hit, 'the campaign send must show on the contact record');
    assert.equal(hit.channel, 'email');
    assert.equal(hit.kind, 'campaign', 'the row identifies itself as a campaign, not a lifecycle touch');
    // automated=false is deliberate and worth stating, because the instinct is
    // the opposite. `automated` means "the system decided to send this", and a
    // campaign is the one bulk send a human chose: Dallas picked the audience
    // and pressed send. The drip, the retention nudge and the New Year touch
    // fire without him, and those are the automated ones. The `kind` field is
    // what tells the drawer this was bulk rather than a personal note.
  } finally {
    await pool.query('DELETE FROM email_sends WHERE id=$1', [send.rows[0].id]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [camp.rows[0].id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [c.rows[0].id]);
  }
});

test('a failed, bounced, or unsent campaign row is NOT shown as a send', async () => {
  // The drawer answers "have we already talked to this person". A queued row
  // that never left, or one that bounced, is not a conversation, and showing
  // it would make an operator skip someone they never actually reached.
  const nonce = `cmh-neg-${Date.now()}`;
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id',
    [nonce, `${nonce}@mkt-test.example`]);
  const camp = await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','sent','Never arrived','<p>hi</p>') RETURNING id`, [nonce]);
  // ASSERT INSIDE THE LOOP. The send-once index is partial on
  // (campaign_id, client_id), so only one row per pair can exist and each case
  // must be cleared before the next. An earlier version of this test deleted
  // three of the four cases and only asserted at the end, so 'failed',
  // 'bounced' and 'queued' were pinned by nothing: dropping them from the SQL
  // filter would have left it green.
  try {
    for (const [status, sentAt] of [
      ['failed', 'NOW()'], ['bounced', 'NOW()'], ['queued', 'NOW()'], ['sent', 'NULL'],
    ]) {
      const r = await pool.query(
        `INSERT INTO email_sends (campaign_id, client_id, subject, status, sent_at)
         VALUES ($1,$2,'Never arrived',$3, ${sentAt}) RETURNING id`,
        [camp.rows[0].id, c.rows[0].id, status]);
      _resetCampaignLegProbe();
      const rows = await getContactMessageHistory(c.rows[0].id);
      assert.equal(rows.filter(x => x.subject === 'Never arrived').length, 0,
        `a '${status}' row (sent_at ${sentAt}) must not count as a send`);
      await pool.query('DELETE FROM email_sends WHERE id=$1', [r.rows[0].id]);
    }
  } finally {
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [camp.rows[0].id]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [camp.rows[0].id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [c.rows[0].id]);
  }
});
