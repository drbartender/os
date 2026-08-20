// Route-level tests for POST /api/proposals/t/:token/options.
//
// This endpoint is a PUBLIC token-gated surface that quotes prices, so the
// assertions that matter most are the ones proving the caller cannot influence
// what those prices are. Harness mirrors public.calculate.test.js: a fresh
// express() app over the real router, driven over real HTTP against the dev DB.
//
// Uses the real seeded catalog (package/add-on slugs from schema.sql) rather
// than inventing its own, because the point is that the shipped rules —
// stripIncludedAddons, applies_to gating, the hosted guest floor — actually fire
// through this route. Seeds and purges only its own client + proposal.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const optionsRouter = require('./publicOptions');

let server;
let baseUrl;
let clientId;
let proposalId;
let token;
const stamp = `optroute-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

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

async function addonIdBySlug(slug) {
  const r = await pool.query('SELECT id FROM service_addons WHERE slug = $1', [slug]);
  return r.rows[0] ? r.rows[0].id : null;
}

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    [`Options Route ${stamp}`, `${stamp}@test.local`]
  );
  clientId = c.rows[0].id;

  // A BYOB proposal at 120 guests / 4 hours: comfortably above the hosted
  // 25-guest floor so every hosted option prices, and above the 100-guest
  // real-glassware cap so that visibility rule is exercised too.
  const byob = await pool.query(
    `SELECT id FROM service_packages WHERE category = 'byob' AND is_active = true ORDER BY id LIMIT 1`
  );
  const p = await pool.query(
    `INSERT INTO proposals (client_id, package_id, status, guest_count, event_duration_hours,
                            num_bars, event_date, event_start_time, total_price)
     VALUES ($1, $2, 'sent', 120, 4, 1, CURRENT_DATE + 90, '5:00 PM', 0)
     RETURNING id, token`,
    [clientId, byob.rows[0].id]
  );
  proposalId = p.rows[0].id;
  token = p.rows[0].token;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', optionsRouter);
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

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalId) await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [proposalId]);
  if (proposalId) await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('prices every active non-class package and flags the current one', async () => {
  const res = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.comparable, true);
  assert.ok(res.body.options.length > 1, 'more than one option is offered');
  const current = res.body.options.filter((o) => o.is_current);
  assert.equal(current.length, 1, 'exactly one option is the current one');
  assert.ok(res.body.options.every((o) => !o.available || typeof o.total === 'number'),
    'every available option carries a numeric total');
  assert.equal(res.body.event.guest_count, 120, 'event numbers come back off the proposal');
});

test('THE MONEY LAW: event numbers are read off the proposal, never the request body', async () => {
  const honest = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  // Everything a caller might hope to steer the price with.
  const tampered = await request('POST', `/api/proposals/t/${token}/options`, {
    body: {
      guest_count: 1, event_duration_hours: 1, num_bars: 0, num_bartenders: 1,
      total_price: 1, total_price_override: 1, adjustments: [{ label: 'hax', amount: -9999 }],
    },
  });
  assert.equal(tampered.status, 200);
  assert.deepEqual(
    tampered.body.options.map((o) => o.total),
    honest.body.options.map((o) => o.total),
    'a body full of pricing inputs changes nothing'
  );
  assert.equal(tampered.body.event.guest_count, 120);
});

test('a BYOB tier does not double-charge for what it already covers', async () => {
  const tierId = await addonIdBySlug('the-full-compound');
  const coveredId = await addonIdBySlug('ice-delivery-only');
  assert.ok(tierId && coveredId, 'seeded tier + covered add-on exist');

  const tierOnly = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { tier_addon_id: tierId, extra_addon_ids: [] },
  });
  const tierPlusCovered = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { tier_addon_id: tierId, extra_addon_ids: [coveredId] },
  });

  const byobTotal = (r) => r.body.options.find((o) => o.category === 'byob').total;
  assert.equal(byobTotal(tierPlusCovered), byobTotal(tierOnly),
    'Full Compound already includes ice delivery, so adding it again costs nothing');
});

test('an add-on that does not apply to a lane is not priced onto it', async () => {
  // Garnish package is byob-only; it must never reach a hosted option's price.
  const garnishId = await addonIdBySlug('garnish-package-only');
  assert.ok(garnishId, 'seeded garnish add-on exists');

  const none = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { extra_addon_ids: [] },
  });
  const withGarnish = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { extra_addon_ids: [garnishId] },
  });

  const hosted = (r) => r.body.options.filter((o) => o.category !== 'byob' && o.available);
  assert.ok(hosted(none).length > 0, 'there are hosted options to check');
  for (const opt of hosted(withGarnish)) {
    const before = hosted(none).find((o) => o.package_id === opt.package_id);
    assert.equal(opt.total, before.total,
      `${opt.name}: a byob-only add-on must not change a hosted price`);
  }
});

test('garbage add-on ids are ignored, not fatal', async () => {
  const res = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { extra_addon_ids: [-1, 0, 'abc', null, 999999999], tier_addon_id: 'nope' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.comparable, true);
});

test('a negotiated price is never offered the comparison', async () => {
  await pool.query('UPDATE proposals SET total_price_override = 4321 WHERE id = $1', [proposalId]);
  const res = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.comparable, false);
  assert.equal(res.body.reason, 'custom_pricing');
  assert.deepEqual(res.body.options, []);
  await pool.query('UPDATE proposals SET total_price_override = NULL WHERE id = $1', [proposalId]);
});

test('a signed proposal is frozen: the configuration is the one they signed', async () => {
  await pool.query('UPDATE proposals SET client_signed_at = NOW() WHERE id = $1', [proposalId]);
  const res = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  assert.equal(res.body.comparable, false);
  assert.equal(res.body.reason, 'already_signed');
  await pool.query('UPDATE proposals SET client_signed_at = NULL WHERE id = $1', [proposalId]);
});

test('a rule-violating option is a per-option verdict, not a failed request', async () => {
  // The whole point of the per-option catch. Guarded by a REAL threshold: below
  // 25 guests every hosted package violates the floor while BYOB still prices.
  // The original fixture sat at 120 guests specifically so nothing could fail,
  // which is exactly why the broken `err.status` guard shipped unnoticed.
  await pool.query('UPDATE proposals SET guest_count = 12 WHERE id = $1', [proposalId]);
  const res = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  assert.equal(res.status, 200, 'one unpriceable option must not fail the whole request');
  const hosted = res.body.options.filter((o) => o.category !== 'byob');
  assert.ok(hosted.length > 0 && hosted.every((o) => o.available === false),
    'hosted options fall below the 25-guest floor');
  assert.ok(hosted.every((o) => o.reason && o.reason.length > 0), 'each carries a reason');
  const byob = res.body.options.filter((o) => o.category === 'byob');
  assert.ok(byob.some((o) => o.available && typeof o.total === 'number'),
    'BYOB still prices while hosted cannot');
  await pool.query('UPDATE proposals SET guest_count = 120 WHERE id = $1', [proposalId]);
});

test('an admin bartender override is carried into the quote', async () => {
  // priceProposedState does not fall back to the stored column for this field,
  // so without an explicit pass-through the quote silently re-derives crew from
  // the 1:100 ratio and undercharges the client's own package.
  // A body is present, so the current option is PRICED rather than echoing the
  // contract total — which is the path this test is about.
  const sel = { extra_addon_ids: [], tier_addon_id: null };
  const base = await request('POST', `/api/proposals/t/${token}/options`, { body: sel });
  const baseTotal = base.body.options.find((o) => o.is_current).total;

  await pool.query('UPDATE proposals SET num_bartenders = 4 WHERE id = $1', [proposalId]);
  const withOverride = await request('POST', `/api/proposals/t/${token}/options`, { body: sel });
  const overrideTotal = withOverride.body.options.find((o) => o.is_current).total;

  assert.ok(overrideTotal > baseTotal,
    `an over-ratio crew must cost more (got ${overrideTotal} vs ${baseTotal})`);
  await pool.query('UPDATE proposals SET num_bartenders = NULL WHERE id = $1', [proposalId]);
});

test("add-on quantity is priced, not flattened to one", async () => {
  const barback = await addonIdBySlug('barback');
  assert.ok(barback, 'seeded barback add-on exists');
  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, quantity) VALUES ($1, $2, 1)
     ON CONFLICT (proposal_id, addon_id) DO UPDATE SET quantity = 1`,
    [proposalId, barback]
  );
  // Stored quantity for a per_hour add-on is effectiveHours x realQty, so at 4
  // hours a real quantity of 2 is stored as 8. Written the way the engine
  // writes it, not as a raw multiplier, or the test pins fiction.
  const sel = { extra_addon_ids: [barback], tier_addon_id: null };
  const one = await request('POST', `/api/proposals/t/${token}/options`, { body: sel });
  const oneTotal = one.body.options.find((o) => o.is_current).total;

  await pool.query('UPDATE proposal_addons SET quantity = 8 WHERE proposal_id = $1 AND addon_id = $2',
    [proposalId, barback]);
  const three = await request('POST', `/api/proposals/t/${token}/options`, { body: sel });
  const threeTotal = three.body.options.find((o) => o.is_current).total;

  assert.ok(threeTotal > oneTotal,
    `two barbacks must cost more than one (got ${threeTotal} vs ${oneTotal})`);
  await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1 AND addon_id = $2',
    [proposalId, barback]);
});

