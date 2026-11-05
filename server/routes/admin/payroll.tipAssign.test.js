require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
// No .env on a gate or audit box: the real auth middleware still verifies a
// token, so the secret falls back to a fixed test value when none is set.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'payroll-tip-assign-test';

/**
 * PATCH /api/admin/payroll/tips/:id/assign places an UNPLACED tip on a shift
 * its recipient worked, and nothing else (audit 2026-11-05, POUT-07).
 *
 * The route resolved the shift and its period, then UPDATE tips SET shift_id
 * with no check on the tip at all: a tip already matched to a shift (and paid
 * through accrual, or rolled forward into a later period) could be assigned
 * again and summed into a second shift's pool, paying it twice; a refunded tip
 * could be placed and paid; and a tip for bartender X could be routed to a
 * shift X never worked, paying X's tip to other people. The list that feeds
 * the screen shows only unplaced tips, but the route is the gate.
 *
 * Harness: the real router and the real auth middleware over node:http, with
 * pool.query replaced by an in-memory stub keyed on the SQL text (the
 * stripePayoutSync.unconfigured.test.js pattern), recording the tips UPDATE
 * instead of executing it. No database.
 *
 * Run: node --test server/routes/admin/payroll.tipAssign.test.js
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
  throw new Error('payroll.tipAssign.test.js refuses to run against production');
}

const ADMIN_ID = 401;
const BARTENDER_ID = 402;
const TIP_ID = 4101;
const SHIFT_ID = 4201;
const PROPOSAL_ID = 4301;

let server, baseUrl;
const realQuery = pool.query;
const realConnect = pool.connect;
let tipRow;        // what the tip read answers with (null = no such tip)
let onRoster;      // whether the recipient is an approved, non-dropped bartender on the shift
let tipUpdates;    // every UPDATE tips the route issued

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.startsWith('SELECT id, email, role, onboarding_status')) {
    return {
      rows: [{
        id: ADMIN_ID, email: 'admin-tips@example.com', role: 'admin', onboarding_status: 'approved',
        can_hire: true, can_staff: true, token_version: 0, pre_hired: false, presence_lead_rank: null,
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('SELECT s.id, s.proposal_id, p.event_date FROM shifts s')) {
    return { rows: [{ id: SHIFT_ID, proposal_id: PROPOSAL_ID, event_date: new Date(2026, 9, 17) }], rowCount: 1 };
  }
  if (sql.startsWith('SELECT id, shift_id, rolled_forward_at')) {
    return tipRow ? { rows: [tipRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.startsWith('SELECT 1 FROM shift_requests')) {
    return onRoster ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.startsWith('SELECT status FROM pay_periods')) {
    return { rows: [{ status: 'open' }], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE tips SET shift_id')) {
    tipUpdates.push(params);
    return { rows: [{ id: TIP_ID, shift_id: SHIFT_ID, amount_cents: 6000, tipped_at: '2026-10-17T23:30:00Z' }], rowCount: 1 };
  }
  // The accrual's proposal read (skipped as missing) and anything else.
  return { rows: [], rowCount: 0 };
}

function tokenFor(id) {
  return jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function patch(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${tokenFor(ADMIN_ID)}`,
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
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', payrollRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('[tip-assign harness] unhandled:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  tipUpdates = [];
  onRoster = true;
  tipRow = { id: TIP_ID, shift_id: null, rolled_forward_at: null, refunded_amount_cents: 0, target_user_id: BARTENDER_ID };
});

after(async () => {
  pool.query = realQuery;
  pool.connect = realConnect;
  if (server) await new Promise((r) => server.close(r));
});

const PATH = `/api/admin/payroll/tips/${TIP_ID}/assign`;

for (const [why, patchRow] of [
  ['already placed on a shift', { shift_id: 4299 }],
  ['already rolled forward', { rolled_forward_at: '2026-10-21T15:00:00Z' }],
  ['already refunded', { refunded_amount_cents: 600 }],
]) {
  test(`a tip ${why} is refused with 409 and never moved`, async () => {
    Object.assign(tipRow, patchRow);
    const r = await patch(PATH, { shift_id: SHIFT_ID });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.code, 'TIP_ALREADY_PLACED');
    assert.deepEqual(tipUpdates, [], 'no UPDATE tips');
  });
}

test('a shift the recipient did not work as a bartender is refused with 422 and the tip is never moved', async () => {
  onRoster = false;
  const r = await patch(PATH, { shift_id: SHIFT_ID });
  assert.equal(r.status, 422, r.raw);
  assert.equal(r.body.code, 'RECIPIENT_NOT_ON_SHIFT');
  assert.deepEqual(tipUpdates, []);
});

test('an unknown tip is 404', async () => {
  tipRow = null;
  const r = await patch(PATH, { shift_id: SHIFT_ID });
  assert.equal(r.status, 404, r.raw);
  assert.deepEqual(tipUpdates, []);
});

test('an unplaced tip for a bartender on the shift is placed, and the UPDATE itself carries the guards', async () => {
  const r = await patch(PATH, { shift_id: SHIFT_ID });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.tip.shift_id, SHIFT_ID);
  assert.equal(tipUpdates.length, 1, 'one UPDATE tips');
  assert.deepEqual(tipUpdates[0], [SHIFT_ID, TIP_ID]);
});
