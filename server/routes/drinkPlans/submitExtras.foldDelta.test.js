// A pay-now submit's extras invoice equals the contract delta (audit PRC-03,
// 2026-11-05). DB-BACKED: run alone against the shared dev DB.
//
//   node --test server/routes/drinkPlans/submitExtras.foldDelta.test.js
//
// THE DEFECT. The pay-now branch priced a per_hour add-on at the flat catalog
// rate while the fold added hours times rate to total_price, so the extras
// invoice (and the charge) billed 2500 against a 10000 contract delta and
// nothing invoiced the remainder. The pure pin of the pricing is
// utils/drinkPlanExtras.legs.test.js; this suite drives the real submit over
// HTTP (the submitExtras suite's harness) with its own catalog rows and
// asserts the committed invoice against the committed total_price move.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const drinkPlansRouter = require('../drinkPlans');

if (process.env.NODE_ENV === 'production') {
  throw new Error('submitExtras.foldDelta.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const SERVER_SLUG = `fold-server-${NONCE}`;
let server, baseUrl, clientId, pkgId, addonId;
const proposalIds = [];

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method,
        headers: bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {} },
      (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => { let json = null; try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: json, raw: data }); }); }
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function seedPlan() {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
                            status, event_type, guest_count, num_bars, num_bartenders, total_price, amount_paid, pricing_snapshot, token)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', 'birthday-party', 60, 0, 2, 1000, 100, '{"total": 1000, "syrups": {"selections": []}}'::jsonb, gen_random_uuid())
     RETURNING id`,
    [clientId, pkgId]
  );
  proposalIds.push(p.rows[0].id);
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email)
     VALUES ($1, 'draft', '{}'::jsonb, $2, $3) RETURNING id, token`,
    [p.rows[0].id, `Fold Delta ${NONCE}`, `fold-delta-${NONCE}@example.com`]
  );
  return { proposalId: p.rows[0].id, token: dp.rows[0].token };
}

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`Fold Delta ${NONCE}`, `fold-delta-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const pkg = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes, is_active)
     VALUES ($1, 'Fold Delta Package', 'byob', 'flat', 350, 300, 50, 75, 'byob', '[]'::jsonb, false)
     RETURNING id`,
    [`fold-delta-${NONCE}`]
  );
  pkgId = pkg.rows[0].id;
  const addon = await pool.query(
    `INSERT INTO service_addons (slug, name, rate, billing_type, minimum_hours, is_active)
     VALUES ($1, 'Fold Delta Server', 25, 'per_hour', 4, true) RETURNING id`,
    [SERVER_SLUG]
  );
  addonId = addon.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', drinkPlansRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', ids]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  await pool.query('DELETE FROM service_addons WHERE id = $1', [addonId]);
  await pool.query('DELETE FROM service_packages WHERE id = $1', [pkgId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('a pay-now submit with a per_hour server: the extras invoice equals the total_price delta, with the engine line', async () => {
  const f = await seedPlan();
  const selections = { addOns: { [SERVER_SLUG]: { enabled: true } }, logistics: { addBarRental: false } };
  const r = await request('PUT', `/api/drink-plans/t/${f.token}`, { body: { status: 'submitted', paid_separately: true, selections } });
  assert.equal(r.status, 200, r.raw);
  const row = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [f.proposalId])).rows[0];
  const deltaCents = Math.round(Number(row.total_price) * 100) - 100000;
  assert.equal(deltaCents, 10000, 'the fold added 4h x 25');
  const inv = (await pool.query(
    `SELECT id, amount_due, status FROM invoices WHERE proposal_id = $1 AND label = 'Drink Plan Extras' AND status <> 'void'`,
    [f.proposalId]
  )).rows;
  assert.equal(inv.length, 1);
  assert.equal(Number(inv[0].amount_due), deltaCents, 'invoiced at the contract delta, to the cent');
  const lines = (await pool.query('SELECT description, quantity::float8 AS quantity, line_total, source_type, source_id FROM invoice_line_items WHERE invoice_id = $1', [inv[0].id])).rows;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].source_type, 'addon');
  assert.equal(lines[0].source_id, addonId);
  assert.equal(Number(lines[0].line_total), 10000);
  assert.equal(lines[0].quantity, 4);
});
