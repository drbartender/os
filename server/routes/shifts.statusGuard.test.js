// PUT /shifts/:id must not write shifts.status.
//
// The handler destructured `status` straight off req.body and wrote
// `status = COALESCE($9, status)` with no validation — while the two fields
// beside it, equipment_required and supply_run, were both validated. That is how
// three dev shifts ended up carrying status='confirmed', a value no schema
// definition allows and nothing in the app writes.
//
// The DB CHECK now rejects anything outside open|filled|completed|cancelled, so
// the residual exposure is narrower than "an arbitrary status" and worse in kind:
// any admin or manager PUT could stamp a LEGAL 'cancelled' onto a delivered
// event. That value is overloaded — the Events dashboard renders a Cancelled chip
// from it, and calendar.js turns it into STATUS:CANCELLED with a bumped SEQUENCE,
// which strikes the event off the owner's subscribed Google Calendar.
//
// The third test is the one that keeps this honest: rejecting status here must
// NOT break the path that legitimately cancels a shift.

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { updateShiftHandler, cancelOrUnassignShiftHandler } = require('./shifts.handlers');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.statusGuard.test.js refuses to run against production');
}

const SHIFT_ID = -7601;
const CLIENT_ID = -7602;
const PROPOSAL_ID = -7603;
const ADMIN_ID = -7604;

// Minimal express-ish res: the handler only ever calls .json() or .status().json().
function mkRes() {
  const out = { code: 200, body: null };
  const res = {
    status(c) { out.code = c; return res; },
    json(b) { out.body = b; return res; },
  };
  return { res, out };
}
const mkReq = (body) => ({ params: { id: String(SHIFT_ID) }, body, user: { id: ADMIN_ID, role: 'admin' } });

async function statusOf() {
  const r = await pool.query('SELECT status, location FROM shifts WHERE id = $1', [SHIFT_ID]);
  return r.rows[0];
}

async function cleanup() {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [PROPOSAL_ID]);
  await pool.query('DELETE FROM users WHERE id = $1', [ADMIN_ID]);
  await pool.query('DELETE FROM clients WHERE id = $1', [CLIENT_ID]);
}

before(async () => {
  await cleanup();
  await pool.query("INSERT INTO clients (id, name, email) VALUES ($1,'Status Guard','statusguard@example.com')", [CLIENT_ID]);
  await pool.query("INSERT INTO users (id, email, password_hash, role) VALUES ($1,'statusguard@example.com','x','admin')", [ADMIN_ID]);
  await pool.query(
    `INSERT INTO proposals (id, client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
     VALUES ($1,$2,CURRENT_DATE + 30,'18:00',4,'America/Chicago','confirmed','birthday-party')`,
    [PROPOSAL_ID, CLIENT_ID]
  );
});

beforeEach(async () => {
  await pool.query('DELETE FROM shifts WHERE id = $1', [SHIFT_ID]);
  await pool.query(
    `INSERT INTO shifts (id, event_date, start_time, end_time, status, location, positions_needed, proposal_id)
     VALUES ($1, CURRENT_DATE + 30, '6:00 PM', '10:00 PM', 'filled', 'Original Ave', '["Bartender"]', $2)`,
    [SHIFT_ID, PROPOSAL_ID]
  );
});

after(async () => { await cleanup(); await pool.end(); });

test('a PUT carrying status is REJECTED, and writes nothing', async () => {
  const { res } = mkRes();
  await assert.rejects(
    () => updateShiftHandler(mkReq({ status: 'cancelled', location: 'Should Not Land' }), res),
    (err) => {
      assert.equal(err.statusCode, 400, 'a rejected edit is a client error, not a 500');
      assert.equal(err.code, 'VALIDATION_ERROR');
      // ValidationError carries the per-field detail on `fieldErrors`, not
      // `message` — the message is the generic "Please fix the errors below".
      assert.ok(err.fieldErrors && err.fieldErrors.status,
        'the rejection must name the offending field, so the caller knows WHY');
      assert.match(err.fieldErrors.status, /not editable here/i);
      return true;
    }
  );
  const row = await statusOf();
  assert.equal(row.status, 'filled', 'status must be untouched');
  assert.equal(row.location, 'Original Ave',
    'and the whole edit must be rejected — a partial write would be worse than the bug');
});

test('the legal values are rejected too, including the dangerous one', async () => {
  // 'cancelled' passes the DB CHECK, so only this guard stops it. It is the one
  // that strikes a delivered event off the owner's Google Calendar.
  for (const status of ['cancelled', 'completed', 'open', 'filled']) {
    const { res } = mkRes();
    await assert.rejects(() => updateShiftHandler(mkReq({ status }), res),
      (err) => err.statusCode === 400, `PUT must reject status=${status}`);
  }
  assert.equal((await statusOf()).status, 'filled');
});

test('an ordinary edit with NO status still works', async () => {
  const { res, out } = mkRes();
  await updateShiftHandler(mkReq({ location: 'New Venue', notes: 'edited' }), res);
  assert.ok(out.body, 'the handler responded');
  const row = await statusOf();
  assert.equal(row.location, 'New Venue', 'the edit landed');
  assert.equal(row.status, 'filled', 'status is preserved, not nulled by the always-null bind');
});

test('the LEGITIMATE cancel path still sets cancelled', async () => {
  // The guard rejects status on the generic editor; it must not disarm the route
  // that actually owns cancellation.
  const { res } = mkRes();
  await cancelOrUnassignShiftHandler(
    { params: { id: String(SHIFT_ID) }, body: { mode: 'cancel' }, user: { id: ADMIN_ID, role: 'admin' } },
    res
  );
  assert.equal((await statusOf()).status, 'cancelled',
    'cancel-or-unassign still owns the cancelled transition');
});
