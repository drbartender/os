require('dotenv').config();

// The Inbox routes (spec 2026-10-06, section 8) against the dev DB: auth, the
// person-key check, the list and the item, a moved key, seen, the taps, Undo,
// and the cache every write clears. Every seeded row is removed in before()
// and after(), found by the suite's fixed tag and phone block.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

if (process.env.NODE_ENV === 'production') throw new Error('inbox.test.js refuses to run against production');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const cache = require('../../utils/inbox/cache');
const engine = require('../../utils/inbox/engine');
const { emailHash, personalEmailKey } = require('../../utils/inbox/people');
const { PERSONAL_ALIAS } = require('../../utils/inbox/constants');
const { GMAIL_MAILBOX } = require('../../utils/gmailClient');
const inboxRouter = require('./inbox');

// Fixed identifiers, not per run, so before() also clears whatever a crashed
// earlier run left behind. Invented numbers in the 555-01xx range.
const TAG = 'inbox-routes-test';
const phone = (i) => `+1773555${String(100 + i).padStart(4, '0')}`;
const PHONES = [0, 1, 2, 3, 4].map((i) => phone(i).slice(-10));
const ids = { users: [], clients: [], sms: [] };
// Personal mail (spec 2026-10-14 decision 6, as decided 2026-10-15): a
// friend wrote to the owner alias only and the sync stored that mail
// personal, on the friend's personal person; the same friend also wrote to
// the business mailbox, a business person. Every gmail id and address here
// starts with GM.
const GM = 'zz-test-inbox-routes';
const FRIEND = `${GM}-friend@example.com`;
const PERSONAL = personalEmailKey(FRIEND);
const FRIEND_BUSINESS = `e-${emailHash(FRIEND)}`;
// An address that never wrote, and one that is now a client's (its e- key
// moved): to a non-owner both must answer exactly as the personal key does.
const UNUSED = `e-${emailHash(`${GM}-nobody@example.com`)}`;
const MOVED = `e-${emailHash(`${GM}-done@example.com`)}`;
const U = {};
const C = {};
let server;
let baseUrl;

function call(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (payload) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function makeUser(role, label) {
  const r = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', $2, 'approved', 0) RETURNING id, token_version",
    [`${TAG}-${label}@example.com`, role]
  );
  ids.users.push(r.rows[0].id);
  const token = jwt.sign({ userId: r.rows[0].id, tokenVersion: r.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return { id: r.rows[0].id, token };
}

async function addClient(label, ph) {
  const r = await pool.query('INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id', [`${label} Example ${TAG}`, ph]);
  ids.clients.push(r.rows[0].id);
  return r.rows[0].id;
}

async function addSms({ direction, clientId = null, senderId = null, ph, body, ago }) {
  const inbound = direction === 'inbound';
  const r = await pool.query(
    `INSERT INTO sms_messages (direction, client_id, sender_id, recipient_phone, body, status, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW() - $8::interval) RETURNING id`,
    [direction, clientId, senderId, ph, body, inbound ? 'received' : 'sent', JSON.stringify(inbound ? { from: ph } : {}), ago]
  );
  ids.sms.push(r.rows[0].id);
  return r.rows[0].id;
}

const key = (id) => `c-${id}`;
const list = async (who = U.admin) => (await call('GET', '/api/admin/inbox', { token: who.token })).body;
const item = async (personKey) => (await call('GET', `/api/admin/inbox/${personKey}`, { token: U.admin.token })).body;
const rowOf = (body, personKey) => body.waiting.find((r) => r.person_key === personKey);
const act = (personKey, body, who = U.admin) => call('POST', `/api/admin/inbox/${personKey}/actions`, { token: who.token, body });
const undo = (id, who = U.admin) => call('DELETE', `/api/admin/inbox/actions/${id}`, { token: who.token });

// Everything this suite seeds, found by its tag, its client names and its phone block.
async function clean() {
  const users = (await pool.query('SELECT id FROM users WHERE email LIKE $1', [`${TAG}-%`])).rows.map((r) => r.id);
  const clients = (await pool.query('SELECT id FROM clients WHERE name LIKE $1', [`%${TAG}`])).rows.map((r) => r.id);
  const keys = [...clients.map(key), ...PHONES.map((t) => `p-${t}`), PERSONAL, FRIEND_BUSINESS, UNUSED, MOVED];
  await pool.query('DELETE FROM gmail_messages WHERE gmail_id LIKE $1', [`${GM}-%`]);
  await pool.query('DELETE FROM inbox_actions WHERE person_key = ANY($1::text[]) OR user_id = ANY($2::int[])', [keys, users]);
  await pool.query('DELETE FROM inbox_seen WHERE person_key = ANY($1::text[]) OR seen_by = ANY($2::int[])', [keys, users]);
  await pool.query('DELETE FROM inbox_sends WHERE person_key = ANY($1::text[]) OR user_id = ANY($2::int[])', [keys, users]);
  await pool.query(
    `DELETE FROM sms_messages
      WHERE RIGHT(REGEXP_REPLACE(recipient_phone, '\\D', '', 'g'), 10) = ANY($1::text[])
         OR client_id = ANY($2::int[]) OR sender_id = ANY($3::int[])`,
    [PHONES, clients, users]
  );
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clients]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]);
}

