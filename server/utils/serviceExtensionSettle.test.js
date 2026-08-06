'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { settleExtension, closeExtension } = require('./serviceExtensionSettle');

const NONCE = `sxs-${Date.now()}`;
let clientId, pkgId, staffAId, staffBId;
const proposals = [];
const shifts = [];
const extensions = [];

async function mkEvent({ hours = 4, shiftCount = 1 } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'balance_paid',100,$3,1,350,350,'2026-09-12','8:00 PM','America/Chicago','{}')
     RETURNING id`,
    [clientId, pkgId, hours]
  );
  const proposalId = p.rows[0].id;
  proposals.push(proposalId);

  const madeShifts = [];
  for (let i = 0; i < shiftCount; i++) {
    const s = await pool.query(
      `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id,
                           event_duration_hours, positions_needed, client_name)
       VALUES ('2026-09-12','8:00 PM','12:00 AM','open',$1,$2,'["Bartender"]',$3)
       RETURNING id`,
      [proposalId, hours, `${NONCE} client`]
    );
    madeShifts.push(s.rows[0].id);
    shifts.push(s.rows[0].id);
  }
  return { proposalId, shiftId: madeShifts[0], allShiftIds: madeShifts };
}

async function assign(shiftId, userId) {
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1,$2,'approved','Bartender')`,
    [shiftId, userId]
  );
}

