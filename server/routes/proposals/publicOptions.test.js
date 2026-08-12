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
  const base = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  const baseTotal = base.body.options.find((o) => o.is_current).total;

  await pool.query('UPDATE proposals SET num_bartenders = 4 WHERE id = $1', [proposalId]);
  const withOverride = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
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
  const one = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  const oneTotal = one.body.options.find((o) => o.is_current).total;

  await pool.query('UPDATE proposal_addons SET quantity = 3 WHERE proposal_id = $1 AND addon_id = $2',
    [proposalId, barback]);
  const three = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  const threeTotal = three.body.options.find((o) => o.is_current).total;

  assert.ok(threeTotal > oneTotal,
    `three barbacks must cost more than one (got ${threeTotal} vs ${oneTotal})`);
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

  const first = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  const firstTotal = first.body.options.find((o) => o.is_current).total;
  assert.ok(!first.body.extras.some((x) => x.addon_id === hidden),
    'the hidden add-on is never offered to the client');

  // Re-quote carrying exactly what the client was offered — the hidden one
  // cannot be in the body because it was never in the list.
  const offered = first.body.extras.filter((x) => x.selected).map((x) => x.addon_id);
  const reQuote = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { extra_addon_ids: offered, tier_addon_id: null },
  });
  const reTotal = reQuote.body.options.find((o) => o.is_current).total;
  assert.equal(reTotal, firstTotal, 'the current option holds its price across a re-quote');

  await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1 AND addon_id = $2',
    [proposalId, hidden]);
});

test('an unknown token 404s rather than leaking', async () => {
  const res = await request('POST', `/api/proposals/t/${crypto.randomUUID()}/options`, { body: {} });
  assert.equal(res.status, 404);
});