before(async () => {
  await clean();
  U.admin = await makeUser('admin', 'admin');
  U.other = await makeUser('admin', 'other');
  U.manager = await makeUser('manager', 'manager');
  U.staff = await makeUser('staff', 'staff');
  C.ask = await addClient('Ask', phone(0));
  C.askSms = await addSms({ direction: 'inbound', clientId: C.ask, ph: phone(0), body: `When can we talk? ${TAG}`, ago: '2 hours' });
  C.done = await addClient('Done', phone(1));
  await pool.query('UPDATE clients SET email = $1 WHERE id = $2', [`${GM}-done@example.com`, C.done]);
  await addSms({ direction: 'inbound', clientId: C.done, ph: phone(1), body: 'Is there parking?', ago: '3 hours' });
  await addSms({ direction: 'outbound', clientId: C.done, senderId: U.admin.id, ph: phone(1), body: 'Yes, by the side door', ago: '1 hour' });
  await addSms({ direction: 'inbound', ph: phone(2), body: 'Hi, who is this?', ago: '1 hour' }); // an unknown number...
  C.moved = await addClient('Moved', phone(2)); // ...that has since become a client
  C.undo = await addClient('Undo', phone(3));
  await addSms({ direction: 'inbound', clientId: C.undo, ph: phone(3), body: 'Do you bring ice?', ago: '1 hour' });
  C.snooze = await addClient('Snooze', phone(4));
  await addSms({ direction: 'inbound', clientId: C.snooze, ph: phone(4), body: 'Can we decide next week?', ago: '1 hour' });
  const mailIn = (gmailId, to, personal, text, ago) => pool.query(
    `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, text, at, personal)
     VALUES ($1, $1, 'in', 'message', $2, $3::text[], $4, NOW() - $5::interval, $6)`,
    [gmailId, FRIEND, to, text, ago, personal]
  );
  await mailIn(`${GM}-personal`, [PERSONAL_ALIAS], true, 'Dinner on Sunday?', '1 hour');
  await mailIn(`${GM}-business`, [GMAIL_MAILBOX], false, 'Do you do corporate events?', '30 minutes');

  const app = express();
  app.use(express.json());
  app.use('/api/admin', inboxRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  engine.__resetEngine();
  if (server) await new Promise((resolve) => server.close(resolve));
  await clean();
  await pool.end();
});

test('auth: no token is 401, staff is 403, a manager reads the list', async () => {
  assert.equal((await call('GET', '/api/admin/inbox')).status, 401);
  assert.equal((await call('GET', '/api/admin/inbox', { token: U.staff.token })).status, 403);
  const res = await call('GET', '/api/admin/inbox', { token: U.manager.token });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['ai', 'feeds', 'generated_at', 'handled', 'snoozed', 'waiting']);
});

