require('dotenv').config();

// listUpcomingEvents (spec 2026-11-19 laws 1, 4 and 10, section 7.3): the
// phone Events list's own query with a date window and the legal-hold
// exclusion on. The phone list itself (no window) is pinned by
// routes/shifts.adminScoped.test.js and its SQL text by
// routes/shifts.queries.pin.test.js. The held booking is synthetic (added
// through __setLegalHoldIdsForTest) and the held client ids come from
// holdExclusion() over a db that drops the real held ids before it queries.
//
// The fixtures sit in March 2033, far from any real event, and every assert
// reads this suite's own shift ids. Shared dev DB (run through
// scripts/run-suites.js); fixtures are deleted by recorded id in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../../db');
const { holdExclusion, __setLegalHoldIdsForTest } = require('../legalHold');
const { LEGAL_HOLD_PROPOSAL_IDS } = require('../staleProposalSweep');
const { listUpcomingEvents } = require('./upcomingEvents');

if (process.env.NODE_ENV === 'production') throw new Error('upcomingEvents.test.js refuses to run against production');

const RUN = `rd-ue-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const TAG = `EventsPin ${crypto.randomBytes(4).toString('hex')}`;
const made = { users: [], clients: [], proposals: [], shifts: [] };
const S = {};
const fx = {};
const REAL_HELD = new Set(LEGAL_HOLD_PROPOSAL_IDS.map(Number));
const syntheticOnly = { query: (sql, [ids]) => pool.query(sql, [ids.filter((id) => !REAL_HELD.has(id))]) };
const WINDOW = { start: '2033-03-07', end: '2033-03-13' };
const NONE = { proposalIds: [], clientIds: [] }; // an explicit empty exclusion

async function client(tag) {
  const { rows: [c] } = await pool.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id', [`${TAG} ${tag}`, `${RUN}-${tag}@example.test`]);
  made.clients.push(c.id);
  return c.id;
}
async function proposal(clientId, date, guests = 100) {
  const { rows: [p] } = await pool.query(
    "INSERT INTO proposals (client_id, status, event_date, guest_count, event_type) VALUES ($1, 'confirmed', $2, $3, 'wedding-reception') RETURNING id",
    [clientId, date, guests]
  );
  made.proposals.push(p.id);
  return p.id;
}
async function shift(key, { date, proposalId = null, positions = '["Bartender"]', status = 'open', clientName = null }) {
  const { rows: [s] } = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed, proposal_id)
     VALUES ($1::date, '18:00', '23:00', $2, '1 Test St', $3, $4, $5) RETURNING id`,
    [date, status, clientName, positions, proposalId]
  );
  made.shifts.push(s.id);
  S[key] = s.id;
  return s.id;
}

before(async () => {
  const hash = await bcrypt.hash('x', 4);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
    [`${RUN}-staff@example.test`, hash]
  );
  made.users.push(u.id);
  fx.free = await client('free');
  fx.held = await client('held');
  // 250 guests on a two-slot roster: the open slots are the roster's, never a guest ratio.
  const a = await proposal(fx.free, '2033-03-08', 250);
  await shift('open', { date: '2033-03-08', proposalId: a, positions: '["Bartender","Barback"]' });
  const b = await proposal(fx.free, '2033-03-09');
  await shift('filled', { date: '2033-03-09', proposalId: b });
  await pool.query("INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')", [S.filled, u.id]);
  await shift('manual', { date: '2033-03-10', clientName: `${TAG} Manual` });
  await shift('cancelled', { date: '2033-03-10', proposalId: a, status: 'cancelled' });
  await shift('outside', { date: '2033-03-20', proposalId: b });
  fx.heldBooking = await proposal(fx.held, '2033-03-11');
  await shift('held', { date: '2033-03-11', proposalId: fx.heldBooking });
  fx.heldOther = await proposal(fx.held, '2033-03-12');
  await shift('heldOther', { date: '2033-03-12', proposalId: fx.heldOther });
  __setLegalHoldIdsForTest([fx.heldBooking]);
  fx.exclude = await holdExclusion(syntheticOnly);
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (made.shifts.length) {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])', [made.shifts]);
    await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [made.shifts]);
  }
  if (made.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  if (made.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [made.users]);
  await pool.end();
});

