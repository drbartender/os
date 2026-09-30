require('dotenv').config();

// Route-level tests for GET /api/admin/lead-call-attention (admin/leadCalls.js).
// Harness mirrors settings.badgeCounts.test.js: minimal express() app with the
// real router + real auth/role middleware. Run ALONE (shared dev DB).
//
// Since 2026-08-25 the endpoint is a UNION over lead_call_attempts and
// consult_call_attempts, tagged with a `kind` column. The lead half is
// unchanged. The consult half is narrowed the same way (faults only) and
// cleared by the CONSULT leaving 'scheduled', never by its slot passing:
// see ruling S-R2 and the fixture table below.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const leadCallsRouter = require('./leadCalls');

let server;
let baseUrl;
let adminToken;
let managerToken;
let staffToken;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_PREFIX = 'lead-call-attention-test-';
const RUN = `lca-test-${NONCE}`;

// Consult fixtures are deleted by RECORDED ID, never by a name or token pattern:
// this is the SHARED dev database and the consult feature is armed in prod against
// a different one. Nothing here removes a row this file did not insert.
const consultIds = [];
const consultAttemptIds = [];

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function makeUser(role) {
  const passwordHash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, $3, 'approved', 0) RETURNING id, token_version`,
    [`${EMAIL_PREFIX}${role}-${NONCE}@example.com`, passwordHash, role]
  );
  return r.rows[0];
}

function tokenFor(u) {
  return jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function makeLead(i, leadStatus = 'new') {
  const r = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, customer_name, customer_phone, status, raw_payload)
     VALUES ($1, $2, '+17735550100', $3, '{}'::jsonb) RETURNING id`,
    [`${RUN}-${i}`, `Attention Lead ${i}`, leadStatus]
  );
  return r.rows[0].id;
}

async function makeAttempt(leadId, status, ageDays = 0, detail = null) {
  const r = await pool.query(
    `INSERT INTO lead_call_attempts (lead_id, status, detail, created_at)
     VALUES ($1, $2, $3, NOW() - ($4 || ' days')::interval) RETURNING id`,
    [leadId, status, detail, ageDays]
  );
  return Number(r.rows[0].id);
}