test('a person key is checked before anything reads it (spec 8)', async () => {
  for (const bad of ['x-1', 'c-01', 'c-2147483648', 'p-12ab', `t-${'a'.repeat(101)}`]) {
    const res = await call('GET', `/api/admin/inbox/${bad}`, { token: U.admin.token });
    assert.deepEqual([res.status, res.body.code, res.body.error], [400, 'VALIDATION_ERROR', 'That is not an Inbox person.'], bad);
  }
  assert.equal((await call('POST', '/api/admin/inbox/c-01/seen', { token: U.admin.token })).status, 400);
});

test('the list: the waiting client with its need and state, and the answered one in Recently handled', async () => {
  cache.invalidate();
  const body = await list();
  const row = rowOf(body, key(C.ask));
  assert.deepEqual([row.name, row.kind, row.need, row.channels, row.hot], [`Ask Example ${TAG}`, 'lead', `When can we talk? ${TAG}`, ['text_888'], false]);
  assert.deepEqual(row.state, { type: 'unseen', by_user_id: null, by_name: null, mine: false, promised_by: null, since: null });
  const handled = body.handled.find((r) => r.person_key === key(C.done));
  assert.deepEqual([handled.reason_code, handled.reason_text, handled.need], ['text', 'You texted back from 888', 'Is there parking?']);
  assert.equal(rowOf(body, key(C.done)), undefined);
});

test('the item: thread, context and reply; a moved key is 404 with moved_to; an unknown one a plain 404', async () => {
  const body = await item(key(C.ask));
  assert.deepEqual([body.status, body.waiting, body.closed, body.context.kind], ['waiting', true, null, 'lead']);
  assert.deepEqual(body.thread.map((r) => r.ref), [`sms:${C.askSms}`]);
  assert.deepEqual([body.reply.mode, body.reply.default_line], ['text', '888']);
  const moved = await call('GET', `/api/admin/inbox/p-${phone(2).slice(-10)}`, { token: U.admin.token });
  assert.deepEqual([moved.status, moved.body.code, moved.body.moved_to], [404, 'INBOX_MOVED', key(C.moved)]);
  const gone = await call('GET', '/api/admin/inbox/c-2147483000', { token: U.admin.token });
  assert.deepEqual([gone.status, gone.body.code, gone.body.moved_to], [404, 'NOT_FOUND', undefined]);
});

test('seen: 204, "Not read yet" goes at once, and the client\'s texts are marked read', async () => {
  await list();
  assert.equal((await call('POST', `/api/admin/inbox/${key(C.ask)}/seen`, { token: U.admin.token })).status, 204);
  assert.equal(rowOf(await list(), key(C.ask)).state.type, null);
  assert.ok((await pool.query('SELECT read_at FROM sms_messages WHERE id = $1', [C.askSms])).rows[0].read_at);
  assert.equal((await pool.query('SELECT seen_by FROM inbox_seen WHERE person_key = $1', [key(C.ask)])).rows[0].seen_by, U.admin.id);
});

test('On it, Let go and Done: 201 with the id, each reflected at once, the claim carrying since', async () => {
  const claim = await act(key(C.ask), { action: 'claim' });
  assert.equal(claim.status, 201);
  assert.ok(Number.isInteger(claim.body.id));
  const madeAt = (await pool.query('SELECT created_at FROM inbox_actions WHERE id = $1', [claim.body.id])).rows[0].created_at;
  const mine = rowOf(await list(), key(C.ask)).state;
  assert.deepEqual([mine.type, mine.mine, mine.since], ['claim', true, madeAt.toISOString()]);
  const theirs = rowOf(await list(U.other), key(C.ask)).state;
  assert.deepEqual([theirs.type, theirs.mine, theirs.by_user_id], ['claim', false, U.admin.id]);
  assert.equal((await act(key(C.ask), { action: 'release' })).status, 201);
  assert.equal(rowOf(await list(), key(C.ask)).state.type, null);
  assert.equal((await act(key(C.ask), { action: 'done' })).status, 201);
  const closed = await item(key(C.ask));
  assert.deepEqual([closed.status, closed.waiting, closed.closed.reason_text], ['handled', false, 'You marked it done']);
});

