require('dotenv').config();

// Route + store tests for the presence tracker (spec 2026-07-02). Hand-rolled
// harness mirrors settings.badgeCounts.test.js: a minimal express() app with
// the real routers + real auth/role middleware, driven via node:http +
// node:test. Runs ALONE against the shared dev DB; assertions target the
// test rows only (the dev DB carries 2 real tracked users at ranks 1 and 2,
// so test ranks live at 901/902 and array lengths are never asserted).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const store = require('../../utils/presenceStore');
const { __setPresenceStoreDeps } = store;
const presenceRouter = require('./presence');
const settingsRouter = require('./settings');

let server;
let baseUrl;
let tokens = {};
let ids = {};

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_PREFIX = 'presence-test-';
const PHONE_A = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
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
    if (payload) req.write(payload);
    req.end();
  });
}
const get = (path, token) => request('GET', path, token);
const post = (path, token, body) => request('POST', path, token, body);

async function makeUser(key, role, presence = {}) {
  const passwordHash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version,
                        presence_lead_rank, presence_nudge_channel, presence_nudge_phone)
     VALUES ($1, $2, $3, 'approved', 0, $4, $5, $6) RETURNING id, token_version`,
    [
      `${EMAIL_PREFIX}${key}-${NONCE}@example.com`, passwordHash, role,
      presence.rank ?? null, presence.channel ?? null, presence.phone ?? null,
    ]
  );
  ids[key] = r.rows[0].id;
  tokens[key] = jwt.sign(
    { userId: r.rows[0].id, tokenVersion: r.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
}

function findUser(payload, key) {
  return payload.users.find((u) => u.id === ids[key]) || null;
}

before(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE '${EMAIL_PREFIX}%'`);

  await makeUser('a', 'admin', { rank: 901, channel: 'sms', phone: PHONE_A });
  await makeUser('b', 'admin', { rank: 902, channel: 'telegram' });
  await makeUser('m', 'manager');
  await makeUser('s', 'staff');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', presenceRouter);
  app.use('/api/admin', settingsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: 'Internal error' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.query(`DELETE FROM users WHERE email LIKE '${EMAIL_PREFIX}%'`);
  await pool.end();
});

// 1. Role gates on the strip read.
test('GET /presence: staff 403, anon 401, manager 200', async () => {
  assert.equal((await get('/api/admin/presence', tokens.s)).status, 403);
  assert.equal((await get('/api/admin/presence', null)).status, 401);
  assert.equal((await get('/api/admin/presence', tokens.m)).status, 200);
});

// 2. Strip payload shape for freshly tracked test rows (inserted raw: no
// backfill seed, so since is null and no open interval exists yet).
test('GET /presence: test rows present with away/false defaults', async () => {
  const res = await get('/api/admin/presence', tokens.a);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.users));
  assert.ok('lead_owner_id' in res.body);
  const a = findUser(res.body, 'a');
  const b = findUser(res.body, 'b');
  assert.ok(a && b, 'both test users appear');
  for (const u of [a, b]) {
    assert.equal(u.state, 'away');
    assert.equal(u.taking_leads, false);
    assert.ok('since' in u);
    assert.equal(u.since, null);
  }
  assert.equal(a.rank, 901);
  assert.equal(b.rank, 902);
});

