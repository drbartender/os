'use strict';

// The proposal-text router and its queue (spec 2026-10-17 laws 2, 3, 4, 7 and
// 8; plan Task 4). DB suite on the shared dev database: run ALONE,
//   node --test server/utils/gvPost/queue.test.js
// The router's notifications gate is injected through routeProposalText's
// __setDeps; SEND_NOTIFICATIONS stays 'false', so nothing can ever send. Every
// fixture is invented (names, 555-01xx numbers, customer ids) and deleted by id
// or key in after(). No agent polls a server with the flag on while these
// queued rows exist: the gv-agent API does not exist yet.
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('queue.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');
const smsTemplates = require('../smsTemplates');
const { proposalUrl } = require('../urls');
const { resolveGvTarget } = require('./identity');
const { routeProposalText } = require('./queue');

const RUN = `gvq-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const ORIG = { flag: process.env.GV_PROPOSAL_POST_ENABLED, cap: process.env.GV_POST_DAILY_CAP };
const created = { leads: [], proposals: [], clients: [], optouts: [], users: [] };
let seq = 0;
let npa;
let nextLine = 0;
let userId;

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

async function mkClient(phone) {
  seq += 1;
  const { rows } = await pool.query(
    'INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id',
    [`Gv Queue ${RUN} ${seq}`, phone]
  );
  created.clients.push(rows[0].id);
  return rows[0].id;
}

async function mkProposal(clientId) {
  const { rows } = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'sent', 'wedding-reception', 1000, 'America/Chicago')
     RETURNING id, token`,
    [clientId]
  );
  created.proposals.push(rows[0].id);
  return rows[0];
}

async function mkLead({ phone, clientId, proposalId = null }) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO thumbtack_leads
       (negotiation_id, client_id, customer_id, customer_name, customer_phone, status, raw_payload, proposal_id)
     VALUES ($1, $2, $3, $4, $5, 'new', '{}'::jsonb, $6)
     RETURNING id, negotiation_id`,
    [`${RUN}-${seq}`, clientId, `${RUN}-cust-${clientId}`, `Gv Lead ${seq}`, `+1${phone}`, proposalId]
  );
  created.leads.push(rows[0].id);
  return rows[0];
}

// A relay client: one post-rollout lead on the client's number, linked to the
// proposal, of the same client and customer.
async function mkRelay({ optedOut = false } = {}) {
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposal = await mkProposal(clientId);
  const lead = await mkLead({ phone, clientId, proposalId: proposal.id });
  if (optedOut) {
    await pool.query(
      `INSERT INTO sms_optouts (phone_last10, opted_out_at, source) VALUES ($1, now() - interval '1 day', 'keyword')`,
      [phone]
    );
    created.optouts.push(phone);
  }
  return { phone, clientId, proposalId: proposal.id, token: proposal.token, lead };
}

const bodyFor = (token) => smsTemplates.initialProposalSms({
  eventTypeLabel: 'wedding reception', eventDate: 'Saturday, June 6', link: proposalUrl(token),
});

const route = (f, extra = {}) => routeProposalText({
  proposalId: f.proposalId, token: f.token, body: bodyFor(f.token), sentBy: userId, sendPath: 'auto', ...extra,
});

const postsFor = async (proposalId) => (await pool.query(
  'SELECT * FROM gv_posts WHERE proposal_id = $1 ORDER BY id', [proposalId]
)).rows;

const notificationsOn = () => true;

before(async () => {
  npa = 200 + crypto.randomInt(0, 600);
  process.env.GV_PROPOSAL_POST_ENABLED = 'true';
  // The cap is global across the shared dev DB; only the cap test lowers it.
  process.env.GV_POST_DAILY_CAP = '1000';
  routeProposalText.__setDeps({ notificationsEnabled: notificationsOn, sweepRegistered: () => true });
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id`,
    [`gv-queue-${RUN}@example.test`]
  );
  userId = u.rows[0].id;
  created.users.push(userId);
});