test('Undo: another user\'s tap is 409; the own tap under 60 seconds is 204, and so is a repeat; an old one is 409; unknown 404; bad id 400', async () => {
  const done = await act(key(C.undo), { action: 'done' });
  assert.equal((await item(key(C.undo))).status, 'handled');
  const stranger = await undo(done.body.id, U.other);
  assert.deepEqual([stranger.status, stranger.body.code], [409, 'INBOX_UNDO_NOT_YOURS']);
  assert.equal((await undo(done.body.id)).status, 204);
  assert.equal((await undo(done.body.id)).status, 204, 'a repeat answers the same');
  assert.equal((await item(key(C.undo))).status, 'waiting');
  const old = await act(key(C.undo), { action: 'claim' });
  await pool.query("UPDATE inbox_actions SET created_at = NOW() - INTERVAL '2 minutes' WHERE id = $1", [old.body.id]);
  const late = await undo(old.body.id);
  assert.deepEqual([late.status, late.body.code], [409, 'INBOX_UNDO_EXPIRED']);
  assert.equal((await undo(2147483000)).status, 404);
  assert.equal((await undo('abc')).status, 400);
});

test('Snooze: until is required, 1 minute to 8 days; only Snooze takes one; Wake ends it', async () => {
  const soon = new Date(Date.now() + 30 * 1000).toISOString();
  const far = new Date(Date.now() + 9 * 24 * 3600e3).toISOString();
  const refused = [
    { action: 'snooze' }, { action: 'snooze', until: 'tomorrow' }, { action: 'snooze', until: soon },
    { action: 'snooze', until: far }, { action: 'claim', until: far }, { action: 'archive' },
  ];
  for (const body of refused) {
    const res = await act(key(C.snooze), body);
    assert.deepEqual([res.status, res.body.code], [400, 'VALIDATION_ERROR'], JSON.stringify(body));
    assert.notEqual(res.body.error, 'Please fix the errors below', 'the toast reads the real problem');
  }
  const until = new Date(Date.now() + 2 * 3600e3).toISOString();
  assert.equal((await act(key(C.snooze), { action: 'snooze', until })).status, 201);
  const body = await list();
  const s = body.snoozed.find((r) => r.person_key === key(C.snooze));
  assert.deepEqual([s.until, s.mine], [until, true]);
  assert.equal(rowOf(body, key(C.snooze)), undefined);
  const snoozed = await item(key(C.snooze));
  assert.deepEqual([snoozed.status, snoozed.waiting, snoozed.snooze.mine], ['snoozed', false, true]);
  assert.equal((await act(key(C.snooze), { action: 'wake' })).status, 201);
  assert.equal((await item(key(C.snooze))).status, 'waiting');
});

test('Reopen brings a handled person back with the Reopened chip and what they needed', async () => {
  assert.equal((await act(key(C.done), { action: 'reopen' })).status, 201);
  const row = rowOf(await list(), key(C.done));
  assert.deepEqual([row.state.type, row.state.mine, row.need], ['reopened', true, 'Is there parking?']);
});

test('every write clears the cache: seen, an action and an Undo each move the generation on', async () => {
  const g0 = cache.generationNow();
  await call('POST', `/api/admin/inbox/${key(C.done)}/seen`, { token: U.admin.token });
  const g1 = cache.generationNow();
  const a = await act(key(C.done), { action: 'claim' });
  const g2 = cache.generationNow();
  await undo(a.body.id);
  const g3 = cache.generationNow();
  assert.ok(g0 < g1 && g1 < g2 && g2 < g3, JSON.stringify([g0, g1, g2, g3]));
});