// 3. Untracked caller cannot mutate.
test('POST /presence/state: untracked manager gets 400', async () => {
  const res = await post('/api/admin/presence/state', tokens.m, { state: 'desk' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Not a presence-tracked user/);
});

// 4. Enum validation.
test('POST /presence/state: bad enum 400', async () => {
  const res = await post('/api/admin/presence/state', tokens.a, { state: 'busy' });
  assert.equal(res.status, 400);
});

// 5. away -> desk resets leads on; open interval created.
test('POST /presence/state desk: leads reset on, open interval exists', async () => {
  const res = await post('/api/admin/presence/state', tokens.a, { state: 'desk' });
  assert.equal(res.status, 200);
  const a = findUser(res.body, 'a');
  assert.equal(a.state, 'desk');
  assert.equal(a.taking_leads, true);
  assert.ok(a.since);
  const open = await pool.query(
    "SELECT state, taking_leads FROM presence_log WHERE user_id = $1 AND ended_at IS NULL",
    [ids.a]
  );
  assert.equal(open.rowCount, 1);
  assert.equal(open.rows[0].state, 'desk');
  assert.equal(open.rows[0].taking_leads, true);
});

// 6. Toggle semantics across the transition matrix.
test('leads opt-out survives desk->available; away wipes; re-entry resets on', async () => {
  let res = await post('/api/admin/presence/leads', tokens.a, { taking: false });
  assert.equal(res.status, 200);
  assert.equal(findUser(res.body, 'a').taking_leads, false);

  res = await post('/api/admin/presence/state', tokens.a, { state: 'available' });
  assert.equal(findUser(res.body, 'a').taking_leads, false, 'opt-out survives desk->available');

  res = await post('/api/admin/presence/state', tokens.a, { state: 'away' });
  assert.equal(findUser(res.body, 'a').taking_leads, false, 'away wipes');

  res = await post('/api/admin/presence/state', tokens.a, { state: 'available' });
  assert.equal(findUser(res.body, 'a').taking_leads, true, 'coming online resets on');
});

// 7. Toggle rejected while away.
test('POST /presence/leads while away: 400', async () => {
  await post('/api/admin/presence/state', tokens.a, { state: 'away' });
  const res = await post('/api/admin/presence/leads', tokens.a, { taking: true });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /unavailable while away/);
});

// 8. Interval bookkeeping: one open row; closed rows chain exactly.
test('presence_log: single open row, switch reasons, contiguous boundaries', async () => {
  const rows = (await pool.query(
    'SELECT state, taking_leads, started_at, ended_at, ended_reason FROM presence_log WHERE user_id = $1 ORDER BY started_at',
    [ids.a]
  )).rows;
  const open = rows.filter((r) => r.ended_at === null);
  assert.equal(open.length, 1, 'exactly one open interval');
  for (let i = 0; i < rows.length - 1; i++) {
    assert.equal(rows[i].ended_reason, 'switch');
    assert.equal(
      new Date(rows[i].ended_at).getTime(),
      new Date(rows[i + 1].started_at).getTime(),
      'close/open boundaries are contiguous'
    );
  }
});

// 9. Log endpoint is admin-only and returns totals + intervals.
test('GET /presence/log: manager 403, admin 200 with totals', async () => {
  assert.equal((await get('/api/admin/presence/log', tokens.m)).status, 403);
  const res = await get('/api/admin/presence/log', tokens.a);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.users));
  assert.ok(Array.isArray(res.body.intervals));
  const a = res.body.users.find((u) => u.id === ids.a);
  assert.ok(a, 'user a in totals');
  assert.equal(typeof a.week.desk_ms, 'number');
  assert.ok(a.week.desk_ms >= 0);
  assert.equal(typeof a.month.available_ms, 'number');
});

// 10. Badge-counts carries the presence block.
test('GET /badge-counts: presence block present', async () => {
  const res = await get('/api/admin/badge-counts', tokens.a);
  assert.equal(res.status, 200);
  assert.ok(res.body.presence, 'presence block present');
  assert.ok(Array.isArray(res.body.presence.users));
  assert.ok('lead_owner_id' in res.body.presence);
});

// 11. Badge-counts survives a presence subquery failure (spec-enumerated).
test('GET /badge-counts: presence failure degrades to null, counts intact', async () => {
  __setPresenceStoreDeps({ pool: { query: async () => { throw new Error('boom'); } } });
  try {
    const res = await get('/api/admin/badge-counts', tokens.a);
    assert.equal(res.status, 200);
    assert.equal(res.body.presence, null);
    assert.equal(typeof res.body.pending_proposals, 'number');
  } finally {
    __setPresenceStoreDeps({ pool });
  }
});

