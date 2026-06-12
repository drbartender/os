// Route-level tests for POST /api/thumbtack/leads. Proves (1) the auto-draft step
// is best-effort: a draft-builder failure still 200s with the lead persisted, and
// (2) a Thumbtack-sourced draft never leaks admin_notes on the public token route.
// Mounts the real routers on a throwaway express app (mirrors crud.test.js), runs
// against the dev DB, and cleans every row it creates. Run ALONE (shared dev DB).
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false'; // never fire real email/SMS from this suite
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const thumbtackRouter = require('./thumbtack');
const publicTokenRouter = require('./proposals/publicToken');
const { createDraftProposalFromLead } = require('../utils/thumbtackProposalDraft');

// Pure unit tests for the guest-count parser (exported from thumbtack.js).
test('extractGuestCount: takes the HIGH end of a range', () => {
  assert.equal(thumbtackRouter.extractGuestCount([{ question: 'Estimated guest count', answer: '51 - 75 guests' }]), 75);
});
test('extractGuestCount: single number passes through', () => {
  assert.equal(thumbtackRouter.extractGuestCount([{ question: 'How many guests?', answer: '80' }]), 80);
});
test('extractGuestCount: open-ended "100+" takes 100', () => {
  assert.equal(thumbtackRouter.extractGuestCount([{ question: 'Guest count', answer: '100+' }]), 100);
});
test('extractGuestCount: no guest question or no number yields null', () => {
  assert.equal(thumbtackRouter.extractGuestCount([{ question: 'Beverage types', answer: 'Beer, Wine' }]), null);
  assert.equal(thumbtackRouter.extractGuestCount(null), null);
});

let server, baseUrl;
const secret = process.env.THUMBTACK_WEBHOOK_SECRET || null;
const negA = `test-fail-${Date.now()}`;
const negB = `test-pii-${Date.now()}`;
const created = { negotiationIds: [negA, negB], proposalIds: [], clientIds: [] };

function httpReq(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + path, { method, headers }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function postLead(negotiationId) {
  const body = JSON.stringify({
    leadID: negotiationId,
    // 555-prefixed fictional number, unique per ms, so findOrCreateClient can never
    // match a real client; cleanup only ever deletes the ids this suite created.
    customer: { name: 'Harness Lead', phone: `+1555${String(Date.now()).slice(-7)}` },
    request: {
      category: 'Wedding Bartending', description: 'need bartender',
      location: { city: 'Tampa', state: 'FL', zipCode: '33602' },
      details: [{ question: 'Guests?', answer: '80' }],
    },
  });
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['x-thumbtack-secret'] = secret;
  return httpReq('POST', '/api/thumbtack/leads', headers, body);
}

function postMessage(messageId, negotiationId) {
  const body = JSON.stringify({
    event: { eventType: 'MessageCreatedV4' },
    data: {
      messageID: messageId,
      negotiationID: negotiationId,
      from: 'Customer',
      text: 'relay-removal harness message',
      sentAt: new Date().toISOString(),
      customer: { displayName: 'Harness Customer' },
    },
  });
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['x-thumbtack-secret'] = secret;
  return httpReq('POST', '/api/thumbtack/messages', headers, body);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/thumbtack', thumbtackRouter);
  app.use('/api/proposals', publicTokenRouter);
  app.use((err, req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message });
  });
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

test('best-effort: a draft-builder failure still 200s, persists the lead, and logs', async () => {
  thumbtackRouter.__setDeps({ createDraftProposalFromLead: async () => { throw new Error('boom'); } });
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.map(String).join(' '));
  try {
    const res = await postLead(negA);
    assert.equal(res.status, 200);
  } finally {
    console.error = origErr;
  }
  const lead = await pool.query('SELECT client_id, proposal_id FROM thumbtack_leads WHERE negotiation_id = $1', [negA]);
  assert.equal(lead.rows.length, 1, 'lead must be captured even though the draft threw');
  assert.equal(lead.rows[0].proposal_id, null, 'no proposal linked when the draft failed');
  if (lead.rows[0].client_id) created.clientIds.push(lead.rows[0].client_id);
  // The "best-effort + captured" guarantee is load-bearing: assert the failure was logged.
  assert.ok(errs.some(e => e.includes('auto-draft failed')), 'the draft failure must be logged');
});

test('a Thumbtack-sourced draft never exposes admin_notes on the public token route', async () => {
  thumbtackRouter.__setDeps({ createDraftProposalFromLead }); // restore the real builder
  const res = await postLead(negB);
  assert.equal(res.status, 200);
  const row = await pool.query(
    'SELECT p.id, p.token, p.source FROM proposals p JOIN thumbtack_leads t ON t.proposal_id = p.id WHERE t.negotiation_id = $1',
    [negB]
  );
  assert.equal(row.rows.length, 1, 'a draft should have been auto-created');
  assert.equal(row.rows[0].source, 'thumbtack');
  created.proposalIds.push(row.rows[0].id);
  const lead = await pool.query('SELECT client_id FROM thumbtack_leads WHERE negotiation_id = $1', [negB]);
  if (lead.rows[0] && lead.rows[0].client_id) created.clientIds.push(lead.rows[0].client_id);

  const pub = await httpReq('GET', `/api/proposals/t/${row.rows[0].token}`, {}, null);
  assert.equal(pub.status, 200);
  assert.equal('admin_notes' in pub.body, false, 'public token route must NOT expose admin_notes');
});

test('POST /messages persists the message and 200s with no admin email block', async () => {
  // Reuse negA (persisted in thumbtack_leads by the earlier draft-failure test) so
  // the message row points at a known lead, mirroring real webhook traffic.
  // negotiation_id has no FK constraint; any string would persist.
  const msgId = `test-msg-${Date.now()}`;
  const res = await postMessage(msgId, negA);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  const row = await pool.query('SELECT text, from_type FROM thumbtack_messages WHERE message_id = $1', [msgId]);
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].from_type, 'Customer');
  await pool.query('DELETE FROM thumbtack_messages WHERE message_id = $1', [msgId]);
});

after(async () => {
  for (const id of created.proposalIds) {
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
  }
  for (const neg of created.negotiationIds) await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  for (const id of created.proposalIds) await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  for (const id of created.clientIds) await pool.query('DELETE FROM clients WHERE id = $1', [id]);
  await new Promise(r => server.close(r));
  await pool.end();
});
