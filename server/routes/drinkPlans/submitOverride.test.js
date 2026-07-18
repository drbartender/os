require('dotenv').config();

// Regression: a client-submitted drink plan carrying a financial extra must NOT
// destroy a negotiated price (proposals.total_price_override).
//
// Origin: Jack Van Dyke (prod proposal 600, 2026-07-16). CC contract $3,273.
// He added a second portable bar in the planner; submit re-priced him at full
// catalog ($4,000), left the override column stranded at 3273, and emailed him
// a $3,900 balance. See docs/superpowers/specs/2026-07-16-drink-plan-override-
// preservation-design.md.
//
// The rule: newOverride = oldOverride + catalogDelta. The delta is priced with
// the override OFF, so anything this submit did not change cancels out. That is
// why the CC-era bundled first bar (first_bar_fee) must NOT appear in the
// delta: it is in the catalog on both sides. Only the genuine second bar
// (additional_bar_fee) is added.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { calculateProposal, calculateSyrupCost } = require('../../utils/pricingEngine');
const drinkPlansRouter = require('../drinkPlans');

let server;
let baseUrl;
let clientId;
let pkg;
let CONTRACT; // a negotiated price genuinely BELOW catalog; derived in before()
const seeded = []; // { proposalId, planToken }

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const DISCOUNT = 577; // Jack's real CC discount: $3,850 catalog -> $3,273 contract

// Price the seeded event at CATALOG (override off) for a given bar count. Used
// to derive a contract that is a real discount, and to prove the handler did
// not re-price at catalog. Derived from the seeded package rather than
// hardcoded, so the test holds whichever package the dev DB happens to seed.
function catalogAt(numBars) {
  return calculateProposal({
    pkg,
    guestCount: 175,
    durationHours: 4,
    numBars,
    numBartenders: 2,
    addons: [],
    syrupSelections: [],
    adjustments: [],
    totalPriceOverride: null,
    gratuityRate: 0,
    tipJar: true,
  }).total;
}

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
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
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// Seed one proposal + drink plan. `override` null => native (no negotiated price).
async function seedProposal({ override, adjustments = [], gratuityRate = 0 }) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, package_id, event_type, guest_count, num_bars, num_bartenders,
        total_price, total_price_override, amount_paid, external_paid,
        adjustments, autopay_enrolled, pricing_snapshot, gratuity_rate, tip_jar)
     VALUES ($1, CURRENT_DATE + 30, '14:00', 4, 'America/Chicago',
             'confirmed', $2, 'wedding-reception', 175, 1, 2,
             $3, $4, 100, 100, $5, false, '{}'::jsonb, $6, true)
     RETURNING id`,
    [clientId, pkg.id, override ?? 1000, override, JSON.stringify(adjustments), gratuityRate]
  );
  const proposalId = p.rows[0].id;
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email)
     VALUES ($1, 'draft', '{}'::jsonb, $2, $3) RETURNING token`,
    [proposalId, `Override Test ${NONCE}`, `override-${NONCE}@example.com`]
  );
  const rec = { proposalId, planToken: dp.rows[0].token };
  seeded.push(rec);
  return rec;
}