after(async () => {
  if (ORIG.flag === undefined) delete process.env.GV_PROPOSAL_POST_ENABLED;
  else process.env.GV_PROPOSAL_POST_ENABLED = ORIG.flag;
  if (ORIG.cap === undefined) delete process.env.GV_POST_DAILY_CAP;
  else process.env.GV_POST_DAILY_CAP = ORIG.cap;
  if (created.proposals.length) {
    await pool.query('DELETE FROM gv_posts WHERE proposal_id = ANY($1::int[])', [created.proposals]);
  }
  if (created.optouts.length) await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [created.optouts]);
  if (created.leads.length) await pool.query('DELETE FROM thumbtack_leads WHERE id = ANY($1::int[])', [created.leads]);
  if (created.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [created.proposals]);
  if (created.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [created.clients]);
  if (created.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [created.users]);
  await pool.end();
});

test('flag off routes twilio disabled', async () => {
  const f = await mkRelay();
  // Off must look like today (law 2): not even a router log line per send.
  const logged = [];
  const realLog = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); };
  delete process.env.GV_PROPOSAL_POST_ENABLED;
  try {
    assert.deepEqual(await route(f), { route: 'twilio', reason: 'disabled' });
    process.env.GV_PROPOSAL_POST_ENABLED = 'TRUE';
    assert.deepEqual(await route(f), { route: 'twilio', reason: 'disabled' }, "only the literal 'true' enables");
  } finally {
    console.log = realLog;
    process.env.GV_PROPOSAL_POST_ENABLED = 'true';
  }
  assert.deepEqual(logged.filter((l) => l.includes('[gvPost]')), [], 'flag off logs no router line');
  assert.equal((await postsFor(f.proposalId)).length, 0);
});

test('a process that does not run the sweep routes twilio sweep_off and queues nothing', async () => {
  // The sweep is the only thing that drains a queued post the box never
  // leased. With the flag on and the sweep off (RUN_GV_POST_SWEEP_SCHEDULER or
  // RUN_SCHEDULERS false), a queued row would sit with no text and no alert.
  const f = await mkRelay();
  routeProposalText.__setDeps({ sweepRegistered: () => false });
  try {
    assert.deepEqual(await route(f), { route: 'twilio', reason: 'sweep_off' });
  } finally {
    routeProposalText.__setDeps({ sweepRegistered: () => true });
  }
  assert.equal((await postsFor(f.proposalId)).length, 0);
  // The real flag: off until server/index.js registers the sweep.
  const sweepState = require('./sweepState');
  assert.equal(sweepState.gvSweepRegistered(), false, 'a test process registers no sweep');
});

test('notifications off routes twilio notifications_off', async () => {
  const f = await mkRelay();
  routeProposalText.__setDeps({ notificationsEnabled: () => false });
  try {
    assert.deepEqual(await route(f), { route: 'twilio', reason: 'notifications_off' });
  } finally {
    routeProposalText.__setDeps({ notificationsEnabled: notificationsOn });
  }
  assert.equal((await postsFor(f.proposalId)).length, 0);
});

test('relay client with a valid body queues one row with status queued', async () => {
  const f = await mkRelay();
  const r = await route(f);
  assert.equal(r.route, 'gv');
  assert.ok(Number.isInteger(r.id));
  const rows = await postsFor(f.proposalId);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.id, r.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.client_id, f.clientId);
  assert.equal(row.lead_id, f.lead.id);
  assert.equal(row.negotiation_id, f.lead.negotiation_id);
  assert.equal(row.body, bodyFor(f.token));
  assert.equal(row.send_path, 'auto');
  assert.equal(row.sent_by, userId);
  assert.equal(row.reason, null);
  assert.equal(row.fallback_status, null);
  assert.equal(row.leased_at, null);
  // No phone number column (law 11): the number is resolved at lease.
  assert.ok(!Object.keys(row).some((k) => /phone/.test(k)), 'gv_posts stores no phone column');
});

test('a body with a line break is stored collapsed', async () => {
  // A SendModal body can carry line breaks. The box rejects any served body
  // with a line break or over 320 raw characters as invalid_body, so the row
  // must hold the normalized body validateGvBody returns, never the raw one.
  const f = await mkRelay();
  const raw = `  ${bodyFor(f.token).replace('. Review', '.\n\nReview').replace('Let me', 'Let\r\nme')}\n`;
  const r = await route(f, { body: raw, sendPath: 'compose' });
  assert.equal(r.route, 'gv');
  const [row] = await postsFor(f.proposalId);
  assert.equal(row.id, r.id);
  assert.equal(row.body, bodyFor(f.token), 'each whitespace run collapsed to one space, then trimmed');
  assert.doesNotMatch(row.body, /[\r\n]/);
  assert.equal(row.send_path, 'compose');
});

