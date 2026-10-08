require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { SMS_HEADERS_SQL } = require('./readSms');
const { HEADER_WARN_ROWS, CACHE_MS, BADGE_MAX_AGE_MS, INBOX_HISTORY_START } = require('./constants');
const { loadContext } = require('./context');
const { loadFeeds } = require('./feeds');
const k = require('./rules.testkit');

if (process.env.NODE_ENV === 'production') throw new Error('engine.test.js refuses to run against production');

process.env.INBOX_TEXT_LINES = '888';
const engine = require('./engine');

// Fixed identifiers, not per run, so before() also clears whatever a crashed
// earlier run left behind. Invented numbers in the 555-01xx range.
const TAG = 'inbox-engine-test';
const phone = (i) => `+1708555${String(100 + i).padStart(4, '0')}`;
const P = { w: phone(0), q: phone(1), h: phone(2), x: phone(3), u: phone(4), l: phone(8) };
const PHONES = Object.values(P).map((p) => p.slice(-10));
const ids = { clients: [], sms: [], proposals: [], users: [] };

// Everything this suite seeds, found by its tag, its client names and its phone block.
async function clean() {
  const users = (await pool.query('SELECT id FROM users WHERE email LIKE $1', [`${TAG}-%`])).rows.map((r) => r.id);
  const clients = (await pool.query('SELECT id FROM clients WHERE name LIKE $1', [`%${TAG}`])).rows.map((r) => r.id);
  await pool.query(
    `DELETE FROM sms_messages
      WHERE RIGHT(REGEXP_REPLACE(recipient_phone, '\\D', '', 'g'), 10) = ANY($1::text[])
         OR client_id = ANY($2::int[]) OR sender_id = ANY($3::int[])`,
    [PHONES, clients, users]
  );
  await pool.query('DELETE FROM proposals WHERE client_id = ANY($1::int[])', [clients]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clients]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]);
}

async function addSms(cols) {
  const r = await pool.query(
    `INSERT INTO sms_messages (direction, client_id, sender_id, recipient_phone, body, status, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW() - $8::interval) RETURNING id`,
    [cols.direction, cols.clientId || null, cols.senderId || null, cols.phone, cols.body,
      cols.direction === 'inbound' ? 'received' : 'sent', JSON.stringify({ from: cols.phone }), cols.ago]
  );
  ids.sms.push(r.rows[0].id);
  return r.rows[0].id;
}

async function addClient(name, ph) {
  const r = await pool.query('INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id', [name, ph]);
  ids.clients.push(r.rows[0].id);
  return r.rows[0].id;
}

before(async () => {
  await clean();
  const admin = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id",
    [`${TAG}-admin@example.com`]
  );
  ids.admin = admin.rows[0].id;
  ids.users.push(ids.admin);
  ids.w = await addClient(`W Example ${TAG}`, P.w);
  ids.q = await addClient(`Q Example ${TAG}`, P.q);
  ids.h = await addClient(`H Example ${TAG}`, P.h);
  ids.wText = await addSms({ direction: 'inbound', clientId: ids.w, phone: P.w, body: `W needs an answer ${TAG}`, ago: '3 hours' });
  await addSms({ direction: 'inbound', clientId: ids.q, phone: P.q, body: 'An old question', ago: '10 days' });
  await addSms({ direction: 'outbound', clientId: ids.q, phone: P.q, body: 'An old answer', ago: '9 days', senderId: ids.admin });
  await addSms({ direction: 'inbound', clientId: ids.h, phone: P.h, body: 'A question on hold', ago: '2 hours' });
  await addSms({ direction: 'inbound', phone: P.x, body: 'Who is this?', ago: '1 hour' }); // an unknown number...
  ids.m = await addClient(`M Example ${TAG}`, P.x); // ...that has since become a client
  await addSms({ direction: 'inbound', phone: P.u, body: 'Can you call me?', ago: '1 hour' }); // a number that never did
  const hold = await pool.query("INSERT INTO proposals (client_id, status, event_date) VALUES ($1, 'confirmed', CURRENT_DATE + 40) RETURNING id", [ids.h]);
  ids.proposals.push(hold.rows[0].id);
  engine.__setEngineDeps({ legalHoldIds: [hold.rows[0].id] });
});

after(async () => {
  engine.__resetEngine();
  await clean();
  await pool.end();
});

