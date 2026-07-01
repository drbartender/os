require('dotenv').config();

// Integration test for B1: a syrup-only pay-now submit must create exactly ONE
// unpaid "Drink Plan Extras" invoice inside a transaction (syrups never fold into
// total_price, so an abandoned card would otherwise leave them uncollected).
//
// Hand-rolled harness in the style of drinkPlans.beo.test.js: real express app +
// real router mounted, driven over HTTP. The PUT /t/:token route is public
// (token-gated), so no auth is needed. Runs against the dev DB; every seeded row
// is torn down in after(). Rows are nonce-suffixed so a crashed prior run can't
// collide.

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
let proposalId;
let drinkPlanId;
let planToken;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

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

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`Extras Test ${NONCE}`, `extras-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, total_price, amount_paid, pricing_snapshot)
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', 'birthday-party', 75, 0, 1000, 100, '{}'::jsonb)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email)
     VALUES ($1, 'draft', '{}'::jsonb, $2, $3) RETURNING id, token`,
    [proposalId, `Extras Test ${NONCE}`, `extras-${NONCE}@example.com`]
  );
  drinkPlanId = dp.rows[0].id;
  planToken = dp.rows[0].token;

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
  // Let fire-and-forget submit side-effects (shopping-list gen, email lookup)
  // settle before we tear down the pool.
  await new Promise((r) => setTimeout(r, 300));
  await pool.query("DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [proposalId]);
  await pool.query("DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [proposalId]);
  await pool.query("DELETE FROM invoices WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM proposal_activity_log WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM drink_plans WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id=$1", [proposalId]);
  await pool.query("DELETE FROM clients WHERE id=$1", [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('syrup-only pay-now submit creates ONE unpaid Drink Plan Extras invoice, lines foot to amount_due', async () => {
  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: {
      status: 'submitted',
      paid_separately: true,
      selections: { syrupSelections: { d1: ['blackberry', 'vanilla'] }, syrupSelfProvided: [] },
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'submitted');

  const inv = await pool.query(
    `SELECT id, status, amount_due, amount_paid FROM invoices
      WHERE proposal_id = $1 AND label = 'Drink Plan Extras' AND status <> 'void'`,
    [proposalId]
  );
  assert.strictEqual(inv.rows.length, 1, 'exactly one non-void extras invoice');
  assert.strictEqual(inv.rows[0].status, 'sent');
  // 2 syrups @ 75 guests = 4 bottles = 1 pack ($75) + 1 single ($30) = $105 = 10500 cents.
  assert.strictEqual(inv.rows[0].amount_due, 10500);
  assert.strictEqual(inv.rows[0].amount_paid, 0);

  // Line items must sum to amount_due (ledger invariant).
  const li = await pool.query(
    'SELECT COALESCE(SUM(line_total), 0) AS s FROM invoice_line_items WHERE invoice_id = $1',
    [inv.rows[0].id]
  );
  assert.strictEqual(Number(li.rows[0].s), 10500);
});

test('re-submit is blocked (submit-once gate), so no duplicate extras invoice', async () => {
  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: {
      status: 'submitted',
      paid_separately: true,
      selections: { syrupSelections: { d1: ['blackberry', 'vanilla'] }, syrupSelfProvided: [] },
    },
  });
  assert.strictEqual(res.status, 409); // already submitted
  const inv = await pool.query(
    `SELECT count(*)::int AS n FROM invoices WHERE proposal_id = $1 AND label = 'Drink Plan Extras' AND status <> 'void'`,
    [proposalId]
  );
  assert.strictEqual(inv.rows[0].n, 1);
});
