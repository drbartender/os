// POST /api/proposals/t/:token/switch on a legal-hold booking (plan
// 2026-10-16-price-override-removal, Task F1; spec section 5.3). The switch is a
// client-triggered re-price, so a held booking is refused by the same guard
// predicate that refuses a signed or paid one, with the switch's existing
// SWITCH_NOT_AVAILABLE answer and today's message: a client-facing refusal never
// names the hold (plan decision 4). The guard reads the id of the row the route
// locked FOR UPDATE by token, and it runs before the money-in-flight phase, so a
// held switch never retrieves or cancels a Stripe intent and writes nothing.
//
// Harness copied from publicSwitch.test.js: fresh express() over the real
// routers, real HTTP, the seeded catalog, nonce'd fixtures purged in after().
// Stripe is faked through the getStripe seam BEFORE the router chain is
// required, so no real Stripe object can be touched. Held ids are synthetic,
// ADDED through __setLegalHoldIdsForTest. Run ALONE:
//   node --test server/routes/proposals/publicSwitch.legalHold.test.js

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const retrieveCalls = [];
const cancelCalls = [];
const scriptedIntents = new Map(); // id -> intent object returned by retrieve
const fakeStripe = {
  paymentIntents: {
    retrieve: (id) => {
      retrieveCalls.push(id);
      if (scriptedIntents.has(id)) return Promise.resolve(scriptedIntents.get(id));
      const err = new Error(`No such payment_intent: ${id}`);
      err.code = 'resource_missing';
      return Promise.reject(err);
    },
    cancel: (id) => {
      cancelCalls.push(id);
      return Promise.resolve({ id, status: 'canceled' });
    },
  },
};
require('../../utils/stripeClient').getStripe = () => fakeStripe;

// Sentry stub, landing before publicSwitch.js requires it, so nothing this
// suite does can reach a real Sentry project.
process.env.SENTRY_DSN_SERVER = process.env.SENTRY_DSN_SERVER || 'https://test@example.invalid/1';
const sentryModule = require('@sentry/node');
sentryModule.captureMessage = () => {};
sentryModule.captureException = () => {};

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
const publicTokenRouter = require('./publicToken');
const optionsRouter = require('./publicOptions');
const switchRouter = require('./publicSwitch');

if (process.env.NODE_ENV === 'production') {
  throw new Error('publicSwitch.legalHold.test.js refuses to run against production');
}

// Today's SWITCH_NOT_AVAILABLE copy, verbatim: the hold adds no new message.
const UNAVAILABLE_MSG =
  'This proposal can no longer be changed online. Reply to your email or give us a call and we will sort it out.';

let server;
let baseUrl;
let byobPkgId;
let hostedPkgId;
const createdProposalIds = new Set();
const createdClientIds = new Set();
const stamp = `switchhold-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** A switchable BYOB proposal at 120 guests / 4 hours (above every floor). */
async function insertProposal() {
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    [`Switch Hold ${stamp}`, `${stamp}-${crypto.randomBytes(3).toString('hex')}@test.local`]
  );
  createdClientIds.add(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, package_id, status, guest_count, event_duration_hours,
                            num_bars, event_date, event_start_time, total_price)
     VALUES ($1, $2, 'sent', 120, 4, 1, CURRENT_DATE + 90, '5:00 PM', 0)
     RETURNING id, token`,
    [c.rows[0].id, byobPkgId]
  );
  createdProposalIds.add(p.rows[0].id);
  return p.rows[0];
}

async function rowOf(id) {
  const r = await pool.query(
    `SELECT id, package_id, status, total_price, total_price_override, pricing_snapshot,
            num_bartenders, deposit_amount, amount_paid, updated_at
       FROM proposals WHERE id = $1`, [id]);
  return r.rows[0];
}

