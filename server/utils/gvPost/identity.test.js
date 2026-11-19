'use strict';

// The GV identity rule (spec 2026-10-17 law 1, plan Task 2): which Thumbtack
// lead, if any, a proposal's text may be posted to through Google Voice.
// DB suite on the shared dev database: run ALONE,
//   node --test server/utils/gvPost/identity.test.js
// Every fixture is invented (names, 555-01xx numbers, customer ids) and is
// deleted by id in after().
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('identity.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');
const { resolveGvTarget } = require('./identity');

const RUN = `gvid-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const created = { leads: [], proposals: [], clients: [] };
let seq = 0;
let npa;
let nextLine = 0;

// A 555-01xx number nothing on the dev DB carries yet (leads, clients or
// opt-outs), so a stray fixture from another suite cannot turn a test into
// foreign_lead. Ten digits, no country code, the way clients.phone is stored.
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

async function mkClient(phone) {
  seq += 1;
  const { rows } = await pool.query(
    'INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id',
    [`Gv Identity ${RUN} ${seq}`, phone]
  );
  created.clients.push(rows[0].id);
  return rows[0].id;
}

async function mkProposal(clientId) {
  const { rows } = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'sent', 'wedding-reception', 1000, 'America/Chicago')
     RETURNING id`,
    [clientId]
  );
  created.proposals.push(rows[0].id);
  return rows[0].id;
}

// createdDaysAgo backdates the lead (a pre-rollout or an aged lead).
async function mkLead({ phone, clientId, customerId, proposalId = null, createdDaysAgo = 0 }) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO thumbtack_leads
       (negotiation_id, client_id, customer_id, customer_name, customer_phone, status, raw_payload, proposal_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 'new', '{}'::jsonb, $6, now() - ($7::int * interval '1 day'))
     RETURNING id, negotiation_id`,
    [`${RUN}-${seq}`, clientId, customerId, `Gv Lead ${seq}`, `+1${phone}`, proposalId, createdDaysAgo]
  );
  created.leads.push(rows[0].id);
  return rows[0];
}

before(() => {
  npa = 200 + crypto.randomInt(0, 600);
});

after(async () => {
  if (created.leads.length) await pool.query('DELETE FROM thumbtack_leads WHERE id = ANY($1::int[])', [created.leads]);
  if (created.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [created.proposals]);
  if (created.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [created.clients]);
  await pool.end();
});

test('linked lead on the client phone resolves', async () => {
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposalId = await mkProposal(clientId);
  // An unlinked lead of the same customer on the same number would make the
  // pick ambiguous; the link to this proposal is what decides it.
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-a` });
  const linked = await mkLead({ phone, clientId, customerId: `${RUN}-cust-a`, proposalId });
  const r = await resolveGvTarget(proposalId);
  assert.deepEqual(r, {
    ok: true, clientId, leadId: linked.id, negotiationId: linked.negotiation_id, phone: `+1${phone}`,
  });
});

test('single unlinked lead of the same client resolves', async () => {
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposalId = await mkProposal(clientId);
  const lead = await mkLead({ phone, clientId, customerId: `${RUN}-cust-b` });
  const r = await resolveGvTarget(proposalId);
  assert.equal(r.ok, true);
  assert.equal(r.leadId, lead.id);
  assert.equal(r.negotiationId, lead.negotiation_id);
  assert.equal(r.phone, `+1${phone}`);
});

test('two unlinked leads of the same client on one number is ambiguous_lead', async () => {
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposalId = await mkProposal(clientId);
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-c` });
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-c` });
  assert.deepEqual(await resolveGvTarget(proposalId), { ok: false, reason: 'ambiguous_lead' });
});

test("another client's lead on the number is foreign_lead", async () => {
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const otherClientId = await mkClient(null);
  const proposalId = await mkProposal(clientId);
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-d`, proposalId });
  await mkLead({ phone, clientId: otherClientId, customerId: `${RUN}-cust-d` });
  assert.deepEqual(await resolveGvTarget(proposalId), { ok: false, reason: 'foreign_lead' });
});

test('a lead with no client on the number is foreign_lead', async () => {
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposalId = await mkProposal(clientId);
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-e`, proposalId });
  await mkLead({ phone, clientId: null, customerId: `${RUN}-cust-e` });
  assert.deepEqual(await resolveGvTarget(proposalId), { ok: false, reason: 'foreign_lead' });
});

test('two leads of the same client with different Thumbtack customer ids is customer_mismatch', async () => {
  // A recycled relay number arrives under a new Thumbtack customer id even when
  // the webhook's name match attached it to the old client row.
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposalId = await mkProposal(clientId);
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-f1`, proposalId });
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-f2` });
  assert.deepEqual(await resolveGvTarget(proposalId), { ok: false, reason: 'customer_mismatch' });
});

test('only a pre-rollout lead is not_relay', async () => {
  // Before 2026-06-08 a lead stored the customer's real number, never a relay.
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposalId = await mkProposal(clientId);
  const { rows } = await pool.query(
    "SELECT (now()::date - DATE '2026-06-01')::int AS days"
  );
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-g`, createdDaysAgo: rows[0].days });
  assert.deepEqual(await resolveGvTarget(proposalId), { ok: false, reason: 'not_relay' });
});

test('linked lead on a different number is lead_not_on_phone', async () => {
  const phone = await freshPhone();
  const otherPhone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposalId = await mkProposal(clientId);
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-h` });
  await mkLead({ phone: otherPhone, clientId, customerId: `${RUN}-cust-h2`, proposalId });
  assert.deepEqual(await resolveGvTarget(proposalId), { ok: false, reason: 'lead_not_on_phone' });
});

// Days back to 2026-06-01: before THUMBTACK_PROXY_ROLLOUT (2026-06-08), and
// still under the 180-day window until late November 2026.
async function preRolloutDaysAgo() {
  const { rows } = await pool.query("SELECT (now()::date - DATE '2026-06-01')::int AS days");
  return rows[0].days;
}

test('a pre-rollout linked lead with another customer id is customer_mismatch', async () => {
  // Steps 3 and 4 read only post-rollout leads, so a linked lead from before
  // the rollout must be held to the shared customer id on its own.
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposalId = await mkProposal(clientId);
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-j1` });
  await mkLead({
    phone, clientId, customerId: `${RUN}-cust-j2`, proposalId, createdDaysAgo: await preRolloutDaysAgo(),
  });
  assert.deepEqual(await resolveGvTarget(proposalId), { ok: false, reason: 'customer_mismatch' });
});

test('a pre-rollout linked lead with no client is foreign_lead', async () => {
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposalId = await mkProposal(clientId);
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-k` });
  await mkLead({
    phone, clientId: null, customerId: `${RUN}-cust-k`, proposalId, createdDaysAgo: await preRolloutDaysAgo(),
  });
  assert.deepEqual(await resolveGvTarget(proposalId), { ok: false, reason: 'foreign_lead' });
});

test('lead older than 180 days is lead_too_old', async () => {
  // A post-rollout lead cannot be 180 days old before December 2026, so the aged
  // lead is the one linked to the proposal: the link picks it, it carries the
  // client's number, and its age alone refuses it.
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposalId = await mkProposal(clientId);
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-i` });
  await mkLead({ phone, clientId, customerId: `${RUN}-cust-i`, proposalId, createdDaysAgo: 181 });
  assert.deepEqual(await resolveGvTarget(proposalId), { ok: false, reason: 'lead_too_old' });
});