const mine = (rows) => rows.filter((r) => made.shifts.includes(r.id));
const keyOf = (id) => Object.keys(S).find((k) => S[k] === id);

test('the window: every live shift in it, in event order; cancelled and outside absent', async () => {
  const { rows } = await listUpcomingEvents({ ...WINDOW, limit: 200, exclude: NONE });
  assert.deepEqual(mine(rows).map((r) => keyOf(r.id)), ['open', 'filled', 'manual', 'held', 'heldOther']);
});

test('under the exclusion the held proposal\'s shift and its client\'s other booking are absent', async () => {
  assert.deepEqual(fx.exclude.clientIds, [fx.held]);
  const { rows } = await listUpcomingEvents({ ...WINDOW, limit: 200, exclude: fx.exclude });
  assert.deepEqual(mine(rows).map((r) => keyOf(r.id)), ['open', 'filled', 'manual']);
});

test('staffing from the shift rows: open is flagged with its open slots by role; filled is present with the flag off', async () => {
  const { rows } = await listUpcomingEvents({ ...WINDOW, limit: 200, exclude: fx.exclude });
  const by = new Map(mine(rows).map((r) => [keyOf(r.id), r]));
  const open = by.get('open');
  assert.deepEqual([open.needs_staff, open.open_slots, open.approved_count, open.positions_needed, open.proposal_guest_count],
    [true, 2, '0', '["Bartender","Barback"]', 250]);
  const filled = by.get('filled');
  assert.deepEqual([filled.needs_staff, filled.open_slots, filled.approved_count, filled.approved_by_role], [false, 0, '1', { Bartender: 1 }]);
  for (const r of mine(rows)) assert.equal(typeof r.needs_staff, 'boolean');
});

test('a hand-made shift with no proposal carries the client name on the shift', async () => {
  const { rows } = await listUpcomingEvents({ ...WINDOW, limit: 200, exclude: NONE });
  const manual = mine(rows).find((r) => r.id === S.manual);
  assert.deepEqual([manual.proposal_id, manual.client_name, manual.event_key], [null, `${TAG} Manual`, `s${S.manual}`]);
  const open = mine(rows).find((r) => r.id === S.open);
  assert.equal(open.client_name, `${TAG} free`, 'a booked shift carries its client');
});

test('rows page by event, the window keys stripped; bad bounds throw', async () => {
  const one = await listUpcomingEvents({ start: '2033-03-08', end: '2033-03-09', limit: 1, exclude: NONE });
  assert.deepEqual(mine(one.rows).map((r) => keyOf(r.id)), ['open']);
  assert.equal(one.has_more, true);
  for (const r of one.rows) {
    for (const k of ['event_rank', 'event_first_date', 'event_last_date', 'total_events', 'scope_events', 'needs_staff_events']) assert.ok(!(k in r), k);
  }
  for (const bad of [{ start: '2033-3-07', end: '2033-03-13' }, { start: '2033-02-30', end: '2033-03-13' }, { start: '2033-03-13', end: '2033-03-07' }, {}]) {
    await assert.rejects(listUpcomingEvents({ ...bad, exclude: NONE }), TypeError, JSON.stringify(bad));
  }
  await assert.rejects(listUpcomingEvents({ ...WINDOW, exclude: { proposalIds: [], clientIds: [null] } }), TypeError);
});

test('fails closed: a missing exclusion throws, a malformed one throws, an explicit empty one answers', async () => {
  for (const args of [{ ...WINDOW }, { ...WINDOW, exclude: undefined }, { ...WINDOW, exclude: null }, { ...WINDOW, excluded: fx.exclude }]) {
    await assert.rejects(listUpcomingEvents(args), /pass the hold exclusion/, JSON.stringify(Object.keys(args)));
  }
  for (const bad of [{}, { proposalIds: [] }, { proposalIds: [], clientIds: 'all' }, [fx.heldBooking]]) {
    await assert.rejects(listUpcomingEvents({ ...WINDOW, exclude: bad }), TypeError, JSON.stringify(bad));
  }
  const { rows } = await listUpcomingEvents({ ...WINDOW, limit: 200, exclude: NONE });
  assert.ok(mine(rows).some((r) => r.id === S.held), 'an explicit empty exclusion leaves the rows in');
});