async function mkExtension({ proposalId, shiftId, requested = 4.5, contracted = 4, status = 'pending', gratuityCents = 0 }) {
  const r = await pool.query(
    `INSERT INTO service_extensions
       (proposal_id, shift_id, requested_by_user_id, contracted_duration_hours,
        requested_duration_hours, contracted_end_time, requested_end_time,
        amount_cents, gratuity_cents, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,'12:00 AM','12:30 AM',5000,$6,$7, NOW() + INTERVAL '1 hour')
     RETURNING id`,
    [proposalId, shiftId, staffAId, contracted, requested, gratuityCents, status]
  );
  extensions.push(r.rows[0].id);
  return r.rows[0].id;
}

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-core-reaction'");
  pkgId = p.rows[0].id;
  // users has NO `name` column and the password column is `password_hash`.
  // See "Test harness constraints" at the top of this plan.
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1,'x','staff','approved',0) RETURNING id`,
    [`${NONCE}-a@example.test`]
  );
  staffAId = a.rows[0].id;
  const b = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1,'x','staff','approved',0) RETURNING id`,
    [`${NONCE}-b@example.test`]
  );
  staffBId = b.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, hourly_rate)
     VALUES ($1,'3125550111',$2,40), ($3,'3125550112',$4,40)`,
    [staffAId, `${NONCE} A`, staffBId, `${NONCE} B`]
  );
});

after(async () => {
  if (extensions.length) await pool.query('DELETE FROM service_extensions WHERE id = ANY($1)', [extensions]);
  if (shifts.length) await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1)', [shifts]);
  if (shifts.length) await pool.query('DELETE FROM shifts WHERE id = ANY($1)', [shifts]);
  if (proposals.length) await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [proposals]);
  if (proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [proposals]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1)', [[staffAId, staffBId]]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[staffAId, staffBId]]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('paid settle bumps duration, syncs the shift, returns every assigned staffer', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  await assign(ev.shiftId, staffBId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId, gratuityCents: 2500 });

  const r = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.equal(r.ok, true);
  assert.equal(r.newDurationHours, 4.5);
  assert.equal(r.previousDurationHours, 4);
  assert.equal(r.newEndDisplay, '12:30 AM');
  assert.equal(r.gratuityCents, 2500);
  assert.deepEqual(r.staffUserIds.slice().sort((x, y) => x - y), [staffAId, staffBId].sort((x, y) => x - y));

  const prop = await pool.query(
    'SELECT event_duration_hours, total_price, amount_paid, status FROM proposals WHERE id = $1',
    [ev.proposalId]
  );
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5);
  // Side money: nothing else about the contract moved.
  assert.equal(Number(prop.rows[0].total_price), 350);
  assert.equal(Number(prop.rows[0].amount_paid), 350);
  assert.equal(prop.rows[0].status, 'balance_paid');

  const sh = await pool.query('SELECT event_duration_hours, end_time FROM shifts WHERE id = $1', [ev.shiftId]);
  assert.equal(Number(sh.rows[0].event_duration_hours), 4.5);
  assert.equal(sh.rows[0].end_time, '12:30 AM');

  const ext = await pool.query('SELECT status FROM service_extensions WHERE id = $1', [extId]);
  assert.equal(ext.rows[0].status, 'paid');

  const log = await pool.query(
    "SELECT action FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'extension_paid'",
    [ev.proposalId]
  );
  assert.equal(log.rowCount, 1);
});

test('a second settle on the same row loses the claim and changes nothing', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  assert.equal((await settleExtension({ extensionId: extId, outcome: 'paid' })).ok, true);
  const second = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'not_pending');

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5, 'must not double-bump');
});

test('override settles the same way and records who and why', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  const r = await settleExtension({
    extensionId: extId, outcome: 'overridden',
    actorUserId: staffBId, overrideReason: 'link never arrived',
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'overridden');

  const ext = await pool.query(
    'SELECT status, override_by_user_id, override_reason FROM service_extensions WHERE id = $1',
    [extId]
  );
  assert.equal(ext.rows[0].status, 'overridden');
  assert.equal(ext.rows[0].override_by_user_id, staffBId);
  assert.equal(ext.rows[0].override_reason, 'link never arrived');

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5);
});

test('a multi-shift event bumps the proposal but flags rather than guessing which shift', async () => {
  const ev = await mkEvent({ shiftCount: 2 });
  await assign(ev.allShiftIds[0], staffAId);
  await assign(ev.allShiftIds[1], staffBId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.allShiftIds[0] });

  const r = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.equal(r.ok, true);
  assert.equal(r.multiShift, true);

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5);
  // Neither shift was rewritten: the admin resolves a multi-shift event by hand.
  const sh = await pool.query('SELECT end_time FROM shifts WHERE proposal_id = $1', [ev.proposalId]);
  for (const row of sh.rows) assert.equal(row.end_time, '12:00 AM');
});

test('closeExtension expires without touching duration, and only once', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  const r = await closeExtension({ extensionId: extId, outcome: 'expired' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.staffUserIds, [staffAId]);

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4, 'expiry must not extend');

  assert.equal((await closeExtension({ extensionId: extId, outcome: 'expired' })).ok, false);
});

test('a settle cannot win after an expiry claimed the row', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  assert.equal((await closeExtension({ extensionId: extId, outcome: 'expired' })).ok, true);
  const late = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'not_pending');

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4);
});

test('a dropped staffer is not notified', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status, position, dropped_at) VALUES ($1,$2,'approved','Bartender',NOW())",
    [ev.shiftId, staffBId]
  );
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });
  const r = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.deepEqual(r.staffUserIds, [staffAId]);
});

test('a nonexistent extension id is a clean not_pending on both paths', async () => {
  // Pins the pre-claim early-return added with the closeExtension lock-order
  // fix: no proposal lock is taken, no claim attempted, typed refusal returned.
  const settled = await settleExtension({ extensionId: 999999999, outcome: 'paid' });
  assert.deepEqual(settled, { ok: false, reason: 'not_pending' });
  const closed = await closeExtension({ extensionId: 999999999, outcome: 'expired' });
  assert.deepEqual(closed, { ok: false, reason: 'not_pending' });
});

// ── The 2:00 AM insurance curfew, re-checked under the lock ────────────────
// A request is validated when created, but the duration it stores is only as
// good as the event it was measured against. These pin the last gate before
// the contract actually moves.

test('settle REFUSES when the event moved under a pending request, past the curfew', async () => {
  const ev = await mkEvent();                       // 8:00 PM, 4h -> ends midnight
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId, requested: 6, contracted: 4 });
  // Admin pushes the start later AFTER the request was created and validated:
  // 11:00 PM + 6h would end at 5:00 AM, well outside coverage.
  await pool.query("UPDATE proposals SET event_start_time = '11:00 PM' WHERE id = $1", [ev.proposalId]);

  const r = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.equal(r.ok, false, 'a booking outside liquor liability coverage must not settle');
  assert.equal(r.reason, 'past_curfew');
  assert.match(r.message, /2:00 AM/);
});

test('the refused request stays PENDING and the contract never moves', async () => {
  const ev = await mkEvent();
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId, requested: 6, contracted: 4 });
  await pool.query("UPDATE proposals SET event_start_time = '11:00 PM' WHERE id = $1", [ev.proposalId]);
  await settleExtension({ extensionId: extId, outcome: 'paid' });

  // The refusal runs BEFORE the claim on purpose. Claiming first would leave a
  // row marked settled on an event whose duration never moved — a split state
  // no sweep can reconcile. Pending is recoverable: the sweep expires it and
  // voids its invoice, exactly like a declined request.
  const { rows } = await pool.query('SELECT status FROM service_extensions WHERE id = $1', [extId]);
  assert.equal(rows[0].status, 'pending', 'still claimable, not stranded half-settled');
  const { rows: pr } = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(pr[0].event_duration_hours), 4, 'the contract is untouched');
});

test('settle still allows a request that ends exactly at the curfew', async () => {
  const ev = await mkEvent();
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId, requested: 6, contracted: 4 });
  // 8:00 PM + 6h = 2:00 AM exactly. Legal, and must not be caught by the guard.
  const r = await settleExtension({ extensionId: extId, outcome: 'paid' });
  assert.equal(r.ok, true);
  const { rows } = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(rows[0].event_duration_hours), 6);
});
