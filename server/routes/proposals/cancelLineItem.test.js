require('dotenv').config();

// Cancel-line routes (lane cancel-line-server, plan Task 8): targets/preview/
// execute over HTTP against the real proposals router, fake Stripe DI, fresh
// admin per write (adminWriteLimiter). Preview must change NOTHING (rollback
// guarantee); execute commits the removal FIRST and fires scoped refunds
// post-commit. Run ALONE against the shared dev DB:
//   node -r dotenv/config --test server/routes/proposals/cancelLineItem.test.js
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
const refundFailRig = { failOnCallN: 0, calls: 0 };
const fakeStripe = {
  refunds: {
    create: async ({ payment_intent, amount }) => {
      refundFailRig.calls += 1;
      if (refundFailRig.failOnCallN && refundFailRig.calls >= refundFailRig.failOnCallN) {
        throw Object.assign(new Error('boom'), { type: 'StripeInvalidRequestError' });
      }
      const id = `re_${payment_intent}_${amount}_${crypto.randomBytes(3).toString('hex')}`;
      refundsCreated.push({ payment_intent, amount, id });
      return { id, payment_intent, amount, status: 'succeeded' };
    },
  },
};
require('../../utils/stripeClient').getStripe = () => fakeStripe;
const labRefreshCalls = [];
require('../drinkPlans/labListRefresh').refreshListAfterLabChange = (planId) => { labRefreshCalls.push(planId); };

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { calculateProposal } = require('../../utils/pricingEngine');
const proposalsRouter = require('./index');
const drinkPlansRouter = require('../drinkPlans');

if (process.env.NODE_ENV === 'production') {
  throw new Error('cancelLineItem.test.js refuses to run against production');
}

const NONCE = `clr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server;
let baseUrl;
let clientId;
let pkg;
let seq = 0;
let adminSeq = 0;
const seededProposals = [];
const seededUsers = [];
const seededAddonCatalog = [];

async function mintUser(role) {
  adminSeq += 1;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, 'x', $2, 0) RETURNING id, token_version`,
    [`${NONCE}-${role}-${adminSeq}@example.test`, role]
  );
  seededUsers.push(u.rows[0].id);
  return jwt.sign({ userId: u.rows[0].id, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET);
}
const mintAdmin = () => mintUser('admin');

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
        try { json = data ? JSON.parse(data) : null; } catch (_) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

const catalogCache = {};
async function seedCatalogAddon({ slug, name, rate }) {
  if (catalogCache[slug]) return catalogCache[slug];
  const r = await pool.query(
    `INSERT INTO service_addons (slug, name, billing_type, rate, applies_to, is_active)
     VALUES ($1, $2, 'flat', $3, 'all', true) RETURNING id`,
    [slug, name, rate]
  );
  seededAddonCatalog.push(r.rows[0].id);
  const row = (await pool.query('SELECT * FROM service_addons WHERE id = $1', [r.rows[0].id])).rows[0];
  catalogCache[slug] = row;
  return row;
}

/**
 * Seed an override'd proposal with a real engine snapshot, optional flat
 * addon, Stripe payments (cents each), and optionally a lab-owned drink plan.
 */