test('personal mail is invisible to everyone but its owner: the list, the item, seen, the taps and the text route answer as if it were not there', async () => {
  cache.invalidate();
  assert.equal(rowOf(await list(), PERSONAL), undefined, 'not on a non-owner\'s list');
  const gone = await call('GET', '/api/admin/inbox/c-2147483000', { token: U.admin.token });
  const hidden = await call('GET', `/api/admin/inbox/${PERSONAL}`, { token: U.admin.token });
  assert.deepEqual([hidden.status, hidden.body], [gone.status, gone.body], 'the same 404 as a key that names no one');
  const refused = [
    await call('POST', `/api/admin/inbox/${PERSONAL}/seen`, { token: U.admin.token }),
    await act(PERSONAL, { action: 'done' }),
    await call('POST', `/api/admin/inbox/${PERSONAL}/text`, { token: U.admin.token, body: {} }),
  ];
  assert.deepEqual(refused.map((r) => [r.status, r.body && r.body.code]), [[404, 'NOT_FOUND'], [404, 'NOT_FOUND'], [404, 'NOT_FOUND']]);
  const written = await pool.query('SELECT (SELECT COUNT(*) FROM inbox_seen WHERE person_key = $1)::int AS seen, (SELECT COUNT(*) FROM inbox_actions WHERE person_key = $1)::int AS acts', [PERSONAL]);
  assert.deepEqual(written.rows[0], { seen: 0, acts: 0 }, 'nothing was written for a refused viewer');
});

// An e- key is a hash of an address anyone can guess: the write routes must
// not tell a personal person from an address that never wrote, or from one
// whose key moved to a client.
test('personal mail: seen, the taps and the text route answer a personal key, an unused e- key and a moved one identically, and write nothing', async () => {
  cache.invalidate();
  const answers = async (personKey) => [
    await call('POST', `/api/admin/inbox/${personKey}/seen`, { token: U.admin.token }),
    await act(personKey, { action: 'claim' }),
    await call('POST', `/api/admin/inbox/${personKey}/text`, { token: U.admin.token, body: { body: 'Hi', line: '888', send_id: crypto.randomUUID() } }),
  ].map((r) => [r.status, r.body]);
  const personal = await answers(PERSONAL);
  assert.deepEqual(personal.map(([status, body]) => [status, body.code]), [[404, 'NOT_FOUND'], [404, 'NOT_FOUND'], [404, 'NOT_FOUND']]);
  assert.deepEqual(await answers(UNUSED), personal, 'an address that never wrote');
  assert.deepEqual(await answers(MOVED), personal, 'an address that is now a client\'s');
  const written = await pool.query(
    `SELECT (SELECT COUNT(*) FROM inbox_seen WHERE person_key = ANY($1::text[]))::int AS seen,
            (SELECT COUNT(*) FROM inbox_actions WHERE person_key = ANY($1::text[]))::int AS acts,
            (SELECT COUNT(*) FROM inbox_sends WHERE person_key = ANY($1::text[]))::int AS sends`,
    [[PERSONAL, UNUSED, MOVED]]
  );
  assert.deepEqual(written.rows[0], { seen: 0, acts: 0, sends: 0 }, 'nothing is written for any of them');
});

