'use strict';

// The SendModal's proposal text and GV routing (spec 2026-10-17, plan Task 5):
// resolveRecipient marks a relay client's Text row, and dispatch routes the
// text before the toll-free send. DB suite on the shared dev database: run
// ALONE,
//   node --test server/utils/comms/actions/proposalResend.gvPost.test.js
// The router is stubbed through the module's __setDeps; resolveRecipient's
// identity lookup is the real one over invented fixtures (names, 555-01xx
// numbers), all deleted by id or key in after().
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('proposalResend.gvPost.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../../db');
const { proposalUrl } = require('../../urls');
const { resolveGvTarget } = require('../../gvPost/identity');
const { routeProposalText } = require('../../gvPost/queue');
const resend = require('./proposalResend');

const RUN = `gvrs-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const ORIG_FLAG = process.env.GV_PROPOSAL_POST_ENABLED;
const created = { leads: [], proposals: [], clients: [] };
let phone, clientId, proposalId, token;

// A 555-01xx number nothing on the dev DB carries yet.
async function freshPhone() {
  let npa = 200 + crypto.randomInt(0, 600);
  for (let line = 0; ; line += 1) {
    if (line > 99) { npa += 1; line = 0; }
    const digits = `${npa}55501${String(line).padStart(2, '0')}`;
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

before(async () => {
  process.env.GV_PROPOSAL_POST_ENABLED = 'true';
  phone = await freshPhone();
  const c = await pool.query('INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id', [`Gv Resend ${RUN}`, phone]);
  clientId = c.rows[0].id;
  created.clients.push(clientId);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'sent', 'wedding-reception', 1000, 'America/Chicago')
     RETURNING id, token`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  token = p.rows[0].token;
  created.proposals.push(proposalId);
  // A relay client: one post-rollout lead on the number, linked to the proposal.
  const l = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_id, customer_name, customer_phone, status, raw_payload, proposal_id)
     VALUES ($1, $2, $3, 'Gv Resend Lead', $4, 'new', '{}'::jsonb, $5) RETURNING id`,
    [`${RUN}-1`, clientId, `${RUN}-cust`, `+1${phone}`, proposalId]
  );
  created.leads.push(l.rows[0].id);
});

// Fixtures first: nothing that can throw runs before the deletes.
after(async () => {
  if (ORIG_FLAG === undefined) delete process.env.GV_PROPOSAL_POST_ENABLED;
  else process.env.GV_PROPOSAL_POST_ENABLED = ORIG_FLAG;
  try {
    if (created.proposals.length) {
      await pool.query('DELETE FROM message_log WHERE proposal_id = ANY($1::int[])', [created.proposals]);
      await pool.query('DELETE FROM gv_posts WHERE proposal_id = ANY($1::int[])', [created.proposals]);
    }
    if (created.leads.length) await pool.query('DELETE FROM thumbtack_leads WHERE id = ANY($1::int[])', [created.leads]);
    if (created.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [created.proposals]);
    if (created.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [created.clients]);
  } finally {
    if (typeof resend.__setDeps === 'function') {
      resend.__setDeps({ resolveGvTarget, routeProposalText, Sentry: require('@sentry/node') });
    }
    await pool.end();
  }
});

test('resend dispatch to a relay client returns sms queued with sms_route thumbtack and writes no message_log row', async () => {
  const calls = [];
  resend.__setDeps({ routeProposalText: (args) => { calls.push(args); return Promise.resolve({ route: 'gv', id: 1 }); } });
  const body = `Hi, Dallas here. Your updated proposal is ready: ${proposalUrl(token)}`;
  try {
    const r = await resend.dispatch(proposalId, { sms: { body } }, ['sms'], { sentBy: 4242 });
    assert.equal(r.sms, 'queued');
    assert.equal(r.sms_route, 'thumbtack');
    assert.equal(r.sms_error, undefined);
    assert.equal(r.email, 'skipped');
  } finally {
    resend.__setDeps({ routeProposalText });
  }
  assert.deepEqual(calls, [{ proposalId, token, body, sentBy: 4242, sendPath: 'compose' }]);
  const logged = await pool.query('SELECT COUNT(*)::int AS n FROM message_log WHERE proposal_id = $1', [proposalId]);
  assert.equal(logged.rows[0].n, 0, 'a GV post writes no message_log row');
});

test('resolveRecipient marks a relay client via thumbtack with max_chars 320 and phone_last4', async () => {
  const r = await resend.resolveRecipient(proposalId);
  assert.equal(r.channels.sms.available, true);
  assert.equal(r.channels.sms.via, 'thumbtack');
  assert.equal(r.channels.sms.max_chars, 320);
  assert.equal(r.channels.sms.phone_last4, phone.slice(-4));

  // The label follows the kill switch: off, the row is today's text.
  delete process.env.GV_PROPOSAL_POST_ENABLED;
  try {
    const off = await resend.resolveRecipient(proposalId);
    assert.equal(off.channels.sms.via, 'twilio');
    assert.equal(off.channels.sms.max_chars, 640);
    assert.equal(off.channels.sms.phone_last4, undefined);
  } finally {
    process.env.GV_PROPOSAL_POST_ENABLED = 'true';
  }
});

test('resolveRecipient falls back to twilio when the identity lookup throws', async () => {
  const captured = [];
  resend.__setDeps({
    resolveGvTarget: () => Promise.reject(new Error('lookup exploded')),
    Sentry: { captureException: (err, ctx) => captured.push({ err, ctx }) },
  });
  try {
    const r = await resend.resolveRecipient(proposalId);
    assert.equal(r.channels.sms.available, true, 'the preview still offers the text');
    assert.equal(r.channels.sms.via, 'twilio');
    assert.equal(r.channels.sms.max_chars, 640);
    assert.equal(r.channels.sms.phone_last4, undefined);
  } finally {
    resend.__setDeps({ resolveGvTarget, Sentry: require('@sentry/node') });
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].ctx.tags.feature, 'gv_post');
  assert.ok(!JSON.stringify(captured[0].ctx).includes(phone), 'no number in the Sentry event');
});
