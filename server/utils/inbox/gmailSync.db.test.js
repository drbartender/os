// gmailSync.js's statements against Postgres (the shared dev DB), so the
// lease, the cursor, the insert gate, the skip upsert and the Zola link are
// verified by the database, not by a stub that restates them. gmail_sync_state
// is a single row (id = 1) that cannot carry a test prefix, so every test runs
// inside ONE transaction that is always rolled back: nothing here ever
// commits. The tick's own per-message BEGIN, COMMIT and ROLLBACK become
// savepoints inside it. Message ids and Zola labels still carry zz-test-, and
// a crashed run leaves nothing behind (an open transaction dies with its
// connection). The Gmail client is a stub; nothing reaches Google. Every
// person, address and body here is invented.
require('dotenv').config();

const { test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { pool, initDb } = require('../../db');

if (process.env.NODE_ENV === 'production') throw new Error('gmailSync.db.test.js refuses to run against production');

const { GmailError, GMAIL_MAILBOX } = require('../gmailClient');
const { buildPeopleIndex } = require('./people');
const {
  makeGmailSyncTick, ensureStateRow, claimLease, releaseLease, SQL, _resetGmailSyncForTest, GMAIL_UNAVAILABLE_SKIP_TICKS,
} = require('./gmailSync');
const rules = require('./gmailRules');
const { GMAIL_SKIP_ATTEMPTS, GMAIL_LEASE_SECONDS, ZOLA_VENDOR_ADDRESS, INBOX_HISTORY_START, PERSONAL_ALIAS } = require('./constants');

const FLOOR = String(Math.floor(Date.parse(INBOX_HISTORY_START) / 1000));

const INDEX = buildPeopleIndex({ env: {} });
const sentry = { calls: [], captureMessage(msg, ctx) { this.calls.push({ msg, ctx }); } };

// The schema as this lane declares it (gmail_messages.bounced_to,
// gmail_sync_skips.unavailable, the Zola indexes), applied the way the other
// inbox DB suites apply it.
before(() => initDb());

beforeEach(() => {
  _resetGmailSyncForTest();
  sentry.calls = [];
  for (const level of ['log', 'warn']) mock.method(console, level, () => {});
});
afterEach(() => mock.restoreAll());
after(() => pool.end());

// One transaction for the whole test, rolled back at the end. `poison` names
// gmail ids whose insert fails inside Postgres (a real error in the
// savepoint, then a real ROLLBACK TO it).
async function inRolledBackTx(fn, { poison = new Set() } = {}) {
  const conn = await pool.connect();
  let depth = 0;
  const savepointed = {
    query: async (sql, params) => {
      if (sql === 'BEGIN') { depth += 1; return conn.query(`SAVEPOINT gm_${depth}`); }
      if (sql === 'COMMIT') { depth -= 1; return conn.query(`RELEASE SAVEPOINT gm_${depth + 1}`); }
      if (sql === 'ROLLBACK') { depth -= 1; return conn.query(`ROLLBACK TO SAVEPOINT gm_${depth + 1}`); }
      if (/INSERT INTO gmail_messages/.test(sql) && poison.has(params[0])) await conn.query('SELECT 1 / 0');
      return conn.query(sql, params);
    },
    release: () => {},
  };
  const db = { query: (sql, params) => conn.query(sql, params), connect: async () => savepointed };
  try {
    await conn.query('BEGIN');
    await fn(db);
  } finally {
    await conn.query('ROLLBACK').catch(() => {});
    conn.release();
  }
}

const b64 = (s) => Buffer.from(s).toString('base64url');
function mail(id, {
  labels = ['INBOX', 'CATEGORY_PERSONAL'], from = 'Jamie Q <jamie.q@example.com>', to = GMAIL_MAILBOX, subject = 'Bar for our party',
  body = 'Hi, do you have the 14th open?', extra = [], messageId = `<${id}@mail.example.com>`, inReplyTo = null, threadId = `th-${id}`,
  at = '2026-10-12T15:00:00Z',
} = {}) {
  const headers = [['From', from], ['To', to], ['Subject', subject], ['Message-ID', messageId], ...extra];
  if (inReplyTo) headers.push(['In-Reply-To', inReplyTo]);
  return {
    id, threadId, labelIds: labels, internalDate: String(Date.parse(at)),
    payload: { mimeType: 'text/plain', headers: headers.map(([name, value]) => ({ name, value })), body: { data: b64(body) } },
  };
}
const AUTH = 'mx.google.com; dkim=pass header.i=@zola.com header.s=s1 header.b=Ab1; dmarc=pass (p=REJECT) header.from=zola.com';
// pages answers the second listing pass (everything but Sent), sentPages the first.
function gmail({ messages = [], history = [], latest = '1100', pages = null, sentPages = null, profileHistoryId = '5000' }) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const fetched = [];
  return {
    fetched,
    getProfile: async () => ({ data: { historyId: profileHistoryId } }),
    listMessages: async ({ q, pageToken }) => {
      const set = (q.startsWith('in:sent ') ? sentPages : pages) || [];
      const at = Number(pageToken || 0);
      const next = at + 1 < set.length ? String(at + 1) : undefined;
      return { data: { messages: (set[at] || []).map((id) => ({ id })), nextPageToken: next } };
    },
    listHistory: async ({ startHistoryId }) => ({
      data: { history: history.filter((r) => BigInt(r.id) > BigInt(startHistoryId)), historyId: latest },
    }),
    getMessage: async (id) => {
      fetched.push(id);
      const m = byId.get(id);
      return m ? { data: structuredClone(m) } : { error: new GmailError('GmailNotFoundError', 404, 'api') };
    },
  };
}
const records = (ids) => ids.map((id, i) => ({ id: String(1001 + i), messagesAdded: [{ message: { id, labelIds: ['INBOX'] } }] }));
const tickFor = (client, db) => makeGmailSyncTick({ client, db, sentry, loadIndex: async () => INDEX, cache: { invalidate() {} } });
const stateOf = async (db) => (await db.query(
  'SELECT history_id, backfill_page, backfill_done, lease_owner, lease_until, last_ok_at, last_error, consecutive_errors FROM gmail_sync_state WHERE id = 1'
)).rows[0];
async function steady(db, historyId = '1000') {
  await ensureStateRow(db);
  await db.query(
    `UPDATE gmail_sync_state SET history_id = $1, backfill_page = NULL, backfill_done = true, lease_owner = NULL,
            lease_until = NULL, consecutive_errors = 0 WHERE id = 1`,
    [historyId]
  );
}