// First in the file: the warning is once per process, and no test before it
// may have spent it. A stand-in db answers pass 1 with one row past the limit,
// counted over every pass-1 row: SMS headers one short of it, one AI read and
// one tap (rows no person owns, so nothing else is read), and the real
// computeSnapshot runs twice.
test('pass 1 past HEADER_WARN_ROWS warns once per process, with counts only, and to Sentry when it is set up', async () => {
  const headerRows = HEADER_WARN_ROWS + 1;
  const many = Array.from({ length: HEADER_WARN_ROWS - 1 }, (_, i) => ({ id: i + 1, direction: 'outbound', created_at: new Date() }));
  const at = new Date();
  const read = {
    kind: 'inbound', subject_ref: 'sms:1', person_key: 'c-2147483000', status: 'ok', needs_reply: false, holding: null,
    summary: null, promised_by: null, reason: null, attempts: 1, created_at: at, updated_at: at,
  };
  const tap = { id: 1, person_key: 'c-2147483000', action: 'done', until_at: null, user_id: 1, created_at: at, undone_at: null };
  const rowsFor = (sql) => {
    if (sql === SMS_HEADERS_SQL) return many;
    if (sql.includes('FROM inbox_reads')) return [read];
    if (sql.includes('FROM inbox_actions')) return [tap];
    return [];
  };
  const db = { query: (sql) => Promise.resolve({ rows: rowsFor(sql), rowCount: 0 }) };
  const warned = [];
  const captured = [];
  const realWarn = console.warn;
  const realCapture = Sentry.captureMessage;
  const realDsn = process.env.SENTRY_DSN_SERVER;
  console.warn = (...args) => { warned.push(args.join(' ')); };
  Sentry.captureMessage = (...args) => { captured.push(args); };
  process.env.SENTRY_DSN_SERVER = 'https://public@example.invalid/1';
  try {
    await engine.computeSnapshot({ now: new Date(), db });
    await engine.computeSnapshot({ now: new Date(), db });
  } finally {
    console.warn = realWarn;
    Sentry.captureMessage = realCapture;
    if (realDsn === undefined) delete process.env.SENTRY_DSN_SERVER;
    else process.env.SENTRY_DSN_SERVER = realDsn;
  }
  const lines = warned.filter((w) => w.startsWith('[inbox] pass 1'));
  assert.equal(lines.length, 1, 'one log line per process, however many loads cross the limit');
  assert.ok(lines[0].includes(`read ${headerRows} header rows`), lines[0]);
  assert.deepEqual(captured, [
    ['[inbox] pass 1 passed HEADER_WARN_ROWS', { level: 'warning', extra: { headerRows, limit: HEADER_WARN_ROWS } }],
  ], 'once, with the two counts and nothing else');
});

test('two passes: full rows only for people waiting, snoozed or closed in the last 7 days', async () => {
  const snap = await engine.computeSnapshot({ now: new Date() });
  assert.ok(snap.fullKeys.has(`c-${ids.w}`));
  assert.ok(!snap.fullKeys.has(`c-${ids.q}`), 'answered nine days ago: quiet');
  assert.equal(snap.eventsByPerson.get(`c-${ids.w}`).find((e) => e.ref === `sms:${ids.wText}`).text, `W needs an answer ${TAG}`);
  const q = snap.eventsByPerson.get(`c-${ids.q}`);
  assert.ok(q.length >= 2 && q.every((e) => e.text === undefined), 'a quiet person keeps light headers only');
});

test('getInbox lists the waiting person with the message as the need', async () => {
  engine.invalidate();
  const body = await engine.getInbox({ viewerId: ids.admin });
  const row = body.waiting.find((r) => r.person_key === `c-${ids.w}`);
  assert.deepEqual([row.name, row.kind, row.need, row.channels, row.state.type],
    [`W Example ${TAG}`, 'lead', `W needs an answer ${TAG}`, ['text_888'], 'unseen']);
  assert.ok(['on', 'off', 'paused', 'failing'].includes(body.ai.status));
  assert.deepEqual(body.feeds.map((f) => f.source), ['thumbtack', '888', '1922', '0082']);
  assert.ok(!body.waiting.some((r) => r.person_key === `c-${ids.q}`));
});

test('getReadSubjects: the cached snapshot, real names or null, never the legal-hold client', async () => {
  engine.invalidate();
  const subjects = await engine.getReadSubjects();
  const w = subjects.find((s) => s.personKey === `c-${ids.w}`);
  assert.deepEqual([w.kind, w.subjectRef, w.name, w.legalHold], ['inbound', `sms:${ids.wText}`, `W Example ${TAG}`, false]);
  assert.equal(w.slice[w.slice.length - 1].ref, `sms:${ids.wText}`);
  const unknown = subjects.find((s) => s.personKey === `p-${P.u.slice(-10)}`);
  assert.equal(unknown.name, null, 'an unknown number has no name: never a label or the number');
  assert.ok(!subjects.some((s) => s.personKey === `c-${ids.h}`), 'decision 31');
  let loads = 0;
  engine.__setEngineDeps({ computeSnapshot: (args) => { loads += 1; return engine.computeSnapshot(args); } });
  await engine.getReadSubjects();
  await engine.getReadSubjects();
  assert.equal(loads, 1, 'the page and the read job share one cached snapshot');
  await engine.getReadSubjects({ fresh: true });
  assert.equal(loads, 2, 'only fresh: true bypasses it');
  engine.__setEngineDeps({ computeSnapshot: null });
});

