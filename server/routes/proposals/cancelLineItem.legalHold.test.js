require('dotenv').config();

// Cancel-line on a legal-hold booking (plan 2026-10-16-price-override-removal,
// Task F1 and its fix round; spec section 5.3, plan decision 4). Cancel-line is
// an admin surface, so it names the hold: applyLineItemCancel refuses a held
// booking right after its row lock, before any per-kind write, with 409
// LEGAL_HOLD and admin copy, and the targets GET answers eligible: false, so
// the admin breakdown draws no remove button (ProposalDetail and
// EventDetailPage keep targets only when eligible). The extras fold's own
// guard (409 NOT_CHANGEABLE) stays behind it as the backstop. Both checks read
// the id of the row the code loaded, never the raw :id. Harness copied from
// cancelLineItem.protected.test.js: real
// routers over HTTP against the shared dev DB, a fresh admin per request
// (adminWriteLimiter), and a fake Stripe installed before the routers load, so
// no real Stripe object can be created. Held ids are synthetic, ADDED through
// __setLegalHoldIdsForTest. Run ALONE:
//   node --test server/routes/proposals/cancelLineItem.legalHold.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

// --- DI stubs, installed BEFORE requiring the routers (both are destructured
// at module load: stripeClient.getStripe by cancelLineItem.js, and
// labListRefresh.refreshListAfterLabChange likewise). ---
const refundsCreated = [];
const fakeStripe = {
  refunds: {
    create: ({ payment_intent, amount }) => {
      refundsCreated.push({ payment_intent, amount });
      return Promise.resolve({ id: `re_${crypto.randomBytes(4).toString('hex')}`, payment_intent, amount, status: 'succeeded' });
    },
  },
};
require('../../utils/stripeClient').getStripe = () => fakeStripe;
require('../drinkPlans/labListRefresh').refreshListAfterLabChange = () => {};

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { calculateProposal } = require('../../utils/pricingEngine');
const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
const { applyLineItemCancel } = require('../../utils/lineItemCancel');
const proposalsRouter = require('./index');

if (process.env.NODE_ENV === 'production') {
  throw new Error('cancelLineItem.legalHold.test.js refuses to run against production');
}

const NONCE = `clh-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const ADMIN_REFUSAL = 'This booking is on legal hold and its lines cannot be removed.';
const LINES = Object.freeze([
  { type: 'discount', label: 'Test discount A', amount: 100, visible: true },
]);
const cents = (n) => Math.round(Number(n) * 100);

let server;
let baseUrl;
let clientId;
let pkg;
let seq = 0;
let adminSeq = 0;
const seededProposals = [];
const seededUsers = [];

async function mintAdmin() {
  adminSeq += 1;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, 'x', 'admin', 0) RETURNING id, token_version`,
    [`${NONCE}-admin-${adminSeq}@example.test`]
  );
  seededUsers.push(u.rows[0].id);
  return jwt.sign({ userId: u.rows[0].id, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET);
}

function request(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
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
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** A native deposit-paid booking with one ordinary discount and one bar. */
async function seedBooking() {
  seq += 1;
  const lines = LINES.map((l) => ({ ...l }));
  const snapshot = calculateProposal({
    pkg, guestCount: 80, durationHours: 4, numBars: 1, numBartenders: null,
    addons: [], syrupSelections: [], adjustments: lines,
    totalPriceOverride: null, gratuityRate: 0, tipJar: true,
  });
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, num_bartenders, adjustments,
        total_price, amount_paid, external_paid, gratuity_rate, tip_jar, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', 'birthday-party', 80, 1, $3, $4::jsonb,
             $5, 100, 0, 0, true, $6::jsonb)
     RETURNING id`,
    [clientId, pkg.id, snapshot.inputs.numBartenders, JSON.stringify(lines),
     snapshot.total, JSON.stringify(snapshot)]
  );
  const proposalId = p.rows[0].id;
  seededProposals.push(proposalId);
  await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'deposit', 10000, 'succeeded', $2)`,
    [proposalId, `pi_${NONCE}_${seq}`]
  );
  return { proposalId, snapshot };
}

/** Everything a cancel could touch on the booking, for a before/after compare. */
async function readState(proposalId) {
  const one = async (sql) => (await pool.query(sql, [proposalId])).rows[0];
  return {
    row: await one(`SELECT adjustments, num_bars, num_bartenders, total_price, total_price_override,
                           amount_paid, status, pricing_snapshot, updated_at
                      FROM proposals WHERE id = $1`),
    log: (await one('SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1')).n,
    addons: (await one('SELECT COUNT(*)::int AS n FROM proposal_addons WHERE proposal_id = $1')).n,
    invoices: (await one('SELECT COUNT(*)::int AS n FROM invoices WHERE proposal_id = $1')).n,
    refunds: (await one('SELECT COUNT(*)::int AS n FROM proposal_refunds WHERE proposal_id = $1')).n,
    shifts: (await one('SELECT COUNT(*)::int AS n FROM shifts WHERE proposal_id = $1')).n,
  };
}