test('the lease on Postgres: one row, claimed when free, refused while held, re-claimed by its owner, claimed when expired', async () => {
  await inRolledBackTx(async (db) => {
    await db.query('DELETE FROM gmail_sync_state WHERE id = 1');
    await ensureStateRow(db);
    await ensureStateRow(db);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM gmail_sync_state')).rows[0].n, 1);
    const a = await claimLease(db, 'zz-test-owner-a');
    assert.deepEqual([a.history_id, a.backfill_page, a.backfill_done, a.last_ok_at], [null, null, false, null]);
    const held = await db.query("SELECT EXTRACT(EPOCH FROM (lease_until - NOW()))::int AS s FROM gmail_sync_state WHERE id = 1");
    assert.equal(held.rows[0].s, GMAIL_LEASE_SECONDS);
    assert.equal(GMAIL_LEASE_SECONDS, 180);
    assert.equal(await claimLease(db, 'zz-test-owner-b'), null, 'refused while another owner holds it');
    assert.ok(await claimLease(db, 'zz-test-owner-a'), 'its own owner may re-claim');
    await db.query("UPDATE gmail_sync_state SET lease_until = NOW() - INTERVAL '1 second' WHERE id = 1");
    assert.ok(await claimLease(db, 'zz-test-owner-b'), 'claimed once expired');
    await releaseLease(db, 'zz-test-owner-a');
    assert.equal((await stateOf(db)).lease_owner, 'zz-test-owner-b', 'only the owner releases');
    assert.equal((await db.query(SQL.tickError, ['SomeError', 'zz-test-owner-a'])).rows.length, 0, 'a tick that lost its lease records nothing');
    assert.equal((await stateOf(db)).consecutive_errors, 0);
    assert.deepEqual((await db.query(SQL.tickError, ['SomeError', 'zz-test-owner-b'])).rows, [{ consecutive_errors: 1 }]);
    await releaseLease(db, 'zz-test-owner-b');
    const s = await stateOf(db);
    assert.deepEqual([s.lease_owner, s.lease_until], [null, null]);
  });
});

test('the first sync on Postgres: history id, the JSON cursor across ticks, backfill_done, the row as stored', async () => {
  await inRolledBackTx(async (db) => {
    await db.query('DELETE FROM gmail_sync_state WHERE id = 1');
    const ids = Array.from({ length: 55 }, (_, i) => `zz-test-f${String(i).padStart(2, '0')}`);
    const client = gmail({ pages: [ids], messages: ids.map((id) => mail(id)), profileHistoryId: '4242' });
    const tick = tickFor(client, db);
    const one = await tick();
    assert.equal(one.stored, 50);
    let s = await stateOf(db);
    assert.equal(s.history_id, '4242');
    assert.equal(s.backfill_done, false);
    const cursor = JSON.parse(s.backfill_page);
    assert.deepEqual([cursor.after, cursor.phase, cursor.page, cursor.done.length], [FLOOR, 'all', null, 50]);
    const two = await tick();
    assert.equal(two.stored, 5);
    s = await stateOf(db);
    assert.deepEqual([s.backfill_done, s.backfill_page, s.consecutive_errors, s.lease_owner], [true, null, 0, null]);
    assert.ok(s.last_ok_at);
    assert.equal(new Set(client.fetched).size, client.fetched.length, 'nothing fetched twice');
    const row = (await db.query(
      `SELECT direction, kind, from_address, from_name, to_addresses, subject, text, attachments, message_id_header,
              in_reply_to, failed, zola_lead_id, at
         FROM gmail_messages WHERE gmail_id = $1`, ['zz-test-f00']
    )).rows[0];
    assert.deepEqual(
      [row.direction, row.kind, row.from_address, row.from_name, row.to_addresses, row.subject, row.text, row.attachments,
        row.message_id_header, row.in_reply_to, row.failed, row.zola_lead_id, row.at.toISOString()],
      ['in', 'message', 'jamie.q@example.com', 'Jamie Q', [GMAIL_MAILBOX], 'Bar for our party', 'Hi, do you have the 14th open?', 0,
        '<zz-test-f00@mail.example.com>', null, false, null, '2026-10-12T15:00:00.000Z']
    );
  });
});