test('getWaitingCount: the number when the engine answers, null when it is slow or fails', async () => {
  engine.invalidate();
  const n = await engine.getWaitingCount({ timeoutMs: 15000 });
  assert.ok(Number.isInteger(n) && n >= 3, 'W, H and the unknown number at least');
  engine.__setEngineDeps({
    computeSnapshot: () => new Promise((resolve) => { setTimeout(() => resolve(engine.__fakeSnapshot()), 3000).unref(); }),
  });
  const started = Date.now();
  assert.equal(await engine.getWaitingCount({ timeoutMs: 100 }), null);
  assert.ok(Date.now() - started < 1000);
  engine.__setEngineDeps({ computeSnapshot: () => Promise.reject(new Error('db down')) });
  assert.equal(await engine.getWaitingCount({ timeoutMs: 1000 }), null);
  engine.__setEngineDeps({ computeSnapshot: null });
});

test('the cache: one load inside 30 seconds, a fresh one after invalidate', async () => {
  let loads = 0;
  engine.__setEngineDeps({ computeSnapshot: (args) => { loads += 1; return engine.computeSnapshot(args); } });
  await engine.getInbox({ viewerId: ids.admin });
  await engine.getInbox({ viewerId: ids.admin });
  assert.equal(loads, 1);
  engine.invalidate();
  await engine.getInbox({ viewerId: ids.admin });
  assert.equal(loads, 2);
  engine.__setEngineDeps({ computeSnapshot: null });
});