test("the client's own price does not drift when they toggle something else", async () => {
  // Dallas's add-ons include ones a client can never see (parking fee is hidden
  // outright). Those must ride the current option on EVERY quote, or the
  // "Yours" card gets cheaper than the total printed above it the instant the
  // client touches an extra — for a reason they cannot see.
  const hidden = await addonIdBySlug('parking-fee');
  const visible = await addonIdBySlug('champagne-toast');
  assert.ok(hidden && visible, 'seeded hidden + visible add-ons exist');
  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, quantity) VALUES ($1, $2, 1)
     ON CONFLICT (proposal_id, addon_id) DO NOTHING`, [proposalId, hidden]);

  const listing = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  assert.ok(!listing.body.extras.some((x) => x.addon_id === hidden),
    'the hidden add-on is never offered to the client');
  const offered = listing.body.extras.filter((x) => x.selected).map((x) => x.addon_id);

  // Both reads take the PRICED path, so this isolates drift across a re-quote
  // rather than comparing a priced total against the contract echo.
  const first = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { extra_addon_ids: offered, tier_addon_id: null },
  });
  const firstTotal = first.body.options.find((o) => o.is_current).total;
  const reQuote = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { extra_addon_ids: offered, tier_addon_id: null },
  });
  const reTotal = reQuote.body.options.find((o) => o.is_current).total;
  assert.equal(reTotal, firstTotal, 'the current option holds its price across a re-quote');

  await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1 AND addon_id = $2',
    [proposalId, hidden]);
});

test("THE CARD MATCHES THE CONTRACT: the current option is the stored total, verbatim", async () => {
  // The client is being asked to pay `total_price`. Whatever the catalog says
  // today, the card for their own bar must show the number on their proposal —
  // a re-price that lands even a dollar off means the comparison contradicts
  // the document directly above it. Pinned with a stored total the engine would
  // never produce on its own, so only a verbatim read can pass.
  const { rows: [orig] } = await pool.query('SELECT total_price FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('UPDATE proposals SET total_price = 1234.56 WHERE id = $1', [proposalId]);

  const res = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  const current = res.body.options.find((o) => o.is_current);
  assert.equal(current.total, 1234.56, 'the current option shows what the proposal says');

  // Alternatives are still genuinely priced — the guarantee is scoped to the
  // one option that has a contract behind it.
  const others = res.body.options.filter((o) => !o.is_current && o.available);
  assert.ok(others.length > 0 && others.every((o) => o.total !== 1234.56),
    'other options are priced, not echoed');

  await pool.query('UPDATE proposals SET total_price = $1 WHERE id = $2', [orig.total_price, proposalId]);
});

test('REGRESSION: a per-guest add-on is not re-multiplied by the guest count', async () => {
  // THE bug. proposal_addons.quantity for a per_guest add-on stores the GUEST
  // COUNT (that is what the engine computes and crud.js persists). Feeding it
  // back as an input multiplier makes the engine bill guests x rate x guests.
  // Seeded exactly the way the engine writes it, so only a correct inverter
  // passes: at 120 guests a $2.50/guest extra must add $300, not $300 x 20
  // (safeAddonQty caps the multiplier at 20).
  const toast = await addonIdBySlug('champagne-toast');
  assert.ok(toast, 'seeded per_guest add-on exists');
  const { rows: [a] } = await pool.query('SELECT rate FROM service_addons WHERE id = $1', [toast]);
  const rate = Number(a.rate);
  const guests = 120;
  const expected = rate * guests;

  const sel = { extra_addon_ids: [], tier_addon_id: null };
  const without = await request('POST', `/api/proposals/t/${token}/options`, { body: sel });
  const withoutTotal = without.body.options.find((o) => o.is_current).total;

  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ($1, $2, 'Champagne Toast', 'per_guest', $3, $4, $5)
     ON CONFLICT (proposal_id, addon_id) DO UPDATE SET quantity = $4, line_total = $5, rate = $3`,
    [proposalId, toast, rate, guests, expected]
  );
  const withIt = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { extra_addon_ids: [toast], tier_addon_id: null },
  });
  const withTotal = withIt.body.options.find((o) => o.is_current).total;
  const delta = +(withTotal - withoutTotal).toFixed(2);

  assert.equal(delta, expected,
    `a $${rate}/guest extra on ${guests} guests must add $${expected}, got $${delta}`);

  await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1 AND addon_id = $2',
    [proposalId, toast]);
});

