require('dotenv').config();

// Enhancement Lab route tests (lane pp2-lab):
//   1. Window states: draft plan → not_ready (GET) + 409 (PUT); approved
//      list → locked (GET) + 409 (PUT).
//   2. GET payload: submitted plan serves drinks with syrup pricing and the
//      active addon price list; the plan GET carries lab_enabled correctly.
//   3. PUT money: lab additions mint/refresh an 'Enhancement Lab' invoice at
//      exactly computeExtrasBreakdown's total; a pre-existing 'Drink Plan
//      Extras' invoice is NEVER touched; planner-owned addOns survive the
//      reconcile; removing everything refreshes the invoice to $0.
//   4. Submit schedules the +36h lab_followup row (idempotent tuple).
//
// Harness per submitPlannerV2.test.js: real router over HTTP against the dev
// DB, nonce-suffixed rows, full teardown. Run ALONE (shared dev DB):
//   node -r dotenv/config --test server/routes/drinkPlans/lab.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { calculateSyrupCost } = require('../../utils/pricingEngine');
const drinkPlansRouter = require('../drinkPlans');

let server;
let baseUrl;
let clientId;
const proposalIds = [];
const planTokens = {};
const planIds = {};
let cocktailId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}) },
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

async function seedPlan(key, { status = 'submitted', shoppingListStatus = null } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, total_price, amount_paid, pricing_snapshot)
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', 'birthday-party', 80, 0, 2000, 100, '{}'::jsonb)
     RETURNING id`,
    [clientId]
  );
  proposalIds.push(p.rows[0].id);
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, shopping_list_status, client_name, client_email)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id, token`,
    [p.rows[0].id, status,
      JSON.stringify({ signatureDrinks: [cocktailId], addOns: { 'photo-booth-nonsense': { enabled: true } } }),
      shoppingListStatus,
      `PP2 Lab ${NONCE}`, `pp2-lab-${NONCE}@example.com`]
  );
  planTokens[key] = dp.rows[0].token;
  planIds[key] = dp.rows[0].id;
  return p.rows[0].id;
}

