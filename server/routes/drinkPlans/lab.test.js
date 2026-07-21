require('dotenv').config();

// Enhancement Lab route tests (lane pp2-lab):
//   1. Window states: draft plan → not_ready (GET) + 409 (PUT); approved
//      list → locked (GET) + 409 (PUT).
//   2. GET payload: submitted plan serves drinks with syrup pricing and the
//      active addon price list; the plan GET carries lab_enabled correctly.
//   3. PUT money (fold model, 2026-07-20): additions fold into the proposal
//      total and the open Balance invoice absorbs them with itemized lines;
//      a legacy open 'Enhancement Lab' invoice zeroes when a Balance absorbs;
//      the fully-paid case carries the UNINVOICED remainder on one itemized
//      lab invoice (a standing unpaid Additional Services invoice is never
//      double-billed); paid-in-full status demotes when new money is owed.
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
const { calculateSyrupCost, calculateProposal } = require('../../utils/pricingEngine');
const { withRepriceQuantities } = require('../../utils/proposalExtrasFold');
const drinkPlansRouter = require('../drinkPlans');

let server;
let baseUrl;
let clientId;
let packageId;
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

async function seedPlan(key, { status = 'submitted', shoppingListStatus = null, proposalStatus = 'deposit_paid' } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, total_price, amount_paid, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             $3, 'birthday-party', 80, 0, 2000, 100, '{}'::jsonb)
     RETURNING id`,
    [clientId, packageId, proposalStatus]
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

  // Real package so the fold can reprice (the fail-closed gate refuses
  // additions on an unpriceable proposal). Same proven shape as
  // submitPlannerV2.test.js. Hosted -> the guard tests' drifted slug must be
  // one that is NOT on the hosted shelf and NOT in the drink's dossier.
  const pkg = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'PP2 Lab Test', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]')
     RETURNING id`,
    [`pp2-lab-${NONCE}`]
  );
  packageId = pkg.rows[0].id;

  await seedPlan('draft', { status: 'draft' });
  await seedPlan('open');
  await seedPlan('locked', { shoppingListStatus: 'approved' });
  await seedPlan('money');
  await seedPlan('guard');
  await seedPlan('paidfull', { proposalStatus: 'balance_paid' });
  await seedPlan('asvc', { proposalStatus: 'balance_paid' });
  await seedPlan('qty');   // per_hour multi-quantity addon preservation
  await seedPlan('extras'); // fully-paid + locked Drink Plan Extras remainder
  await seedPlan('prebook', { proposalStatus: 'sent' }); // pre-deposit gate

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
  if (packageId) await pool.query('DELETE FROM service_packages WHERE id=$1', [packageId]);
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

async function toastPricing() {
  const toast = await pool.query(
    "SELECT rate, billing_type FROM service_addons WHERE slug = 'champagne-toast' AND is_active = true"
  );
  assert.ok(toast.rows[0], 'dev DB has the champagne-toast addon');
  const rate = Number(toast.rows[0].rate);
  return toast.rows[0].billing_type === 'per_guest' ? rate * 80 : rate;
}