// Seed one consult and its single attempt, placed the way PRODUCTION places them.
// writtenDaysAgo is how long ago the attempt row was written. slotSec is where the
// slot sat RELATIVE TO THAT WRITE, which is what the chain code actually decides:
// ring 1 fires at slot-90s, advanceChain refuses to ring past slot+600s, the open
// sweep covers slots in [now-3min, now+5min] and the missed-window sweep covers
// [now-30min, now-3min]. Anchoring the slot to the write rather than to NOW() is
// the whole point of the helper: a fault written yesterday has a slot that is now
// a day in the past, and ruling S-R2 says that must NOT retire the item.
async function seedConsultFault(key, {
  status, detail = null, writtenDaysAgo = 0, slotSec = 0,
  consultStatus = 'scheduled', bookerName,
} = {}) {
  const c = await pool.query(
    `INSERT INTO consults (client_id, proposal_id, scheduled_at, calcom_event_id, status, booker_name, booker_phone)
     VALUES (NULL, NULL,
             NOW() - ($1 || ' days')::interval + ($2 || ' seconds')::interval,
             $3, $4, $5, '+17735550199')
     RETURNING id`,
    [writtenDaysAgo, slotSec, `${RUN}-consult-${key}`, consultStatus,
      bookerName === undefined ? `Attention Booker ${key}` : bookerName]
  );
  const consultId = c.rows[0].id;
  consultIds.push(consultId);

  // consult_call_attempts is one row per (consult, slot) and UNIQUE on that pair,
  // so the attempt takes its consult's slot verbatim.
  const a = await pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, detail, created_at)
     SELECT c.id, c.scheduled_at, $2, $3, NOW() - ($4 || ' days')::interval
       FROM consults c WHERE c.id = $1
     RETURNING id`,
    [consultId, status, detail, writtenDaysAgo]
  );
  const attemptId = Number(a.rows[0].id);
  consultAttemptIds.push(attemptId);
  return { attemptId, consultId };
}

// Bulk version for the S-R1 starvation case: `count` chain-open cap trips, all
// written NOW, which is what a stranger hammering the public booking page produces.
//
// ONE statement, so the consults and their attempt rows commit together. Their slots
// sit inside the sweep's open window, [now-3min, now+5min], because that is where a
// chain-open cap trip really happens; seeding the two tables in separate statements
// would leave a gap in which a sweep tick could open REAL chains against consults
// that momentarily have none. Schedulers default off on this box, but a fixture
// should not depend on that to be safe.
async function seedConsultFlood(key, count) {
  const r = await pool.query(
    `WITH seeded AS (
       INSERT INTO consults (client_id, proposal_id, scheduled_at, calcom_event_id,
                             status, booker_name, booker_phone)
       SELECT NULL, NULL, NOW() + INTERVAL '3 minutes', $1 || '-' || g, 'scheduled',
              'Attention Booker ' || $2 || '-' || g, '+17735550199'
         FROM generate_series(1, $3::int) g
       RETURNING id, scheduled_at
     )
     INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, detail, created_at)
     SELECT id, scheduled_at, 'skipped_cap', 'cap_tripped', NOW() FROM seeded
     RETURNING id, consult_id`,
    [`${RUN}-consult-${key}`, key, count]
  );
  consultIds.push(...r.rows.map((x) => x.consult_id));
  const attemptIds = r.rows.map((x) => Number(x.id));
  consultAttemptIds.push(...attemptIds);
  return new Set(attemptIds);
}

before(async () => {
  adminToken = tokenFor(await makeUser('admin'));
  managerToken = tokenFor(await makeUser('manager'));
  staffToken = tokenFor(await makeUser('staff'));

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', leadCallsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  await new Promise((r) => server.close(r));
  if (consultAttemptIds.length) {
    await pool.query(`DELETE FROM consult_call_attempts WHERE id = ANY($1::bigint[])`, [consultAttemptIds]);
  }
  if (consultIds.length) {
    await pool.query(`DELETE FROM consults WHERE id = ANY($1::int[])`, [consultIds]);
  }
  await pool.query(`DELETE FROM thumbtack_leads WHERE negotiation_id LIKE $1`, [`${RUN}-%`]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  await pool.end();
});

test('returns open FAULT rows with the join fields, newest first (2026-07-20: faults only)', async () => {
  const failedId = await makeAttempt(await makeLead('failed'), 'failed', 0, 'cap_tripped');
  const badPhoneId = await makeAttempt(await makeLead('badphone'), 'skipped_invalid_phone', 1, 'no_phone');
  const res = await get('/api/admin/lead-call-attention', adminToken);
  assert.equal(res.status, 200);
  const mine = res.body.filter((r) => (r.customer_name || '').startsWith('Attention Lead'));
  assert.deepEqual(mine.map((r) => Number(r.id)), [failedId, badPhoneId], 'newest first');
  const row = mine[0];
  for (const k of ['id', 'kind', 'status', 'detail', 'created_at', 'customer_name', 'proposal_id', 'client_id']) {
    assert.ok(k in row, `field ${k}`);
  }
  assert.deepEqual([...new Set(mine.map((r) => r.kind))], ['lead'], 'lead rows are tagged kind=lead');
});

test('excludes missed, after-hours, connected, stale rows past 7 days, and non-new leads', async () => {
  // Missed and after-hours are deliberate NON-items (2026-07-20 per Dallas):
  // the moment has passed; follow-up rides the normal email/SMS pipeline.
  await makeAttempt(await makeLead('missed'), 'missed');
  await makeAttempt(await makeLead('ah'), 'skipped_after_hours');
  await makeAttempt(await makeLead('conn'), 'connected');
  await makeAttempt(await makeLead('old'), 'failed', 8);
  await makeAttempt(await makeLead('contacted', 'contacted'), 'failed');
  const res = await get('/api/admin/lead-call-attention', adminToken);
  const names = res.body.map((r) => r.customer_name);
  assert.ok(!names.includes('Attention Lead missed'), 'missed is not an attention item');
  assert.ok(!names.includes('Attention Lead ah'), 'after-hours is not an attention item');
  assert.ok(!names.includes('Attention Lead conn'), 'connected excluded');
  assert.ok(!names.includes('Attention Lead old'), '7-day cutoff');
  assert.ok(!names.includes('Attention Lead contacted'), 'lead no longer new clears the item');
});

// Every consult fault, placed where the chain code actually writes it. Read off
// consultCallChain.js and consultCallSweep.js, not guessed. Six of the eight sit on
// a slot that has ALREADY PASSED by the time the feed is read. Two of those can only
// ever be written after the slot (failed/too_late and skipped_missed_window) and one
// more is path-dependent (the VA-leg failure via the ring-3 hop); the other three are
// past because they were written days ago, which is the ordinary state of anything
// waiting in a seven-day feed. That is why ruling S-R2 forbids a scheduled_at > NOW()
// filter: it would take six of these eight.
const CONSULT_FAULT_FIXTURES = [
  // advanceChain refuses to ring past slot+TOO_LATE_ADMIN_SEC (600), so this row
  // can only exist with the slot already behind it.
  { key: 'toolate', status: 'failed', detail: 'too_late', slotSec: -900, writtenDaysAgo: 0 },
  // The VA-leg failure carries a raw Twilio error code in detail, written by
  // placeLeg's catch at the ring-3 hop. RING_OFFSETS_SEC[3] is 180, so that hop
  // runs at slot+180s and the slot is already behind it. Path-dependent, not by
  // construction: the same status is reachable at ring 1 when ADMIN_PHONE is unset.
  { key: 'valeg', status: 'failed', detail: '13224', slotSec: -180, writtenDaysAgo: 1 },
  // The missed-window sweep covers slots 3 to 30 minutes behind. Past by definition.
  { key: 'window', status: 'skipped_missed_window', detail: null, slotSec: -600, writtenDaysAgo: 0 },
  // CORRECTED: this is NOT written on the Zul hop after the slot. Its one writer is
  // advanceChain's ADMIN_PHONE-unset branch, where Zul takes the call directly, and
  // that runs at ring 1: ninety seconds BEFORE the slot. The ring-3 hop files no cap
  // marker at all, falling through to finishMissed so Dallas still gets the text.
  { key: 'vacap', status: 'skipped_cap', detail: 'va_leg_cap_tripped', slotSec: 90, writtenDaysAgo: 0 },
  // The dial cap is checked at ring time, and ring 1 fires at slot-90s.
  { key: 'dialcap', status: 'skipped_cap', detail: 'dial_cap_tripped', slotSec: 90, writtenDaysAgo: 1 },
  // openChain's cap, the DOMINANT detail: what a stranger hammering the public
  // booking page hits first. The open sweep covers slots up to 5 minutes ahead.
  { key: 'chaincap', status: 'skipped_cap', detail: 'cap_tripped', slotSec: 180, writtenDaysAgo: 2 },
  // Also ring 1, at slot-90s, and it emails NOTHING, so this feed is its ONLY
  // surface. Aged on purpose: under the old filter a row like this was visible for
  // about ninety seconds and then gone forever.
  { key: 'unconf', status: 'skipped_unconfigured', detail: null, slotSec: 90, writtenDaysAgo: 3 },
  // The Cal.com webhook post-commit tail writes this at BOOKING time, so its slot
  // is typically hours or weeks out. The one fault still sitting ahead of its slot.
  { key: 'badphone', status: 'skipped_invalid_phone', detail: 'no_phone', slotSec: 4 * 3600, writtenDaysAgo: 0 },
];

test('every consult fault surfaces as kind=consult, including the ones whose slot has passed (S-R2)', async () => {
  const seeded = [];
  for (const f of CONSULT_FAULT_FIXTURES) seeded.push([f, await seedConsultFault(f.key, f)]);

  const res = await get('/api/admin/lead-call-attention', adminToken);
  assert.equal(res.status, 200);
  const mine = res.body.filter((r) => r.kind === 'consult');
  const ids = new Set(mine.map((r) => Number(r.id)));
  for (const [f, s] of seeded) {
    assert.ok(ids.has(s.attemptId),
      `${f.status}${f.detail ? '/' + f.detail : ''} surfaces (slot ${f.slotSec}s from write, written ${f.writtenDaysAgo}d ago)`);
  }

  // The guard is only worth having if the fixtures really do sit past their slots,
  // so prove that from the database rather than from the comment above. TWO are still
  // ahead: badphone, written at booking time with the slot hours out, and vacap,
  // written ninety seconds before its slot and read back in the same second. The
  // other six are past, so re-adding scheduled_at > NOW() silently takes six of the
  // eight and the loop above is what catches it.
  //
  // The expected count is DERIVED from the fixture table rather than typed, so moving
  // a fixture cannot leave a stale number behind, and the floor below is what stops
  // the table drifting into fixtures that all sit in the future.
  const expectedAhead = CONSULT_FAULT_FIXTURES
    .filter((f) => f.slotSec - f.writtenDaysAgo * 86400 > 0)
    .map((f) => f.key).sort();
  assert.deepEqual(expectedAhead, ['badphone', 'vacap'], 'the table places exactly two slots ahead');
  const ahead = await pool.query(
    `SELECT count(*)::int AS n FROM consults
      WHERE id = ANY($1::int[]) AND scheduled_at > NOW()`,
    [seeded.map(([, s]) => s.consultId)]
  );
  assert.equal(ahead.rows[0].n, expectedAhead.length, 'the database agrees with the fixture table');
  assert.ok(CONSULT_FAULT_FIXTURES.length - expectedAhead.length >= 6,
    'at least six fixtures sit past their slot, so the S-R2 guard keeps its teeth');

  // skipped_cap is the one fault class a STRANGER can trigger: the Cal.com booking
  // page is public. All THREE cap details ride through untouched so the client can
  // tell the chain-open cap, the dial cap and the international-leg cap apart.
  const detailOf = (key) => {
    const [, s] = seeded.find(([f]) => f.key === key);
    return mine.find((r) => Number(r.id) === s.attemptId);
  };
  assert.equal(detailOf('chaincap').detail, 'cap_tripped');
  assert.equal(detailOf('dialcap').detail, 'dial_cap_tripped');
  assert.equal(detailOf('vacap').detail, 'va_leg_cap_tripped');
  assert.deepEqual(
    [...new Set([detailOf('chaincap').status, detailOf('dialcap').status, detailOf('vacap').status])],
    ['skipped_cap'], 'all three cap details land on the one status');
  // detail is diagnostic, not an enum: a failed calls.create writes a raw Twilio code.
  assert.equal(detailOf('valeg').detail, '13224');

  const row = detailOf('chaincap');
  assert.equal(row.customer_name, 'Attention Booker chaincap', 'booker_name lands in customer_name');
  for (const k of ['id', 'kind', 'status', 'detail', 'created_at', 'customer_name', 'proposal_id', 'client_id']) {
    assert.ok(k in row, `field ${k}`);
  }
  assert.equal(Object.keys(row).length, 8, 'both halves project the same eight columns');

  // booker_name is nullable (Cal.com does not guarantee it), and a nameless booker
  // is still a fault worth seeing. The join must not quietly drop the row.
  const nameless = await seedConsultFault('nameless',
    { status: 'failed', detail: 'too_late', slotSec: -900, bookerName: null });
  const after2 = await get('/api/admin/lead-call-attention', adminToken);
  const namelessRow = after2.body.find((r) => r.kind === 'consult' && Number(r.id) === nameless.attemptId);
  assert.ok(namelessRow, 'a consult with no booker_name still surfaces');
  assert.equal(namelessRow.customer_name, null);
});

test('consult exclusions: the consult leaving scheduled, the non-fault statuses, the 7-day cutoff', async () => {
  // A live control in the SAME response. Without it every assertion below would
  // still pass if the consult half were deleted outright, which proves nothing.
  await seedConsultFault('control', { status: 'failed', detail: 'too_late', slotSec: -900 });

  // The consult's own status is the ONLY clearing mechanism (S-R2). Seeded at BOTH
  // slot positions so nobody can mistake the clearing for a slot rule: completed and
  // no_show can only happen after the slot, a cancellation usually lands before it.
  await seedConsultFault('completed', { status: 'failed', consultStatus: 'completed', slotSec: -3600 });
  await seedConsultFault('no_show', { status: 'failed', consultStatus: 'no_show', slotSec: -3600 });
  await seedConsultFault('cancelled', { status: 'failed', consultStatus: 'cancelled', slotSec: 4 * 3600 });

  // Non-fault attempt statuses, each placed where the chain writes it.
  const NON_FAULTS = [
    { key: 'st-missed', status: 'missed', slotSec: -300 },
    { key: 'st-skipped_cancelled', status: 'skipped_cancelled', slotSec: 3600 },
    { key: 'st-skipped_disabled', status: 'skipped_disabled', slotSec: 180 },
    { key: 'st-connected', status: 'connected', slotSec: -60 },
    { key: 'st-pending', status: 'pending', slotSec: 180 },
  ];
  for (const f of NON_FAULTS) await seedConsultFault(f.key, f);
  await seedConsultFault('old', { status: 'failed', detail: 'too_late', slotSec: -900, writtenDaysAgo: 8 });

  const res = await get('/api/admin/lead-call-attention', adminToken);
  const names = res.body.map((r) => r.customer_name);
  assert.ok(names.includes('Attention Booker control'), 'control: the consult half is live in this response');
  assert.ok(!names.includes('Attention Booker completed'), 'a completed consult clears its item');
  assert.ok(!names.includes('Attention Booker no_show'), 'a no_show consult clears its item');
  assert.ok(!names.includes('Attention Booker cancelled'), 'a cancelled consult clears its item');
  assert.ok(!names.includes('Attention Booker st-missed'), 'missed is not an item, the text already fired');
  assert.ok(!names.includes('Attention Booker st-skipped_cancelled'), 'skipped_cancelled is not a fault');
  assert.ok(!names.includes('Attention Booker st-skipped_disabled'), 'skipped_disabled is the kill switch, not a fault');
  assert.ok(!names.includes('Attention Booker st-connected'), 'connected excluded');
  assert.ok(!names.includes('Attention Booker st-pending'), 'an in-flight chain is not an attention item');
  assert.ok(!names.includes('Attention Booker old'), '7-day cutoff applies to the consult half too');
});

test('the two halves interleave by created_at, newest first', async () => {
  const olderConsult = await seedConsultFault('order',
    { status: 'failed', detail: 'too_late', slotSec: -900, writtenDaysAgo: 3 });
  const newerLead = await makeAttempt(await makeLead('order'), 'failed', 2);
  const res = await get('/api/admin/lead-call-attention', adminToken);
  const seq = res.body
    .filter((r) => (r.kind === 'consult' && Number(r.id) === olderConsult.attemptId)
      || (r.kind === 'lead' && Number(r.id) === newerLead))
    .map((r) => r.kind);
  assert.deepEqual(seq, ['lead', 'consult'], 'a 2-day-old lead sorts ahead of a 3-day-old consult');
});

// Seeds a flood, so it must run after every test that reads the whole feed.
test('per-half limits keep a consult flood from crowding the lead half off the feed (S-R1)', async () => {
  // The abuse case, seeded for real. skipped_cap rows do NOT count toward
  // CONSULT_CALL_DAILY_CAP (ruling R15), so a stranger booking public Cal.com slots
  // files them without bound. 205 is more than the old single LIMIT 200 and every
  // one is NEWER than every lead row, so under a shared limit the Thumbtack lead
  // faults would be gone from the response entirely rather than merely reordered.
  const floodIds = await seedConsultFlood('flood', 205);

  const res = await get('/api/admin/lead-call-attention', adminToken);
  assert.equal(res.status, 200);
  const consultRows = res.body.filter((r) => r.kind === 'consult');
  const names = res.body.map((r) => r.customer_name);

  // The HARM first, so a regression fails with the damage named rather than the
  // mechanism: under a shared limit these three lead faults vanish from the feed.
  for (const n of ['Attention Lead failed', 'Attention Lead badphone', 'Attention Lead order']) {
    assert.ok(names.includes(n), `${n} survives the flood`);
  }
  assert.equal(consultRows.length, 100, 'the consult half is bounded by its own inner LIMIT 100');
  assert.ok(consultRows.every((r) => floodIds.has(Number(r.id))),
    'the 100 kept are the newest, so the inner ORDER BY runs before the inner LIMIT');
  assert.ok(res.body.length <= 300, 'the outer limit holds');
});

test('role guard: manager allowed, staff and anonymous denied', async () => {
  assert.equal((await get('/api/admin/lead-call-attention', managerToken)).status, 200);
  assert.equal((await get('/api/admin/lead-call-attention', staffToken)).status, 403);
  assert.equal((await get('/api/admin/lead-call-attention', null)).status, 401);
});