async function labInvoices(proposalId) {
  const r = await pool.query(
    "SELECT id, label, amount_due, status FROM invoices WHERE proposal_id = $1 AND status <> 'void' ORDER BY id",
    [proposalId]
  );
  return r.rows;
}

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`PP2 Lab ${NONCE}`, `pp2-lab-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  cocktailId = `pp2l-cock-${NONCE}`;
  await pool.query(
    `INSERT INTO cocktails (id, name, is_active, syrup_id, enhancements)
     VALUES ($1, $2, true, 'jalapeno', '[]'::jsonb)`,
    [cocktailId, `PP2L Cocktail ${NONCE}`]
  );

  await seedPlan('draft', { status: 'draft' });
  await seedPlan('open');
  await seedPlan('locked', { shoppingListStatus: 'approved' });
  await seedPlan('money');
  await seedPlan('guard');

  const app = express();
  app.use(express.json());
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
  for (const pid of proposalIds) {
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)', [pid]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)', [pid]);
    await pool.query('DELETE FROM invoices WHERE proposal_id=$1', [pid]);
    await pool.query("DELETE FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1", [pid]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id=$1', [pid]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id=$1', [pid]);
    await pool.query('DELETE FROM proposals WHERE id=$1', [pid]);
  }
  if (cocktailId) await pool.query('DELETE FROM cocktails WHERE id=$1', [cocktailId]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id=$1', [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('draft plan: GET is not_ready, PUT is 409', async () => {
  const g = await request('GET', `/api/drink-plans/t/${planTokens.draft}/lab`);
  assert.equal(g.status, 200);
  assert.equal(g.body.state, 'not_ready');

  const p = await request('PUT', `/api/drink-plans/t/${planTokens.draft}/lab`, { body: { addOns: {} } });
  assert.equal(p.status, 409);
});

test('approved list: GET is locked, PUT is 409, plan GET lab_enabled=false', async () => {
  const g = await request('GET', `/api/drink-plans/t/${planTokens.locked}/lab`);
  assert.equal(g.status, 200);
  assert.equal(g.body.state, 'locked');

  const p = await request('PUT', `/api/drink-plans/t/${planTokens.locked}/lab`, { body: { addOns: {} } });
  assert.equal(p.status, 409);

  const plan = await request('GET', `/api/drink-plans/t/${planTokens.locked}`);
  assert.equal(plan.body.lab_enabled, false);
});

test('open plan: GET serves drinks with syrup pricing; plan GET lab_enabled=true', async () => {
  const g = await request('GET', `/api/drink-plans/t/${planTokens.open}/lab`);
  assert.equal(g.status, 200);
  assert.equal(g.body.state, 'open');
  assert.equal(g.body.guest_count, 80);
  const drink = g.body.drinks.find((d) => d.id === cocktailId);
  assert.ok(drink, 'seeded cocktail is on the shelf');
  assert.equal(drink.syrup.id, 'jalapeno');
  assert.equal(drink.syrup.price, calculateSyrupCost(['jalapeno'], 80).total);
  assert.ok(Array.isArray(g.body.addon_pricing) && g.body.addon_pricing.length > 0, 'addon pricing present');
  assert.ok(!g.body.addon_pricing.some((a) => a.slug === 'pre-batched-mocktail' || a.slug === 'mocktail-bar'),
    'the Jack pair is never a lab upsell');

  const plan = await request('GET', `/api/drink-plans/t/${planTokens.open}`);
  assert.equal(plan.body.lab_enabled, true);
});

test('PUT bills an Enhancement Lab invoice, never touches Drink Plan Extras, and reconciles', async () => {
  const proposalId = proposalIds[3]; // 'money' plan
  // Pre-existing pay-now extras invoice: must be untouched by every lab PUT.
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Drink Plan Extras', 9000, 9000, 'paid', true)`,
    [proposalId, `T-${NONCE.slice(-14)}`]
  );

  const toast = await pool.query(
    "SELECT rate, billing_type FROM service_addons WHERE slug = 'champagne-toast' AND is_active = true"
  );
  assert.ok(toast.rows[0], 'dev DB has the champagne-toast addon');
  const toastRate = Number(toast.rows[0].rate);
  const toastTotal = toast.rows[0].billing_type === 'per_guest' ? toastRate * 80 : toastRate;
  const syrupTotal = calculateSyrupCost(['jalapeno'], 80).total;
  const expectedCents = Math.round((toastTotal + syrupTotal) * 100);

  const p = await request('PUT', `/api/drink-plans/t/${planTokens.money}/lab`, {
    body: {
      addOns: { 'champagne-toast': { servingStyle: 'Passed on trays', toastTime: '8:30 PM' } },
      labSyrupSelections: { [cocktailId]: ['jalapeno'] },
    },
  });
  assert.equal(p.status, 200);
  assert.ok(p.body.lab_additions.addOns['champagne-toast'].labAdded === undefined
    || p.body.lab_additions.addOns['champagne-toast'].labAdded === true);

  let invoices = await labInvoices(proposalId);
  const extras = invoices.find((i) => i.label === 'Drink Plan Extras');
  const lab = invoices.find((i) => i.label === 'Enhancement Lab');
  assert.equal(Number(extras.amount_due), 9000, 'extras invoice untouched');
  assert.ok(lab, 'Enhancement Lab invoice minted');
  assert.equal(Number(lab.amount_due), expectedCents);

  // Selections: lab entries landed with labAdded, planner-owned addon survived.
  const sel = (await pool.query('SELECT selections FROM drink_plans WHERE id=$1', [planIds.money])).rows[0].selections;
  assert.equal(sel.addOns['champagne-toast'].labAdded, true);
  assert.equal(sel.addOns['champagne-toast'].toastTime, '8:30 PM');
  assert.equal(sel.addOns['photo-booth-nonsense'].enabled, true, 'planner-owned addon untouched');
  assert.deepEqual(sel.labSyrupSelections[cocktailId], ['jalapeno']);

  // Reconcile to empty: lab invoice refreshes to $0, planner addon still there.
  const p2 = await request('PUT', `/api/drink-plans/t/${planTokens.money}/lab`, {
    body: { addOns: {}, labSyrupSelections: {} },
  });
  assert.equal(p2.status, 200);
  invoices = await labInvoices(proposalId);
  assert.equal(Number(invoices.find((i) => i.label === 'Enhancement Lab').amount_due), 0);
  assert.equal(Number(invoices.find((i) => i.label === 'Drink Plan Extras').amount_due), 9000);
  const sel2 = (await pool.query('SELECT selections FROM drink_plans WHERE id=$1', [planIds.money])).rows[0].selections;
  assert.equal(sel2.addOns['champagne-toast'], undefined);
  assert.equal(sel2.addOns['photo-booth-nonsense'].enabled, true);
});