test('steady state on Postgres: a Sent row, its bounce, a Zola notice and its lead, a NUL body, the insert gate', async () => {
  await inRolledBackTx(async (db) => {
    await steady(db);
    const messages = [
      mail('zz-test-s1', { labels: ['SENT'], from: GMAIL_MAILBOX, to: 'Jamie Q <jamie.q@example.com>', messageId: '<zz-test-s1@mail.gmail.com>' }),
      mail('zz-test-b1', {
        from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)',
        inReplyTo: '<zz-test-s1@mail.gmail.com>', extra: [['Auto-Submitted', 'auto-replied']],
      }),
      mail('zz-test-z1', {
        from: `Zola <${ZOLA_VENDOR_ADDRESS}>`, subject: 'New message from zz-test Alex B & Sam C for Dr. Bartender',
        labels: ['INBOX', 'CATEGORY_UPDATES'], extra: [['Authentication-Results', AUTH]],
      }),
      mail('zz-test-n1', { body: 'see you\u0000 then' }),
      mail('zz-test-q1', { from: `Zola <${ZOLA_VENDOR_ADDRESS}>`, subject: 'New Zola inquiry for Dr. Bartender', labels: ['INBOX'], extra: [['Authentication-Results', AUTH]] }),
      mail('zz-test-q2', { from: `Zola <${ZOLA_VENDOR_ADDRESS}>`, subject: 'New Zola inquiry for Dr. Bartender', labels: ['INBOX'], extra: [['Authentication-Results', AUTH]] }),
      mail('zz-test-r1', { from: 'events@venue.example.com', labels: ['INBOX', 'CATEGORY_UPDATES'], inReplyTo: '<zz-test-s1@mail.gmail.com>' }),
    ];
    const ids = messages.map((m) => m.id);
    const client = gmail({ history: records(ids), messages });
    const sum = await tickFor(client, db)();
    assert.deepEqual([sum.stored, sum.unparsed, sum.failed], [7, 3, 0]);
    const rows = new Map((await db.query(
      'SELECT gmail_id, direction, kind, failed, text, zola_lead_id FROM gmail_messages WHERE gmail_id = ANY($1::text[])', [ids]
    )).rows.map((r) => [r.gmail_id, r]));
    assert.deepEqual([rows.get('zz-test-s1').direction, rows.get('zz-test-s1').failed], ['out', true], 'the bounce marked the Sent row');
    assert.deepEqual([rows.get('zz-test-b1').kind, rows.get('zz-test-b1').text], ['bounce', null]);
    assert.equal(rows.get('zz-test-n1').text, 'see you then');
    assert.equal(rows.get('zz-test-r1').kind, 'message', 'a reply to our stored Sent mail counts whatever its category');
    const z = rows.get('zz-test-z1');
    assert.deepEqual([z.kind, z.text], ['zola_unparsed', null]);
    const lead = (await db.query('SELECT couple_label, couple_label_key FROM zola_leads WHERE id = $1', [z.zola_lead_id])).rows[0];
    assert.deepEqual([lead.couple_label, lead.couple_label_key], ['zz-test Alex B & Sam C', 'zz-test alex b & sam c']);
    const [q1, q2] = [rows.get('zz-test-q1').zola_lead_id, rows.get('zz-test-q2').zola_lead_id];
    assert.notEqual(q1, q2, 'two unlabeled inquiries on one day are two fresh leads');
    const fallback = (await db.query('SELECT couple_label FROM zola_leads WHERE id = ANY($1::int[]) ORDER BY id', [[q1, q2]])).rows;
    assert.deepEqual(fallback.map((r) => r.couple_label), ['Zola notice 2026-10-12', 'Zola notice 2026-10-12']);
    assert.equal((await stateOf(db)).history_id, '1100');
    const leadsBefore = (await db.query('SELECT COUNT(*)::int AS n FROM zola_leads')).rows[0].n;

    // The same window again: the unique index turns every insert into a no-op,
    // and a no-op insert runs no side effect.
    await db.query("UPDATE gmail_sync_state SET history_id = '1000' WHERE id = 1");
    await db.query("UPDATE gmail_messages SET failed = false WHERE gmail_id = 'zz-test-s1'");
    const again = await tickFor(client, db)();
    assert.equal(again.stored, 0);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM zola_leads WHERE couple_label LIKE 'zz-test %'")).rows[0].n, 1);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM zola_leads')).rows[0].n, leadsBefore, 'no lead row for a re-processed notice');
    assert.equal((await db.query("SELECT failed FROM gmail_messages WHERE gmail_id = 'zz-test-s1'")).rows[0].failed, false);
  });
});