test('non-relay client routes twilio not_relay', async () => {
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const proposal = await mkProposal(clientId);
  const r = await route({ proposalId: proposal.id, token: proposal.token });
  assert.deepEqual(r, { route: 'twilio', reason: 'not_relay' });
  assert.equal((await postsFor(proposal.id)).length, 0);
});

test('a second route while one is open returns merged with the same id and no spacing trip', async () => {
  const f = await mkRelay();
  const first = await route(f);
  assert.equal(first.route, 'gv');
  const second = await route(f, { body: `${bodyFor(f.token)} Edited.`, sendPath: 'compose' });
  assert.deepEqual(second, { route: 'merged', id: first.id });
  const rows = await postsFor(f.proposalId);
  assert.equal(rows.length, 1);
  // The merged send keeps the first body (plan decision 9).
  assert.equal(rows[0].body, bodyFor(f.token));
  assert.equal(rows[0].send_path, 'auto');
});

test('a second route while one is open returns merged even when its body would fail validation', async () => {
  // Law 4 and plan decision 9: while a post is open, a second send of the same
  // proposal merges into it whatever it carries, and never texts from the 888
  // beside the open post. The open-row check runs before identity,
  // suppression and the body check.
  const f = await mkRelay();
  const first = await route(f);
  assert.equal(first.route, 'gv');
  const second = await route(f, { body: 'Hi, your proposal is in your email.', sendPath: 'compose' });
  assert.deepEqual(second, { route: 'merged', id: first.id });
  const rows = await postsFor(f.proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, bodyFor(f.token), 'the open row keeps the first body');
});

test('concurrent routes for one proposal yield one row and one merged', async () => {
  const f = await mkRelay();
  const results = await Promise.all([route(f), route(f)]);
  const routes = results.map((r) => r.route).sort();
  assert.deepEqual(routes, ['gv', 'merged'], `expected one gv and one merged, got ${JSON.stringify(results)}`);
  assert.equal(results[0].id, results[1].id, 'the merged send names the open row');
  assert.equal((await postsFor(f.proposalId)).length, 1);
});

test('cap reached routes twilio cap', async () => {
  const other = await mkRelay();
  assert.equal((await route(other)).route, 'gv', "another proposal's open row");
  const f = await mkRelay();
  process.env.GV_POST_DAILY_CAP = '1';
  try {
    assert.deepEqual(await route(f), { route: 'twilio', reason: 'cap' });
  } finally {
    process.env.GV_POST_DAILY_CAP = '1000';
  }
  assert.equal((await postsFor(f.proposalId)).length, 0);
});

test("another proposal's post to the same number within 10 minutes routes twilio spacing", async () => {
  const f = await mkRelay();
  assert.equal((await route(f)).route, 'gv');
  // A second proposal of the same client: its only lead on the number is the
  // first proposal's, so it resolves to the same conversation.
  const second = await mkProposal(f.clientId);
  const r = await route({ proposalId: second.id, token: second.token });
  assert.deepEqual(r, { route: 'twilio', reason: 'spacing' });
  assert.equal((await postsFor(second.id)).length, 0);
});

test('a throwing identity lookup routes twilio error', async () => {
  const f = await mkRelay();
  routeProposalText.__setDeps({ resolveGvTarget: () => Promise.reject(new Error('lookup exploded')) });
  try {
    assert.deepEqual(await route(f), { route: 'twilio', reason: 'error' });
  } finally {
    routeProposalText.__setDeps({ resolveGvTarget });
  }
  assert.equal((await postsFor(f.proposalId)).length, 0);
});

test('an opted-out number routes twilio opted_out', async () => {
  const f = await mkRelay({ optedOut: true });
  assert.deepEqual(await route(f), { route: 'twilio', reason: 'opted_out' });
  assert.equal((await postsFor(f.proposalId)).length, 0);
});