test('the badge takes a snapshot up to BADGE_MAX_AGE_MS old; the page and the read job take one under 30 seconds', async () => {
  let loads = 0;
  engine.__setEngineDeps({ computeSnapshot: () => { loads += 1; return Promise.resolve(engine.__fakeSnapshot()); } });
  const realNow = Date.now;
  const start = realNow();
  try {
    assert.equal(await engine.getWaitingCount({ timeoutMs: 1000 }), 0);
    assert.equal(loads, 1);
    Date.now = () => start + CACHE_MS + 5000;
    assert.equal(await engine.getWaitingCount({ timeoutMs: 1000 }), 0);
    assert.equal(loads, 1, 'past CACHE_MS, inside BADGE_MAX_AGE_MS: the badge reuses it');
    await engine.getReadSubjects();
    assert.equal(loads, 2, 'past CACHE_MS the read job (and the page) load again');
    Date.now = () => start + CACHE_MS + 5000 + BADGE_MAX_AGE_MS + 1000;
    await engine.getWaitingCount({ timeoutMs: 1000 });
    assert.equal(loads, 3, 'past BADGE_MAX_AGE_MS the badge loads again too');
  } finally {
    Date.now = realNow;
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

test('getItem: the thread, the context card and the reply area', async () => {
  const item = await engine.getItem({ personKey: `c-${ids.w}`, viewerId: ids.admin });
  assert.deepEqual([item.person.kind, item.status, item.waiting, item.legal_hold, item.closed], ['lead', 'waiting', true, false, null]);
  assert.deepEqual(item.thread.map((r) => [r.ref, r.direction]), [[`sms:${ids.wText}`, 'in']]);
  assert.deepEqual([item.context.kind, item.context.status_chip, item.context.proposal.chip], ['lead', 'Lead', 'None']);
  assert.deepEqual([item.reply.mode, item.reply.lines, item.reply.default_line, item.reply.their_line, item.reply.opted_out, item.reply.staff],
    ['text', ['888'], '888', '888', null, false]);
  assert.deepEqual(item.reply.first_text_prefix, {}, 'the 888 never takes the prefix');
  assert.equal(item.reply.recipient_display, `(708) 555-${P.w.slice(-4)}`);
  assert.equal((await engine.getItem({ personKey: `c-${ids.h}`, viewerId: ids.admin })).legal_hold, true);
});

test('getItem: a key that no longer resolves says where it moved; an unknown key is a plain 404', async () => {
  await assert.rejects(engine.getItem({ personKey: `p-${P.x.slice(-10)}`, viewerId: ids.admin }),
    (err) => err instanceof engine.InboxMovedError && err.movedTo === `c-${ids.m}` && err.statusCode === 404);
  await assert.rejects(engine.getItem({ personKey: 'c-2147483000', viewerId: ids.admin }),
    (err) => err.statusCode === 404 && err.code === 'NOT_FOUND' && !(err instanceof engine.InboxMovedError));
});

// A p- key that still has events stays, as the alias fold keeps its taps
// (aliases.js rule 1), so its row and its thread agree. A synthetic snapshot
// whose index now names someone else for the number, as when a newer Thumbtack
// lead took it as a proxy number and the older texts stayed under p-.
test('getItem: a p- key that still has events opens, even when its number now resolves to someone else', async () => {
  const now = new Date();
  const live = phone(5);
  const gone = phone(6);
  const snap = engine.__fakeSnapshot({
    now, events: [k.smsIn(`p-${live.slice(-10)}`, new Date(now.getTime() - 3600e3), 'Is this still the right number?', { phone: live })],
  });
  snap.index.resolvePhone = (digits) => ([live, gone].some((p) => p.slice(-10) === digits) ? 'c-2147483000' : null);
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  try {
    const item = await engine.getItem({ personKey: `p-${live.slice(-10)}`, viewerId: ids.admin });
    assert.deepEqual([item.person.person_key, item.status, item.thread.map((r) => r.direction)],
      [`p-${live.slice(-10)}`, 'waiting', ['in']]);
    await assert.rejects(engine.getItem({ personKey: `p-${gone.slice(-10)}`, viewerId: ids.admin }),
      (err) => err instanceof engine.InboxMovedError && err.movedTo === 'c-2147483000', 'no events left: it moved');
    await assert.rejects(engine.getItem({ personKey: `p-${phone(7).slice(-10)}`, viewerId: ids.admin }),
      (err) => err.statusCode === 404 && !(err instanceof engine.InboxMovedError), 'no events and no one: a plain 404');
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

// Merge review: the reply area and the Messages reply read a client's last
// texted line from the same all-history rows (decision 9 has no date window).
test('getItem: a client who last texted before the history floor keeps that line, as the Messages reply does', async () => {
  const floorMs = new Date(INBOX_HISTORY_START).getTime();
  ids.l = await addClient(`L Example ${TAG}`, P.l);
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, sender_id, recipient_phone, body, status, metadata, created_at)
     VALUES ('outbound', $1, $2, $3, 'An answer from before Inbox', 'sent', '{"line":"888"}'::jsonb, $4)`,
    [ids.l, ids.admin, P.l, new Date(floorMs - 7 * 24 * 3600e3)]
  );
  const savedLines = process.env.INBOX_TEXT_LINES;
  process.env.INBOX_TEXT_LINES = '888,1922';
  try {
    engine.invalidate();
    const item = await engine.getItem({ personKey: `c-${ids.l}`, viewerId: 1 });
    assert.deepEqual([item.reply.mode, item.reply.last_line, item.reply.default_line], ['text', '888', '888']);
  } finally {
    if (savedLines === undefined) delete process.env.INBOX_TEXT_LINES;
    else process.env.INBOX_TEXT_LINES = savedLines;
  }
});

test('getItem: a key parsePersonKey rejects is a plain 404, never a TypeError', async () => {
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(engine.__fakeSnapshot()) });
  try {
    for (const personKey of ['not-a-key', 'c-007']) {
      await assert.rejects(engine.getItem({ personKey, viewerId: ids.admin }),
        (err) => err.statusCode === 404 && err.code === 'NOT_FOUND' && !(err instanceof engine.InboxMovedError), personKey);
    }
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

test('loadContext: a key parsePersonKey rejects has no context card, never a TypeError', async () => {
  assert.deepEqual(await loadContext({ personKey: 'c-007', index: null, events: [], todayYmd: '2026-10-08' }), { context: null, legalHold: false });
});

test('loadFeeds reads through the pool when no db is passed', async () => {
  const feeds = await loadFeeds({ now: new Date() });
  assert.deepEqual(feeds.map((f) => f.source), ['thumbtack', '888', '1922', '0082']);
});

test('getReadSubjects honors a maxAgeMs it is given (lane inbox-ai reads at BADGE_MAX_AGE_MS); the default is unchanged', async () => {
  let loads = 0;
  engine.__setEngineDeps({ computeSnapshot: () => { loads += 1; return Promise.resolve(engine.__fakeSnapshot()); } });
  const realNow = Date.now;
  const start = realNow();
  try {
    await engine.getReadSubjects({ maxAgeMs: BADGE_MAX_AGE_MS });
    assert.equal(loads, 1);
    Date.now = () => start + CACHE_MS + 5000;
    await engine.getReadSubjects({ maxAgeMs: BADGE_MAX_AGE_MS });
    assert.equal(loads, 1, 'past CACHE_MS, inside the maxAgeMs it passed: the same snapshot');
    await engine.getReadSubjects();
    assert.equal(loads, 2, 'with no maxAgeMs, past CACHE_MS it loads again');
  } finally {
    Date.now = realNow;
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});
