require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Deterministic Stripe mode: force "not in a test window" so nothing here depends
// on a local .env STRIPE_TEST_MODE_UNTIL. The public intent routes never verify a
// webhook secret, so this only affects the (unused) mode gate.
process.env.STRIPE_TEST_MODE_UNTIL = '';

// Fake Stripe via the getStripe seam. stripe.js AND stripeRouteHelpers.js both
// destructure getStripe at load, so the override MUST land before the router is
// required (mirrors stripe.invoiceIntentArchived.test.js). The spy arrays prove
// what was charged, what metadata rode along, and which stale intents were
// cancelled — the whole election-at-payment contract lives in those three.
const createCalls = [];
const cancelCalls = [];
let retrieveResult = null; // set per-test to script the pending-intent branch
const fakeStripe = {
  customers: {
    retrieve: async (id) => ({ id, deleted: false }),
    create: async () => ({ id: `cus_fake_${Date.now()}` }),
  },
  paymentIntents: {
    create: async (params) => {
      createCalls.push(params);
      return {
        id: `pi_fake_${Date.now()}_${createCalls.length}`,
        client_secret: `secret_${Date.now()}_${createCalls.length}`,
      };
    },
    retrieve: async (id) => {
      if (retrieveResult && retrieveResult.id === id) return retrieveResult;
      const err = new Error(`No such payment_intent: ${id}`);
      err.code = 'resource_missing';
      throw err;
    },
    cancel: async (id) => {
      cancelCalls.push(id);
      return { id, status: 'canceled' };
    },
  },
};
require('../utils/stripeClient').getStripe = () => fakeStripe;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripeCreateIntent.test.js refuses to run against production');
}

// Election-at-payment (spec 2026-08-03). create-intent must compute the client's
// tip-jar election IN MEMORY, charge the right amount, and stamp the election
// into PaymentIntent metadata — writing NOTHING to the proposal. An abandoned
// checkout must leave the quote at the service price.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

// Snapshot carries the frozen gratuity basis so gratuityBasisFromSnapshot
// resolves 1 staff x 5h — a $50/staff/hr floor rate means a $250 floor total.
const SNAPSHOT = {
  total: 450,
  breakdown: [{ label: 'The Core Reaction (5hrs, 50 guests)', amount: 450 }],
  staffing: { actual: 1 },
  staff_noun: 'bartender',
  gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 5, staff_noun: 'bartender', total: 0 },
};

async function seedProposal() {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Grat Intent Test', $1) RETURNING id`,
    [`grat-intent-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, tip_jar, gratuity_rate,
                            event_date, event_duration_hours, pricing_snapshot, stripe_customer_id, token)
     VALUES ($1, 'viewed', 'wedding', 450, true, 0,
             CURRENT_DATE + INTERVAL '60 days', 5, $2, 'cus_faketest', $3)
     RETURNING id, token`,
    [c.rows[0].id, JSON.stringify(SNAPSHOT), crypto.randomUUID()]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0];
}

function post(path, body) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = Buffer.from(payload);
    const r = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
      },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
    );
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

before(async () => {
  // The two pending-intent cases use fixed intent ids (stripe_sessions.
  // stripe_payment_intent_id is UNIQUE), so sweep any rows a crashed prior run
  // stranded — otherwise the seed INSERT conflicts and the case fails for the
  // wrong reason.
  await pool.query(
    "DELETE FROM stripe_sessions WHERE stripe_payment_intent_id IN ('pi_stale_meta', 'pi_reusable')"
  );
  const app = express();
  app.use('/api/stripe', express.json());
  app.use('/api/stripe', stripeRouter);
  // Mirror the production error middleware (server/index.js) so a ValidationError
  // surfaces as a 400 with its code instead of a bare 500.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { retrieveResult = null; });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('full-pay with skip-jar election: correct charge + metadata, NO proposal write', async () => {
  const p = await seedProposal();
  const res = await post(`/api/stripe/create-intent/${p.token}`,
    { payment_option: 'full', tip_jar: false, gratuity_total: 250 });
  assert.equal(res.status, 200, res.body);
  const call = createCalls[createCalls.length - 1];
  assert.equal(call.amount, 70000, 'charged the in-memory gratuity-inclusive total');
  assert.equal(call.metadata.tip_jar, 'false');
  assert.equal(call.metadata.gratuity_rate, '50');
  const body = JSON.parse(res.body);
  assert.equal(body.total_price, 700);
  assert.equal(body.gratuity.total, 250);
  const row = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price, pricing_snapshot FROM proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal(row.tip_jar, true, 'election NOT persisted');
  assert.equal(Number(row.gratuity_rate), 0, 'rate NOT persisted');
  assert.equal(Number(row.total_price), 450, 'total NOT rewritten');
  assert.ok(!row.pricing_snapshot.breakdown.some(l => l.label === 'Gratuity'), 'no Gratuity line persisted');
});

