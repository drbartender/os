require('dotenv').config();

// Cancel-line protection (plan 2026-10-16-price-override-removal, Task A3;
// spec section 6): a line marked source 'refund' or 'agreed_price' is not a
// cancel target. Removing one would raise the total and bill refunded money,
// or the whole agreed difference, again. Targets list such a line with
// cancellable: false, reason 'protected_line'; preview AND execute on its
// index answer 409 PROTECTED_LINE and write nothing; an ordinary discount
// still previews and cancels as before. Real routers over HTTP against the
// shared dev DB, a fresh admin per request (adminWriteLimiter), and a fake
// Stripe installed before the routers load, so no real Stripe object can be
// created. Run ALONE:
//   node --test server/routes/proposals/cancelLineItem.protected.test.js
const { test, before, after } = require('node:test');
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
const proposalsRouter = require('./index');

if (process.env.NODE_ENV === 'production') {
  throw new Error('cancelLineItem.protected.test.js refuses to run against production');
}

const NONCE = `clp-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server;
let baseUrl;
let clientId;
let pkg;
let seq = 0;
let adminSeq = 0;
const seededProposals = [];
const seededUsers = [];

// Synthetic lines: a refund line, an ordinary discount, an agreed-price line.
// The ordinary line sits BETWEEN the two protected ones so the refusal is
// proven per index, not per position.
const LINES = Object.freeze([
  { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 424242 },
  { type: 'discount', label: 'Test discount A', amount: 100, visible: true },
  { type: 'surcharge', label: 'Agreed price adjustment', amount: 35.5, visible: false, source: 'agreed_price' },
]);
const cents = (n) => Math.round(Number(n) * 100);

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

/** A native (no override) deposit-paid booking carrying the three LINES. */
async function seedBooking() {
  seq += 1;
  const lines = LINES.map((l) => ({ ...l }));
  const snapshot = calculateProposal({
    pkg, guestCount: 80, durationHours: 4, numBars: 0, numBartenders: null,
    addons: [], syrupSelections: [], adjustments: lines,
    totalPriceOverride: null, gratuityRate: 0, tipJar: true,
  });
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, num_bartenders, adjustments,
        total_price, amount_paid, external_paid, gratuity_rate, tip_jar, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', 'birthday-party', 80, 0, $3, $4::jsonb,
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
    row: await one(`SELECT adjustments, total_price, amount_paid, status, pricing_snapshot, updated_at
                      FROM proposals WHERE id = $1`),
    log: (await one('SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1')).n,
    invoices: (await one('SELECT COUNT(*)::int AS n FROM invoices WHERE proposal_id = $1')).n,
    refunds: (await one('SELECT COUNT(*)::int AS n FROM proposal_refunds WHERE proposal_id = $1')).n,
    shifts: (await one('SELECT COUNT(*)::int AS n FROM shifts WHERE proposal_id = $1')).n,
  };
}

const previewPath = (id) => `/api/proposals/${id}/cancel-line/preview`;
const executePath = (id) => `/api/proposals/${id}/cancel-line`;

async function preview(proposalId, target) {
  return request('POST', previewPath(proposalId), { token: await mintAdmin(), body: { target } });
}

async function execute(proposalId, target, fingerprint) {
  return request('POST', executePath(proposalId), {
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
    [`CLP ${NONCE}`, `clp-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const pkgIns = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'CLP Test Pkg', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]')
     RETURNING id`,
    [`clp-${NONCE}`]
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

after(async () => {
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

test('targets list refund and agreed-price lines as protected; the ordinary discount stays cancellable', async () => {
  const o = await seedBooking();
  const r = await request('GET', `/api/proposals/${o.proposalId}/cancel-line/targets`, { token: await mintAdmin() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.eligible, true);
  const adj = (i) => r.body.targets.find((t) => t.target === `adjustment:${i}`);
  assert.deepEqual(adj(0), { target: 'adjustment:0', label: 'Refund', amount: -20, cancellable: false, reason: 'protected_line' });
  assert.deepEqual(adj(1), { target: 'adjustment:1', label: 'Test discount A', amount: -100, cancellable: true });
  assert.deepEqual(adj(2), {
    target: 'adjustment:2', label: 'Agreed price adjustment', amount: 35.5, cancellable: false, reason: 'protected_line',
  });
});

test('preview and execute on a protected line answer 409 PROTECTED_LINE and change nothing', async () => {
  const o = await seedBooking();
  const beforeState = await readState(o.proposalId);
  for (const idx of [0, 2]) {
    const prev = await preview(o.proposalId, `adjustment:${idx}`);
    assert.equal(prev.status, 409, JSON.stringify(prev.body));
    assert.equal(prev.body.code, 'PROTECTED_LINE');
  }
  // A CURRENT fingerprint (the ordinary line's preview rolls back, so the row
  // is unchanged), so execute is refused by the protection and not by the
  // staleness check.
  const ok = await preview(o.proposalId, 'adjustment:1');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  for (const idx of [0, 2]) {
    const exec = await execute(o.proposalId, `adjustment:${idx}`, ok.body.fingerprint);
    assert.equal(exec.status, 409, JSON.stringify(exec.body));
    assert.equal(exec.body.code, 'PROTECTED_LINE');
  }
  assert.deepEqual(await readState(o.proposalId), beforeState);
  assert.equal(refundsCreated.length, 0);
});

test('the ordinary discount still previews and cancels, and the protected lines stay byte for byte', async () => {
  const o = await seedBooking();
  const oldCents = cents(o.snapshot.total);
  const prev = await preview(o.proposalId, 'adjustment:1');
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.removed_label, 'Test discount A');
  assert.equal(cents(prev.body.old_total), oldCents);
  assert.equal(cents(prev.body.new_total), oldCents + 10000);
  assert.equal(cents(prev.body.delta), 10000);
  assert.equal(prev.body.overpayment_cents, 0);

  const exec = await execute(o.proposalId, 'adjustment:1', prev.body.fingerprint);
  assert.equal(exec.status, 200, JSON.stringify(exec.body));
  assert.equal(exec.body.removed, true);
  assert.equal(cents(exec.body.new_total), oldCents + 10000);

  const row = (await pool.query('SELECT adjustments, total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.deepEqual(row.adjustments, [LINES[0], LINES[2]]);
  assert.equal(cents(row.total_price), oldCents + 10000);
  const audit = (await pool.query(
    "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'line_item_cancelled'",
    [o.proposalId]
  )).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.removed_label, 'Test discount A');
  assert.equal(refundsCreated.length, 0);
});