test('a poison message on Postgres: the savepoint rolls back, attempts 1, 2, 3 in gmail_sync_skips, then the window advances', async () => {
  await inRolledBackTx(async (db) => {
    await steady(db);
    const ids = ['zz-test-a1', 'zz-test-p1', 'zz-test-c1'];
    const client = gmail({ history: records(ids), messages: ids.map((id) => mail(id)) });
    const attempts = async () => (await db.query('SELECT attempts, last_error FROM gmail_sync_skips WHERE gmail_id = $1', ['zz-test-p1'])).rows[0];
    const first = await tickFor(client, db)();
    assert.deepEqual([first.stored, first.failed], [2, 1]);
    assert.deepEqual(await attempts(), { attempts: 1, last_error: 'DatabaseError 22012' });
    assert.equal((await stateOf(db)).history_id, '1001');
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM gmail_messages WHERE gmail_id = 'zz-test-p1'")).rows[0].n, 0);
    await tickFor(client, db)();
    assert.equal((await attempts()).attempts, 2);
    const third = await tickFor(client, db)();
    assert.equal(third.skipped, 1);
    assert.equal((await attempts()).attempts, GMAIL_SKIP_ATTEMPTS);
    assert.equal((await stateOf(db)).history_id, '1100');
    assert.equal(sentry.calls.filter((c) => c.ctx.tags.issue === 'skip').length, 1);
  }, { poison: new Set(['zz-test-p1']) });
});

test('a failing tick on Postgres: last_error holds the class, consecutive_errors counts, the lease is released', async () => {
  await inRolledBackTx(async (db) => {
    await steady(db);
    const client = gmail({});
    client.listHistory = async () => ({ error: new GmailError('GmailAuthError', 401, 'token') });
    for (let i = 0; i < 3; i += 1) await tickFor(client, db)();
    const s = await stateOf(db);
    assert.deepEqual([s.last_error, s.consecutive_errors, s.lease_owner], ['GmailAuthError:token', 3, null]);
    assert.equal(sentry.calls.filter((c) => c.ctx.tags.issue === 'failing').length, 1);
  });
});

// 118 of the 120 Sent rows carry no Message-ID: a NULL sorts first under
// DESC, so the ordering must not let them outrank the named rows.
test('a long thread cannot crowd the Sent row a bounce names out of the lookup', async () => {
  await inRolledBackTx(async (db) => {
    await steady(db);
    await db.query(
      `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, message_id_header, at)
       SELECT 'zz-test-long' || g, 'zz-test-thread-long', 'out', 'message', $1,
              CASE WHEN g IN (1, 120) THEN '<zz-test-long' || g || '@mail.gmail.com>' END, NOW()
         FROM generate_series(1, 120) AS g`,
      [GMAIL_MAILBOX]
    );
    const dsn = (id, named) => mail(id, {
      from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', threadId: 'zz-test-thread-long',
      inReplyTo: named, extra: [['Auto-Submitted', 'auto-replied']],
    });
    const messages = [dsn('zz-test-bo', '<zz-test-long1@mail.gmail.com>'), dsn('zz-test-bn', '<zz-test-long120@mail.gmail.com>')];
    const sum = await tickFor(gmail({ history: records(messages.map((m) => m.id)), messages }), db)();
    assert.equal(sum.stored, 2);
    const failed = (await db.query(
      "SELECT gmail_id FROM gmail_messages WHERE thread_id = 'zz-test-thread-long' AND failed ORDER BY gmail_id"
    )).rows.map((r) => r.gmail_id);
    assert.deepEqual(failed, ['zz-test-long1', 'zz-test-long120'], 'the oldest and the newest of 120, and nothing else');
  });
});

// ─── the review round (2026-10-15) ───

test('per-recipient bounces on Postgres: each report adds its failed addresses to the Sent row; one that names none fails it whole', async () => {
  await inRolledBackTx(async (db) => {
    await steady(db);
    await db.query(
      `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, message_id_header, at)
       VALUES ('zz-test-sb', 'zz-test-tsb', 'out', 'message', $1, ARRAY['pat@example.com', 'bad.cc@example.com', 'old.cc@example.com'],
               '<zz-test-sb@mail.gmail.com>', NOW())`,
      [GMAIL_MAILBOX]
    );
    // The report's failed recipients, as gmailRules hands them over.
    const named = new Map([['zz-test-d1', ['Bad.CC@example.com']], ['zz-test-d2', ['old.cc@example.com', 'bad.cc@example.com']], ['zz-test-d3', []]]);
    const real = rules.classifyMessage;
    mock.method(rules, 'classifyMessage', (args) => {
      const verdict = real(args);
      const id = args.headers.get('message-id').slice(1).split('@')[0];
      return verdict.kind === 'bounce' && named.has(id) ? { ...verdict, bouncedTo: named.get(id) } : verdict;
    });
    const dsn = (id) => mail(id, {
      from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', threadId: 'zz-test-tsb',
      inReplyTo: '<zz-test-sb@mail.gmail.com>', extra: [['Auto-Submitted', 'auto-replied']],
    });
    const sent = async () => (await db.query("SELECT failed, bounced_to FROM gmail_messages WHERE gmail_id = 'zz-test-sb'")).rows[0];
    const bounced = async (id) => (await db.query('SELECT kind, bounced_to FROM gmail_messages WHERE gmail_id = $1', [id])).rows[0];
    const run = async (id) => {
      await db.query("UPDATE gmail_sync_state SET history_id = '1000' WHERE id = 1");
      return (await tickFor(gmail({ history: records([id]), messages: [dsn(id)] }), db)()).stored;
    };
    assert.equal(await run('zz-test-d1'), 1);
    assert.deepEqual(await sent(), { failed: true, bounced_to: ['bad.cc@example.com'] });
    assert.deepEqual(await bounced('zz-test-d1'), { kind: 'bounce', bounced_to: ['bad.cc@example.com'] });
    assert.equal(await run('zz-test-d2'), 1);
    assert.deepEqual(await sent(), { failed: true, bounced_to: ['bad.cc@example.com', 'old.cc@example.com'] }, 'merged once each, in order');
    assert.equal(await run('zz-test-d3'), 1);
    assert.deepEqual(await sent(), { failed: true, bounced_to: null }, 'a report naming nobody fails every recipient');
    assert.deepEqual(await bounced('zz-test-d3'), { kind: 'bounce', bounced_to: null });
  });
});

