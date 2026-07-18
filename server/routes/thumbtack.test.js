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

// Pure unit tests for the stated-budget parser (exported from thumbtack.js).
// Answer shapes below are real prod payload values verified 2026-07-02
// (see the spec's Production findings).
test('extractBudget: single range', () => {
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: '$300 - $400' }]),
    { budgetMin: 300, budgetMax: 400, budgetRaw: '$300 - $400' }
  );
});
test('extractBudget: multi-select collapses to min-of-mins / max-of-maxes', () => {
  const raw = '$300 - $400, $400 - $500, $200 - $300 (typically only for small/brief events)';
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: raw }]),
    { budgetMin: 200, budgetMax: 500, budgetRaw: raw }
  );
});
test('extractBudget: "Under $200" bounds [0, 200]', () => {
  const raw = 'Under $200 (typically only for small/brief events)';
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: raw }]),
    { budgetMin: 0, budgetMax: 200, budgetRaw: raw }
  );
});
test('extractBudget: "More than $750" leaves an open max (no flag possible)', () => {
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: 'More than $750' }]),
    { budgetMin: 750, budgetMax: null, budgetRaw: 'More than $750' }
  );
});
test('extractBudget: any "More than" token forces the open max even mixed with ranges', () => {
  const raw = 'More than $750, $500 - $600, $600- $750';
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: raw }]),
    { budgetMin: 500, budgetMax: null, budgetRaw: raw }
  );
});
test('extractBudget: unsure-only is all nulls (entity-decoded before matching)', () => {
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: 'I&#39;m not sure' }]),
    { budgetMin: null, budgetMax: null, budgetRaw: null }
  );
});
test('extractBudget: unsure token mixed with a range is ignored, raw keeps the decoded answer', () => {
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: 'I&#39;m not sure, $300 - $400' }]),
    { budgetMin: 300, budgetMax: 400, budgetRaw: "I'm not sure, $300 - $400" }
  );
});
test('extractBudget: free-form "$300 to $600" and the missing-space "$600- $750"', () => {
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: '$300 to $600' }]),
    { budgetMin: 300, budgetMax: 600, budgetRaw: '$300 to $600' }
  );
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: '$600- $750' }]),
    { budgetMin: 600, budgetMax: 750, budgetRaw: '$600- $750' }
  );
});
test('extractBudget: no budget question, junk answer, bare single number, or null details are all nulls', () => {
  const NULLS = { budgetMin: null, budgetMax: null, budgetRaw: null };
  assert.deepEqual(thumbtackRouter.extractBudget([{ question: 'Beverage types', answer: 'Beer, Wine' }]), NULLS);
  assert.deepEqual(thumbtackRouter.extractBudget([{ question: 'Budget', answer: 'call me to discuss' }]), NULLS);
  assert.deepEqual(thumbtackRouter.extractBudget([{ question: 'Budget', answer: '$400' }]), NULLS);
  assert.deepEqual(thumbtackRouter.extractBudget(null), NULLS);
});
test('parseLead: V4 and legacy both carry the budget fields', () => {
  const v4 = thumbtackRouter.parseLead({
    event: { eventType: 'NewLeadV4' },
    data: { negotiationID: 'neg-budget', request: { details: [{ question: 'Budget', answer: '$300 - $400' }] } },
  });
  assert.equal(v4.budgetMin, 300);
  assert.equal(v4.budgetMax, 400);
  assert.equal(v4.budgetRaw, '$300 - $400');
  const legacy = thumbtackRouter.parseLead({
    leadID: 'lead-budget',
    request: { details: [{ question: 'Budget', answer: 'More than $750' }] },
  });
  assert.equal(legacy.budgetMin, 750);
  assert.equal(legacy.budgetMax, null);
  assert.equal(legacy.budgetRaw, 'More than $750');
});

