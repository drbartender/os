require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Deterministic Stripe mode: force "not in a test window" so nothing here depends
// on a local .env STRIPE_TEST_MODE_UNTIL (mirrors stripe.invoiceIntentArchived.test.js).
process.env.STRIPE_TEST_MODE_UNTIL = '';

// NOTE: this file is the shared suite for the public extension surface.
// Task 9 wrote the intent-gate tests (first five below); Task 8 merged in the
// accept-route tests (the "accept:" block) and mounts the extensions router in
// `before`. Task 9's "after accepting" test stamps client_accepted_at directly
// in SQL, which is the exact predicate the stripe.js gate reads; the accept
// ROUTE is driven end-to-end by the Task 8 tests.

// Silence real sends: stub the notify module BEFORE the routers require it
// (create.js and publicAccept.js both `require` it at load). Same stub shape as
// create.test.js, plus notifyStaffOfOutcome for the zero-delta settle path.
const notify = require('../../utils/serviceExtensionNotify');
notify.notifyClientOfRequest = async () => ({ sms: 'sent', email: 'sent', reachable: true });
notify.alertAdminsRequestSent = async () => {};
notify.alertAdminsProblem = async () => {};
notify.notifyStaffOfOutcome = async () => ({ notified: [], unreachable: [] });

// Fake Stripe via the getStripe seam. stripe.js AND stripeRouteHelpers.js both
// destructure getStripe at load, so the override MUST land before the router is
// required. A shared paymentIntents.create spy proves the acceptance gate
// short-circuits BEFORE any Stripe call.
const createCalls = [];
const fakeStripe = {
  customers: {
    retrieve: async (id) => ({ id, deleted: false }),
    create: async () => ({ id: `cus_fake_${Date.now()}` }),
  },
  paymentIntents: {
    create: async (params) => {
      createCalls.push(params);
      return { id: `pi_test_${Date.now()}_${createCalls.length}`, client_secret: `cs_test_${Date.now()}_${createCalls.length}`, amount: params.amount };
    },
  },
};
require('../../utils/stripeClient').getStripe = () => fakeStripe;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const stripeRouter = require('../stripe');
const extensionsRouter = require('./index');

if (process.env.NODE_ENV === 'production') {
  throw new Error('publicAccept.test.js refuses to run against production');
}

// Task 9: create-intent-for-invoice refuses an extension invoice until the
// extension's terms are accepted (spec decision 8), and ordinary invoices see
// zero behavior change. The gate sits in the busiest client payment route, so
// the ordinary-invoice 200 below is the regression guard that matters most.
//
// publicLimiter budget: 20 requests / 15 min / IP with no test skip. This suite
// makes 11 limiter-counted public POSTs total (5 intent-gate + 6 accept; the
// non-UUID accept is rejected by requireUuidToken BEFORE the limiter runs, so
// it does not count). Keep the total well under ~15 if extending.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

async function seedProposal({ status = 'deposit_paid' } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Ext Intent Gate', $1) RETURNING id`,
    [`ext-gate-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, status, total_price, amount_paid, event_type, pricing_snapshot, stripe_customer_id)
     VALUES ($1, $2, 1000, 100, 'wedding', '{}'::jsonb, 'cus_faketest')
     RETURNING id`,
    [c.rows[0].id, status]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedInvoice(proposalId, { label = 'Balance', status = 'sent', amountDue = 12000, amountPaid = 0 } = {}) {
  const token = crypto.randomUUID();
  const r = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [proposalId, token, `INV${crypto.randomBytes(5).toString('hex')}`, label, amountDue, amountPaid, status]
  );
  return { id: r.rows[0].id, token };
}

async function seedExtension(proposalId, invoiceId, {
  status = 'pending',
  amountCents = 12000,
  acceptedAt = null,
  expiresAt = new Date(Date.now() + 2 * 3600 * 1000),
} = {}) {
  const r = await pool.query(
    `INSERT INTO service_extensions
       (proposal_id, invoice_id, contracted_end_time, requested_end_time,
        contracted_duration_hours, requested_duration_hours,
        amount_cents, gratuity_cents, terms_version, status, client_accepted_at, expires_at)
     VALUES ($1, $2, '10:00 PM', '11:00 PM', 4.0, 5.0, $3, 0, 'v1', $4, $5, $6)
     RETURNING id`,
    [proposalId, invoiceId, amountCents, status, acceptedAt, expiresAt]
  );
  return r.rows[0].id;
}

function postJson(path, body, headers = {}) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = Buffer.from(payload);
    const r = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...headers },
      },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const createdForProposal = (pid) => createCalls.filter((c) => String(c.metadata?.proposal_id) === String(pid)).length;