test('personal mail: its owner sees the row with personal set, opens it, marks it seen and taps it', async () => {
  // The owner is users.id 1 in production; this suite's manager stands in.
  engine.__setEngineDeps({ personalOwnerId: U.manager.id });
  try {
    cache.invalidate();
    const row = rowOf(await list(U.manager), PERSONAL);
    assert.deepEqual([row.personal, row.need, row.channels], [true, 'Dinner on Sunday?', ['email']]);
    assert.equal(rowOf(await list(U.admin), PERSONAL), undefined, 'still hidden from everyone else');
    const opened = await call('GET', `/api/admin/inbox/${PERSONAL}`, { token: U.manager.token });
    assert.deepEqual([opened.status, opened.body.status, opened.body.reply.mode], [200, 'waiting', 'open']);
    assert.equal((await call('POST', `/api/admin/inbox/${PERSONAL}/seen`, { token: U.manager.token })).status, 204);
    assert.equal((await act(PERSONAL, { action: 'claim' }, U.manager)).status, 201);
    const text = await call('POST', `/api/admin/inbox/${PERSONAL}/text`, { token: U.manager.token, body: {} });
    assert.deepEqual([text.status, text.body.code], [400, 'VALIDATION_ERROR'], 'past the personal check, the route\'s own refusal');
    const unused = await call('POST', `/api/admin/inbox/${UNUSED}/seen`, { token: U.manager.token });
    assert.deepEqual([unused.status, unused.body.code], [404, 'NOT_FOUND'], 'an e- key with no mail is no one, to the owner too');
  } finally {
    engine.__resetEngine();
  }
});

// Test 3 of the 2026-10-15 brief over the routes: one friend, two items. The
// business one is everyone's; the personal one is the owner's alone.
test('one sender, a personal mail and a business mail: another admin lists and opens the business one only; the owner sees both', async () => {
  engine.__setEngineDeps({ personalOwnerId: U.manager.id });
  try {
    cache.invalidate();
    const admin = await list(U.admin);
    assert.deepEqual([rowOf(admin, PERSONAL), rowOf(admin, FRIEND_BUSINESS).personal], [undefined, false]);
    const opened = await call('GET', `/api/admin/inbox/${FRIEND_BUSINESS}`, { token: U.admin.token });
    assert.deepEqual([opened.status, opened.body.thread.map((r) => r.text)], [200, ['Do you do corporate events?']]);
    const owner = await list(U.manager);
    assert.deepEqual([rowOf(owner, PERSONAL).personal, rowOf(owner, FRIEND_BUSINESS).personal], [true, false]);
    assert.notEqual(PERSONAL, FRIEND_BUSINESS);
  } finally {
    engine.__resetEngine();
  }
});

// Test 7 over the routes, last in the file because it makes the friend a
// client: the personal key never moves, so another admin still gets the
// plain 404 with no moved_to, and the owner still opens it; the friend's
// business key now has no mail of its own and moves to the client.
test('the personal key never moves: the friend became a client, the personal key is still the plain 404 with no moved_to, and the owner opens it', async () => {
  const friendClient = await addClient('Friend', null);
  await pool.query('UPDATE clients SET email = $1 WHERE id = $2', [FRIEND, friendClient]);
  engine.__setEngineDeps({ personalOwnerId: U.manager.id });
  try {
    cache.invalidate();
    const gone = await call('GET', '/api/admin/inbox/c-2147483000', { token: U.admin.token });
    const hidden = await call('GET', `/api/admin/inbox/${PERSONAL}`, { token: U.admin.token });
    assert.deepEqual([hidden.status, hidden.body], [gone.status, gone.body], 'the plain 404, with no moved_to');
    assert.equal(rowOf(await list(U.admin), PERSONAL), undefined);
    const owner = await call('GET', `/api/admin/inbox/${PERSONAL}`, { token: U.manager.token });
    const mailRows = (body) => body.thread.filter((r) => String(r.ref || '').startsWith('gm:')).map((r) => r.text);
    assert.deepEqual([owner.status, mailRows(owner.body)], [200, ['Dinner on Sunday?']]);
    const moved = await call('GET', `/api/admin/inbox/${FRIEND_BUSINESS}`, { token: U.admin.token });
    assert.deepEqual([moved.status, moved.body.code, moved.body.moved_to], [404, 'INBOX_MOVED', `c-${friendClient}`]);
    const theirItem = await call('GET', `/api/admin/inbox/c-${friendClient}`, { token: U.admin.token });
    assert.deepEqual(mailRows(theirItem.body), ['Do you do corporate events?'], 'the client item never holds the personal mail');
  } finally {
    engine.__resetEngine();
  }
});