test('our own auto-reply on Postgres is no stored Sent mail: an unknown sender in its thread is filtered as bulk', async () => {
  await inRolledBackTx(async (db) => {
    await steady(db);
    await db.query(
      `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, message_id_header, at)
       VALUES ('zz-test-vac', 'zz-test-tvac', 'out', 'auto_reply', $1, ARRAY['deals@shop.example.com'], '<zz-test-vac@mail.gmail.com>', NOW())`,
      [GMAIL_MAILBOX]
    );
    const promo = mail('zz-test-pr', {
      from: 'deals@shop.example.com', labels: ['INBOX', 'CATEGORY_PROMOTIONS'], threadId: 'zz-test-tvac', inReplyTo: '<zz-test-vac@mail.gmail.com>',
    });
    const sum = await tickFor(gmail({ history: records([promo.id]), messages: [promo] }), db)();
    assert.deepEqual([sum.stored, sum.dropped], [0, 1]);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM gmail_messages WHERE gmail_id = 'zz-test-pr'")).rows[0].n, 0);
  });
});

test('a message Gmail never answers on Postgres: its own count in gmail_sync_skips, then skipped for good, attempts untouched', async () => {
  await inRolledBackTx(async (db) => {
    await steady(db);
    const ids = ['zz-test-u1', 'zz-test-ux', 'zz-test-u2'];
    const client = gmail({ history: records(ids), messages: ids.map((id) => mail(id)) });
    const get = client.getMessage;
    client.getMessage = async (id) => (id === 'zz-test-ux' ? { error: new GmailError('GmailUnavailableError', 503, 'api') } : get(id));
    const row = async () => (await db.query("SELECT attempts, unavailable, last_error FROM gmail_sync_skips WHERE gmail_id = 'zz-test-ux'")).rows[0];
    const first = await tickFor(client, db)();
    assert.deepEqual([first.stored, first.failed], [2, 1]);
    assert.deepEqual(await row(), { attempts: 0, unavailable: 1, last_error: 'GmailUnavailableError:api' });
    assert.equal((await stateOf(db)).history_id, '1001');
    for (let i = 2; i <= GMAIL_UNAVAILABLE_SKIP_TICKS; i += 1) await tickFor(client, db)();
    assert.deepEqual(await row(), { attempts: 0, unavailable: GMAIL_UNAVAILABLE_SKIP_TICKS, last_error: 'GmailUnavailableError:api' });
    assert.equal(sentry.calls.filter((c) => c.ctx.tags.issue === 'skip').length, 1);
    const s = await stateOf(db);
    assert.deepEqual([s.history_id, s.consecutive_errors], ['1100', 0], 'skipped for good, the window advances on the strike that skips it');
  });
});

test('a lost lease on Postgres: the cursor write changes no row and the tick stops, recording nothing', async () => {
  await inRolledBackTx(async (db) => {
    await steady(db);
    const client = gmail({ history: records(['zz-test-l1']), messages: [mail('zz-test-l1')] });
    const get = client.getMessage;
    client.getMessage = async (id) => {
      await db.query("UPDATE gmail_sync_state SET lease_owner = 'zz-test-owner-b', lease_until = NOW() + INTERVAL '1 minute' WHERE id = 1");
      return get(id);
    };
    const sum = await tickFor(client, db)();
    assert.equal(sum.stored, 1);
    const s = await stateOf(db);
    assert.deepEqual([s.history_id, s.lease_owner, s.consecutive_errors], ['1000', 'zz-test-owner-b', 0]);
  });
});