before(async () => {
  const app = express();
  app.use('/api/stripe', express.json());
  app.use('/api/stripe', stripeRouter);
  // The full extensions composition router (publicAccept mounted FIRST inside
  // it), exactly as server/index.js mounts it. The accept route reads no body,
  // so no json middleware is needed on this mount.
  app.use('/api/service-extensions', extensionsRouter);
  // Mirror the production error middleware (inline in server/index.js) so
  // AppError.code serializes to JSON; the tests assert body.code.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const b = { error: err.message, code: err.code };
      if (err.fieldErrors) b.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(b);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM service_extensions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

// ── Task 9: acceptance gate on create-intent-for-invoice ─────────────────────

let sharedToken; // tests 1 and 2 drive the SAME token, per the task text
let sharedExtId;
let sharedProposalId;

test('intent creation on an UNACCEPTED extension invoice returns 409 EXTENSION_TERMS_NOT_ACCEPTED and mints nothing', async () => {
  sharedProposalId = await seedProposal();
  const inv = await seedInvoice(sharedProposalId, { label: 'Service Extension' });
  sharedToken = inv.token;
  sharedExtId = await seedExtension(sharedProposalId, inv.id, { acceptedAt: null });

  const r = await postJson(`/api/stripe/create-intent-for-invoice/${sharedToken}`, {});
  assert.equal(r.status, 409, `expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.code, 'EXTENSION_TERMS_NOT_ACCEPTED', 'error code is EXTENSION_TERMS_NOT_ACCEPTED');
  assert.equal(createdForProposal(sharedProposalId), 0, 'no paymentIntents.create call before acceptance');

  const sess = await one('SELECT COUNT(*)::int AS n FROM stripe_sessions WHERE proposal_id = $1', [sharedProposalId]);
  assert.equal(sess.n, 0, 'no stripe_sessions row minted before acceptance');
});

test('after accepting, intent creation on the same token returns 200 with a clientSecret', async () => {
  // Stamp acceptance directly: client_accepted_at is the exact predicate the
  // gate reads. The accept ROUTE (Task 8) has its own end-to-end tests.
  await pool.query('UPDATE service_extensions SET client_accepted_at = NOW() WHERE id = $1', [sharedExtId]);

  const r = await postJson(`/api/stripe/create-intent-for-invoice/${sharedToken}`, {});
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(r.body?.clientSecret, 'a clientSecret is returned after acceptance');
  assert.equal(createdForProposal(sharedProposalId), 1, 'exactly one paymentIntents.create call after acceptance');
});

test('intent creation on an EXPIRED pending extension returns 409 EXTENSION_EXPIRED and mints nothing', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p, { label: 'Service Extension' });
  await seedExtension(p, inv.id, {
    acceptedAt: null,
    expiresAt: new Date(Date.now() - 3600 * 1000),
  });

  const r = await postJson(`/api/stripe/create-intent-for-invoice/${inv.token}`, {});
  assert.equal(r.status, 409, `expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
  // Expiry outranks the missing acceptance: an expired row reports EXPIRED,
  // never TERMS_NOT_ACCEPTED, so the client is not invited to accept a corpse.
  assert.equal(r.body?.code, 'EXTENSION_EXPIRED', 'error code is EXTENSION_EXPIRED');
  assert.equal(createdForProposal(p), 0, 'no paymentIntents.create call for an expired extension');
});

test('intent creation on an ORDINARY Balance invoice still returns 200 (gate scoped to extension invoices only)', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p, { label: 'Balance' });

  const r = await postJson(`/api/stripe/create-intent-for-invoice/${inv.token}`, {});
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(r.body?.clientSecret, 'a clientSecret is returned for an ordinary invoice');
  assert.equal(createdForProposal(p), 1, 'exactly one paymentIntents.create call for the ordinary invoice');
});

test('intent creation on a SETTLED (non-pending) extension returns 409 EXTENSION_NOT_PENDING', async () => {
  // Covers the gate's first branch: a paid/expired/cancelled/overridden row is
  // terminal, and its invoice link must stop being a charge surface.
  const p = await seedProposal();
  // partially_paid keeps the invoice inside the route's payable-status fetch
  // even though the extension itself is settled.
  const inv = await seedInvoice(p, { label: 'Service Extension', status: 'partially_paid', amountDue: 12000, amountPaid: 6000 });
  await seedExtension(p, inv.id, {
    status: 'paid',
    acceptedAt: new Date(),
  });

  const r = await postJson(`/api/stripe/create-intent-for-invoice/${inv.token}`, {});
  assert.equal(r.status, 409, `expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.code, 'EXTENSION_NOT_PENDING', 'error code is EXTENSION_NOT_PENDING');
  assert.equal(createdForProposal(p), 0, 'no paymentIntents.create call for a settled extension');
});

// ── Task 8: the accept route, end to end ─────────────────────────────────────

const UA = 'publicAccept-suite/1.0';
// Node's http.request sends NO User-Agent by default, and the route records it
// on first acceptance, so every accept call pins one explicitly.
const accept = (token) => postJson(`/api/service-extensions/t/${token}/accept`, {}, { 'User-Agent': UA });

/**
 * Stamp a real, parseable event onto a seeded proposal so the zero-delta settle
 * can bump duration and derive the new end display. Date pieces are LOCAL
 * frame, never toISOString(): the UTC date rolls to tomorrow after 7pm Chicago
 * (the create.test.js precedent).
 */
async function primeEvent(proposalId) {
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await pool.query(
    `UPDATE proposals
        SET event_date = $2, event_start_time = '6:00 PM',
            event_timezone = 'America/Chicago', event_duration_hours = 4
      WHERE id = $1`,
    [proposalId, dateStr]
  );
}

test('accept: a non-UUID token returns 404, not 500', async () => {
  const r = await accept('not-a-uuid');
  assert.equal(r.status, 404, `expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
});

test('accept: an unknown UUID returns 404', async () => {
  const r = await accept(crypto.randomUUID());
  assert.equal(r.status, 404, `expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
});

let pricedToken, pricedExtId, pricedProposalId, firstAcceptedAt;

test('accept: a priced pending request stamps acceptance and does NOT settle', async () => {
  pricedProposalId = await seedProposal();
  await primeEvent(pricedProposalId);
  const inv = await seedInvoice(pricedProposalId, { label: 'Service Extension' });
  pricedToken = inv.token;
  pricedExtId = await seedExtension(pricedProposalId, inv.id, { amountCents: 12000 });

  const r = await accept(pricedToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.accepted, true);
  assert.equal(r.body?.requiresPayment, true, 'a priced extension still requires payment');
  assert.ok(r.body?.acceptedAt, 'acceptedAt is returned');
  firstAcceptedAt = r.body.acceptedAt;

  const row = await one(
    'SELECT status, client_accepted_at, client_accept_ip, client_accept_ua FROM service_extensions WHERE id = $1',
    [pricedExtId]
  );
  assert.equal(row.status, 'pending', 'a priced accept must NOT settle; payment is the settle trigger');
  assert.ok(row.client_accepted_at, 'client_accepted_at stamped');
  assert.ok(row.client_accept_ip, 'client_accept_ip stamped');
  assert.equal(row.client_accept_ua, UA, 'client_accept_ua stamped');

  const prop = await one('SELECT event_duration_hours FROM proposals WHERE id = $1', [pricedProposalId]);
  assert.equal(Number(prop.event_duration_hours), 4, 'event_duration_hours unchanged before payment');
});

test('accept: accepting twice keeps the FIRST timestamp', async () => {
  const r = await accept(pricedToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.acceptedAt, firstAcceptedAt, 'a double-tap cannot rewrite the audit record');
});

test('accept: a zero-delta request settles on accept and never touches contract money', async () => {
  const p = await seedProposal();
  await primeEvent(p);
  const inv = await seedInvoice(p, { label: 'Service Extension', amountDue: 0 });
  const extId = await seedExtension(p, inv.id, { amountCents: 0 });

  const r = await accept(inv.token);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.requiresPayment, false, 'nothing to pay on a zero delta');
  assert.equal(r.body?.settled, true, 'acceptance itself settles a zero delta');

  const row = await one('SELECT status, finalized_at FROM service_extensions WHERE id = $1', [extId]);
  assert.equal(row.status, 'paid', 'the row settles as paid');
  assert.ok(row.finalized_at, 'every settle path ends with finalizeExtension (plan Global Constraints)');

  const prop = await one(
    'SELECT event_duration_hours, total_price, amount_paid, status FROM proposals WHERE id = $1',
    [p]
  );
  assert.equal(Number(prop.event_duration_hours), 5, 'event_duration_hours bumped to the requested 5h');
  assert.equal(Number(prop.total_price), 1000, 'total_price untouched');
  assert.equal(Number(prop.amount_paid), 100, 'amount_paid untouched');
  assert.equal(prop.status, 'deposit_paid', 'proposal status untouched');
});

test('accept: an expired-by-timestamp pending row returns 409 EXTENSION_EXPIRED and does not stamp acceptance', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p, { label: 'Service Extension' });
  const extId = await seedExtension(p, inv.id, { expiresAt: new Date(Date.now() - 3600 * 1000) });

  const r = await accept(inv.token);
  assert.equal(r.status, 409, `expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.code, 'EXTENSION_EXPIRED', 'error code is EXTENSION_EXPIRED');
  const row = await one('SELECT client_accepted_at FROM service_extensions WHERE id = $1', [extId]);
  assert.equal(row.client_accepted_at, null, 'no acceptance stamped on an expired row');
});

test('accept: a voided invoice returns 404', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p, { label: 'Service Extension', status: 'void' });
  await seedExtension(p, inv.id, {});

  const r = await accept(inv.token);
  assert.equal(r.status, 404, `expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
});
