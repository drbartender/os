require('dotenv').config();

// Planner v2 submit-path tests (lane pp2-planner, per-concern sibling of
// submitExtras/submitOverride/submitReconcile):
//   1. sanitizeSelections normalizes the new v2 keys (crowd / barPlacement /
//      powerAtBar) and PRESERVES guestPreferences (the 2026-07-18 allow-list
//      data-loss bugfix).
//   2. The Jack rule is enforced SERVER-side: on a hosted non-mocktail
//      package, 2+ picked mocktails bill the Mocktail Bar addon and the
//      client-sent pre-batched addon is discarded; 1 pick bills pre-batched.
//   3. The version gate (2026-07-18 push review): the flip applies ONLY to
//      v2 plans on a package with entered contents — a legacy (v1) plan's
//      picks stay informational and its user-added pre-batched is honored.
//
// Harness per submitExtras.test.js: real router over HTTP against the dev DB,
// nonce-suffixed rows, full teardown. Run ALONE (shared dev DB):
//   node -r dotenv/config --test server/routes/drinkPlans/submitPlannerV2.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const drinkPlansRouter = require('../drinkPlans');

let server;
let baseUrl;
let clientId;
let packageId;
const proposalIds = [];
const planTokens = {};
const mocktailIds = [];

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

async function seedPlan(key) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, total_price, amount_paid, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', 'birthday-party', 80, 0, 2000, 100, '{}'::jsonb)
     RETURNING id`,
    [clientId, packageId]
  );
  proposalIds.push(p.rows[0].id);
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email)
     VALUES ($1, 'draft', '{}'::jsonb, $2, $3) RETURNING token`,
    [p.rows[0].id, `PP2 Submit ${NONCE}`, `pp2-submit-${NONCE}@example.com`]
  );
  planTokens[key] = dp.rows[0].token;
  return p.rows[0].id;
}

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`PP2 Submit ${NONCE}`, `pp2-submit-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  // Hosted full_bar (non-mocktail) package — the Jack-rule trigger context.
  const pkg = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'PP2 Hosted Test', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]')
     RETURNING id`,
    [`pp2-submit-${NONCE}`]
  );
  packageId = pkg.rows[0].id;

  // Contents-readiness: the flip enforces only when package_items exist
  // (coverageCtx non-null), so seed one row to make this package the
  // disclosed v2 cohort. Cleaned up by the package delete (FK CASCADE).
  await pool.query(
    "INSERT INTO package_items (package_id, category, par_per_100) VALUES ($1, 'Vodka', 2)",
    [packageId]
  );

  for (let i = 0; i < 2; i += 1) {
    const m = await pool.query(
      `INSERT INTO mocktails (id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
      [`pp2t-mock-${NONCE}-${i}`, `PP2T Mocktail ${NONCE} ${i}`]
    );
    mocktailIds.push(m.rows[0].id);
  }

  await seedPlan('sanitize');
  await seedPlan('flipTwo');
  await seedPlan('flipOne');
  await seedPlan('legacyPicksOnly');
  await seedPlan('legacyAddon');
  await pool.query(
    'UPDATE drink_plans SET planner_version = 1 WHERE token IN ($1, $2)',
    [planTokens.legacyPicksOnly, planTokens.legacyAddon]
  );

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
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id=$1', [pid]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id=$1', [pid]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id=$1', [pid]);
    await pool.query('DELETE FROM proposals WHERE id=$1', [pid]);
  }
  if (mocktailIds.length) await pool.query('DELETE FROM mocktails WHERE id = ANY($1::text[])', [mocktailIds]);
  if (packageId) await pool.query('DELETE FROM service_packages WHERE id=$1', [packageId]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id=$1', [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('v2 keys normalize on save and guestPreferences survives (allow-list bugfix)', async () => {
  const res = await request('PUT', `/api/drink-plans/t/${planTokens.sanitize}`, {
    body: {
      status: 'draft',
      selections: {
        crowd: { drinkers: 'abc', unsure: 'nope', profile: 'party-animals' },
        barPlacement: 'roof',
        powerAtBar: 'maybe',
        guestPreferences: { balance: 'mostly_beer', naInterest: 'yes', wineLean: 'red' },
        _logoFilename: 'evil',
      },
    },
  });
  assert.strictEqual(res.status, 200);

  const row = await pool.query('SELECT selections FROM drink_plans WHERE token = $1', [planTokens.sanitize]);
  const sel = row.rows[0].selections;
  assert.deepEqual(sel.crowd, { drinkers: null, unsure: true, profile: 'help' });
  assert.strictEqual(sel.barPlacement, 'unsure');
  assert.strictEqual(sel.powerAtBar, 'unsure');
  assert.deepEqual(sel.guestPreferences, { balance: 'mostly_beer', naInterest: 'yes', wineLean: 'red' });
  assert.strictEqual(sel._logoFilename, undefined);

  // Valid values pass through untouched.
  const ok = await request('PUT', `/api/drink-plans/t/${planTokens.sanitize}`, {
    body: {
      status: 'draft',
      selections: { crowd: { drinkers: 60, unsure: false, profile: 'cocktail_forward' }, barPlacement: 'outdoors', powerAtBar: 'yes' },
    },
  });
  assert.strictEqual(ok.status, 200);
  const row2 = await pool.query('SELECT selections FROM drink_plans WHERE token = $1', [planTokens.sanitize]);
  assert.deepEqual(row2.rows[0].selections.crowd, { drinkers: 60, unsure: false, profile: 'cocktail_forward' });
});

test('Jack rule: 2 mocktails on hosted non-mocktail package bill the Mocktail Bar, never the client-sent pre-batched', async () => {
  const res = await request('PUT', `/api/drink-plans/t/${planTokens.flipTwo}`, {
    body: {
      status: 'submitted',
      selections: {
        mocktails: mocktailIds,
        // Client lies: claims the cheap addon despite two picks.
        addOns: { 'pre-batched-mocktail': { enabled: true } },
      },
    },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const pid = proposalIds[1];
  const addons = await pool.query(
    `SELECT sa.slug FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id WHERE pa.proposal_id = $1`,
    [pid]
  );
  const slugs = addons.rows.map((r) => r.slug);
  assert.ok(slugs.includes('mocktail-bar'), `mocktail-bar billed (got: ${slugs.join(',')})`);
  assert.ok(!slugs.includes('pre-batched-mocktail'), 'pre-batched discarded');
});

test('Jack rule: exactly 1 mocktail bills pre-batched, never the Mocktail Bar', async () => {
  const res = await request('PUT', `/api/drink-plans/t/${planTokens.flipOne}`, {
    body: {
      status: 'submitted',
      selections: { mocktails: [mocktailIds[0]] },
    },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const pid = proposalIds[2];
  const addons = await pool.query(
    `SELECT sa.slug FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id WHERE pa.proposal_id = $1`,
    [pid]
  );
  const slugs = addons.rows.map((r) => r.slug);
  assert.ok(slugs.includes('pre-batched-mocktail'), `pre-batched billed (got: ${slugs.join(',')})`);
  assert.ok(!slugs.includes('mocktail-bar'), 'mocktail-bar not billed for a single pick');
});

test('Version gate: a legacy (v1) plan never gets the flip — picks are informational, user-added pre-batched honored', async () => {
  // Picks alone: no financial side effects, nothing billed.
  const resPicks = await request('PUT', `/api/drink-plans/t/${planTokens.legacyPicksOnly}`, {
    body: { status: 'submitted', selections: { mocktails: mocktailIds } },
  });
  assert.strictEqual(resPicks.status, 200, JSON.stringify(resPicks.body));
  const none = await pool.query(
    'SELECT sa.slug FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id WHERE pa.proposal_id = $1',
    [proposalIds[3]]
  );
  assert.deepEqual(none.rows, [], 'legacy picks bill nothing');

  // The legacy checkbox path: a deliberate user-added pre-batched is honored
  // exactly as sent, never flipped to the Mocktail Bar by the pick count.
  const resAddon = await request('PUT', `/api/drink-plans/t/${planTokens.legacyAddon}`, {
    body: {
      status: 'submitted',
      selections: { mocktails: mocktailIds, addOns: { 'pre-batched-mocktail': { enabled: true } } },
    },
  });
  assert.strictEqual(resAddon.status, 200, JSON.stringify(resAddon.body));
  const rows = await pool.query(
    'SELECT sa.slug FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id WHERE pa.proposal_id = $1',
    [proposalIds[4]]
  );
  const slugs = rows.rows.map((r) => r.slug);
  assert.ok(slugs.includes('pre-batched-mocktail'), `user-added pre-batched honored (got: ${slugs.join(',')})`);
  assert.ok(!slugs.includes('mocktail-bar'), 'no flip on a v1 plan');
});