test('empty reconcile preserves total_price even with a multi-quantity per_hour addon (reprice fidelity)', async () => {
  const proposalId = proposalIds[7]; // 'qty' plan
  // A per_hour addon at quantity 3 (banquet-server: bartenders bring the
  // hosted 1:100 ratio in, so a plain per_hour addon isolates the bug). The
  // bare `sa.*` reprice dropped pa.quantity → this would reprice as quantity 1
  // and shave 2 servers off total_price on the first (even empty) lab save.
  const svc = await pool.query(
    "SELECT * FROM service_addons WHERE slug = 'banquet-server' AND is_active = true"
  );
  assert.ok(svc.rows[0], 'dev DB has the banquet-server addon');
  const rate = Number(svc.rows[0].rate);
  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ($1, $2, $3, $4, $5, 3, $6)`,
    [proposalId, svc.rows[0].id, svc.rows[0].name, svc.rows[0].billing_type, rate, rate * 4 * 3]
  );
  const pkg = (await pool.query('SELECT * FROM service_packages WHERE id = $1', [packageId])).rows[0];
  const prop = (await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId])).rows[0];
  // Ground-truth total WITH 3 servers (what the fix must preserve).
  const expected = calculateProposal({
    pkg,
    guestCount: prop.guest_count,
    durationHours: Number(prop.event_duration_hours),
    numBars: prop.num_bars ?? 0,
    numBartenders: prop.num_bartenders,
    addons: withRepriceQuantities([{ ...svc.rows[0], pa_quantity: 3 }]),
    syrupSelections: [],
    adjustments: prop.adjustments || [],
    totalPriceOverride: null,
    gratuityRate: prop.gratuity_rate,
    tipJar: prop.tip_jar,
  }).total;
  await pool.query('UPDATE proposals SET total_price = $1 WHERE id = $2', [expected, proposalId]);

  const p = await request('PUT', `/api/drink-plans/t/${planTokens.qty}/lab`, {
    body: { addOns: {}, labSyrupSelections: {} },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const after = Number((await pool.query('SELECT total_price FROM proposals WHERE id = $1', [proposalId])).rows[0].total_price);
  assert.equal(after, expected, 'empty reconcile must not shave the 3-server (per_hour qty>1) addon');
});

test('pre-deposit proposal: lab is not_ready (GET) and 409 (PUT) — never folds an unsigned contract', async () => {
  const g = await request('GET', `/api/drink-plans/t/${planTokens.prebook}/lab`);
  assert.equal(g.status, 200);
  assert.equal(g.body.state, 'not_ready');
  const p = await request('PUT', `/api/drink-plans/t/${planTokens.prebook}/lab`, {
    body: { addOns: { 'champagne-toast': {} } },
  });
  assert.equal(p.status, 409, JSON.stringify(p.body));
});

test('additions fold into the balance: total rises, Balance absorbs with itemized lines, legacy lab invoice zeroes', async () => {
  const proposalId = proposalIds[3]; // 'money' plan
  // Locked paid Deposit + open Balance + a paid pay-now extras invoice that
  // must never be touched + a LEGACY open 'Enhancement Lab' invoice from the
  // pre-fold off-ledger model that must ZERO once the Balance absorbs.
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 10000, 'paid', true),
            ($1, $3, 'Balance', 0, 0, 'sent', false),
            ($1, $4, 'Drink Plan Extras', 9000, 9000, 'paid', true),
            ($1, $5, 'Enhancement Lab', 5000, 0, 'sent', false)`,
    [proposalId, `TA${NONCE.slice(-12)}`, `TB${NONCE.slice(-12)}`, `TC${NONCE.slice(-12)}`, `TL${NONCE.slice(-12)}`]
  );

  // Empty reconcile first: total_price becomes the engine's catalog baseline
  // (the seed's placeholder 2000 is not an engine number), so the addition
  // delta below is exact.
  const p0 = await request('PUT', `/api/drink-plans/t/${planTokens.money}/lab`, {
    body: { addOns: {}, labSyrupSelections: {} },
  });
  assert.equal(p0.status, 200, JSON.stringify(p0.body));
  const baseline = Number((await pool.query('SELECT total_price FROM proposals WHERE id=$1', [proposalId])).rows[0].total_price);
  // The legacy off-ledger-model invoice zeroed on the very first reconcile.
  const legacy = (await labInvoices(proposalId)).find((i) => i.label === 'Enhancement Lab');
  assert.equal(Number(legacy.amount_due), 0, 'legacy open lab invoice zeroed while a Balance absorbs');

  const toastTotal = await toastPricing();
  const syrupTotal = calculateSyrupCost(['jalapeno'], 80).total;
  const addedDollars = toastTotal + syrupTotal;

  const p = await request('PUT', `/api/drink-plans/t/${planTokens.money}/lab`, {
    body: {
      addOns: { 'champagne-toast': { servingStyle: 'Passed on trays', toastTime: '8:30 PM' } },
      labSyrupSelections: { [cocktailId]: ['jalapeno'] },
    },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.lab_breakdown.totalCents, Math.round(addedDollars * 100));
  assert.equal(p.body.balance.total, baseline + addedDollars, 'PUT reports the folded balance');

  // Proposal total rose by exactly the additions; addon landed in proposal_addons.
  const prop = (await pool.query('SELECT total_price FROM proposals WHERE id=$1', [proposalId])).rows[0];
  assert.equal(Number(prop.total_price), baseline + addedDollars);
  const pa = await pool.query(
    `SELECT pa.addon_name FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id
      WHERE pa.proposal_id = $1 AND sa.slug = 'champagne-toast'`,
    [proposalId]
  );
  assert.equal(pa.rows.length, 1, 'lab addon upserted into proposal_addons');

  // Balance invoice absorbed it: amount_due = total − lockedTotal (Deposit
  // 10000 + Extras 9000 both locked), with the lab items as their own lines.
  const invoices = await labInvoices(proposalId);
  const balanceInv = invoices.find((i) => i.label === 'Balance');
  const newTotalCents = Math.round((baseline + addedDollars) * 100);
  assert.equal(Number(balanceInv.amount_due), newTotalCents - 10000 - 9000);
  assert.equal(Number(invoices.find((i) => i.label === 'Drink Plan Extras').amount_due), 9000, 'extras invoice untouched');
  assert.equal(Number(invoices.find((i) => i.label === 'Enhancement Lab').amount_due), 0, 'no separate lab billing while a balance is owed');
  const lines = await pool.query(
    'SELECT description FROM invoice_line_items WHERE invoice_id = $1',
    [balanceInv.id]
  );
  const descs = lines.rows.map((r) => r.description);
  assert.ok(descs.some((d) => d.includes('Champagne Toast')), `toast has its own line (${descs.join(' | ')})`);
  assert.ok(descs.some((d) => d.includes('Signature Syrups')), 'syrups have their own line');

  // Selections: lab entries landed with labAdded, planner-owned addon survived.
  const sel = (await pool.query('SELECT selections FROM drink_plans WHERE id=$1', [planIds.money])).rows[0].selections;
  assert.equal(sel.addOns['champagne-toast'].labAdded, true);
  assert.equal(sel.addOns['champagne-toast'].toastTime, '8:30 PM');
  assert.equal(sel.addOns['photo-booth-nonsense'].enabled, true, 'planner-owned addon untouched');
  assert.deepEqual(sel.labSyrupSelections[cocktailId], ['jalapeno']);

  // Reconcile to empty: total and Balance walk back down; addon row removed.
  const p2 = await request('PUT', `/api/drink-plans/t/${planTokens.money}/lab`, {
    body: { addOns: {}, labSyrupSelections: {} },
  });
  assert.equal(p2.status, 200);
  const prop2 = (await pool.query('SELECT total_price FROM proposals WHERE id=$1', [proposalId])).rows[0];
  assert.equal(Number(prop2.total_price), baseline);
  const balance2 = (await labInvoices(proposalId)).find((i) => i.label === 'Balance');
  assert.equal(Number(balance2.amount_due), Math.round(baseline * 100) - 10000 - 9000);
  const pa2 = await pool.query('SELECT id FROM proposal_addons WHERE proposal_id = $1', [proposalId]);
  assert.equal(pa2.rows.length, 0, 'lab addon row removed on reconcile');
  const sel2 = (await pool.query('SELECT selections FROM drink_plans WHERE id=$1', [planIds.money])).rows[0].selections;
  assert.equal(sel2.addOns['champagne-toast'], undefined);
  assert.equal(sel2.addOns['photo-booth-nonsense'].enabled, true);
});