test('deposit with skip-jar election: flat deposit amount, metadata present, no write', async () => {
  const p = await seedProposal();
  const res = await post(`/api/stripe/create-intent/${p.token}`,
    { payment_option: 'deposit', tip_jar: false, gratuity_total: 250 });
  assert.equal(res.status, 200, res.body);
  const call = createCalls[createCalls.length - 1];
  assert.equal(call.amount, 10000, 'deposit stays flat regardless of election');
  assert.equal(call.metadata.tip_jar, 'false');
  assert.equal(call.metadata.gratuity_rate, '50');
  const row = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price FROM proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal(row.tip_jar, true, 'election NOT persisted');
  assert.equal(Number(row.gratuity_rate), 0, 'rate NOT persisted');
  assert.equal(Number(row.total_price), 450, 'total NOT rewritten');
});

test('below-floor no-jar election: 400, no Stripe call, no write', async () => {
  const p = await seedProposal();
  const before = createCalls.length;
  const res = await post(`/api/stripe/create-intent/${p.token}`,
    { payment_option: 'deposit', tip_jar: false, gratuity_total: 100 }); // floor is 250
  assert.equal(res.status, 400);
  assert.equal(createCalls.length, before, 'no intent created');
});

test('sub-cent-below-floor election is rejected: 400, no Stripe call, no charge', async () => {
  // Merge-fleet blocker (fix round 1). 249.999 on a 1 staff x 5h basis cleared
  // deriveGratuityRate's half-cent TOTAL tolerance and derived rate 49.9998 —
  // chargeable here, unwritable by the webhook (DB CHECK tip_jar OR rate >= 50).
  // The engine now re-asserts the floor on the DERIVED rate; this proves the fix
  // reaches the route, so no such intent is ever minted or charged.
  const p = await seedProposal();
  const before = createCalls.length;
  const res = await post(`/api/stripe/create-intent/${p.token}`,
    { payment_option: 'full', tip_jar: false, gratuity_total: 249.999 });
  assert.equal(res.status, 400, res.body);
  assert.equal(createCalls.length, before, 'no intent created for a sub-floor derived rate');
  const row = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price FROM proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal(row.tip_jar, true);
  assert.equal(Number(row.gratuity_rate), 0);
  assert.equal(Number(row.total_price), 450);
});

test('metadata-bearing pending intent is cancelled, never reused, by a metadata-less request', async () => {
  const p = await seedProposal();
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, 'pi_stale_meta', 10000, 'pending')`, [p.id]);
  retrieveResult = { id: 'pi_stale_meta', status: 'requires_payment_method',
    client_secret: 'sec_stale', metadata: { tip_jar: 'false', gratuity_rate: '50' } };
  const res = await post(`/api/stripe/create-intent/${p.token}`, { payment_option: 'deposit' });
  assert.equal(res.status, 200, res.body);
  assert.ok(cancelCalls.includes('pi_stale_meta'), 'stale election intent cancelled');
  const call = createCalls[createCalls.length - 1];
  assert.equal(call.metadata.tip_jar, undefined, 'fresh intent carries no election');
  const sess = (await pool.query(
    "SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = 'pi_stale_meta'")).rows[0];
  assert.equal(sess.status, 'canceled');
});

test('metadata-less pending intent at the same amount is still reused (existing behavior)', async () => {
  const p = await seedProposal();
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, 'pi_reusable', 10000, 'pending')`, [p.id]);
  retrieveResult = { id: 'pi_reusable', status: 'requires_payment_method',
    client_secret: 'sec_reuse', metadata: {} };
  const before = createCalls.length;
  const res = await post(`/api/stripe/create-intent/${p.token}`, { payment_option: 'deposit' });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).clientSecret, 'sec_reuse', 'reused the pending intent');
  assert.equal(createCalls.length, before, 'no new intent minted');
});

