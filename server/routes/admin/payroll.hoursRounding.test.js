require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
// No .env on a gate or audit box: the real auth middleware still verifies a
// token, so the secret falls back to a fixed test value when none is set.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'payroll-hours-rounding-test';

/**
 * PATCH /api/admin/payroll/payout-events/:id computes the wage from the hours
 * the column will store (audit 2026-11-05, POUT-11).
 *
 * payout_events.hours is NUMERIC(5,2). The route accepted any finite value in
 * [0, 24] and computed wage = round(hours x rate) from the raw value, while
 * Postgres rounded the stored hours to two decimals: 7.125 h at 2000c/h stored
 * 7.13 h against a 14,250c wage, so the paystub's printed hours and its wage
 * disagreed by ten cents and a re-accrual from the stored hours silently
 * changed the line. The route now rounds the hours to two decimals first.
 *
 * Harness: the real router and the real auth middleware over node:http, with
 * pool.query and pool.connect replaced by in-memory stubs keyed on the SQL
 * text (the stripePayoutSync.unconfigured.test.js pattern), recording the
 * payout_events UPDATE instead of executing it. No database.
 *
 * Run: node --test server/routes/admin/payroll.hoursRounding.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const payrollRouter = require('./payroll');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payroll.hoursRounding.test.js refuses to run against production');
}

const ADMIN_ID = 801;
const EVENT_ID = 8101;
const RATE_CENTS = 2000;

let server, baseUrl;
const realQuery = pool.query;
const realConnect = pool.connect;
let lineUpdates; // params of every UPDATE payout_events

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.startsWith('SELECT id, email, role, onboarding_status')) {
    return {
      rows: [{
        id: ADMIN_ID, email: 'admin-hours@example.com', role: 'admin', onboarding_status: 'approved',
        can_hire: true, can_staff: true, token_version: 0, pre_hired: false, presence_lead_rank: null,
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('SELECT pe.*, po.id AS payout_id')) {
    return {
      rows: [{
        id: EVENT_ID, payout_id: 91, payout_status: 'pending', pay_period_id: 31, period_status: 'open',
        hours: '7.00', rate_cents: RATE_CENTS, late: false, adjustment_cents: 0, adjustment_note: null,
        gratuity_share_cents: 0, card_tip_net_cents: 0, held_state: null,
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('UPDATE payout_events')) {
    lineUpdates.push(params);
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE payouts po SET total_cents')) {
    return { rows: [{ total_cents: 14260 }], rowCount: 1 };
  }
  if (sql.startsWith('SELECT * FROM payout_events')) {
    const p = lineUpdates[lineUpdates.length - 1] || [];
    return { rows: [{ id: EVENT_ID, hours: p[0], wage_cents: p[5] }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

function patch(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(`${baseUrl}/api/admin/payroll/payout-events/${EVENT_ID}`);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${jwt.sign({ userId: ADMIN_ID, tokenVersion: 0 }, process.env.JWT_SECRET)}`,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = d ? JSON.parse(d) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: j, raw: d });
      });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

before(async () => {
  pool.query = (text, params) => Promise.resolve(answer(text, params));
  pool.connect = () => Promise.resolve({
    query: (text, params) => Promise.resolve(answer(text, params)),
    release: () => {},
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', payrollRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('[hours-rounding harness] unhandled:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { lineUpdates = []; });

after(async () => {
  pool.query = realQuery;
  pool.connect = realConnect;
  if (server) await new Promise((r) => server.close(r));
});

// UPDATE payout_events params: hours, rate_cents, late, adjustment_cents,
// adjustment_note, wage_cents, line_total_cents, held_state, id.
test('hours 7.125 are stored as 7.13 and the wage is computed from 7.13, so the stored hours and wage agree', async () => {
  const r = await patch({ hours: 7.125 });
  assert.equal(r.status, 200, r.raw);
  assert.equal(lineUpdates.length, 1);
  const [hours, rate, , , , wage, lineTotal] = lineUpdates[0];
  assert.equal(hours, 7.13, 'the value the NUMERIC(5,2) column will hold');
  assert.equal(wage, Math.round(hours * rate), 'wage = round(stored hours x rate)');
  assert.equal(wage, 14260);
  assert.equal(lineTotal, 14260);
});

test('two-decimal hours are untouched', async () => {
  const r = await patch({ hours: 5.5 });
  assert.equal(r.status, 200, r.raw);
  const [hours, , , , , wage] = lineUpdates[0];
  assert.equal(hours, 5.5);
  assert.equal(wage, 11000);
});