test('an unknown token 404s rather than leaking', async () => {
  const res = await request('POST', `/api/proposals/t/${crypto.randomUUID()}/options`, { body: {} });
  assert.equal(res.status, 404);
});

// ─── Hidden add-ons ride every option (spec 2026-08-14, decision 10) ─────────

test('own hidden add-ons ride EVERY option, not just the current card', async () => {
  // A parking fee is an event fact, not a package feature: the venue charges
  // for parking no matter which bar we run. It must be inside every option's
  // price, or the drawer's deltas compare a fee-carrying contract against
  // fee-free alternatives and every "less than yours" line overstates itself.
  const hidden = await addonIdBySlug('parking-fee');
  assert.ok(hidden, 'seeded parking-fee exists');
  const { rows: [pf] } = await pool.query(
    'SELECT rate, applies_to, billing_type FROM service_addons WHERE id = $1', [hidden]);
  assert.equal(pf.applies_to, 'all', 'parking-fee applies to every package (catalog fact this test leans on)');
  const fee = Number(pf.rate);
  assert.ok(fee > 0, 'parking-fee carries a rate');

  const sel = { extra_addon_ids: [], tier_addon_id: null };
  const control = await request('POST', `/api/proposals/t/${token}/options`, { body: sel });

  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ($1, $2, 'Parking Fee', $3, $4, 1, $4)
     ON CONFLICT (proposal_id, addon_id) DO NOTHING`,
    [proposalId, hidden, pf.billing_type, fee]);
  const withFee = await request('POST', `/api/proposals/t/${token}/options`, { body: sel });

  // The fee is per_staff in the seeded catalog, so its dollar amount is the
  // ENGINE's business (staff count x rate), not this test's. What the test
  // pins: the fee lands on every option, and by the same amount it lands on
  // the current card, which has always carried it. At 120 guests every package
  // derives the same crew, so the deltas must agree exactly.
  const currentDelta = +(withFee.body.options.find((o) => o.is_current).total
    - control.body.options.find((o) => o.is_current).total).toFixed(2);
  assert.ok(currentDelta >= fee,
    `the fee visibly lands on the current card (delta ${currentDelta}, rate ${fee})`);
  for (const opt of withFee.body.options.filter((o) => o.available)) {
    const before = control.body.options.find((o) => o.package_id === opt.package_id);
    if (!before || !before.available) continue;
    const delta = +(opt.total - before.total).toFixed(2);
    assert.equal(delta, currentDelta,
      `${opt.name}: the hidden fee must be inside this option's price (delta ${delta}, expected ${currentDelta})`);
    assert.deepEqual(opt.dropped, [],
      `${opt.name}: a fee that rides is not dropped`);
  }

  // Both pricing call sites agree: with no tier selected, the BYOB option and
  // the "Bar service only" tier are the same configuration and must be the
  // same number, fee included.
  const byobOpt = withFee.body.options.find((o) => o.category === 'byob');
  const bareTier = withFee.body.tiers.find((t) => t.addon_id === null);
  assert.equal(bareTier.total, byobOpt.total,
    'tiers loop and options loop price the same configuration identically');

  await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1 AND addon_id = $2',
    [proposalId, hidden]);
});