// ─── Admin gratuity mandate (spec 2026-08-10) ────────────────────────────────
// Mandated seed: 450 service + $100 mandate (rate 20, 1 staff x 5h) = 550.

const MANDATED_SNAPSHOT = {
  total: 550,
  breakdown: [
    { label: 'The Core Reaction (5hrs, 50 guests)', amount: 450 },
    { label: 'Gratuity', amount: 100 },
  ],
  staffing: { actual: 1 },
  staff_noun: 'bartender',
  gratuity: { rate: 20, tip_jar: true, staff_count: 1, hours: 5, staff_noun: 'bartender', total: 100, floor_rate: 20 },
};

async function seedMandatedProposal() {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Mandate Intent Test', $1) RETURNING id`,
    [`mand-intent-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, tip_jar, gratuity_rate,
                            gratuity_floor_rate, event_date, event_duration_hours, pricing_snapshot,
                            stripe_customer_id, token)
     VALUES ($1, 'viewed', 'wedding', 550, true, 20, 20,
             CURRENT_DATE + INTERVAL '60 days', 5, $2, 'cus_faketest', $3)
     RETURNING id, token`,
    [c.rows[0].id, JSON.stringify(MANDATED_SNAPSHOT), crypto.randomUUID()]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0];
}

test('mandate: election below the floor is 400 with the required-gratuity message, no Stripe call', async () => {
  const p = await seedMandatedProposal();
  const before = createCalls.length;
  const res = await post(`/api/stripe/create-intent/${p.token}`,
    { payment_option: 'full', tip_jar: true, gratuity_total: 40 });
  assert.equal(res.status, 400, res.body);
  assert.match(res.body, /required gratuity of at least \$100\.00/);
  assert.equal(createCalls.length, before, 'no intent created');
});

test('mandate: no-jar election AT a sub-50 mandate is accepted (mandate replaces the 50 rule)', async () => {
  const p = await seedMandatedProposal();
  const res = await post(`/api/stripe/create-intent/${p.token}`,
    { payment_option: 'full', tip_jar: false, gratuity_total: 100 });
  assert.equal(res.status, 200, res.body);
  const call = createCalls[createCalls.length - 1];
  assert.equal(call.amount, 55000, 'mandate-inclusive total, unchanged by an at-floor election');
  assert.equal(call.metadata.tip_jar, 'false');
  assert.equal(call.metadata.gratuity_rate, '20', 'sub-50 rate rides the metadata (amended CHECK permits it)');
});

test('mandate: election above the floor charges the raised total', async () => {
  const p = await seedMandatedProposal();
  const res = await post(`/api/stripe/create-intent/${p.token}`,
    { payment_option: 'full', tip_jar: true, gratuity_total: 150 });
  assert.equal(res.status, 200, res.body);
  const call = createCalls[createCalls.length - 1];
  assert.equal(call.amount, 60000, '450 service + 150 elected = 600');
  assert.equal(call.metadata.gratuity_rate, '30');
});

test('mandate: untouched chooser (no election keys) charges total_price with no gratuity metadata', async () => {
  const p = await seedMandatedProposal();
  const res = await post(`/api/stripe/create-intent/${p.token}`, { payment_option: 'full' });
  assert.equal(res.status, 200, res.body);
  const call = createCalls[createCalls.length - 1];
  assert.equal(call.amount, 55000, 'total_price verbatim (mandate already inside)');
  assert.equal(call.metadata.tip_jar, undefined, 'no election metadata: webhook must not touch gratuity');
});