async function preview(proposalId, target) {
  return request('POST', `/api/proposals/${proposalId}/cancel-line/preview`, { token: await mintAdmin(), body: { target } });
}

async function execute(proposalId, target, fingerprint) {
  return request('POST', `/api/proposals/${proposalId}/cancel-line`, {
    token: await mintAdmin(),
    body: {
      target, reason: 'synthetic test', idempotency_key: crypto.randomUUID(),
      notify_client: false, fingerprint,
    },
  });
}

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`CLH ${NONCE}`, `clh-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const pkgIns = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'CLH Test Pkg', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]')
     RETURNING id`,
    [`clh-${NONCE}`]
  );
  pkg = (await pool.query('SELECT * FROM service_packages WHERE id = $1', [pkgIns.rows[0].id])).rows[0];

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', proposalsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    }
    console.error('unexpected test-harness error:', err);
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
  await new Promise((r) => setTimeout(r, 300));
  for (const pid of seededProposals) {
    await pool.query('DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = $1)', [pid]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [pid]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [pid]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [pid]);
    await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [pid]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [pid]);
  }
  for (const uid of seededUsers) await pool.query('DELETE FROM users WHERE id = $1', [uid]);
  if (pkg) await pool.query('DELETE FROM service_packages WHERE id = $1', [pkg.id]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('preview and execute on a held booking answer 409 LEGAL_HOLD with admin copy for each kind and change nothing', async () => {
  const o = await seedBooking();
  // Unheld first: the line is cancellable and the fingerprint is current (the
  // preview rolls back), so the refusals below are the hold, never staleness.
  const ok = await preview(o.proposalId, 'adjustment:0');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  __setLegalHoldIdsForTest([o.proposalId]);
  const beforeState = await readState(o.proposalId);
  for (const target of ['adjustment:0', 'bar']) {
    const prev = await preview(o.proposalId, target);
    assert.equal(prev.status, 409, `${target} preview: ${JSON.stringify(prev.body)}`);
    assert.equal(prev.body.code, 'LEGAL_HOLD', target);
    assert.equal(prev.body.error, ADMIN_REFUSAL, target);
    const exec = await execute(o.proposalId, target, ok.body.fingerprint);
    assert.equal(exec.status, 409, `${target} execute: ${JSON.stringify(exec.body)}`);
    assert.equal(exec.body.code, 'LEGAL_HOLD', target);
    assert.equal(exec.body.error, ADMIN_REFUSAL, target);
  }
  assert.deepEqual(await readState(o.proposalId), beforeState);
  assert.equal(refundsCreated.length, 0);
});

test('the refusal comes right after the row lock: the lock is the only statement sent', async () => {
  const o = await seedBooking();
  __setLegalHoldIdsForTest([o.proposalId]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sent = [];
    const rec = { query: (...args) => { sent.push(args[0]); return client.query(...args); } };
    await assert.rejects(
      applyLineItemCancel(rec, { proposalId: o.proposalId, target: 'adjustment:0', actorId: null }),
      (err) => err.code === 'LEGAL_HOLD' && err.statusCode === 409 && err.message === ADMIN_REFUSAL
    );
    assert.equal(sent.length, 1, `statements sent: ${sent.length}`);
    assert.match(sent[0], /^SELECT \* FROM proposals WHERE id = \$1 FOR UPDATE$/);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

test('targets for a held booking are not eligible, so the admin breakdown draws no remove button', async () => {
  const o = await seedBooking();
  const open = await request('GET', `/api/proposals/${o.proposalId}/cancel-line/targets`, { token: await mintAdmin() });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.equal(open.body.eligible, true, 'the control: unheld, the lines are offered');
  assert.ok(open.body.targets.some((t) => t.target === 'adjustment:0' && t.cancellable));

  __setLegalHoldIdsForTest([o.proposalId]);
  const held = await request('GET', `/api/proposals/${o.proposalId}/cancel-line/targets`, { token: await mintAdmin() });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.deepEqual(held.body, { eligible: false, targets: [], reason: 'legal_hold' });
});

test('with the hold lifted the same execute removes the line (the control)', async () => {
  const o = await seedBooking();
  __setLegalHoldIdsForTest([o.proposalId]);
  const refused = await preview(o.proposalId, 'adjustment:0');
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'LEGAL_HOLD');

  __setLegalHoldIdsForTest(null);
  const prev = await preview(o.proposalId, 'adjustment:0');
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  const exec = await execute(o.proposalId, 'adjustment:0', prev.body.fingerprint);
  assert.equal(exec.status, 200, JSON.stringify(exec.body));
  const row = (await pool.query('SELECT adjustments, total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.deepEqual(row.adjustments, []);
  assert.equal(cents(row.total_price), cents(o.snapshot.total) + 10000);
  assert.equal(refundsCreated.length, 0);
});