test('pay-then-add: paid+locked lab invoice is never mutated; delta invoice minted', async () => {
  const proposalId = proposalIds[3]; // 'money' plan, lab invoice currently open at $0
  await pool.query(
    `UPDATE invoices SET amount_due = 6000, amount_paid = 6000, status = 'paid', locked = true
      WHERE proposal_id = $1 AND label = 'Enhancement Lab'`,
    [proposalId]
  );

  const toast = await pool.query(
    "SELECT rate, billing_type FROM service_addons WHERE slug = 'champagne-toast' AND is_active = true"
  );
  const toastRate = Number(toast.rows[0].rate);
  const toastCents = Math.round((toast.rows[0].billing_type === 'per_guest' ? toastRate * 80 : toastRate) * 100);

  const p = await request('PUT', `/api/drink-plans/t/${planTokens.money}/lab`, {
    body: { addOns: { 'champagne-toast': {} }, labSyrupSelections: {} },
  });
  assert.equal(p.status, 200);

  const invoices = await labInvoices(proposalId);
  const labs = invoices.filter((i) => i.label === 'Enhancement Lab');
  assert.equal(labs.length, 2, 'paid invoice kept, delta invoice minted');
  const paid = labs.find((i) => i.status === 'paid');
  const open = labs.find((i) => i.status === 'sent');
  assert.equal(Number(paid.amount_due), 6000, 'paid+locked invoice untouched');
  assert.equal(Number(open.amount_due), toastCents - 6000, 'delta = cumulative minus settled');
});

test('unknown addon slug is rejected', async () => {
  const p = await request('PUT', `/api/drink-plans/t/${planTokens.money}/lab`, {
    body: { addOns: { 'totally-made-up': {} } },
  });
  assert.equal(p.status, 400);
});

test('submit schedules the +36h lab_followup row', async () => {
  const proposalId = proposalIds[0]; // 'draft' plan submits now
  const p = await request('PUT', `/api/drink-plans/t/${planTokens.draft}`, {
    body: { status: 'submitted', selections: { signatureDrinks: [cocktailId] } },
  });
  assert.equal(p.status, 200);
  // Scheduling is fire-and-forget after the response; give it a beat.
  await new Promise((r) => setTimeout(r, 400));
  const rows = await pool.query(
    `SELECT scheduled_for, recipient_type, channel FROM scheduled_messages
      WHERE entity_type='proposal' AND entity_id=$1 AND message_type='lab_followup' AND status='pending'`,
    [proposalId]
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].recipient_type, 'client');
  assert.equal(rows.rows[0].channel, 'email');
  const hoursOut = (new Date(rows.rows[0].scheduled_for) - Date.now()) / 3600000;
  assert.ok(hoursOut > 35 && hoursOut < 37, `scheduled ~36h out (got ${hoursOut.toFixed(1)}h)`);
});

test('lab PUT rejects addons outside the offered surface (2026-07-20 allowlist)', async () => {
  const ab = await pool.query(
    "SELECT slug FROM service_addons WHERE slug = 'additional-bartender' AND is_active = true"
  );
  assert.ok(ab.rows[0], 'dev DB has the additional-bartender addon');
  const p = await request('PUT', `/api/drink-plans/t/${planTokens.guard}/lab`, {
    body: { addOns: { 'additional-bartender': {} } },
  });
  assert.equal(p.status, 400, JSON.stringify(p.body));
  const invoices = await labInvoices(proposalIds[4]);
  assert.equal(invoices.filter((i) => i.label === 'Enhancement Lab').length, 0, 'nothing minted');
});

test('lab PUT silently drops a stored lab addition that drifted out of the offered surface', async () => {
  await pool.query(
    `UPDATE drink_plans SET selections = jsonb_set(selections, '{addOns,zero-proof-spirits}', '{"enabled":true,"labAdded":true}') WHERE id = $1`,
    [planIds.guard]
  );
  const p = await request('PUT', `/api/drink-plans/t/${planTokens.guard}/lab`, {
    body: { addOns: { 'zero-proof-spirits': {} } },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.lab_additions.addOns['zero-proof-spirits'], undefined, 'drifted slug dropped, not bricked');
});

test('lab PUT drops a syrup that is not the drink\'s own pairing', async () => {
  const p = await request('PUT', `/api/drink-plans/t/${planTokens.guard}/lab`, {
    body: { labSyrupSelections: { [cocktailId]: ['orgeat'] } },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.lab_additions.labSyrupSelections, {}, 'non-pairing syrup dropped');
  const invoices = await labInvoices(proposalIds[4]);
  assert.equal(invoices.filter((i) => i.label === 'Enhancement Lab').length, 0, 'nothing minted');
});