before(async () => {
  const byob = await pool.query(
    `SELECT id FROM service_packages WHERE category = 'byob' AND is_active = true ORDER BY id LIMIT 1`);
  byobPkgId = byob.rows[0].id;
  const hosted = await pool.query(
    `SELECT id FROM service_packages
      WHERE pricing_type = 'per_guest' AND is_active = true AND bar_type IS DISTINCT FROM 'class'
      ORDER BY id LIMIT 1`);
  hostedPkgId = hosted.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', publicTokenRouter);
  app.use('/api/proposals', optionsRouter);
  app.use('/api/proposals', switchRouter);
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
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterEach(() => __setLegalHoldIdsForTest(null));

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (server) await new Promise((r) => server.close(r));
  const pids = [...createdProposalIds];
  if (pids.length > 0) {
    await pool.query(
      'DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [pids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [pids]);
  }
  if (createdClientIds.size > 0) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[...createdClientIds]]);
  }
  await pool.end();
});

test('a held booking gets the existing SWITCH_NOT_AVAILABLE answer, before any Stripe call or write', async () => {
  const p = await insertProposal();
  // A live checkout intent: an unheld switch retrieves and cancels it, so its
  // silence below proves the held refusal ran first.
  const piId = `pi_hold_${crypto.randomBytes(4).toString('hex')}`;
  scriptedIntents.set(piId, { id: piId, status: 'requires_payment_method' });
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 35000, 'pending')`, [p.id, piId]);

  const quote = await request('POST', `/api/proposals/t/${p.token}/options`, {
    body: { extra_addon_ids: [], tier_addon_id: null },
  });
  assert.equal(quote.status, 200, quote.raw);
  const option = quote.body.options.find((x) => x.package_id === hostedPkgId);
  assert.ok(option && option.available, 'the hosted target is offered');
  const body = {
    package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [],
    acknowledged_total: option.total,
  };

  __setLegalHoldIdsForTest([p.id]);
  const beforeRow = await rowOf(p.id);
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, { body });
  assert.equal(res.status, 409, res.raw);
  assert.equal(res.body.code, 'SWITCH_NOT_AVAILABLE');
  assert.equal(res.body.error, UNAVAILABLE_MSG);
  assert.doesNotMatch(res.raw, /legal|hold/i, 'a client-facing refusal never names the hold');

  assert.deepEqual(await rowOf(p.id), beforeRow, 'the held row is untouched');
  assert.ok(!retrieveCalls.includes(piId), 'no Stripe retrieve for a held booking');
  assert.ok(!cancelCalls.includes(piId), 'no Stripe cancel for a held booking');
  const sess = await pool.query('SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.rows[0].status, 'pending');
  const log = await pool.query(
    "SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'package_switched'",
    [p.id]);
  assert.equal(log.rows[0].n, 0);

  // The control: the identical request with the hold lifted switches, and the
  // money-in-flight phase now runs (the intent is retrieved and cancelled).
  __setLegalHoldIdsForTest(null);
  const ok = await request('POST', `/api/proposals/t/${p.token}/switch`, { body });
  assert.equal(ok.status, 200, ok.raw);
  assert.equal((await rowOf(p.id)).package_id, hostedPkgId);
  assert.ok(retrieveCalls.includes(piId));
  assert.ok(cancelCalls.includes(piId));
});

test('a hold on another booking leaves this switch alone', async () => {
  const held = await insertProposal();
  const p = await insertProposal();
  const quote = await request('POST', `/api/proposals/t/${p.token}/options`, {
    body: { extra_addon_ids: [], tier_addon_id: null },
  });
  assert.equal(quote.status, 200, quote.raw);
  const option = quote.body.options.find((x) => x.package_id === hostedPkgId);
  assert.ok(option && option.available);

  __setLegalHoldIdsForTest([held.id]);
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: {
      package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [],
      acknowledged_total: option.total,
    },
  });
  assert.equal(res.status, 200, res.raw);
  assert.equal((await rowOf(p.id)).package_id, hostedPkgId);
  assert.equal((await rowOf(held.id)).package_id, byobPkgId);
});