test('fully paid: itemized Enhancement Lab invoice carries the remainder; paid-in-full demoted', async () => {
  const proposalId = proposalIds[5]; // 'paidfull' plan
  // Baseline the total, then mark the event fully paid with everything locked.
  const p0 = await request('PUT', `/api/drink-plans/t/${planTokens.paidfull}/lab`, {
    body: { addOns: {}, labSyrupSelections: {} },
  });
  assert.equal(p0.status, 200, JSON.stringify(p0.body));
  const baseline = Number((await pool.query('SELECT total_price FROM proposals WHERE id=$1', [proposalId])).rows[0].total_price);
  const baselineCents = Math.round(baseline * 100);
  await pool.query(
    "UPDATE proposals SET amount_paid = total_price, status = 'balance_paid' WHERE id = $1",
    [proposalId]
  );
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Balance', $3, $3, 'paid', true)`,
    [proposalId, `TD${NONCE.slice(-12)}`, baselineCents]
  );

  const toastTotal = await toastPricing();
  const p = await request('PUT', `/api/drink-plans/t/${planTokens.paidfull}/lab`, {
    body: { addOns: { 'champagne-toast': {} }, labSyrupSelections: {} },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));

  // Paid-in-full flag re-evaluated (CLAUDE.md cross-cutting law).
  const prop = (await pool.query('SELECT status, total_price FROM proposals WHERE id=$1', [proposalId])).rows[0];
  assert.equal(prop.status, 'deposit_paid', 'balance_paid demoted when new money is owed');
  assert.equal(Number(prop.total_price), baseline + toastTotal);

  // Separate itemized invoice for exactly the remainder.
  const invoices = await labInvoices(proposalId);
  const labInv = invoices.find((i) => i.label === 'Enhancement Lab');
  assert.ok(labInv, 'Enhancement Lab invoice minted only in the fully-paid case');
  assert.equal(Number(labInv.amount_due), Math.round(toastTotal * 100));
  const lines = await pool.query('SELECT description, line_total FROM invoice_line_items WHERE invoice_id = $1', [labInv.id]);
  assert.ok(lines.rows.some((r) => r.description.includes('Champagne Toast')), 'itemized, not a generic line');
  const lineSum = lines.rows.reduce((s, r) => s + Number(r.line_total), 0);
  assert.equal(lineSum, Number(labInv.amount_due), 'lines sum to amount_due');

  // Removal refreshes the same invoice back to $0 — never a second one.
  const p2 = await request('PUT', `/api/drink-plans/t/${planTokens.paidfull}/lab`, {
    body: { addOns: {}, labSyrupSelections: {} },
  });
  assert.equal(p2.status, 200);
  const labs2 = (await labInvoices(proposalId)).filter((i) => i.label === 'Enhancement Lab');
  assert.equal(labs2.length, 1);
  assert.equal(Number(labs2[0].amount_due), 0);
});

