'use strict';

// POST /api/comms/send for a Thumbtack relay client (spec 2026-10-17 law 9,
// plan Task 5): the body must fit GV's 320 characters and carry exactly this
// proposal's link, checked before any side effect, and the response says where
// the text went. With the kill switch off, today's rules stand. Mirrors the
// express()+node:http harness of comms.silent.test.js. DB suite on the shared
// dev database: run ALONE,
//   node --test server/routes/comms.gvPost.test.js
// The router is stubbed through proposalResend's __setDeps, so nothing is
// queued (the flag-off case uses the real router, which answers 'disabled'
// before any read); relay detection is the real identity rule over invented
// fixtures (names, 555-01xx numbers), all deleted by id in after().
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('comms.gvPost.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { proposalUrl } = require('../utils/urls');
const { routeProposalText } = require('../utils/gvPost/queue');
const resend = require('../utils/comms/actions/proposalResend');
const commsRouter = require('./comms');

const RUN = `gvcm-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const ORIG_FLAG = process.env.GV_PROPOSAL_POST_ENABLED;
const CAP_MSG = 'Thumbtack texts are capped at 320 characters.';
const LINK_MSG = 'The text must include the proposal link.';
const MULTI_MSG = 'The text can carry only one proposal link.';
const WRONG_MSG = "The text links a different proposal. Use this proposal's link.";
const OTHER_TOKEN = '0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e';
const created = { leads: [], proposals: [], clients: [], users: [] };
let server, baseUrl, adminToken, clientId, proposalId, token;
const routeCalls = [];
const stubRoute = (args) => { routeCalls.push(args); return Promise.resolve({ route: 'gv', id: 1 }); };

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sendSms = (smsBody) => request('POST', '/api/comms/send', {
  body: { action: 'proposal_resend', entity_id: proposalId, channels: ['sms'], sms: { body: smsBody } },
});

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
  resend.__setDeps({ routeProposalText: stubRoute });

  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id, token_version`,
    [`gv-comms-${RUN}@example.test`]
  );
  created.users.push(admin.rows[0].id);
  adminToken = jwt.sign(
    { userId: admin.rows[0].id, tokenVersion: admin.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  const phone = await freshPhone();
  const c = await pool.query('INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id', [`Gv Comms ${RUN}`, phone]);
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
  const l = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_id, customer_name, customer_phone, status, raw_payload, proposal_id)
     VALUES ($1, $2, $3, 'Gv Comms Lead', $4, 'new', '{}'::jsonb, $5) RETURNING id`,
    [`${RUN}-1`, clientId, `${RUN}-cust`, `+1${phone}`, proposalId]
  );
  created.leads.push(l.rows[0].id);

  const app = express();
  app.use(express.json());
  app.use('/api/comms', commsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

// Fixtures first: nothing that can throw runs before the deletes.
after(async () => {
  if (ORIG_FLAG === undefined) delete process.env.GV_PROPOSAL_POST_ENABLED;
  else process.env.GV_PROPOSAL_POST_ENABLED = ORIG_FLAG;
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (created.proposals.length) {
      await pool.query('DELETE FROM message_log WHERE proposal_id = ANY($1::int[])', [created.proposals]);
      await pool.query('DELETE FROM gv_posts WHERE proposal_id = ANY($1::int[])', [created.proposals]);
      // Only a failed proposal_send case flips its draft (invoice, activity
      // log, drip); invoices restrict the proposal delete, so they go first.
      await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [created.proposals]);
      await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [created.proposals]);
      await pool.query(
        "DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = ANY($1::int[])",
        [created.proposals]
      );
    }
    if (created.leads.length) await pool.query('DELETE FROM thumbtack_leads WHERE id = ANY($1::int[])', [created.leads]);
    if (created.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [created.proposals]);
    if (created.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [created.clients]);
    if (created.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [created.users]);
  } finally {
    if (typeof resend.__setDeps === 'function') resend.__setDeps({ routeProposalText });
    await pool.end();
  }
});

test('comms send rejects a relay body over 320 with the cap message', async () => {
  const head = `Your proposal: ${proposalUrl(token)} `;
  const res = await sendSms(head + 'x'.repeat(321 - head.length));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, CAP_MSG);
  assert.deepEqual(res.body.fieldErrors, { sms_body: CAP_MSG });
  assert.equal(routeCalls.length, 0, 'nothing was dispatched');
});

test('comms send rejects a relay body without the link', async () => {
  const res = await sendSms('Hi, Dallas here. Your proposal is in your email.');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, LINK_MSG);
  assert.deepEqual(res.body.fieldErrors, { sms_body: LINK_MSG });
  assert.equal(routeCalls.length, 0, 'nothing was dispatched');
});

test('comms send rejects a relay body with two links', async () => {
  const link = proposalUrl(token);
  const res = await sendSms(`Your proposal: ${link} and again: ${link}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, MULTI_MSG);
  assert.deepEqual(res.body.fieldErrors, { sms_body: MULTI_MSG });
  assert.equal(routeCalls.length, 0, 'nothing was dispatched');
});