test('an extra that cannot apply to an option is NAMED in its dropped list', async () => {
  // Today the visibility gate silently drops a byob-only extra from hosted
  // options (the price is right, the client just never learns why). The drawer
  // needs the reason on the wire: per-option `dropped` names what fell off.
  const garnishId = await addonIdBySlug('garnish-package-only');
  assert.ok(garnishId, 'seeded garnish add-on exists');

  const res = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { extra_addon_ids: [garnishId], tier_addon_id: null },
  });
  const hosted = res.body.options.filter((o) => o.category !== 'byob');
  assert.ok(hosted.length > 0, 'there are hosted options to check');
  for (const opt of hosted) {
    assert.ok(Array.isArray(opt.dropped)
      && opt.dropped.some((d) => d.addon_id === garnishId && typeof d.name === 'string' && d.name.length > 0),
      `${opt.name}: the byob-only extra must be named in dropped`);
  }
  const byob = res.body.options.find((o) => o.category === 'byob');
  assert.ok(!byob.dropped.some((d) => d.addon_id === garnishId),
    'the extra rides the byob option, so it is not dropped there');
});

test('a PROVABLE staffing derivation is re-derived per package; an override still carries', async () => {
  // num_bartenders holds persisted derivations as well as true overrides (crud
  // writes staffing.actual back into the column). Carrying a derivation onto a
  // package with a different ratio prices phantom over-ratio bartenders, and
  // quote and commit would AGREE on the phantom, so no 409 can catch it. The
  // rule: strip the column ONLY when the stored snapshot proves it is a
  // derivation (staffing.actual === staffing.required === the column); anything
  // unprovable keeps carrying (the pre-existing behavior, and what the
  // "admin bartender override is carried" test above pins for a bare column).
  const sel = { extra_addon_ids: [], tier_addon_id: null };
  const control = await request('POST', `/api/proposals/t/${token}/options`, { body: sel });
  const controlTotals = control.body.options.filter((o) => o.available)
    .map((o) => [o.package_id, o.total]);

  // Provable STALE derivation: the snapshot was written when this event
  // derived 3 bartenders (say, before a guest-count edit); at 120 guests every
  // package derives 2 today. Carrying the stored 3 as an override prices a
  // phantom over-ratio bartender on every option; the provable-derivation rule
  // strips it and lets each package re-derive.
  await pool.query(
    `UPDATE proposals SET num_bartenders = 3,
       pricing_snapshot = '{"staffing":{"required":3,"actual":3}}'::jsonb
     WHERE id = $1`, [proposalId]);
  const derived = await request('POST', `/api/proposals/t/${token}/options`, { body: sel });
  for (const [pkgId, controlTotal] of controlTotals) {
    const opt = derived.body.options.find((o) => o.package_id === pkgId);
    if (!opt || !opt.available) continue;
    assert.equal(opt.total, controlTotal,
      `${opt.name}: a provable derivation must re-derive per package, not ride as an override`);
  }

  // True override: snapshot proves actual != required.
  await pool.query(
    `UPDATE proposals SET num_bartenders = 4,
       pricing_snapshot = '{"staffing":{"required":2,"actual":4}}'::jsonb
     WHERE id = $1`, [proposalId]);
  const overridden = await request('POST', `/api/proposals/t/${token}/options`, { body: sel });
  const controlCurrent = control.body.options.find((o) => o.is_current).total;
  const overriddenCurrent = overridden.body.options.find((o) => o.is_current).total;
  assert.ok(overriddenCurrent > controlCurrent,
    `a true override must still raise the price (got ${overriddenCurrent} vs ${controlCurrent})`);

  // pricing_snapshot is NOT NULL with a default in this schema; restore the
  // empty object, not NULL.
  await pool.query(
    `UPDATE proposals SET num_bartenders = NULL, pricing_snapshot = '{}'::jsonb WHERE id = $1`,
    [proposalId]);
});