test('the schema this lane declares is on the database: bounced_to, personal, personal_to, unavailable and the two partial Zola indexes', async () => {
  const cols = (await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND ((table_name = 'gmail_messages' AND column_name IN ('bounced_to', 'personal', 'personal_to'))
         OR (table_name = 'gmail_sync_skips' AND column_name = 'unavailable')) ORDER BY table_name, column_name`
  )).rows;
  assert.deepEqual(cols.map((c) => [c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default]), [
    ['gmail_messages', 'bounced_to', 'ARRAY', 'YES', null],
    ['gmail_messages', 'personal', 'boolean', 'NO', 'false'],
    ['gmail_messages', 'personal_to', 'ARRAY', 'YES', null],
    ['gmail_sync_skips', 'unavailable', 'integer', 'NO', '0'],
  ]);
  const ix = (await pool.query(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('idx_gmail_messages_zola_at', 'idx_gmail_messages_zola_lead') ORDER BY indexname"
  )).rows;
  assert.equal(ix.length, 2);
  for (const r of ix) assert.match(r.indexdef, /WHERE \(zola_lead_id IS NOT NULL\)/, r.indexname);
});

// Personal mail on Postgres (spec 2026-10-14 decision 6, as the owner decided
// it on 2026-10-15): the sync's own lookups against real clients, leads and
// staff rows, each made before or after the mail, and the readers over what
// was stored. Every record is inside the rolled-back transaction.
test('personal mail on Postgres: judged once at storage by the records that existed when each mail arrived, and read on its own person', async () => {
  const { loadPeopleIndex, personalEmailKey, emailHash } = require('./people');
  const { MAIL_HEADERS_SQL } = require('./readGmail');
  const { mapMailHeaders } = require('./readZola');
  const at = '2026-10-12T15:00:00Z';
  const before = '2026-10-01T00:00:00Z';
  const who = (name) => `zz-test-${name}@example.com`;
  await inRolledBackTx(async (db) => {
    await steady(db);
    const client = async (name, createdAt) => (await db.query(
      'INSERT INTO clients (name, email, created_at) VALUES ($1, $2, COALESCE($3::timestamptz, NOW())) RETURNING id',
      [`zz-test ${name}`, who(name), createdAt]
    )).rows[0].id;
    const wasClient = await client('was.client', before);
    const laterClient = await client('later.client', null); // made now, after the mail
    for (const [name, createdAt] of [['lead', before], ['late.lead', null]]) {
      await db.query('INSERT INTO email_leads (name, email, created_at) VALUES ($1, $2, COALESCE($3::timestamptz, NOW()))', [`zz-test ${name}`, who(name), createdAt]);
    }
    const staff = (await db.query(
      "INSERT INTO users (email, password_hash, role, onboarding_status, token_version, created_at) VALUES ($1, 'x', 'staff', 'approved', 0, $2) RETURNING id",
      [who('staffer'), before]
    )).rows[0].id;
    await db.query('INSERT INTO contractor_profiles (user_id, preferred_name, created_at) VALUES ($1, $2, $3)', [staff, 'Kai', before]);
    await db.query('INSERT INTO agreements (user_id, full_name, sms_consent, created_at) VALUES ($1, $2, true, $3)', [staff, 'Kai Example', before]);

    const toAlias = (id, name, opts = {}) => mail(id, { from: `Robin <${who(name)}>`, to: PERSONAL_ALIAS, threadId: `th-${id}`, at, ...opts });
    const messages = [
      toAlias('zz-test-p1', 'friend'),
      toAlias('zz-test-p2', 'was.client'),
      toAlias('zz-test-p3', 'later.client'),
      toAlias('zz-test-p4', 'lead'),
      toAlias('zz-test-p5', 'late.lead'),
      toAlias('zz-test-p6', 'staffer'),
      toAlias('zz-test-p7', 'friend', { to: 'Someone Else <someone.else@example.com>' }),
      toAlias('zz-test-p8', 'friend', { to: `${PERSONAL_ALIAS}, ${GMAIL_MAILBOX}` }),
      toAlias('zz-test-p9', 'friend', { to: GMAIL_MAILBOX }),
      mail('zz-test-s1', {
        labels: ['SENT'], from: `Dallas <${PERSONAL_ALIAS}>`, to: `${who('friend')}, ${who('was.client')}`, threadId: 'th-zz-test-p1',
        inReplyTo: '<zz-test-p1@mail.example.com>', messageId: '<zz-test-s1@mail.gmail.com>', at: '2026-10-12T16:00:00Z',
      }),
      mail('zz-test-s2', {
        labels: ['SENT'], from: GMAIL_MAILBOX, to: who('friend'), threadId: 'th-zz-test-p9', inReplyTo: '<zz-test-p9@mail.example.com>',
        messageId: '<zz-test-s2@mail.gmail.com>', at: '2026-10-12T16:00:00Z',
      }),
      mail('zz-test-s3', {
        labels: ['SENT'], from: GMAIL_MAILBOX, to: who('friend'), threadId: 'th-zz-test-p3', inReplyTo: '<zz-test-p3@mail.example.com>',
        messageId: '<zz-test-s3@mail.gmail.com>', at: '2026-10-12T16:00:00Z',
      }),
      // Answering decides first: the alias answering the friend's business mail.
      mail('zz-test-s4', {
        labels: ['SENT'], from: `Dallas <${PERSONAL_ALIAS}>`, to: who('friend'), threadId: 'th-zz-test-p9', inReplyTo: '<zz-test-p9@mail.example.com>',
        messageId: '<zz-test-s4@mail.gmail.com>', at: '2026-10-12T16:00:00Z',
      }),
      // A fresh send from the alias to someone nobody knew, copying the client.
      mail('zz-test-s5', {
        labels: ['SENT'], from: PERSONAL_ALIAS, to: `${who('new.pal')}, ${who('was.client')}`, threadId: 'th-zz-test-s5',
        messageId: '<zz-test-s5@mail.gmail.com>', at: '2026-10-12T16:00:00Z',
      }),
    ];
    const ids = messages.map((m) => m.id);
    const sum = await tickFor(gmail({ history: records(ids), messages }), db)();
    assert.deepEqual([sum.stored, sum.failed], [ids.length, 0]);
    const stored = new Map((await db.query(
      'SELECT gmail_id, personal, personal_to FROM gmail_messages WHERE gmail_id = ANY($1::text[])', [ids]
    )).rows.map((r) => [r.gmail_id, [r.personal, r.personal_to]]));
    assert.deepEqual(ids.map((id) => [id, ...stored.get(id)]), [
      ['zz-test-p1', true, null], // to the alias alone, from someone nobody knew
      ['zz-test-p2', false, null], // a client when it arrived
      ['zz-test-p3', true, null], // a client made after it arrived does not unhide it
      ['zz-test-p4', false, null], // a marketing lead when it arrived
      ['zz-test-p5', true, null], // a lead made after it
      ['zz-test-p6', false, null], // a send-eligible staffer when it arrived
      ['zz-test-p7', true, null], // To and Cc name none of ours: we were Bcc'd
      ['zz-test-p8', false, null], // the business mailbox in copy
      ['zz-test-p9', false, null], // the same friend to the business mailbox
      ['zz-test-s1', true, [who('friend')]], // the owner's reply from the alias; the client it copies stays business
      ['zz-test-s2', false, null], // a business reply to the business mail
      ['zz-test-s3', true, [who('friend')]], // from the mailbox, answering a personal mail at another address (a Reply-To)
      ['zz-test-s4', false, null], // from the alias, answering a business mail: answering decides
      ['zz-test-s5', true, [who('new.pal')]], // a fresh send from the alias; the client it copies stays business
    ]);

    // The readers over those rows, with the index as it is NOW (the later
    // client exists): the personal rows stay on their own people.
    const index = await loadPeopleIndex(db);
    const rows = (await db.query(MAIL_HEADERS_SQL, [INBOX_HISTORY_START])).rows.filter((r) => ids.includes(r.gmail_id));
    const keysOf = (gmailId) => mapMailHeaders(rows, index).filter((e) => e.meta.gmailId === gmailId)
      .map((e) => [e.personKey, e.meta.personal]).sort();
    const friendPersonal = personalEmailKey(who('friend'));
    const friendBusiness = `e-${emailHash(who('friend'))}`;
    assert.deepEqual(keysOf('zz-test-p1'), [[friendPersonal, true]]);
    assert.deepEqual(keysOf('zz-test-p3'), [[personalEmailKey(who('later.client')), true]], 'not the client it names now');
    assert.notEqual(personalEmailKey(who('later.client')), `c-${laterClient}`);
    assert.deepEqual(keysOf('zz-test-p2'), [[`c-${wasClient}`, false]]);
    assert.deepEqual(keysOf('zz-test-p9'), [[friendBusiness, false]], 'the same friend\'s business mail is a business person');
    assert.deepEqual(keysOf('zz-test-s1'), [[`c-${wasClient}`, false], [friendPersonal, true]].sort());
    assert.deepEqual(keysOf('zz-test-s2'), [[friendBusiness, false]]);
    assert.deepEqual(keysOf('zz-test-s3'), [[personalEmailKey(who('later.client')), true], [friendPersonal, true]].sort(),
      'the asker of the personal mail it answers, and the friend it went to');
    assert.deepEqual(keysOf('zz-test-s4'), [[friendBusiness, false]], 'the business item gets the alias\'s reply');
    assert.deepEqual(keysOf('zz-test-s5'), [[`c-${wasClient}`, false], [personalEmailKey(who('new.pal')), true]].sort());
  });
});

// The 2026-10-15 fix-up round, on Postgres: the first sync's Sent-first order,
// a Message-ID reused by a later mail, an operator in copy, and the indexes
// the known-at lookup reads through.
test('a reply the first sync stored before the personal mail it answers: each recipient nobody knows lands personal, a copied client stays business', async () => {
  const { loadPeopleIndex, personalEmailKey } = require('./people');
  const { MAIL_HEADERS_SQL } = require('./readGmail');
  const { mapMailHeaders } = require('./readZola');
  const who = (name) => `zz-test-${name}@example.com`;
  await inRolledBackTx(async (db) => {
    await steady(db);
    const client = (await db.query(
      "INSERT INTO clients (name, email, created_at) VALUES ('zz-test copied', $1, '2026-10-01') RETURNING id", [who('copied.client')]
    )).rows[0].id;
    const reply = mail('zz-test-r1', {
      labels: ['SENT'], from: GMAIL_MAILBOX, to: `${who('friend')}, ${who('spouse')}, ${who('copied.client')}`, threadId: 'th-zz-test-pp',
      inReplyTo: '<zz-test-pp@mail.example.com>', messageId: '<zz-test-r1@mail.gmail.com>', at: '2026-10-12T16:00:00Z',
    });
    const ask = mail('zz-test-pp', { from: `Robin <${who('friend')}>`, to: PERSONAL_ALIAS, threadId: 'th-zz-test-pp', at: '2026-10-12T15:00:00Z' });
    const sum = await tickFor(gmail({ history: records(['zz-test-r1', 'zz-test-pp']), messages: [reply, ask] }), db)();
    assert.equal(sum.stored, 2);
    const stored = new Map((await db.query("SELECT gmail_id, personal, personal_to FROM gmail_messages WHERE gmail_id IN ('zz-test-r1', 'zz-test-pp')"))
      .rows.map((r) => [r.gmail_id, [r.personal, r.personal_to]]));
    assert.deepEqual([stored.get('zz-test-r1'), stored.get('zz-test-pp')], [[false, null], [true, null]],
      'the sync judged the reply before its personal mail was stored: a fresh send from the mailbox');
    const index = await loadPeopleIndex(db);
    const rows = (await db.query(MAIL_HEADERS_SQL, [INBOX_HISTORY_START])).rows.filter((r) => r.gmail_id.startsWith('zz-test-'));
    const keys = mapMailHeaders(rows, index).filter((e) => e.meta.gmailId === 'zz-test-r1').map((e) => [e.personKey, e.meta.personal]).sort();
    assert.deepEqual(keys, [[personalEmailKey(who('friend')), true], [personalEmailKey(who('spouse')), true], [`c-${client}`, false]].sort());
  });
});

test('a later mail that reuses a Message-ID never takes a reply away from the personal mail it answers, at sync time and at read time', async () => {
  const { loadPeopleIndex, personalEmailKey } = require('./people');
  const { MAIL_HEADERS_SQL } = require('./readGmail');
  const { mapMailHeaders } = require('./readZola');
  const who = (name) => `zz-test-${name}@example.com`;
  const shared = '<zz-test-shared@mail.example.com>';
  await inRolledBackTx(async (db) => {
    await steady(db);
    // Stored first (the backfill lists newer pages first), dated after the reply.
    const reuse = mail('zz-test-mx', { from: `Kim <${who('kim')}>`, to: GMAIL_MAILBOX, messageId: shared, threadId: 'th-zz-test-mx', at: '2026-10-12T17:00:00Z' });
    const ask = mail('zz-test-p20', { from: `Robin <${who('friend')}>`, to: PERSONAL_ALIAS, messageId: shared, threadId: 'th-zz-test-p20', at: '2026-10-12T15:00:00Z' });
    const reply = mail('zz-test-r20', {
      labels: ['SENT'], from: GMAIL_MAILBOX, to: who('friend'), inReplyTo: shared, threadId: 'th-zz-test-p20',
      messageId: '<zz-test-r20@mail.gmail.com>', at: '2026-10-12T16:00:00Z',
    });
    const ids = ['zz-test-mx', 'zz-test-p20', 'zz-test-r20'];
    assert.equal((await tickFor(gmail({ history: records(ids), messages: [reuse, ask, reply] }), db)()).stored, 3);
    const row = (await db.query("SELECT personal, personal_to FROM gmail_messages WHERE gmail_id = 'zz-test-r20'")).rows[0];
    assert.deepEqual([row.personal, row.personal_to], [true, [who('friend')]], 'the sync paired it with the personal mail');
    const index = await loadPeopleIndex(db);
    const rows = (await db.query(MAIL_HEADERS_SQL, [INBOX_HISTORY_START])).rows.filter((r) => ids.includes(r.gmail_id));
    assert.deepEqual(mapMailHeaders(rows, index).filter((e) => e.meta.gmailId === 'zz-test-r20').map((e) => [e.personKey, e.meta.personal]),
      [[personalEmailKey(who('friend')), true]], 'and so did the reader');
  });
});

test('an operator in copy on Postgres: mail to the alias that names an admin\'s or manager\'s own address is business', async () => {
  const { loadEmailIndex } = require('./people');
  const who = (name) => `zz-test-${name}@example.com`;
  await inRolledBackTx(async (db) => {
    await steady(db);
    await db.query(
      "INSERT INTO users (email, password_hash, role, onboarding_status, token_version, created_at) VALUES ($1, 'x', 'manager', 'approved', 0, '2026-09-01')",
      [who('ops')]
    );
    const messages = [
      mail('zz-test-o1', { from: `Robin <${who('friend')}>`, to: PERSONAL_ALIAS, extra: [['Cc', `Ops <${who('ops')}>`]] }),
      mail('zz-test-o2', { from: `Robin <${who('friend')}>`, to: who('ops').replace('@', '+events@') }),
      mail('zz-test-o3', { from: `Robin <${who('friend')}>`, to: PERSONAL_ALIAS }),
    ];
    const ids = messages.map((m) => m.id);
    const tick = makeGmailSyncTick({
      client: gmail({ history: records(ids), messages }), db, sentry, loadIndex: () => loadEmailIndex(db), cache: { invalidate() {} },
    });
    assert.equal((await tick()).stored, 3);
    const stored = new Map((await db.query('SELECT gmail_id, personal FROM gmail_messages WHERE gmail_id = ANY($1::text[])', [ids]))
      .rows.map((r) => [r.gmail_id, r.personal]));
    assert.deepEqual(ids.map((id) => [id, stored.get(id)]), [['zz-test-o1', false], ['zz-test-o2', false], ['zz-test-o3', true]]);
  });
});

test('the known-at lookup reads clients, email_leads and users through their normalized-address indexes', async () => {
  const personalMail = require('./personalMail');
  const defs = (await pool.query(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('idx_clients_email_norm', 'idx_email_leads_email_norm', 'idx_users_email_norm') ORDER BY indexname"
  )).rows;
  assert.deepEqual(defs.map((r) => r.indexname), ['idx_clients_email_norm', 'idx_email_leads_email_norm', 'idx_users_email_norm']);
  for (const r of defs) assert.match(r.indexdef, /lower\(btrim\(\(?email\)?(::text)?\)\)/, r.indexname);
  await inRolledBackTx(async (db) => {
    await db.query('SET LOCAL enable_seqscan = off');
    const plan = (await db.query(`EXPLAIN ${personalMail.SQL.knownAt}`, [['zz-test-nobody@example.com'], new Date('2026-10-12T15:00:00Z')]))
      .rows.map((r) => r['QUERY PLAN']).join('\n');
    for (const name of ['idx_clients_email_norm', 'idx_email_leads_email_norm', 'idx_users_email_norm']) assert.match(plan, new RegExp(name), name);
  });
});