before(async () => {
  // A per_guest, non-class package with BOTH bar fees, so the delta can prove
  // the first-bar fee cancels and only the additional-bar fee lands.
  const pk = await pool.query(
    `SELECT * FROM service_packages
      WHERE is_active = true AND pricing_type = 'per_guest' AND bar_type <> 'class'
        AND first_bar_fee > 0 AND additional_bar_fee > 0
      ORDER BY id LIMIT 1`
  );
  assert.ok(pk.rows[0], 'need an active per_guest, non-class package with both bar fees');
  pkg = pk.rows[0];

  // Model Jack: a contract genuinely below catalog (his $3,273 sat under $3,850
  // of catalog). Seeded at num_bars = 1, the bar his CC contract bundles.
  CONTRACT = Math.round((catalogAt(1) - DISCOUNT) * 100) / 100;
  assert.ok(CONTRACT > 0, 'seeded package must be expensive enough to discount');

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`Override Test ${NONCE}`, `override-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', drinkPlansRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
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

after(async () => {
  // Let fire-and-forget submit side-effects (shopping-list gen, email lookup) settle.
  await new Promise((r) => setTimeout(r, 300));
  for (const { proposalId } of seeded) {
    await pool.query("DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [proposalId]);
    await pool.query("DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [proposalId]);
    await pool.query("DELETE FROM invoices WHERE proposal_id=$1", [proposalId]);
    await pool.query("DELETE FROM proposal_addons WHERE proposal_id=$1", [proposalId]);
    await pool.query("DELETE FROM proposal_activity_log WHERE proposal_id=$1", [proposalId]);
    await pool.query("DELETE FROM drink_plans WHERE proposal_id=$1", [proposalId]);
    await pool.query("DELETE FROM proposals WHERE id=$1", [proposalId]);
  }
  await pool.query("DELETE FROM clients WHERE id=$1", [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('overridden proposal: a second bar adds exactly additional_bar_fee and the contract survives', async () => {
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT });

  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: {
      status: 'submitted',
      paid_separately: false, // add-to-balance branch
      selections: { logistics: { addBarRental: true } },
    },
  });
  assert.strictEqual(res.status, 200);

  const row = (await pool.query(
    'SELECT total_price, total_price_override, num_bars, pricing_snapshot FROM proposals WHERE id = $1',
    [proposalId]
  )).rows[0];

  const expected = CONTRACT + Number(pkg.additional_bar_fee);

  // num_bars 1 -> 2. The bar he already had is in the catalog on BOTH sides of
  // the delta, so its first_bar_fee cancels and must not be charged.
  assert.strictEqual(row.num_bars, 2, 'the added bar is recorded');
  assert.strictEqual(Number(row.total_price_override), expected,
    'the contract must move by exactly the additional-bar fee');
  assert.strictEqual(Number(row.total_price), expected,
    'total_price must track the contract, not the catalog');
  assert.strictEqual(Number(row.pricing_snapshot.total), expected,
    'the snapshot total must agree with total_price');
  assert.strictEqual(Number(row.pricing_snapshot.total_price_override), expected,
    'the snapshot must carry the new contract, not null');

  // The bug: the handler re-priced at catalog and threw the discount away.
  assert.strictEqual(Number(row.total_price), catalogAt(2) - DISCOUNT,
    'the discount must survive intact on top of the new bar');
  assert.notStrictEqual(Number(row.total_price), catalogAt(2),
    'must NOT be re-priced at catalog (this is the Jack Van Dyke regression)');

  // The opposite bug: preserving the override naively makes the extra free.
  assert.ok(Number(row.total_price) > CONTRACT,
    'the extra must actually be charged, not given away');
});

test('overridden proposal: the first-bar fee never enters the delta', async () => {
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT });
  await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: { status: 'submitted', paid_separately: false, selections: { logistics: { addBarRental: true } } },
  });
  const row = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [proposalId])).rows[0];
  const wrong = CONTRACT + Number(pkg.first_bar_fee) + Number(pkg.additional_bar_fee);
  assert.notStrictEqual(Number(row.total_price), wrong,
    'the contractually included first bar must not be re-charged');
});

test('native proposal (no override) keeps the catalog recompute and stays un-overridden', async () => {
  const { proposalId, planToken } = await seedProposal({ override: null });

  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: { status: 'submitted', paid_separately: false, selections: { logistics: { addBarRental: true } } },
  });
  assert.strictEqual(res.status, 200);

  const row = (await pool.query(
    'SELECT total_price, total_price_override, pricing_snapshot FROM proposals WHERE id = $1',
    [proposalId]
  )).rows[0];

  assert.strictEqual(row.total_price_override, null,
    'a native proposal must never acquire an override');
  // Catalog recompute: guest-driven base, well above the seeded $1,000 placeholder.
  assert.ok(Number(row.total_price) > 1000, 'native path still re-prices from catalog');
  assert.strictEqual(Number(row.pricing_snapshot.total), Number(row.total_price));
});

test('overridden proposal keeps its visible adjustment lines in the rebuilt breakdown', async () => {
  const adjustments = [{ type: 'discount', label: 'Corporate 3-Night Rate', amount: 100, visible: true }];
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT, adjustments });

  await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: { status: 'submitted', paid_separately: false, selections: { logistics: { addBarRental: true } } },
  });

  const snap = (await pool.query('SELECT pricing_snapshot FROM proposals WHERE id = $1', [proposalId])).rows[0].pricing_snapshot;
  assert.strictEqual(snap.adjustments.length, 1, 'adjustments must survive the submit recompute');
  assert.strictEqual(snap.adjustments[0].label, 'Corporate 3-Night Rate');
  assert.ok(
    snap.breakdown.some(l => l.label === 'Corporate 3-Night Rate' && l.amount === -100),
    'the discount must render as a negative breakdown line'
  );
});

test('client-elected gratuity is never folded into the contract by the delta', async (t) => {
  // The override is a SERVICE-level contract; the engine layers the gratuity
  // line on top of it. If the delta were differenced from the engine's `.total`
  // (which includes gratuity), a gratuity move would be baked into the contract
  // AND charged again by the final snapshot. Caught by the review fleet: an
  // additional-bartender addon overcharged by rate x hours ($200) and left
  // gratuity dollars permanently inside total_price_override.
  // Must use `additional-bartender`: it is the ONLY add-on that moves the
  // gratuity staff basis (pricingEngine gratuityStaffCountFrom), so it is the
  // only input that can expose the double-count. A bar rental cannot -- it does
  // not touch staffing, so its gratuity is equal on both delta legs and cancels
  // whether the arithmetic is right or wrong. The planner UI does not offer this
  // add-on, but the public token endpoint honors any active slug, so a crafted
  // PUT reaches it. Skip rather than pass vacuously if the catalog ever drops it.
  const addon = (await pool.query(
    "SELECT slug, rate FROM service_addons WHERE slug = 'additional-bartender' AND is_active = true"
  )).rows[0];
  if (!addon) { t.skip('additional-bartender add-on not seeded'); return; }

  const GRAT = 50; // $/staff/hr; the no-jar floor
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT, gratuityRate: GRAT });

  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: {
      status: 'submitted',
      paid_separately: false,
      selections: { addOns: { 'additional-bartender': { enabled: true } } },
    },
  });
  assert.strictEqual(res.status, 200);

  const row = (await pool.query(
    'SELECT total_price, total_price_override, pricing_snapshot FROM proposals WHERE id = $1',
    [proposalId]
  )).rows[0];
  const snap = row.pricing_snapshot;

  assert.ok(Number(snap.gratuity.total) > 0, 'the gratuity line is populated (guards the test itself)');
  assert.ok(Number(row.total_price_override) > CONTRACT, 'the added bartender is actually charged');

  // The contract must move by the addon's SERVICE cost only. Differencing the
  // engine's `.total` would also fold in the gratuity increase the extra staff
  // member creates, overcharging by rate x hours and polluting the contract.
  const gratuityBaked = Number(row.total_price_override) - CONTRACT >= GRAT * 4;
  assert.ok(!gratuityBaked,
    `contract moved by $${Number(row.total_price_override) - CONTRACT}, which includes gratuity dollars`);

  // total = contract + gratuity, layered on top exactly once.
  assert.strictEqual(Number(row.total_price),
    Math.round((Number(row.total_price_override) + Number(snap.gratuity.total)) * 100) / 100,
    'gratuity must be layered on the contract exactly once, not baked in and re-added');
});

test('overridden proposal: self-provided syrups are excluded from the contract delta', async () => {
  // Two catalog syrups, one brought by the client. Co-submitted with a bar
  // rental so the money-recompute path runs (syrups only reach the override
  // delta when another financial extra triggers it). The self-provided flavor
  // must not move the contract — the same overbill class as the Jack bug.
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT });

  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: {
      status: 'submitted',
      paid_separately: false,
      selections: {
        logistics: { addBarRental: true },
        syrupSelections: { d1: ['blackberry', 'lavender'] },
        syrupSelfProvided: ['lavender'],
      },
    },
  });
  assert.strictEqual(res.status, 200);

  const row = (await pool.query(
    'SELECT total_price_override FROM proposals WHERE id = $1', [proposalId]
  )).rows[0];

  // Seed guest_count is 175. Only 'blackberry' is priced; 'lavender' is BYO.
  const onePricedSyrup = calculateSyrupCost(['blackberry'], 175).total;
  const bothSyrups = calculateSyrupCost(['blackberry', 'lavender'], 175).total;
  assert.notStrictEqual(onePricedSyrup, bothSyrups, 'test guard: the two counts must differ');

  const expected = Math.round((CONTRACT + Number(pkg.additional_bar_fee) + onePricedSyrup) * 100) / 100;
  assert.strictEqual(Number(row.total_price_override), expected,
    'a self-provided syrup must not be charged into the contract');
});

test('overridden proposal: self-providing an already-contracted syrup does not shave the contract', async () => {
  // The syrup is already priced into the contract (snapshot). Marking it
  // self-provided must be NEUTRAL to the delta, not a client-driven contract
  // reduction. It sits on both delta legs and is filtered from both.
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT });
  await pool.query(
    'UPDATE proposals SET pricing_snapshot = $1 WHERE id = $2',
    [JSON.stringify({ syrups: { selections: ['blackberry'] } }), proposalId]
  );

  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: {
      status: 'submitted',
      paid_separately: false,
      selections: {
        logistics: { addBarRental: true },
        syrupSelections: { d1: ['blackberry'] },
        syrupSelfProvided: ['blackberry'],
      },
    },
  });
  assert.strictEqual(res.status, 200);

  const row = (await pool.query('SELECT total_price_override FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.strictEqual(Number(row.total_price_override), CONTRACT + Number(pkg.additional_bar_fee),
    'a self-provided already-contracted syrup must not reduce the negotiated contract');
});

test('overridden proposal: a malformed syrupSelfProvided does not 500', async () => {
  // Public token payload: a non-array syrupSelfProvided (e.g. {}) must not throw
  // on .includes inside the transaction. Bar rental drives the recompute path.
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT });
  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: {
      status: 'submitted',
      paid_separately: false,
      selections: { logistics: { addBarRental: true }, syrupSelfProvided: {} },
    },
  });
  assert.strictEqual(res.status, 200, 'a non-array syrupSelfProvided must not crash the submit');
  const row = (await pool.query('SELECT total_price_override FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.strictEqual(Number(row.total_price_override), CONTRACT + Number(pkg.additional_bar_fee),
    'no syrups selected -> the bar fee is the only move');
});

test('a submit with no financial extras moves no money', async () => {
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT });

  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: { status: 'submitted', paid_separately: false, selections: { mocktails: ['shirley-temple-deluxe'] } },
  });
  assert.strictEqual(res.status, 200);

  const row = (await pool.query('SELECT total_price, total_price_override FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.strictEqual(Number(row.total_price), CONTRACT);
  assert.strictEqual(Number(row.total_price_override), CONTRACT);
});
