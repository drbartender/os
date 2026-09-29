require('dotenv').config();
// Read BEFORE the line below overwrites it: tested after, the production guard
// further down could never fire.
const LAUNCHED_AS = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';

/**
 * Remove (DELETE /shifts/requests/:id): two rules added 2026-09-29, lane ma-e2.
 *
 * 1. WHO. Staffing is an admin, or a manager WITH can_staff: the rule
 *    requireStaffing applies to every other staffing write. This route tested
 *    the role alone, so any manager could delete any request, an approved one
 *    included. A manager without can_staff is a staffer here: their own
 *    pending request and nothing else.
 *
 * 3. THE RECORD. A staffing removal writes one admin_audit_log entry, because
 *    the request and its queued messages are hard-deleted and nothing else
 *    says who removed whom. A person's own withdrawal writes none.
 *
 * 4. THE OWNER'S DELETE IS PENDING-ONLY IN THE STATEMENT ITSELF, so an approval
 *    that commits between the handler's check and its delete is not deleted.
 *
 * 2. THE QUEUE. Approving someone queues their day-before reminder and their
 *    thank-you, and nothing at send time checks that they are still on the
 *    shift. Remove deletes that person's PENDING reminder and thank-you for
 *    that shift and leaves every other row alone. Deleted, not suppressed: a
 *    suppressed row blocks the reminder of the same person assigned again.
 *
 * Harness mirrors shifts.removeReaccrue.test.js: express over real HTTP,
 * hand-signed JWTs. SHARED DEV DB DISCIPLINE: every fixture email matches
 * 'rmrm-%@example.com', the proposal's event_type is 'rmrm-fixture', and the
 * event is 400 days out, so no fixture message is ever due.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

// The spy must be installed BEFORE the router loads: shifts.js destructures
// reaccrueDutyForProposal out of serviceArea at require time.
const serviceArea = require('../utils/serviceArea');
const reaccrueCalls = [];
serviceArea.reaccrueDutyForProposal = (proposalId) => { reaccrueCalls.push(proposalId); };
const shiftsRouter = require('./shifts');

if (LAUNCHED_AS === 'production') {
  throw new Error('shifts.removeReminders.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = "email LIKE 'rmrm-%@example.com'";
const QUEUED = ['shift_reminder', 'staff_thank_you'];

let server, baseUrl;
let clientId, proposalId;
const who = {};      // tag -> user id
const token = {};    // tag -> JWT

function req(method, path, { as, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        'Content-Type': 'application/json',
        ...(as ? { Authorization: `Bearer ${token[as]}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = d ? JSON.parse(d) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function cleanup() {
  const uids = `(SELECT id FROM users WHERE ${EMAIL_LIKE})`;
  const props = `(SELECT id FROM proposals WHERE event_type = 'rmrm-fixture')`;
  const shifts = `(SELECT id FROM shifts WHERE proposal_id IN ${props})`;
  await pool.query(`DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id IN ${shifts}`);
  await pool.query(`DELETE FROM scheduled_messages WHERE recipient_type = 'staff' AND recipient_id IN ${uids}`);
  await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id IN ${uids} OR target_user_id IN ${uids}`);
  await pool.query(`DELETE FROM shift_requests WHERE shift_id IN ${shifts}`);
  await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id IN ${props}`);
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN ${props}`);
  await pool.query(`DELETE FROM proposals WHERE event_type = 'rmrm-fixture'`);
  await pool.query(`DELETE FROM clients WHERE email LIKE 'rmrm-%@example.com'`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN ${uids}`);
  await pool.query(`DELETE FROM users WHERE ${EMAIL_LIKE}`);
}

async function mkUser(tag, role, canStaff = false) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, can_staff, token_version)
     VALUES ($1, 'x', $2, 'approved', $3, 0) RETURNING id`,
    [`rmrm-${tag}-${NONCE}@example.com`, role, canStaff]
  );
  who[tag] = rows[0].id;
  token[tag] = jwt.sign({ userId: rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  if (role !== 'admin') {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, preferred_name, position) VALUES ($1, $2, 'bartender')`,
      [rows[0].id, `Rmrm ${tag}`]
    );
  }
  return rows[0].id;
}

async function mkShift() {
  const { rows } = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location, client_name, positions_needed)
     VALUES (CURRENT_DATE + 400, '18:00', '22:00', 'open', $1, '1 Test St', $2, '["Bartender","Bartender","Bartender"]'::jsonb)
     RETURNING id`,
    [proposalId, `RMRM ${NONCE}`]
  );
  return rows[0].id;
}

async function seed(shiftId, tag, status) {
  const { rows } = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, requested_positions)
     VALUES ($1, $2, $3, $4, '["Bartender"]') RETURNING id`,
    [shiftId, who[tag], status, status === 'approved' ? 'Bartender' : null]
  );
  return rows[0].id;
}

// Through the real route, so the queue holds what production queues.
async function assign(shiftId, tag) {
  const r = await req('POST', `/api/shifts/${shiftId}/assign`, { as: 'admin', body: { user_id: who[tag], position: 'Bartender' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

async function queue(shiftId, tag) {
  const { rows } = await pool.query(
    `SELECT message_type, status FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1 AND recipient_type = 'staff' AND recipient_id = $2
      ORDER BY message_type, status`,
    [shiftId, who[tag]]
  );
  return rows.map((r) => `${r.message_type}:${r.status}`);
}

async function audit(tag) {
  const { rows } = await pool.query(
    `SELECT actor_user_id, target_user_id, action, metadata FROM admin_audit_log
      WHERE target_user_id = $1 AND action = 'shift_request_removed' ORDER BY id`,
    [who[tag]]
  );
  return rows;
}

async function exists(requestId) {
  const { rows } = await pool.query('SELECT 1 FROM shift_requests WHERE id = $1', [requestId]);
  return rows.length === 1;
}

before(async () => {
  await cleanup();
  await mkUser('admin', 'admin');
  await mkUser('lead', 'manager', true);      // a manager WITH can_staff
  await mkUser('plain', 'manager', false);    // a manager without it
  await mkUser('ana', 'staff');
  await mkUser('ben', 'staff');

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [`RMRM ${NONCE}`, `rmrm-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 400, '18:00', 4, 'America/Chicago', 'confirmed', 'rmrm-fixture') RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/shifts', shiftsRouter);
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('[rmrm harness] unhandled:', err);
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await cleanup();
  await pool.end();
});

test('Remove takes that person\'s pending reminder and thank-you out of the queue, and nothing else', async () => {
  const shiftA = await mkShift();
  const shiftB = await mkShift();
  const anaOnA = await assign(shiftA, 'ana');
  await assign(shiftA, 'ben');
  await assign(shiftB, 'ana');
  // The real route queued both messages for each of them.
  assert.deepEqual(await queue(shiftA, 'ana'), ['shift_reminder:pending', 'staff_thank_you:pending']);
  assert.deepEqual(await queue(shiftA, 'ben'), ['shift_reminder:pending', 'staff_thank_you:pending']);
  // Two rows of Ana's on shift A that Remove must leave: one already sent, and
  // one of a kind Remove does not own.
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status, sent_at)
     VALUES ($1, 'shift', 'shift_reminder', 'staff', $2, 'email', NOW() + INTERVAL '399 days', 'sent', NOW()),
            ($1, 'shift', 'rmrm_other', 'staff', $2, 'sms', NOW() + INTERVAL '399 days', 'pending', NULL)`,
    [shiftA, who.ana]
  );
  reaccrueCalls.length = 0;

  const r = await req('DELETE', `/api/shifts/requests/${anaOnA}`, { as: 'admin' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.equal(await exists(anaOnA), false);
  assert.deepEqual(await queue(shiftA, 'ana'), ['rmrm_other:pending', 'shift_reminder:sent']);
  assert.deepEqual(await queue(shiftA, 'ben'), ['shift_reminder:pending', 'staff_thank_you:pending'], 'a teammate on the same shift');
  assert.deepEqual(await queue(shiftB, 'ana'), ['shift_reminder:pending', 'staff_thank_you:pending'], 'the same person on another shift');
  // The payroll hook still runs.
  assert.deepEqual(reaccrueCalls, [proposalId]);
});

test('a person removed and then assigned again gets the reminder again', async () => {
  const shiftId = await mkShift();
  const first = await assign(shiftId, 'ana');
  assert.equal((await req('DELETE', `/api/shifts/requests/${first}`, { as: 'admin' })).status, 200);
  assert.deepEqual(await queue(shiftId, 'ana'), []);
  await assign(shiftId, 'ana');
  assert.deepEqual(await queue(shiftId, 'ana'), ['shift_reminder:pending', 'staff_thank_you:pending']);
});

test('a manager WITH can_staff removes an approved person, queue included', async () => {
  const shiftId = await mkShift();
  const requestId = await assign(shiftId, 'ana');
  const r = await req('DELETE', `/api/shifts/requests/${requestId}`, { as: 'lead' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await exists(requestId), false);
  assert.deepEqual(await queue(shiftId, 'ana'), []);
});

test('a manager WITHOUT can_staff cannot delete anyone else\'s request, approved or pending', async () => {
  const shiftId = await mkShift();
  const approved = await assign(shiftId, 'ana');
  const pending = await seed(shiftId, 'ben', 'pending');
  reaccrueCalls.length = 0;
  for (const requestId of [approved, pending]) {
    const r = await req('DELETE', `/api/shifts/requests/${requestId}`, { as: 'plain' });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(await exists(requestId), true, 'the request is still there');
  }
  assert.deepEqual(await queue(shiftId, 'ana'), ['shift_reminder:pending', 'staff_thank_you:pending']);
  assert.deepEqual(reaccrueCalls, [], 'payroll was not touched');
});

test('a manager WITHOUT can_staff is a staffer here: their own pending request goes, their own approved one does not', async () => {
  const shiftA = await mkShift();
  const shiftB = await mkShift();
  const pending = await seed(shiftA, 'plain', 'pending');
  const approved = await seed(shiftB, 'plain', 'approved');

  const own = await req('DELETE', `/api/shifts/requests/${pending}`, { as: 'plain' });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(await exists(pending), false);

  const held = await req('DELETE', `/api/shifts/requests/${approved}`, { as: 'plain' });
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, 'already_approved');
  assert.equal(await exists(approved), true);
});

test('staff still withdraw their own pending request, and only their own', async () => {
  const shiftId = await mkShift();
  const mine = await seed(shiftId, 'ana', 'pending');
  const theirs = await seed(shiftId, 'ben', 'pending');
  assert.equal((await req('DELETE', `/api/shifts/requests/${theirs}`, { as: 'ana' })).status, 403);
  assert.equal(await exists(theirs), true);
  assert.equal((await req('DELETE', `/api/shifts/requests/${mine}`, { as: 'ana' })).status, 200);
  assert.equal(await exists(mine), false);
});

test('a staffing removal is recorded: who, whom, which request, which shift, in what state', async () => {
  const shiftId = await mkShift();
  const requestId = await assign(shiftId, 'ben');
  const before = (await audit('ben')).length;
  assert.equal((await req('DELETE', `/api/shifts/requests/${requestId}`, { as: 'lead' })).status, 200);
  const rows = await audit('ben');
  assert.equal(rows.length, before + 1);
  const entry = rows[rows.length - 1];
  assert.equal(entry.actor_user_id, who.lead);
  assert.equal(entry.target_user_id, who.ben);
  assert.deepEqual(entry.metadata, {
    request_id: requestId, shift_id: shiftId, proposal_id: proposalId, status: 'approved', position: 'Bartender',
  });
});

test('the record survives a failure in a later step of the removal', async () => {
  const shiftId = await mkShift();
  const requestId = await assign(shiftId, 'ben');
  const before = (await audit('ben')).length;
  // The queue cleanup fails once: the handler answers 500 with the request gone.
  const realQuery = pool.query.bind(pool);
  let armed = true;
  pool.query = async (text, params) => {
    if (armed && typeof text === 'string' && /^\s*DELETE FROM scheduled_messages/.test(text)) {
      armed = false;
      throw new Error('rmrm: induced failure');
    }
    return realQuery(text, params);
  };
  const log = console.error;
  console.error = () => {};            // the harness prints the induced error
  let r;
  try {
    r = await req('DELETE', `/api/shifts/requests/${requestId}`, { as: 'admin' });
  } finally {
    pool.query = realQuery;
    console.error = log;
  }
  assert.equal(armed, false, 'the queue cleanup ran');
  assert.equal(r.status, 500);
  assert.equal(await exists(requestId), false);
  const rows = await audit('ben');
  assert.equal(rows.length, before + 1, 'the removal is on record');
  assert.equal(rows[rows.length - 1].metadata.request_id, requestId);
  assert.equal(rows[rows.length - 1].actor_user_id, who.admin);
});

test('a record that cannot be written costs the removal nothing: the lock, payroll and the queue still run', async () => {
  const shiftId = await mkShift();
  const requestId = await assign(shiftId, 'ben');
  assert.deepEqual(await queue(shiftId, 'ben'), ['shift_reminder:pending', 'staff_thank_you:pending']);
  // The worst the logger can meet: its INSERT rejects with no error object at
  // all, so its own catch throws reading the message.
  const realQuery = pool.query.bind(pool);
  let armed = true;
  pool.query = (text, params) => {
    if (armed && typeof text === 'string' && /INSERT INTO admin_audit_log/.test(text)) {
      armed = false;
      // eslint-disable-next-line prefer-promise-reject-errors
      return Promise.reject(undefined);
    }
    return realQuery(text, params);
  };
  const log = console.error;
  console.error = () => {};
  reaccrueCalls.length = 0;
  let r;
  try {
    r = await req('DELETE', `/api/shifts/requests/${requestId}`, { as: 'admin' });
  } finally {
    pool.query = realQuery;
    console.error = log;
  }
  assert.equal(armed, false, 'the logger ran');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await exists(requestId), false);
  assert.deepEqual(reaccrueCalls, [proposalId], 'payroll re-accrued');
  assert.deepEqual(await queue(shiftId, 'ben'), [], 'the queue was cleared');
});

test('the record names the request that was deleted, whatever form the path id took', async (t) => {
  // Postgres 16 and later read 1_01 as the integer 101. Number('1_01') is NaN.
  const probe = await pool.query("SELECT '1_0'::text AS form").then(
    (x) => pool.query('SELECT $1::int AS n', [x.rows[0].form]).then((y) => y.rows[0].n, () => null)
  );
  if (probe !== 10) { t.skip('this database does not read an underscore in an integer'); return; }
  const shiftId = await mkShift();
  const requestId = await assign(shiftId, 'ben');
  // A leading 0_ reads as the same integer whatever its length (`_7` does not).
  const spelled = `0_${requestId}`;
  const r = await req('DELETE', `/api/shifts/requests/${spelled}`, { as: 'admin' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await exists(requestId), false);
  const rows = await audit('ben');
  assert.equal(rows[rows.length - 1].metadata.request_id, requestId);
});

test('a person\'s own withdrawal, and a refused removal, write no record', async () => {
  const shiftId = await mkShift();
  const mine = await seed(shiftId, 'ana', 'pending');
  const theirs = await seed(shiftId, 'ben', 'pending');
  const before = [(await audit('ana')).length, (await audit('ben')).length];
  assert.equal((await req('DELETE', `/api/shifts/requests/${mine}`, { as: 'ana' })).status, 200);
  assert.equal((await req('DELETE', `/api/shifts/requests/${theirs}`, { as: 'plain' })).status, 403);
  assert.deepEqual([(await audit('ana')).length, (await audit('ben')).length], before);
});

test('an approval that lands between the owner\'s check and the owner\'s delete is not deleted', async () => {
  const shiftId = await mkShift();
  const requestId = await seed(shiftId, 'ana', 'pending');
  // The handler has read the row as pending. Approve it just before its DELETE
  // runs: the one place the two statements can be pulled apart from outside.
  const realQuery = pool.query.bind(pool);
  let armed = true;
  pool.query = async (text, params) => {
    if (armed && typeof text === 'string' && /^DELETE FROM shift_requests WHERE id = \$1 AND user_id = \$2/.test(text)) {
      armed = false;
      await realQuery("UPDATE shift_requests SET status = 'approved', position = 'Bartender' WHERE id = $1", [params[0]]);
    }
    return realQuery(text, params);
  };
  reaccrueCalls.length = 0;
  let r;
  try {
    r = await req('DELETE', `/api/shifts/requests/${requestId}`, { as: 'ana' });
  } finally {
    pool.query = realQuery;
  }
  assert.equal(armed, false, 'the owner delete ran');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'request_changed');
  const row = await pool.query('SELECT status FROM shift_requests WHERE id = $1', [requestId]);
  assert.equal(row.rows[0].status, 'approved', 'the approval stands');
  assert.deepEqual(reaccrueCalls, [], 'nothing after the delete ran');
});

test('no token, no delete', async () => {
  const shiftId = await mkShift();
  const requestId = await seed(shiftId, 'ana', 'pending');
  const r = await req('DELETE', `/api/shifts/requests/${requestId}`);
  assert.equal(r.status, 401);
  assert.equal(await exists(requestId), true);
});