// Pure unit tests for event-duration capture (exported from thumbtack.js).
// Real V4 leads carry the event window as proposedTimes[].start/end (never a
// scalar booking.duration), so the duration is the unambiguous end - start.
test('computeDurationHours: hours from the end - start window', () => {
  assert.equal(thumbtackRouter.computeDurationHours('2026-08-29T22:00:00Z', '2026-08-30T04:00:00Z'), 6);
  assert.equal(thumbtackRouter.computeDurationHours('2026-07-24T21:30:00Z', '2026-07-25T00:30:00Z'), 3);
});
test('computeDurationHours: missing or implausible window yields null', () => {
  assert.equal(thumbtackRouter.computeDurationHours(null, '2026-01-01T00:00:00Z'), null);
  assert.equal(thumbtackRouter.computeDurationHours('2026-01-01T05:00:00Z', '2026-01-01T05:00:00Z'), null); // 0h
  assert.equal(thumbtackRouter.computeDurationHours('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'), null); // negative
  assert.equal(thumbtackRouter.computeDurationHours('2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z'), null); // 48h > 24
  assert.equal(thumbtackRouter.computeDurationHours('bad', 'worse'), null);
});
test('parseLead: V4 captures eventDuration from the proposedTimes window', () => {
  const lead = thumbtackRouter.parseLead({
    event: { eventType: 'NewLead' },
    data: {
      negotiationID: 'neg-dur',
      request: {
        category: { name: 'Bartending' },
        proposedTimes: [{ start: '2026-08-29T22:00:00Z', end: '2026-08-30T04:00:00Z' }],
        details: [],
      },
    },
  });
  assert.equal(lead.eventDuration, 6);
  assert.equal(lead.eventDate, '2026-08-29T22:00:00Z');
});
test('parseLead: V4 with no end time leaves eventDuration null (draft falls back to 4)', () => {
  const lead = thumbtackRouter.parseLead({
    event: {}, data: { negotiationID: 'n', request: { proposedTimes: [{ start: '2026-08-29T22:00:00Z' }], details: [] } },
  });
  assert.equal(lead.eventDuration, null);
});

let server, baseUrl;
const secret = process.env.THUMBTACK_WEBHOOK_SECRET || null;
const negA = `test-fail-${Date.now()}`;
const negB = `test-pii-${Date.now()}`;
const negC = `test-half-${Date.now()}`;
const negD = `test-budget-${Date.now()}`;
const created = { negotiationIds: [negA, negB, negC, negD], proposalIds: [], clientIds: [] };

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

// V4 envelope with a proposedTimes window, so eventDuration is computed from
// end - start. start/end are ISO strings.
function postLeadV4(negotiationId, start, end) {
  const body = JSON.stringify({
    event: { eventType: 'NewLeadV4' },
    data: {
      negotiationID: negotiationId,
      customer: { firstName: 'Half', lastName: 'Hour', phone: `+1555${String(Date.now()).slice(-7)}` },
      request: {
        category: { name: 'Bartending' }, description: 'half-hour window',
        location: { city: 'Chicago', state: 'IL', zipCode: '60601' },
        proposedTimes: [{ start, end }],
        details: [{ question: 'Guests?', answer: '60' }],
      },
    },
  });
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['x-thumbtack-secret'] = secret;
  return httpReq('POST', '/api/thumbtack/leads', headers, body);
}