async function seedProposal(opts = {}) {
  seq += 1;
  const {
    status = 'balance_paid',
    override = 2500,
    amountPaid = 2500,
    externalPaid = 0,
    addonRate = 200,
    withAddon = true,
    labAdded = false,
    gratuityRate = 0,
    tipJar = true,
    payments = [100000],
    withLockedInvoice = false, // locked contract invoice (due == paid) linked to payment 1
  } = opts;

  const engineAddons = [];
  let addonSlug = null;
  if (withAddon) {
    addonSlug = `addon-${NONCE}-r${addonRate}`;
    const cat = await seedCatalogAddon({ slug: addonSlug, name: `Addon ${addonRate}`, rate: addonRate });
    engineAddons.push({ ...cat, quantity: 1 });
  }
  const snapshot = calculateProposal({
    pkg, guestCount: 80, durationHours: 4, numBars: 0, numBartenders: null,
    addons: engineAddons, syrupSelections: [], adjustments: [],
    totalPriceOverride: override, gratuityRate, tipJar,
  });
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, num_bartenders, adjustments,
        total_price, total_price_override, amount_paid, external_paid, gratuity_rate, tip_jar, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             $3, 'birthday-party', 80, 0, $4, '[]'::jsonb,
             $5, $6, $7, $8, $9, $10, $11::jsonb)
     RETURNING id`,
    [clientId, pkg.id, status, snapshot.inputs.numBartenders,
     snapshot.total, override, amountPaid, externalPaid, gratuityRate, tipJar, JSON.stringify(snapshot)]
  );
  const proposalId = p.rows[0].id;
  seededProposals.push(proposalId);
  for (const sa of snapshot.addons) {
    await pool.query(
      `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [proposalId, sa.id, sa.name, sa.billing_type, sa.rate, sa.quantity, sa.line_total]
    );
  }
  const intents = [];
  const paymentIds = [];
  for (const cents of payments) {
    const intent = `pi_${NONCE}_${seq}_${intents.length}`;
    const pay = await pool.query(
      `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
       VALUES ($1, 'balance', $2, 'succeeded', $3) RETURNING id`,
      [proposalId, cents, intent]
    );
    intents.push(intent);
    paymentIds.push(pay.rows[0].id);
  }
  let lockedInvId = null;
  if (withLockedInvoice && paymentIds.length > 0) {
    const cents = payments[0];
    const inv = await pool.query(
      `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
       VALUES ($1, $2, 'Full Payment', $3, $3, 'paid', true) RETURNING id`,
      [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, cents]
    );
    lockedInvId = inv.rows[0].id;
    await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
      [lockedInvId, paymentIds[0], cents]);
  }
  let planId = null;
  let planToken = null;
  if (labAdded && addonSlug) {
    const dp = await pool.query(
      `INSERT INTO drink_plans (proposal_id, status, planner_version, selections, client_name, client_email)
       VALUES ($1, 'submitted', 2, $2::jsonb, $3, $4) RETURNING id, token`,
      [proposalId,
       JSON.stringify({ signatureDrinks: [], addOns: { [addonSlug]: { enabled: true, labAdded: true } }, labSyrupSelections: {} }),
       `CLR ${NONCE}`, `clr-${NONCE}@example.com`]
    );
    planId = dp.rows[0].id;
    planToken = dp.rows[0].token;
  }
  return { proposalId, addonSlug, snapshot, intents, planId, planToken, lockedInvId };
}

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`CLR ${NONCE}`, `clr-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const pkgIns = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'CLR Test Pkg', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]')
     RETURNING id`,
    [`clr-${NONCE}`]
  );
  pkg = (await pool.query('SELECT * FROM service_packages WHERE id = $1', [pkgIns.rows[0].id])).rows[0];

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', proposalsRouter);
  app.use('/api/drink-plans', drinkPlansRouter);
  // eslint-disable-next-line no-unused-vars
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
  for (const aid of seededAddonCatalog) await pool.query('DELETE FROM service_addons WHERE id = $1', [aid]);
  if (pkg) await pool.query('DELETE FROM service_packages WHERE id = $1', [pkg.id]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function previewThenExecute(o, { execBody = {}, previewBody = {} } = {}) {
  const prev = await request('POST', `/api/proposals/${o.proposalId}/cancel-line/preview`, {
    token: await mintAdmin(),
    body: { target: `addon:${o.addonSlug}`, ...previewBody },
  });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  const exec = await request('POST', `/api/proposals/${o.proposalId}/cancel-line`, {
    token: await mintAdmin(),
    body: {
      target: `addon:${o.addonSlug}`,
      reason: 'client asked',
      idempotency_key: crypto.randomUUID(),
      notify_client: false,
      fingerprint: prev.body.fingerprint,
      ...execBody,
    },
  });
  return { prev, exec };
}

test('targets endpoint lists lines for a booked proposal (manager can read)', async () => {
  const o = await seedProposal({});
  const r = await request('GET', `/api/proposals/${o.proposalId}/cancel-line/targets`, { token: await mintUser('manager') });
  assert.equal(r.status, 200);
  assert.equal(r.body.eligible, true);
  assert.ok(r.body.targets.some((t) => t.target === `addon:${o.addonSlug}`));
});

test('preview computes the removal and CHANGES NOTHING', async () => {
  const o = await seedProposal({});
  const beforeRow = (await pool.query('SELECT total_price, amount_paid, pricing_snapshot FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  const r = await request('POST', `/api/proposals/${o.proposalId}/cancel-line/preview`, {
    token: await mintAdmin(), body: { target: `addon:${o.addonSlug}` },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.old_total, 2500);
  assert.equal(r.body.new_total, 2300);
  assert.equal(r.body.delta, -200);
  assert.equal(r.body.overpayment_cents, 20000);
  assert.deepEqual(r.body.refund, { splits: 1, stripe_cents: 20000, manual_return_cents: 0 });
  assert.equal(r.body.new_balance_due, 0);
  assert.ok(r.body.fingerprint?.updated_at);
  // Rollback guarantee: byte-identical state, nothing written anywhere.
  const afterRow = (await pool.query('SELECT total_price, amount_paid, pricing_snapshot FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.deepEqual(afterRow, beforeRow);
  const addons = (await pool.query('SELECT id FROM proposal_addons WHERE proposal_id = $1', [o.proposalId])).rows;
  assert.equal(addons.length, 1);
  const refunds = (await pool.query('SELECT id FROM proposal_refunds WHERE proposal_id = $1', [o.proposalId])).rows;
  assert.equal(refunds.length, 0);
  const log = (await pool.query('SELECT id FROM proposal_activity_log WHERE proposal_id = $1', [o.proposalId])).rows;
  assert.equal(log.length, 0);
});

test('execute removes, commits, then refunds the overpayment with scope overpayment + audit row', async () => {
  const o = await seedProposal({ withLockedInvoice: true });
  const stripeCallsBefore = refundsCreated.length;
  const { exec } = await previewThenExecute(o);
  assert.equal(exec.status, 200, JSON.stringify(exec.body));
  assert.equal(exec.body.removed, true);
  assert.equal(exec.body.new_total, 2300);
  assert.equal(exec.body.refund_incomplete, false);
  assert.deepEqual(exec.body.refunds, [{ payment_id: exec.body.refunds[0].payment_id, amount_cents: 20000, status: 'succeeded' }]);
  assert.equal(refundsCreated.length, stripeCallsBefore + 1);
  const p = (await pool.query('SELECT total_price, amount_paid FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(p.total_price), 2300);   // fold set it; refund did NOT re-lower
  assert.equal(Number(p.amount_paid), 2300);   // refund reconciliation dropped 200
  const addons = (await pool.query('SELECT id FROM proposal_addons WHERE proposal_id = $1', [o.proposalId])).rows;
  assert.equal(addons.length, 0);
  const refundRows = (await pool.query('SELECT status, total_scope, amount FROM proposal_refunds WHERE proposal_id = $1', [o.proposalId])).rows;
  assert.equal(refundRows.length, 1);
  assert.equal(refundRows[0].status, 'succeeded');
  assert.equal(refundRows[0].total_scope, 'overpayment');
  assert.equal(Number(refundRows[0].amount), 20000);
  const audit = (await pool.query(
    "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'line_item_cancel_refunded'",
    [o.proposalId])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.refund_row_ids.length, 1);
  assert.equal(audit[0].details.amount_cents, 20000);
  assert.equal(audit[0].details.incomplete, false);
  // The LOCKED settled invoice stays settled at the corrected figure: both
  // figures drop by the refund, no client-visible phantom balance
  // (merge-fleet code-review regression, 2026-07-24).
  const inv = (await pool.query('SELECT amount_due, amount_paid, status FROM invoices WHERE id = $1', [o.lockedInvId])).rows[0];
  assert.equal(Number(inv.amount_due), 80000);
  assert.equal(Number(inv.amount_paid), 80000);
  assert.equal(inv.status, 'paid');
});

test('execute splits across two charges sequentially, largest first', async () => {
  const o = await seedProposal({ addonRate: 950, payments: [10000, 90000] });
  const callsBefore = refundsCreated.length;
  const { exec } = await previewThenExecute(o);
  assert.equal(exec.status, 200, JSON.stringify(exec.body));
  assert.equal(exec.body.refunds.length, 2);
  assert.deepEqual(exec.body.refunds.map((r) => r.amount_cents), [90000, 5000]);
  assert.deepEqual(refundsCreated.slice(callsBefore).map((r) => r.amount), [90000, 5000]);
  const rows = (await pool.query(
    "SELECT amount FROM proposal_refunds WHERE proposal_id = $1 AND status = 'succeeded' ORDER BY amount DESC",
    [o.proposalId])).rows;
  assert.deepEqual(rows.map((r) => Number(r.amount)), [90000, 5000]);
});

test('stripe failure leaves the removal standing and flags refund_incomplete', async () => {
  const o = await seedProposal({});
  refundFailRig.failOnCallN = refundFailRig.calls + 1; // next Stripe call throws (definitive rejection)
  try {
    const { exec } = await previewThenExecute(o);
    assert.equal(exec.status, 200, JSON.stringify(exec.body));
    assert.equal(exec.body.refund_incomplete, true);
    assert.equal(exec.body.refunds[0].status, 'failed');
    const p = (await pool.query('SELECT total_price, amount_paid FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
    assert.equal(Number(p.total_price), 2300);  // removal committed
    assert.equal(Number(p.amount_paid), 2500);  // no money moved: reads overpaid (panel = retry path)
    const addons = (await pool.query('SELECT id FROM proposal_addons WHERE proposal_id = $1', [o.proposalId])).rows;
    assert.equal(addons.length, 0);
    const refundRows = (await pool.query('SELECT status FROM proposal_refunds WHERE proposal_id = $1', [o.proposalId])).rows;
    assert.deepEqual(refundRows.map((r) => r.status), ['failed']);
    const audit = (await pool.query(
      "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'line_item_cancel_refunded'",
      [o.proposalId])).rows;
    assert.equal(audit[0].details.incomplete, true);
  } finally {
    refundFailRig.failOnCallN = 0;
  }
});

test('stale fingerprint 409s and changes nothing', async () => {
  const o = await seedProposal({});
  const prev = await request('POST', `/api/proposals/${o.proposalId}/cancel-line/preview`, {
    token: await mintAdmin(), body: { target: `addon:${o.addonSlug}` },
  });
  await pool.query('UPDATE proposals SET amount_paid = amount_paid + 1 WHERE id = $1', [o.proposalId]);
  const exec = await request('POST', `/api/proposals/${o.proposalId}/cancel-line`, {
    token: await mintAdmin(),
    body: {
      target: `addon:${o.addonSlug}`, reason: 'x', idempotency_key: crypto.randomUUID(),
      notify_client: false, fingerprint: prev.body.fingerprint,
    },
  });
  assert.equal(exec.status, 409);
  assert.equal(exec.body.code, 'STALE_PREVIEW');
  const addons = (await pool.query('SELECT id FROM proposal_addons WHERE proposal_id = $1', [o.proposalId])).rows;
  assert.equal(addons.length, 1);
});

test('partly paid removal fires no refund, just lowers the balance', async () => {
  const o = await seedProposal({ status: 'deposit_paid', amountPaid: 100 });
  const { exec } = await previewThenExecute(o);
  assert.equal(exec.status, 200, JSON.stringify(exec.body));
  assert.deepEqual(exec.body.refunds, []);
  assert.equal(exec.body.manual_return_cents, 0);
  const refunds = (await pool.query('SELECT id FROM proposal_refunds WHERE proposal_id = $1', [o.proposalId])).rows;
  assert.equal(refunds.length, 0);
  const p = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(p.total_price), 2300);
});

test('external-paid remainder reported; only the card portion fires', async () => {
  const o = await seedProposal({ externalPaid: 1500, payments: [10000] });
  const { prev, exec } = await previewThenExecute(o);
  assert.equal(prev.body.external_paid, 1500);
  assert.deepEqual(prev.body.refund, { splits: 1, stripe_cents: 10000, manual_return_cents: 10000 });
  assert.equal(exec.status, 200, JSON.stringify(exec.body));
  assert.equal(exec.body.manual_return_cents, 10000);
  assert.deepEqual(exec.body.refunds.map((r) => r.amount_cents), [10000]);
});

test('gratuity execute fires the mandatory staff notice', async () => {
  const o = await seedProposal({ withAddon: false, gratuityRate: 50, tipJar: false, amountPaid: 100, status: 'deposit_paid' });
  const s = await pool.query(
    `INSERT INTO shifts (proposal_id, event_date, status) VALUES ($1, CURRENT_DATE + 30, 'confirmed') RETURNING id`,
    [o.proposalId]
  );
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
    [`${NONCE}-staffnotice@example.test`]
  );
  seededUsers.push(u.rows[0].id);
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1, $2, 'bartender', 'approved')`,
    [s.rows[0].id, u.rows[0].id]
  );
  const notice = require('../../utils/gratuityStaffNotice');
  const sends = [];
  notice.__setDeps({ sendEmail: async (args) => { sends.push(args); return { id: 'stub' }; } });
  try {
    const prev = await request('POST', `/api/proposals/${o.proposalId}/cancel-line/preview`, {
      token: await mintAdmin(), body: { target: 'gratuity' },
    });
    assert.equal(prev.status, 200);
    assert.deepEqual(prev.body.gratuity, { new_rate: 0, tip_jar_after: true, staff_notice: true });
    const exec = await request('POST', `/api/proposals/${o.proposalId}/cancel-line`, {
      token: await mintAdmin(),
      body: {
        target: 'gratuity', reason: 'client removed gratuity', idempotency_key: crypto.randomUUID(),
        notify_client: false, fingerprint: prev.body.fingerprint,
      },
    });
    assert.equal(exec.status, 200, JSON.stringify(exec.body));
    assert.equal(sends.length, 1);
    assert.match(sends[0].subject, /tip jar update/i);
    const n = exec.body.notifications.find((x) => x.type === 'gratuity_staff_notice');
    assert.deepEqual(n, { type: 'gratuity_staff_notice', sent: 1, failed: 0 });
    const p = (await pool.query('SELECT gratuity_rate, tip_jar FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
    assert.equal(Number(p.gratuity_rate), 0);
    assert.equal(p.tip_jar, true);
  } finally {
    notice.__setDeps({ sendEmail: require('../../utils/email').sendEmail });
  }
});

test('notify_client: refund case sends the refund notice; removal-only sends the removal notice', async () => {
  const refundNotify = require('../../utils/refundClientNotify');
  const removalNotify = require('../../utils/lineItemRemovedNotify');
  const refundSends = [];
  const removalSends = [];
  refundNotify.__setDeps({ sendEmail: async (args) => { refundSends.push(args); return { id: 'stub' }; } });
  removalNotify.__setDeps({ sendEmail: async (args) => { removalSends.push(args); return { id: 'stub' }; } });
  try {
    const overpaid = await seedProposal({});
    const a = await previewThenExecute(overpaid, { execBody: { notify_client: true } });
    assert.equal(a.exec.status, 200, JSON.stringify(a.exec.body));
    assert.equal(refundSends.length, 1);
    assert.equal(removalSends.length, 0);
    assert.ok(a.exec.body.notifications.some((n) => n.type === 'refund_notice' && n.email === 'sent'));

    const partlyPaid = await seedProposal({ status: 'deposit_paid', amountPaid: 100 });
    const b = await previewThenExecute(partlyPaid, { execBody: { notify_client: true } });
    assert.equal(b.exec.status, 200, JSON.stringify(b.exec.body));
    assert.equal(removalSends.length, 1);
    assert.equal(refundSends.length, 1); // unchanged
    assert.match(removalSends[0].subject, /total was updated/i);
    assert.ok(b.exec.body.notifications.some((n) => n.type === 'line_item_removed_notice' && n.email === 'sent'));
  } finally {
    refundNotify.__setDeps({ sendEmail: require('../../utils/email').sendEmail });
    removalNotify.__setDeps({ sendEmail: require('../../utils/email').sendEmail });
  }
});

test('lab-added removal cleans the plan, triggers the list refresh, and a lab replay cannot resurrect', async () => {
  const o = await seedProposal({ labAdded: true, status: 'deposit_paid', amountPaid: 100 });
  const { exec } = await previewThenExecute(o);
  assert.equal(exec.status, 200, JSON.stringify(exec.body));
  await new Promise((r) => setTimeout(r, 50)); // setImmediate tail
  assert.ok(labRefreshCalls.includes(o.planId), 'shopping-list refresh must fire post-commit');
  const sel = (await pool.query('SELECT selections FROM drink_plans WHERE id = $1', [o.planId])).rows[0].selections;
  assert.equal(sel.addOns[o.addonSlug], undefined);
  // Lab GET no longer lists it.
  const g = await request('GET', `/api/drink-plans/t/${o.planToken}/lab`);
  assert.equal(g.status, 200);
  assert.equal(g.body.lab_additions?.addOns?.[o.addonSlug], undefined);
  // Empty replay PUT (fresh-UI desired state) must not re-add or move money.
  const totalBefore = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0].total_price;
  const put = await request('PUT', `/api/drink-plans/t/${o.planToken}/lab`, { body: { addOns: {}, labSyrupSelections: {} } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const addons = (await pool.query('SELECT id FROM proposal_addons WHERE proposal_id = $1', [o.proposalId])).rows;
  assert.equal(addons.length, 0);
  const totalAfter = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0].total_price;
  assert.equal(Number(totalAfter), Number(totalBefore));
});

test('manager can read targets but cannot preview or execute', async () => {
  const o = await seedProposal({});
  const managerToken = await mintUser('manager');
  const prev = await request('POST', `/api/proposals/${o.proposalId}/cancel-line/preview`, {
    token: managerToken, body: { target: `addon:${o.addonSlug}` },
  });
  assert.equal(prev.status, 403);
  const exec = await request('POST', `/api/proposals/${o.proposalId}/cancel-line`, {
    token: managerToken,
    body: { target: `addon:${o.addonSlug}`, reason: 'x', idempotency_key: crypto.randomUUID(), fingerprint: {} },
  });
  assert.equal(exec.status, 403);
});

test('reason, idempotency_key, and fingerprint are required', async () => {
  const o = await seedProposal({});
  const base = { target: `addon:${o.addonSlug}` };
  let r = await request('POST', `/api/proposals/${o.proposalId}/cancel-line`, {
    token: await mintAdmin(), body: { ...base, idempotency_key: 'k', fingerprint: {} },
  });
  assert.equal(r.body.code, 'REASON_REQUIRED');
  r = await request('POST', `/api/proposals/${o.proposalId}/cancel-line`, {
    token: await mintAdmin(), body: { ...base, reason: 'x', fingerprint: {} },
  });
  assert.equal(r.body.code, 'MISSING_IDEMPOTENCY_KEY');
  r = await request('POST', `/api/proposals/${o.proposalId}/cancel-line`, {
    token: await mintAdmin(), body: { ...base, reason: 'x', idempotency_key: 'k' },
  });
  assert.equal(r.body.code, 'MISSING_FINGERPRINT');
});

test('GET /:id still returns the proposal (mount order not shadowed)', async () => {
  const o = await seedProposal({});
  const r = await request('GET', `/api/proposals/${o.proposalId}`, { token: await mintAdmin() });
  assert.equal(r.status, 200);
  assert.equal(Number(r.body.id ?? r.body.proposal?.id), o.proposalId);
});

test('all-external overpayment: removal notice names the manual return, no Stripe refund', async () => {
  const removalNotify = require('../../utils/lineItemRemovedNotify');
  const sends = [];
  removalNotify.__setDeps({ sendEmail: async (args) => { sends.push(args); return { id: 'stub' }; } });
  try {
    const o = await seedProposal({ externalPaid: 2500, payments: [] }); // paid entirely off-Stripe
    const { prev, exec } = await previewThenExecute(o, { execBody: { notify_client: true } });
    assert.deepEqual(prev.body.refund, { splits: 0, stripe_cents: 0, manual_return_cents: 20000 });
    assert.equal(exec.status, 200, JSON.stringify(exec.body));
    assert.deepEqual(exec.body.refunds, []);
    assert.equal(exec.body.manual_return_cents, 20000);
    assert.equal(sends.length, 1);
    assert.match(sends[0].text, /owe you \$200\.00 back/i);
    assert.ok(!/fully settled/i.test(sends[0].text));
  } finally {
    removalNotify.__setDeps({ sendEmail: require('../../utils/email').sendEmail });
  }
});

test('a non-string target is rejected before anything commits', async () => {
  const o = await seedProposal({});
  const before = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  const r = await request('POST', `/api/proposals/${o.proposalId}/cancel-line/preview`, {
    token: await mintAdmin(), body: { target: { kind: 'adjustment', key: '0' } },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'VALIDATION_ERROR');
  const after = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(after.total_price), Number(before.total_price));
  const log = (await pool.query(
    "SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'line_item_cancelled'",
    [o.proposalId])).rows;
  assert.equal(log.length, 0, 'no audit row may claim a removal that never happened');
});

test('a drink-plan-rail charge funds the refund instead of a manual return', async () => {
  // The cancel-line feature removes drink-plan items, so the charge that paid
  // for them must be refundable. The admin-panel rail list excluded
  // drink_plan_extras / drink_plan_with_balance, which sent the client a "we
  // will return it separately" notice for money sitting on a refundable Stripe
  // charge (cross-LLM push review, 2026-07-26).
  const o = await seedProposal({ payments: [] });
  const intent = `pi_dpx_${NONCE}`;
  await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'drink_plan_extras', 250000, 'succeeded', $2)`,
    [o.proposalId, intent]
  );
  const prev = await request('POST', `/api/proposals/${o.proposalId}/cancel-line/preview`, {
    token: await mintAdmin(), body: { target: `addon:${o.addonSlug}` },
  });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.refund.manual_return_cents, 0, 'this money is refundable, not a manual return');
  assert.equal(prev.body.refund.stripe_cents, 20000);
  assert.equal(prev.body.refund.splits, 1);
});