test('comms send rejects a relay body linking another proposal', async () => {
  const res = await sendSms(`Your proposal is ready: ${proposalUrl(OTHER_TOKEN)}.`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, WRONG_MSG);
  assert.deepEqual(res.body.fieldErrors, { sms_body: WRONG_MSG });
  assert.equal(routeCalls.length, 0, 'nothing was dispatched');
});

test('comms send response carries sms_route', async () => {
  const body = `Hi, Dallas here. Your proposal is ready: ${proposalUrl(token)}.`;
  const res = await sendSms(body);
  assert.equal(res.status, 200);
  assert.equal(res.body.sms, 'queued');
  assert.equal(res.body.sms_route, 'thumbtack');
  assert.equal(res.body.sms_error, null);
  assert.equal(routeCalls.length, 1);
  assert.equal(routeCalls[0].sendPath, 'compose');
  assert.equal(routeCalls[0].body, body);
});

test('flag off, a relay body of 500 characters with no link is accepted as today', async () => {
  // Law 2: off means exactly today. The 640 cap stands, no link is required,
  // and the real router answers 'disabled', so the text goes the 888 way (a
  // dev-skipped send under SEND_NOTIFICATIONS=false, ledgered nowhere).
  const body = `Hi, Dallas here. ${'Your proposal is in your email. '.repeat(16)}`.slice(0, 500);
  assert.equal(body.length, 500);
  const n = routeCalls.length;
  delete process.env.GV_PROPOSAL_POST_ENABLED;
  resend.__setDeps({ routeProposalText });
  let res;
  try {
    res = await sendSms(body);
  } finally {
    process.env.GV_PROPOSAL_POST_ENABLED = 'true';
    resend.__setDeps({ routeProposalText: stubRoute });
  }
  assert.equal(res.status, 200);
  assert.equal(res.body.sms, 'sent');
  assert.equal(res.body.sms_route, null);
  assert.equal(res.body.sms_error, null);
  assert.equal(routeCalls.length, n, 'the stubbed router was never asked');
  const posts = await pool.query('SELECT COUNT(*)::int AS n FROM gv_posts WHERE proposal_id = $1', [proposalId]);
  assert.equal(posts.rows[0].n, 0, 'no GV post was queued');
});

test('comms proposal_send rejects a relay body without the link and leaves the draft unsent', async () => {
  // The initial send's draft flips to sent (with its invoice) in
  // ensureSideEffects, so a rejected relay body must stop the request first.
  // This client's one lead on the number resolves the draft as relay too.
  const d = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '28 days', 'draft', 'wedding-reception', 1000, 'America/Chicago')
     RETURNING id`,
    [clientId]
  );
  const draftId = d.rows[0].id;
  created.proposals.push(draftId);
  const n = routeCalls.length;
  const res = await request('POST', '/api/comms/send', {
    body: { action: 'proposal_send', entity_id: draftId, channels: ['sms'], sms: { body: 'Hi, your proposal is in your email.' } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, LINK_MSG);
  assert.deepEqual(res.body.fieldErrors, { sms_body: LINK_MSG });
  assert.equal(routeCalls.length, n, 'nothing was dispatched');
  const { rows: [draft] } = await pool.query(
    `SELECT p.status, p.sent_at, (SELECT COUNT(*)::int FROM invoices i WHERE i.proposal_id = p.id) AS invoices
       FROM proposals p WHERE p.id = $1`,
    [draftId]
  );
  assert.equal(draft.status, 'draft');
  assert.equal(draft.sent_at, null);
  assert.equal(draft.invoices, 0);
});