test('fully paid + standing unpaid Additional Services: lab remainder never double-bills it', async () => {
  const proposalId = proposalIds[6]; // 'asvc' plan
  const p0 = await request('PUT', `/api/drink-plans/t/${planTokens.asvc}/lab`, {
    body: { addOns: {}, labSyrupSelections: {} },
  });
  assert.equal(p0.status, 200, JSON.stringify(p0.body));
  const baseline = Number((await pool.query('SELECT total_price FROM proposals WHERE id=$1', [proposalId])).rows[0].total_price);
  const baselineCents = Math.round(baseline * 100);
  // Fully paid on the ORIGINAL contract; then an admin edit added a $50
  // surcharge that already stands on an UNLOCKED Additional Services invoice
  // (its amount is inside total_price — the exact double-bill shape the
  // fleet flagged). Modeled as an `adjustments` surcharge so the fold's
  // engine recompute PRESERVES it (a raw total_price bump would evaporate).
  await pool.query(
    `UPDATE proposals SET amount_paid = total_price, status = 'balance_paid',
        total_price = total_price + 50,
        adjustments = '[{"type":"surcharge","amount":50,"label":"Admin edit"}]'::jsonb
      WHERE id = $1`,
    [proposalId]
  );
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Balance', $3, $3, 'paid', true),
            ($1, $4, 'Additional Services', 5000, 0, 'sent', false)`,
    [proposalId, `TE${NONCE.slice(-12)}`, baselineCents, `TF${NONCE.slice(-12)}`]
  );

  const toastTotal = await toastPricing();
  const p = await request('PUT', `/api/drink-plans/t/${planTokens.asvc}/lab`, {
    body: { addOns: { 'champagne-toast': {} }, labSyrupSelections: {} },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));

  const invoices = await labInvoices(proposalId);
  const labInv = invoices.find((i) => i.label === 'Enhancement Lab');
  const asvcInv = invoices.find((i) => i.label === 'Additional Services');
  assert.equal(Number(asvcInv.amount_due), 5000, 'Additional Services invoice untouched');
  assert.ok(labInv, 'lab remainder invoice minted');
  assert.equal(Number(labInv.amount_due), Math.round(toastTotal * 100),
    'remainder subtracts the open Additional Services carrier — the $50 is never billed twice');
});

test('fully paid + paid Drink Plan Extras: lab remainder ignores the pay-now extras (never under-bills)', async () => {
  const proposalId = proposalIds[8]; // 'extras' plan
  const p0 = await request('PUT', `/api/drink-plans/t/${planTokens.extras}/lab`, {
    body: { addOns: {}, labSyrupSelections: {} },
  });
  assert.equal(p0.status, 200, JSON.stringify(p0.body));
  const baseline = Number((await pool.query('SELECT total_price FROM proposals WHERE id=$1', [proposalId])).rows[0].total_price);
  const baselineCents = Math.round(baseline * 100);
  await pool.query(
    "UPDATE proposals SET amount_paid = total_price, status = 'balance_paid' WHERE id = $1",
    [proposalId]
  );
  // Fully paid on the contract, PLUS a paid pay-now 'Drink Plan Extras' whose
  // $90 is NOT in total_price. It is locked, so it lands in the naive
  // lockedTotal — subtracting it would shrink the remainder and under-bill (or
  // mint nothing). The fix excludes it from the lab lockedTotal.
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Balance', $3, $3, 'paid', true),
            ($1, $4, 'Drink Plan Extras', 9000, 9000, 'paid', true)`,
    [proposalId, `TG${NONCE.slice(-12)}`, baselineCents, `TH${NONCE.slice(-12)}`]
  );

  const toastTotal = await toastPricing();
  const p = await request('PUT', `/api/drink-plans/t/${planTokens.extras}/lab`, {
    body: { addOns: { 'champagne-toast': {} }, labSyrupSelections: {} },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const labInv = (await labInvoices(proposalId)).find((i) => i.label === 'Enhancement Lab');
  assert.ok(labInv, 'lab remainder invoice minted despite the paid extras invoice');
  assert.equal(Number(labInv.amount_due), Math.round(toastTotal * 100),
    'remainder ignores the $90 pay-now extras (not total_price money) — bills exactly the toast');
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
  // smoked-cocktail-kit is active but neither on the event shelf nor in the
  // guard drink's (empty) dossier — a stored addition for it is "drifted".
  // (zero-proof-spirits joined the offered shelf when the seeds gained a
  // hosted package, so it no longer drifts.)
  await pool.query(
    `UPDATE drink_plans SET selections = jsonb_set(selections, '{addOns,smoked-cocktail-kit}', '{"enabled":true,"labAdded":true}') WHERE id = $1`,
    [planIds.guard]
  );
  const p = await request('PUT', `/api/drink-plans/t/${planTokens.guard}/lab`, {
    body: { addOns: { 'smoked-cocktail-kit': {} } },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.lab_additions.addOns['smoked-cocktail-kit'], undefined, 'drifted slug dropped, not bricked');
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
