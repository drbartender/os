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
// The tip-placement routes live in payrollTips.js (split out of payroll.js on
// 2026-11-05 when the assign guards took that file past the 1000-line ratchet).
const payrollTipsRouter = require('./payrollTips');

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
let tipRow;          // the tips row as the scripted statements leave it (null = no such tip)
let onRoster;        // whether the recipient is an approved, non-dropped bartender on the shift
let tipUpdates;      // every UPDATE tips SET shift_id the route issued (params)
let periodStatus;    // the event period's status
let todayRowExists;  // whether the current week's pay_periods row has been materialized
let todayStatus;     // its status when it exists
let periodInserts;   // the find-or-create INSERTs into pay_periods (params)
let rollLines;       // payout_events upserts the roll-forward wrote (params)
let clawLines;       // payout_events upserts the clawback wrote (params)
let markerWrites;    // the clawback's final cumulative-marker writes (params)
let log;             // the order of the statements that matter, by name
const TODAY_PERIOD = 55;

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
    return { rows: [{ status: periodStatus }], rowCount: 1 };
  }
  // payrollProcessing.findOpenPeriodForDate: the open period containing today,
  // a bare SELECT that finds nothing until the week's row is materialized.
  if (sql.startsWith('SELECT id, start_date, end_date, payday, status FROM pay_periods WHERE status = \'open\'')) {
    return todayRowExists && todayStatus === 'open'
      ? { rows: [{ id: TODAY_PERIOD, start_date: '2026-10-20', end_date: '2026-10-26', payday: '2026-10-27', status: 'open' }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  // The find-or-create of the week's row (payrollLateTip / payrollClawback
  // shape): a new row is born open; an existing one keeps its status.
  if (sql.startsWith('INSERT INTO pay_periods')) {
    periodInserts.push(params);
    if (!todayRowExists) { todayRowExists = true; todayStatus = 'open'; }
    return { rows: [{ id: TODAY_PERIOD, status: todayStatus }], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE tips SET shift_id')) {
    tipUpdates.push(params);
    log.push('assign');
    // The row as the statement leaves it: placed, marker reset, a clawback
    // deferral armed for a partial refund.
    const refunded = Number(params[2]);
    tipRow = {
      ...tipRow, shift_id: SHIFT_ID, refunded_amount_cents: 0,
      ...(refunded > 0 ? { deferred_at: 'assign-time', defer_kind: 'clawback', defer_target_cents: refunded } : {}),
    };
    return { rows: [{ id: TIP_ID, shift_id: SHIFT_ID, amount_cents: 6000, tipped_at: '2026-10-17T23:30:00Z' }], rowCount: 1 };
  }
  // payrollLateTip.rollForwardLateTip, on its own client.
  if (sql.startsWith('SELECT id, shift_id, amount_cents, fee_cents, rolled_forward_at')) {
    log.push('rollforward:read');
    return {
      rows: [{
        id: TIP_ID, shift_id: tipRow.shift_id, amount_cents: 6000, fee_cents: 204,
        rolled_forward_at: tipRow.rolled_forward_at, target_user_id: BARTENDER_ID,
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('UPDATE tips SET rolled_forward_at = NOW()')) {
    log.push('rollforward:success');
    tipRow = { ...tipRow, rolled_forward_at: 'rolled', deferred_at: null, defer_kind: null };
    return { rows: [], rowCount: 1 };
  }
  // The re-armed clawback deferral between the roll-forward and the claw.
  if (sql.startsWith('UPDATE tips SET deferred_at = NOW(), defer_kind = \'clawback\'')) {
    log.push('rearm');
    markerWrites.push({ rearm: params });
    tipRow = { ...tipRow, deferred_at: 'rearm-time', defer_kind: 'clawback', defer_target_cents: Number(params[1]) };
    return { rows: [], rowCount: 1 };
  }
  // payrollClawback.clawbackTip, on its own client.
  if (sql.startsWith('SELECT id, shift_id, amount_cents, fee_cents, refunded_amount_cents')) {
    log.push('claw:read');
    return {
      rows: [{
        id: TIP_ID, shift_id: tipRow.shift_id, amount_cents: 6000, fee_cents: 204,
        refunded_amount_cents: tipRow.refunded_amount_cents, target_user_id: BARTENDER_ID,
        deferred_at: tipRow.deferred_at || null, defer_kind: tipRow.defer_kind || null,
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('SELECT sr.user_id, (u.cc_id LIKE')) {
    return { rows: [{ user_id: BARTENDER_ID, is_stub: false }], rowCount: 1 };
  }
  if (sql.startsWith('INSERT INTO payouts')) {
    return { rows: [{ id: 900 + Number(params[1]) }], rowCount: 1 };
  }
  if (sql.startsWith('INSERT INTO payout_events')) {
    // The clawback's column list names adjustment_note; the roll-forward's names
    // card_tip_gross_cents (both ON CONFLICT arms mention adjustment_cents).
    if (sql.includes('adjustment_note')) clawLines.push(params); else rollLines.push(params);
    return { rows: [{ held_state: null }], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE tips SET refunded_amount_cents')) {
    log.push('claw:final');
    markerWrites.push(params);
    tipRow = { ...tipRow, refunded_amount_cents: Number(params[0]), deferred_at: null, defer_kind: null };
    return { rows: [], rowCount: 1 };
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
  app.use('/api/admin', payrollTipsRouter);
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
  clawLines = [];
  markerWrites = [];
  onRoster = true;
  periodStatus = 'open';
  todayRowExists = true;
  todayStatus = 'open';
  periodInserts = [];
  rollLines = [];
  log = [];
  tipRow = {
    id: TIP_ID, shift_id: null, rolled_forward_at: null, refunded_amount_cents: 0,
    amount_cents: 6000, target_user_id: BARTENDER_ID,
  };
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
  ['refunded in full', { refunded_amount_cents: 6000 }],
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
  assert.equal(r.body.refund_clawed_cents, 0);
  assert.equal(tipUpdates.length, 1, 'one UPDATE tips');
  assert.deepEqual(tipUpdates[0], [SHIFT_ID, TIP_ID, 0], 'the refunded marker it read rides along as a guard');
  assert.deepEqual(clawLines, [], 'nothing to claw');
});

// M2 (verify pass): a tip partly refunded while it was unplaced is placed, and
// the refunded cents are booked as a clawback at placement, so the bartender
// receives the gross minus the refunded part instead of nothing forever.
test('a tip partly refunded while unplaced is placed, its marker reset in the same statement, and the refund clawed net of fee', async () => {
  tipRow.refunded_amount_cents = 600;
  const r = await patch(PATH, { shift_id: SHIFT_ID });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.tip.shift_id, SHIFT_ID);
  assert.deepEqual(tipUpdates[0], [SHIFT_ID, TIP_ID, 600], 'placed with the marker it read as the guard, reset to 0 by the statement');
  // clawbackTip ran with the refunded total as the cumulative: delta 600, fee
  // share round(204 x 600 / 6000) = 20, net 580 on the one bartender, in the
  // open period containing today.
  assert.equal(clawLines.length, 1, 'one clawback line');
  assert.equal(clawLines[0][0], 900 + BARTENDER_ID, 'the bartender payout in today period');
  assert.equal(clawLines[0][1], SHIFT_ID, 'keyed by the placed shift');
  assert.equal(clawLines[0][2], -580, 'the refunded cents net of their fee share');
  assert.deepEqual(markerWrites.map((p) => p[0]), [600], 'the cumulative marker is back at the refunded total');
  assert.equal(r.body.refund_clawed_cents, 600);
});

test('a partly refunded tip on a frozen event is refused while today period EXISTS and is frozen, with the reason named, and nothing moves', async () => {
  tipRow.refunded_amount_cents = 600;
  periodStatus = 'paid';
  todayRowExists = true;
  todayStatus = 'processing';
  const r = await patch(PATH, { shift_id: SHIFT_ID });
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.code, 'PERIOD_NOT_OPEN');
  assert.match(r.body.error, /processing/, 'the message names the period state that blocks the placement');
  assert.deepEqual(tipUpdates, []);
  assert.deepEqual(clawLines, []);
  assert.deepEqual(rollLines, []);
});

// Round 3, M1: the week's pay_periods row is created by the first accrual (or
// by a roll-forward or a clawback), so on a Tuesday before any event of the
// new week has completed there is no row at all. The pre-check must then
// create it open the way the roll-forward and the clawback do, not refuse.
test('a partly refunded tip on a frozen event is placed when today period row does not exist yet: the row is created open, the gross rolls forward and the claw is booked', async () => {
  tipRow.refunded_amount_cents = 600;
  periodStatus = 'paid';
  todayRowExists = false;
  const r = await patch(PATH, { shift_id: SHIFT_ID });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.frozen_period, true);
  assert.ok(periodInserts.length >= 1, 'the week row was materialized by the find-or-create path');
  assert.deepEqual(tipUpdates[0], [SHIFT_ID, TIP_ID, 600], 'placed');
  assert.equal(rollLines.length, 1, 'the gross rolled forward into the new open week');
  assert.equal(rollLines[0][0], 900 + BARTENDER_ID);
  assert.equal(rollLines[0][1], SHIFT_ID);
  assert.equal(clawLines.length, 1, 'and the refund was clawed right after');
  assert.equal(clawLines[0][2], -580);
  assert.equal(r.body.refund_clawed_cents, 600);
  assert.equal(tipRow.rolled_forward_at, 'rolled');
  assert.equal(tipRow.refunded_amount_cents, 600, 'the cumulative marker is back at the refunded total');
});

