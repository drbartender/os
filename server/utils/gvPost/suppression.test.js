'use strict';

// GV post suppression (spec 2026-10-17 law 8, plan Task 3): today's SMS
// suppression carries over unchanged, then the per-number opt-out record, then
// the sendable proposal statuses. DB suite on the shared dev database: run ALONE,
//   node --test server/utils/gvPost/suppression.test.js
// Every fixture is invented (names, 555-01xx numbers) and deleted by id or key
// in after().
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('suppression.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');
const { loadGvContext, gvSuppression } = require('./suppression');

const RUN = `gvsup-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const created = { proposals: [], clients: [], optouts: [] };
let seq = 0;
let npa;
let nextLine = 0;

// A 555-01xx number nothing on the dev DB carries yet.
async function freshPhone() {
  for (;;) {
    if (nextLine > 99) { npa += 1; nextLine = 0; }
    const digits = `${npa}55501${String(nextLine).padStart(2, '0')}`;
    nextLine += 1;
    const { rows } = await pool.query(
      `SELECT 1 FROM thumbtack_leads WHERE RIGHT(REGEXP_REPLACE(customer_phone, '\\D', '', 'g'), 10) = $1
       UNION ALL SELECT 1 FROM clients WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
       UNION ALL SELECT 1 FROM sms_optouts WHERE phone_last10 = $1
       LIMIT 1`,
      [digits]
    );
    if (rows.length === 0) return digits;
  }
}

async function mkFixture({ status = 'sent', smsEnabled = true, phoneStatus = 'ok' } = {}) {
  seq += 1;
  const phone = await freshPhone();
  const c = await pool.query(
    `INSERT INTO clients (name, phone, communication_preferences, phone_status)
     VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
    [`Gv Suppression ${RUN} ${seq}`, phone,
      JSON.stringify({ sms_enabled: smsEnabled, email_enabled: true, marketing_enabled: true }), phoneStatus]
  );
  created.clients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', $2, 'wedding-reception', 1000, 'America/Chicago')
     RETURNING id`,
    [c.rows[0].id, status]
  );
  created.proposals.push(p.rows[0].id);
  return { proposalId: p.rows[0].id, phone };
}

async function optOut(phone, { cleared = false } = {}) {
  await pool.query(
    `INSERT INTO sms_optouts (phone_last10, opted_out_at, source, cleared_at)
     VALUES ($1, now() - interval '1 day', 'keyword', CASE WHEN $2::boolean THEN now() END)`,
    [phone, cleared]
  );
  created.optouts.push(phone);
}

// The context the router and the lease build: loadGvContext, then the number
// that would be texted (E.164, as resolveGvTarget returns it).
async function suppressionFor(proposalId, phone) {
  const ctx = await loadGvContext(proposalId);
  return gvSuppression({ ...ctx, phone: `+1${phone}` });
}

before(() => {
  npa = 200 + crypto.randomInt(0, 600);
});

after(async () => {
  if (created.optouts.length) await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [created.optouts]);
  if (created.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [created.proposals]);
  if (created.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [created.clients]);
  await pool.end();
});

test('archived proposal is archived', async () => {
  const { proposalId, phone } = await mkFixture({ status: 'archived' });
  assert.deepEqual(await suppressionFor(proposalId, phone), { ok: false, reason: 'archived' });
});

test('sms_enabled false is channel_disabled', async () => {
  const { proposalId, phone } = await mkFixture({ smsEnabled: false });
  assert.deepEqual(await suppressionFor(proposalId, phone), { ok: false, reason: 'channel_disabled' });
});

test('phone_status bad is bad_contact', async () => {
  const { proposalId, phone } = await mkFixture({ phoneStatus: 'bad' });
  assert.deepEqual(await suppressionFor(proposalId, phone), { ok: false, reason: 'bad_contact' });
});

test('active sms_optouts row is opted_out', async () => {
  const { proposalId, phone } = await mkFixture();
  await optOut(phone);
  assert.deepEqual(await suppressionFor(proposalId, phone), { ok: false, reason: 'opted_out' });
});

test('a cleared opt-out passes', async () => {
  const { proposalId, phone } = await mkFixture();
  await optOut(phone, { cleared: true });
  assert.deepEqual(await suppressionFor(proposalId, phone), { ok: true });
  // loadGvContext reads the shape the router and the lease feed to gvSuppression.
  const ctx = await loadGvContext(proposalId);
  assert.equal(ctx.proposal.id, proposalId);
  assert.equal(ctx.proposal.status, 'sent');
  assert.match(ctx.proposal.token, /^[0-9a-f-]{36}$/);
  assert.equal(ctx.client.phone, phone);
  assert.equal(ctx.client.phone_status, 'ok');
  assert.equal(ctx.client.communication_preferences.sms_enabled, true);
});

test('status draft is not_sendable', async () => {
  const { proposalId, phone } = await mkFixture({ status: 'draft' });
  assert.deepEqual(await suppressionFor(proposalId, phone), { ok: false, reason: 'not_sendable' });
});