// V4 lead whose details carry a stated Budget answer (multi-select,
// entity-encoded exactly like real prod payloads).
function postLeadV4Budget(negotiationId, budgetAnswer) {
  const body = JSON.stringify({
    event: { eventType: 'NewLeadV4' },
    data: {
      negotiationID: negotiationId,
      customer: { firstName: 'Budget', lastName: 'Harness', phone: `+1555${String(Date.now()).slice(-7)}` },
      request: {
        category: { name: 'Bartending' }, description: 'budget harness',
        location: { city: 'Chicago', state: 'IL', zipCode: '60601' },
        proposedTimes: [{ start: '2026-09-19T23:00:00Z', end: '2026-09-20T03:00:00Z' }],
        details: [
          { question: 'Estimated guest count', answer: '76 - 100 guests' },
          { question: 'Budget', answer: budgetAnswer },
        ],
      },
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

test('a fractional (:30) event window persists the lead and prices the half-hour, never 500s', async () => {
  thumbtackRouter.__setDeps({ createDraftProposalFromLead }); // real builder
  // 6:00 PM -> 9:30 PM Central = 3.5h. A routine customer choice; this must NOT
  // crash the INTEGER insert (regression guard for the auto-draft duration fix).
  const res = await postLeadV4(negC, '2026-09-12T23:00:00Z', '2026-09-13T02:30:00Z');
  assert.equal(res.status, 200, 'a half-hour window must not 500 the webhook');

  const lead = await pool.query('SELECT event_duration, client_id, proposal_id FROM thumbtack_leads WHERE negotiation_id = $1', [negC]);
  assert.equal(lead.rows.length, 1, 'lead persisted');
  assert.equal(Number(lead.rows[0].event_duration), 3.5, 'fractional duration stored faithfully');
  if (lead.rows[0].client_id) created.clientIds.push(lead.rows[0].client_id);
  assert.ok(lead.rows[0].proposal_id, 'a draft was auto-created');
  created.proposalIds.push(lead.rows[0].proposal_id);

  const p = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [lead.rows[0].proposal_id]);
  assert.equal(Number(p.rows[0].event_duration_hours), 3.5, 'draft priced on the real 3.5h, not the 4h default');
});

test('webhook persists the parsed stated budget on the lead row', async () => {
  thumbtackRouter.__setDeps({ createDraftProposalFromLead }); // real builder
  const res = await postLeadV4Budget(negD, 'I&#39;m not sure, $300 - $400, $400 - $500');
  assert.equal(res.status, 200);
  const lead = await pool.query(
    'SELECT budget_min, budget_max, budget_raw, client_id, proposal_id FROM thumbtack_leads WHERE negotiation_id = $1',
    [negD]
  );
  assert.equal(lead.rows.length, 1, 'lead persisted');
  if (lead.rows[0].client_id) created.clientIds.push(lead.rows[0].client_id);
  if (lead.rows[0].proposal_id) created.proposalIds.push(lead.rows[0].proposal_id);
  assert.equal(lead.rows[0].budget_min, 300, 'unsure token ignored; min of selected ranges');
  assert.equal(lead.rows[0].budget_max, 500, 'max of selected ranges');
  assert.equal(lead.rows[0].budget_raw, "I'm not sure, $300 - $400, $400 - $500", 'raw stored decoded');
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

test('seeding: a new email-less Thumbtack lead flags its client pending', async () => {
  thumbtackRouter.__setDeps({ createDraftProposalFromLead: async () => null });
  const neg = `test-seed-pending-${Date.now()}`;
  created.negotiationIds.push(neg);
  const res = await postLead(neg);
  assert.equal(res.status, 200);
  const lead = await pool.query('SELECT client_id FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  const clientId = lead.rows[0].client_id;
  assert.ok(clientId, 'a client should have been created');
  created.clientIds.push(clientId);
  const c = await pool.query('SELECT email, email_harvest_status FROM clients WHERE id = $1', [clientId]);
  assert.equal(c.rows[0].email, null, 'harness lead has no email');
  assert.equal(c.rows[0].email_harvest_status, 'pending', 'an email-less Thumbtack client must be flagged pending');
});

test('seeding: a returning lead does NOT re-flag a client whose harvest already concluded', async () => {
  // findOrCreateClient's phone match only fires on email-NULL, name-matching rows
  // (anti-takeover guard in clientDedup.js), so a Thumbtack lead never resolves to a
  // client that already has an email. The reachable protection is the STATUS guard:
  // once a client's harvest concluded (failed/harvested), a new lead must not reset
  // it to pending. Re-arm is an explicit admin action. Here we drive a 'failed' row.
  thumbtackRouter.__setDeps({ createDraftProposalFromLead: async () => null });
  const phone = `+1555${String(Date.now()).slice(-7)}`;
  const name = 'Harness Returning';
  const mkBody = (neg) => JSON.stringify({
    leadID: neg,
    customer: { name, phone },
    request: { category: 'Wedding Bartending', description: 'x', location: { city: 'Tampa', state: 'FL', zipCode: '33602' }, details: [] },
  });
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['x-thumbtack-secret'] = secret;

  // Lead 1 creates the email-less client (seeded pending).
  const neg1 = `test-seed-a-${Date.now()}`;
  created.negotiationIds.push(neg1);
  await httpReq('POST', '/api/thumbtack/leads', headers, mkBody(neg1));
  const r1 = await pool.query('SELECT client_id FROM thumbtack_leads WHERE negotiation_id = $1', [neg1]);
  const clientId = r1.rows[0].client_id;
  assert.ok(clientId, 'lead 1 should create a client');
  created.clientIds.push(clientId);

  // The harvester gave up: status 'failed', email still null.
  await pool.query("UPDATE clients SET email_harvest_status = 'failed' WHERE id = $1", [clientId]);

  // Lead 2 (same name + phone) dedupes onto the same email-null client.
  const neg2 = `test-seed-b-${Date.now()}`;
  created.negotiationIds.push(neg2);
  const res = await httpReq('POST', '/api/thumbtack/leads', headers, mkBody(neg2));
  assert.equal(res.status, 200);
  const r2 = await pool.query('SELECT client_id FROM thumbtack_leads WHERE negotiation_id = $1', [neg2]);
  assert.equal(r2.rows[0].client_id, clientId, 'lead 2 should dedupe onto the same email-null client by name+phone');
  const status = await pool.query('SELECT email_harvest_status FROM clients WHERE id = $1', [clientId]);
  assert.equal(status.rows[0].email_harvest_status, 'failed', 'a concluded (failed) harvest must NOT be reset to pending by a new lead');
});

test('duplicate-heal: a committed lead with no draft heals on redelivery; a fully-processed duplicate does not', async () => {
  // First delivery: stub the draft to no-op so the lead + client persist but
  // proposal_id stays null — the exact shape of a crash-after-commit strand
  // (client committed alongside the lead, post-commit draft never landed).
  thumbtackRouter.__setDeps({ createDraftProposalFromLead: async () => null });
  const neg = `test-heal-${Date.now()}`;
  created.negotiationIds.push(neg);
  const first = await postLead(neg);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'ok');
  const l1 = await pool.query('SELECT client_id, proposal_id FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  const clientId = l1.rows[0].client_id;
  assert.ok(clientId, 'a client is committed alongside the lead');
  created.clientIds.push(clientId);
  assert.equal(l1.rows[0].proposal_id, null, 'strand: no draft yet');

  // The heal now fires only OUTSIDE the in-flight window (created_at older than
  // 10 minutes). Backdate the strand so this redelivery is heal-eligible; without
  // this the fix would defer it as an in-flight duplicate (503 retry_later).
  // Semantics-preserving: the strand still heals on redelivery — now meaning a
  // redelivery that arrives outside the original attempt's in-flight window.
  await pool.query(
    "UPDATE thumbtack_leads SET created_at = NOW() - INTERVAL '20 minutes' WHERE negotiation_id = $1",
    [neg]
  );

  // Redelivery with the REAL builder: the heal must run the post-commit steps
  // and create the draft.
  thumbtackRouter.__setDeps({ createDraftProposalFromLead });
  const second = await postLead(neg);
  assert.equal(second.status, 200);
  assert.equal(second.body.status, 'healed', 'the strand is healed, not a plain duplicate');
  const l2 = await pool.query('SELECT proposal_id FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  assert.ok(l2.rows[0].proposal_id, 'heal created the draft');
  created.proposalIds.push(l2.rows[0].proposal_id);

  // Third delivery: proposal_id is now set -> a normal, fully-processed duplicate
  // -> no heal, no re-notify.
  const third = await postLead(neg);
  assert.equal(third.status, 200);
  assert.equal(third.body.status, 'duplicate', 'a fully-processed duplicate is skipped, never re-run');
});

// B10 RED: a duplicate delivered while the FIRST attempt's post-commit tail is
// still in flight (inside the 10-minute window) must NOT double-notify. The
// proposal_id heal marker cannot tell a crashed original from one still alive in
// its tail; the created_at window gate defers the in-flight duplicate with a 503
// so the provider keeps retrying rather than firing a second admin notify.
test('B10: a duplicate delivered while the first attempt is mid-tail defers (503) and does not double-notify', async () => {
  let draftCalls = 0;
  let releaseFirstDraft;
  const firstDraftGate = new Promise((r) => { releaseFirstDraft = r; });
  let notifyCount = 0;
  thumbtackRouter.__setDeps({
    // First call parks in the post-commit tail (models the original still alive,
    // pre-notify). Later calls return null immediately. Returns null so proposal_id
    // stays NULL — the exact strand shape the heal marker keys on.
    createDraftProposalFromLead: async () => {
      draftCalls += 1;
      if (draftCalls === 1) await firstDraftGate;
      return null;
    },
    notifyAdminCategory: async () => { notifyCount += 1; return { ok: true }; },
  });
  const negI = `test-inflight-${Date.now()}`;
  created.negotiationIds.push(negI);

  // Attempt A: do NOT await — it commits the lead + client, releases, then parks
  // inside runPostCommitSteps at the draft gate (before its own notify).
  const firstP = postLead(negI);

  // Wait until A has committed the lead with a client and proposal_id still NULL.
  let leadRow = null;
  for (let i = 0; i < 200; i += 1) {
    const r = await pool.query('SELECT client_id, proposal_id FROM thumbtack_leads WHERE negotiation_id = $1', [negI]);
    if (r.rows.length && r.rows[0].client_id && r.rows[0].proposal_id === null) { leadRow = r.rows[0]; break; }
    await new Promise((res) => setTimeout(res, 25));
  }
  assert.ok(leadRow, 'attempt A committed the lead + client and is parked in its post-commit tail');
  created.clientIds.push(leadRow.client_id);

  try {
    // The duplicate arrives inside the in-flight window: must be deferred, not healed.
    const dup = await postLead(negI);
    assert.equal(dup.status, 503, 'the in-flight duplicate is deferred (503), not healed (HEAD: 200)');
    assert.equal(dup.body.status, 'retry_later');
    // The gated duplicate touched nothing: no second draft-builder call, no notify.
    assert.equal(draftCalls, 1, 'the gated duplicate did not invoke the draft builder a second time');
  } finally {
    // Always release A's parked tail — otherwise its HTTP request never responds
    // and the after() server.close() hangs.
    releaseFirstDraft();
  }

  // A finishes and fires its single notify.
  const first = await firstP;
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'ok');
  assert.equal(notifyCount, 1, 'exactly one admin notify across the original + in-flight duplicate (HEAD: 2)');

  const afterRow = await pool.query('SELECT proposal_id FROM thumbtack_leads WHERE negotiation_id = $1', [negI]);
  assert.equal(afterRow.rows[0].proposal_id, null, 'the gated duplicate left proposal_id NULL');
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

// ─── Lead call bridge wiring (post-commit tail step 3) ───────────

test('lead-call trigger: normal path passes the inserted row id; a trigger throw still 200s', async () => {
  const calls = [];
  thumbtackRouter.__setDeps({
    createDraftProposalFromLead: async () => null,
    triggerLeadCall: async (args) => { calls.push(args); },
  });
  const neg = `test-leadcall-${Date.now()}`;
  created.negotiationIds.push(neg);
  const res = await postLead(neg);
  assert.equal(res.status, 200);
  const row = await pool.query('SELECT id, client_id FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  if (row.rows[0].client_id) created.clientIds.push(row.rows[0].client_id);
  assert.equal(calls.length, 1, 'trigger fires once per captured lead');
  assert.equal(calls[0].leadId, row.rows[0].id, 'the inserted PK is threaded through');
  assert.ok(calls[0].lead && calls[0].lead.customerPhone, 'the parsed lead rides along');

  thumbtackRouter.__setDeps({ triggerLeadCall: async () => { throw new Error('boom'); } });
  const neg2 = `test-leadcall2-${Date.now()}`;
  created.negotiationIds.push(neg2);
  const res2 = await postLead(neg2);
  assert.equal(res2.status, 200);
  assert.equal(res2.body.status, 'ok', 'a trigger throw never changes webhook semantics');
  const row2 = await pool.query('SELECT id, client_id FROM thumbtack_leads WHERE negotiation_id = $1', [neg2]);
  assert.ok(row2.rows[0], 'lead persisted despite the trigger throw');
  if (row2.rows[0].client_id) created.clientIds.push(row2.rows[0].client_id);
  thumbtackRouter.__setDeps({ triggerLeadCall: require('../utils/leadCallTrigger').triggerLeadCall });
});

test('lead-call trigger: the heal path passes the existing row id', async () => {
  const calls = [];
  thumbtackRouter.__setDeps({
    createDraftProposalFromLead: async () => null,
    triggerLeadCall: async (args) => { calls.push(args); },
  });
  const neg = `test-leadcall-heal-${Date.now()}`;
  created.negotiationIds.push(neg);
  await postLead(neg);
  const l1 = await pool.query('SELECT id, client_id FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  const leadRowId = l1.rows[0].id;
  if (l1.rows[0].client_id) created.clientIds.push(l1.rows[0].client_id);

  // Backdate outside the in-flight window so redelivery is heal-eligible.
  await pool.query("UPDATE thumbtack_leads SET created_at = NOW() - INTERVAL '20 minutes' WHERE negotiation_id = $1", [neg]);
  calls.length = 0;
  thumbtackRouter.__setDeps({ createDraftProposalFromLead }); // real builder so the heal completes
  const second = await postLead(neg);
  assert.equal(second.body.status, 'healed');
  const l2 = await pool.query('SELECT proposal_id FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  if (l2.rows[0].proposal_id) created.proposalIds.push(l2.rows[0].proposal_id);
  assert.equal(calls.length, 1, 'heal re-fires the trigger');
  assert.equal(calls[0].leadId, leadRowId, 'heal threads the existing row id');
  thumbtackRouter.__setDeps({ triggerLeadCall: require('../utils/leadCallTrigger').triggerLeadCall });
});