// 12. Store-level applyAutoFlip success: closes at nudged_at, opens away.
test('applyAutoFlip: closes at nudged_at, flips user, no negative durations', async () => {
  await store.transitionState(ids.a, 'desk');
  const open = (await pool.query(
    'SELECT id FROM presence_log WHERE user_id = $1 AND ended_at IS NULL', [ids.a]
  )).rows[0];
  await pool.query(
    "UPDATE presence_log SET nudged_at = started_at + interval '1 minute' WHERE id = $1",
    [open.id]
  );
  const flipped = await store.applyAutoFlip({ intervalId: open.id, userId: ids.a });
  assert.equal(flipped, true);

  const closed = (await pool.query(
    'SELECT ended_at, ended_reason, nudged_at FROM presence_log WHERE id = $1', [open.id]
  )).rows[0];
  assert.equal(closed.ended_reason, 'auto_flip');
  assert.equal(new Date(closed.ended_at).getTime(), new Date(closed.nudged_at).getTime());

  const newOpen = (await pool.query(
    'SELECT state, taking_leads, started_at FROM presence_log WHERE user_id = $1 AND ended_at IS NULL', [ids.a]
  )).rows[0];
  assert.equal(newOpen.state, 'away');
  assert.equal(newOpen.taking_leads, false);
  assert.equal(new Date(newOpen.started_at).getTime(), new Date(closed.ended_at).getTime());

  const u = (await pool.query(
    'SELECT presence_state, presence_taking_leads FROM users WHERE id = $1', [ids.a]
  )).rows[0];
  assert.equal(u.presence_state, 'away');
  assert.equal(u.presence_taking_leads, false);

  const negative = await pool.query(
    'SELECT COUNT(*)::int AS n FROM presence_log WHERE user_id = $1 AND ended_at < started_at', [ids.a]
  );
  assert.equal(negative.rows[0].n, 0);
});

// 13. Store-level applyAutoFlip race-abort: a manual switch wins.
test('applyAutoFlip: aborts cleanly when a manual transition won the race', async () => {
  await store.transitionState(ids.a, 'desk');
  const open = (await pool.query(
    'SELECT id FROM presence_log WHERE user_id = $1 AND ended_at IS NULL', [ids.a]
  )).rows[0];
  await pool.query(
    "UPDATE presence_log SET nudged_at = started_at + interval '1 minute' WHERE id = $1",
    [open.id]
  );
  await store.transitionState(ids.a, 'available'); // manual switch wins
  const flipped = await store.applyAutoFlip({ intervalId: open.id, userId: ids.a });
  assert.equal(flipped, false);

  const u = (await pool.query('SELECT presence_state FROM users WHERE id = $1', [ids.a])).rows[0];
  assert.equal(u.presence_state, 'available', 'manual switch untouched');
  const row = (await pool.query('SELECT ended_reason FROM presence_log WHERE id = $1', [open.id])).rows[0];
  assert.equal(row.ended_reason, 'switch', 'observed interval keeps its manual close');
});

// 14. stampByNudgePhone: match stamps, non-match is a no-op.
test('stampByNudgePhone: tracked phone stamps last-seen; unknown returns null', async () => {
  const matched = await store.stampByNudgePhone(PHONE_A);
  assert.equal(matched, ids.a);
  const u = (await pool.query(
    'SELECT presence_last_seen_at FROM users WHERE id = $1', [ids.a]
  )).rows[0];
  assert.ok(u.presence_last_seen_at, 'last seen stamped');
  assert.ok(Date.now() - new Date(u.presence_last_seen_at).getTime() < 10000, 'stamp is fresh');

  const none = await store.stampByNudgePhone('+15550000000');
  assert.equal(none, null);
});
