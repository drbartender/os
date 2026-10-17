require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Sentry = require('@sentry/node');
const { pool, initDb } = require('../../db');
const { SMS_HEADERS_SQL } = require('./readSms');
const {
  HEADER_WARN_ROWS, CACHE_MS, BADGE_MAX_AGE_MS, INBOX_HISTORY_START, gmailThreadUrl, zolaLeadUrl, PERSONAL_MAILBOX_OWNER_USER_ID,
} = require('./constants');
const { loadContext } = require('./context');
const { loadFeeds } = require('./feeds');
const { personalEmailKey, emailHash } = require('./people');
const { PERSONAL_ALIAS } = require('./constants');
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
// Email rows (spec 2026-10-14): every gmail id and address starts with GM.
const GM = 'zz-test-engine';

// Everything this suite seeds, found by its tag, its client names and its phone block.
async function clean() {
  const users = (await pool.query('SELECT id FROM users WHERE email LIKE $1 OR email LIKE $2', [`${TAG}-%`, `${GM}-%`])).rows.map((r) => r.id);
  const clients = (await pool.query('SELECT id FROM clients WHERE name LIKE $1', [`%${TAG}`])).rows.map((r) => r.id);
  await pool.query('DELETE FROM gmail_messages WHERE gmail_id LIKE $1', [`${GM}-%`]);
  await pool.query('DELETE FROM inbox_reads WHERE subject_ref LIKE $1', [`gm:${GM}-%`]);
  await pool.query(
    `DELETE FROM sms_messages
      WHERE RIGHT(REGEXP_REPLACE(recipient_phone, '\\D', '', 'g'), 10) = ANY($1::text[])
         OR client_id = ANY($2::int[]) OR sender_id = ANY($3::int[])`,
    [PHONES, clients, users]
  );
  // A consult keeps its row when its proposal goes (ON DELETE SET NULL); the
  // held client's email ledger rows go with their proposal (ON DELETE CASCADE).
  await pool.query('DELETE FROM consults WHERE booker_email LIKE $1', [`${TAG}-%`]);
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
  // The schema as this lane declares it (gmail_messages.bounced_to, which the
  // snapshot's mail scan reads), applied the way the other inbox DB suites do.
  await initDb();
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
  // A Sent mail to the held client and a planner nobody knows, older than the
  // held client's question so it leaves them waiting; and one to M alone.
  await pool.query('UPDATE clients SET email = $1 WHERE id = $2', [`${GM}-h@example.com`, ids.h]);
  await pool.query('UPDATE clients SET email = $1 WHERE id = $2', [`${GM}-m@example.com`, ids.m]);
  const sent = (gmailId, to) => pool.query(
    `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, text, at)
     VALUES ($1, $1, 'out', 'message', 'contact@drbartender.com', $2::text[], 'Following up', NOW() - INTERVAL '4 hours')`,
    [gmailId, to]
  );
  await sent(`${GM}-held`, [`${GM}-h@example.com`, `${GM}-planner@example.com`]);
  await sent(`${GM}-free`, [`${GM}-m@example.com`]);
  // The held client's second address, known only from the email ledger: the
  // people index makes it an e- person, and only the full held key set ties it
  // to the hold. A planner writes first; one Sent mail answers both.
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status)
     VALUES ($1, $2, 'email', 'other', $3, 'sent')`,
    [hold.rows[0].id, ids.h, `${GM}-ledger@example.com`]
  );
  const theyWrote = (gmailId, from, text, ago) => pool.query(
    `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, text, at)
     VALUES ($1, $1, 'in', 'message', $2, ARRAY['contact@drbartender.com'], $3, NOW() - $4::interval)`,
    [gmailId, from, text, ago]
  );
  await theyWrote(`${GM}-p2ask`, `${GM}-planner2@example.com`, 'Who is bringing the ice?', '5 hours');
  // The email ledger keeps a send to an address that matches no client under
  // its proposal alone (client_id NULL, messageLog.js): that address is held
  // too, and its owner writes in.
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status)
     VALUES ($1, NULL, 'email', 'other', $2, 'sent')`,
    [hold.rows[0].id, `${GM}-stale@example.com`]
  );
  await theyWrote(`${GM}-stale-in`, `${GM}-stale@example.com`, 'Is the date still on?', '3 hours');
  // A held address at Gmail, known from the ledger. Every form Gmail
  // delivers to it, and a +tag of the held client's own address, is held:
  // as the sender (From) and as a copied recipient (To or Cc). The local
  // part is invented and holds a hyphen, which Gmail usernames never do, so
  // it can never be a real person's; a real domain is needed for the Gmail
  // folding.
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status)
     VALUES ($1, NULL, 'email', 'other', $2, 'sent')`,
    [hold.rows[0].id, 'zz-fixture.held@gmail.com']
  );
  const mailTo = (gmailId, from, to, text) => pool.query(
    `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, text, at)
     VALUES ($1, $1, 'in', 'message', $2, $3::text[], $4, NOW() - INTERVAL '2 hours')`,
    [gmailId, from, to, text]
  );
  await mailTo(`${GM}-v-from-tag`, `${GM}-h+law@example.com`, ['contact@drbartender.com'], 'From a tagged address');
  await mailTo(`${GM}-v-from-gmail`, 'ZZ-FixtureHeld+x@googlemail.com', ['contact@drbartender.com'], 'From a Gmail form');
  await mailTo(`${GM}-v-cc-gmail`, `${GM}-planner3@example.com`, ['contact@drbartender.com', 'z.z-fixture.held+cc@gmail.com'], 'Copying a Gmail form');
  await mailTo(`${GM}-v-cc-tag`, `${GM}-planner4@example.com`, ['contact@drbartender.com', `${GM}-h+cc@example.com`], 'Copying a tagged address');
  await mailTo(`${GM}-v-free`, `${GM}-hx@example.com`, ['contact@drbartender.com', `${GM}-hx+cc@example.com`], 'A different address');
  // The ledger also logs a staff notice under a proposal (client_id NULL), and
  // a ledger row can name an address that is ours: neither is a held address.
  // A staffer (a users row) and the personal alias, each on a row under the
  // held proposal; their mail, and a client's mail to the alias, stay
  // unheld, while a mail copying both the held client and the staffer is held.
  const staffer = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id",
    [`${TAG}-staffer@example.com`]
  );
  ids.users.push(staffer.rows[0].id);
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status)
     VALUES ($1, NULL, 'email', 'gratuity_removed_staff_notice', $2, 'sent'), ($1, NULL, 'email', 'other', $3, 'sent')`,
    [hold.rows[0].id, `${TAG}-Staffer+notice@example.com`, PERSONAL_ALIAS]
  );
  // Provenance, not a matching users row, decides a drop (the fleet's fourth
  // round): anyone can register an address, so an in_progress and an applied
  // account naming held ledger addresses leave them held; a consult booked
  // with an approved staffer's address stays held too.
  const registered = (email, status) => pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', 'staff', $2, 0) RETURNING id",
    [email, status]
  );
  ids.users.push((await registered(`${GM}-ledger@example.com`, 'in_progress')).rows[0].id);
  ids.users.push((await registered(`${GM}-stale@example.com`, 'applied')).rows[0].id);
  ids.users.push((await registered(`${TAG}-staffer2@example.com`, 'approved')).rows[0].id);
  // A submitted bartender (set only by an admin, the status route) on a
  // staff notice under the held proposal is a real staffer: not held. A
  // service_extension_request row is the client's copy, never a staff
  // notice, so even an approved staffer's address on one stays held.
  ids.users.push((await registered(`${TAG}-staffer3@example.com`, 'submitted')).rows[0].id);
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status)
     VALUES ($1, NULL, 'email', 'service_extension_declined', $2, 'sent')`,
    [hold.rows[0].id, `${TAG}-staffer3@example.com`]
  );
  ids.users.push((await registered(`${TAG}-staffer4@example.com`, 'approved')).rows[0].id);
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status)
     VALUES ($1, NULL, 'email', 'service_extension_request', $2, 'sent')`,
    [hold.rows[0].id, `${TAG}-staffer4@example.com`]
  );
  await pool.query(
    "INSERT INTO consults (proposal_id, scheduled_at, status, booker_email) VALUES ($1, NOW() - INTERVAL '30 days', 'cancelled', $2)",
    [hold.rows[0].id, `${TAG}-staffer2@example.com`]
  );
  // The client-row exemption: a second held client whose own address is an
  // admin's (dropped from every other source) is still held.
  const op = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id",
    [`${TAG}-op2@example.com`]
  );
  ids.users.push(op.rows[0].id);
  ids.opClient = await addClient(`Op Example ${TAG}`, null);
  await pool.query('UPDATE clients SET email = $1 WHERE id = $2', [`${TAG}-op2@example.com`, ids.opClient]);
  ids.opHold = (await pool.query("INSERT INTO proposals (client_id, status) VALUES ($1, 'draft') RETURNING id", [ids.opClient])).rows[0].id;
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status)
     VALUES ($1, NULL, 'email', 'other', $2, 'sent')`,
    [ids.opHold, `${TAG}-admin@example.com`]
  );
  await mailTo(`${GM}-o-staffer`, `${TAG}-staffer@example.com`, ['contact@drbartender.com'], 'Running ten minutes late');
  await mailTo(`${GM}-o-alias`, `${GM}-m@example.com`, [PERSONAL_ALIAS], 'A note for the owner');
  await mailTo(`${GM}-o-both`, `${GM}-planner6@example.com`, ['contact@drbartender.com', `${GM}-h@example.com`, `${TAG}-staffer@example.com`], 'Copying the client and the bartender');
  // Counsel writes with the held client's ledger address copied, then again
  // in the same thread without it.
  await pool.query(
    `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, text, at)
     VALUES ($1, $2, 'in', 'message', $3, $4::text[], $5, NOW() - $6::interval)`,
    [`${GM}-cc1`, `${GM}-th-counsel`, `${GM}-counsel@example.com`, ['contact@drbartender.com', `${GM}-ledger@example.com`], 'Copying my client on the schedule', '3 hours']
  );
  await pool.query(
    `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, text, at)
     VALUES ($1, $2, 'in', 'message', $3, ARRAY['contact@drbartender.com'], $4, NOW() - $5::interval)`,
    [`${GM}-cc2`, `${GM}-th-counsel`, `${GM}-counsel@example.com`, 'A question of my own', '1 hour']
  );
  await sent(`${GM}-ledger`, [`${GM}-ledger@example.com`, `${GM}-planner2@example.com`]);
  // A vendor pitch, already read as a solicitation (stored needs_reply true).
  await theyWrote(`${GM}-pitch`, `${GM}-vendor@example.com`, 'We make bar stools for events', '2 hours');
  await pool.query(
    `INSERT INTO inbox_reads (kind, subject_ref, person_key, status, needs_reply, summary, reason, solicitation, model, attempts)
     VALUES ('inbound', $1, $2, 'ok', true, 'Selling bar stools for events', 'A vendor pitch', true, 'claude-opus-5-5', 1)`,
    [`gm:${GM}-pitch`, `e-${emailHash(`${GM}-vendor@example.com`)}`]
  );
  // Personal mail end to end (test 1 of the 2026-10-15 brief): the sync stored
  // a dallas@-only mail personal while its sender was nobody we knew; the
  // sender is a client now, and wrote to the business mailbox since.
  ids.later = await addClient(`Later Example ${TAG}`, null);
  await pool.query('UPDATE clients SET email = $1 WHERE id = $2', [`${GM}-later@example.com`, ids.later]);
  const mailIn = (gmailId, to, personal, text, ago) => pool.query(
    `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, text, at, personal)
     VALUES ($1, $1, 'in', 'message', $2, $3::text[], $4, NOW() - $5::interval, $6)`,
    [gmailId, `${GM}-later@example.com`, to, text, ago, personal]
  );
  await mailIn(`${GM}-personal`, ['dallas@drbartender.com'], true, `Private words before they booked ${TAG}`, '2 hours');
  await mailIn(`${GM}-business`, ['contact@drbartender.com'], false, `Booking question ${TAG}`, '1 hour');
  // Answering decides first (pin a): someone nobody knows writes to the
  // business mailbox, and the owner replies from his alias. The reply row is
  // stored as the first sync would leave it, judged a fresh send from the
  // alias before the inbound it answers was stored.
  await pool.query(
    `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, text, message_id_header, at)
     VALUES ($1, $2, 'in', 'message', $3, ARRAY['contact@drbartender.com'], $4, $5, NOW() - INTERVAL '3 hours')`,
    [`${GM}-ask`, `${GM}-th-ask`, `${GM}-stranger@example.com`, `Do you do corporate events? ${TAG}`, `<${GM}-ask@mail.example.com>`]
  );
  await pool.query(
    `INSERT INTO gmail_messages (gmail_id, thread_id, direction, kind, from_address, to_addresses, text, in_reply_to, at, personal, personal_to)
     VALUES ($1, $2, 'out', 'message', 'dallas@drbartender.com', $3::text[], 'We do, here is a quote', $4, NOW() - INTERVAL '2 hours', true, $3::text[])`,
    [`${GM}-answer`, `${GM}-th-ask`, [`${GM}-stranger@example.com`], `<${GM}-ask@mail.example.com>`]
  );
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
  assert.deepEqual(body.feeds.map((f) => f.source), ['thumbtack', '888', '1922', '0082', 'gmail', 'zola']);
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
  assert.deepEqual(feeds.map((f) => f.source), ['thumbtack', '888', '1922', '0082', 'gmail', 'zola']);
  assert.ok(['on', 'off', 'failing', 'catching_up'].includes(feeds[4].status));
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

// ─── Email and Zola keys (spec 2026-10-14 sections 4.1, 4.2 and 6) ───

test('the sibling hold flag: a Sent mail that reached the held client marks every sibling legalHold, and only that mail', async () => {
  const snap = await engine.computeSnapshot({ now: new Date() });
  const all = [...snap.eventsByPerson.values()].flat();
  const held = all.filter((e) => e.meta.readRef === `gm:${GM}-held`);
  assert.deepEqual(held.map((e) => [e.personKey.slice(0, 2), e.meta.legalHold]).sort(), [['c-', true], ['e-', true]]);
  assert.ok(held.some((e) => e.personKey === `c-${ids.h}`));
  const free = all.filter((e) => e.meta.readRef === `gm:${GM}-free`);
  assert.deepEqual(free.map((e) => [e.personKey, e.meta.legalHold]), [[`c-${ids.m}`, false]]);
});

test('resolveKey: an e- key with events stays, one whose address is now a client moves, a z- key follows its lead', async () => {
  const now = new Date();
  const kept = 'e-0123456789abcdef';
  const index = {
    keyByEmailHash: new Map([['e-fedcba9876543210', 'c-2147483001']]),
    zolaLeadsById: new Map([[7, { id: 7, client_id: 2147483002, couple_label: 'Alex B & Sam C' }], [8, { id: 8, client_id: null, couple_label: 'Lee D & Max E' }]]),
  };
  const snap = engine.__fakeSnapshot({ now, events: [k.gmIn(kept, new Date(now.getTime() - 3600e3), 'Do you travel?')], index });
  assert.deepEqual(await engine.resolveKey(kept, snap), {});
  assert.deepEqual(await engine.resolveKey('e-fedcba9876543210', snap), { movedTo: 'c-2147483001' });
  assert.deepEqual(await engine.resolveKey('e-aaaaaaaaaaaaaaaa', snap), { missing: true });
  assert.deepEqual(await engine.resolveKey('z-7', snap), { movedTo: 'c-2147483002' });
  assert.deepEqual(await engine.resolveKey('z-8', snap), {});
  assert.deepEqual(await engine.resolveKey('z-9', snap), { missing: true });
});

test('directoryFor: an e- person is their From name, else the marketing lead name, else the address; a z- couple is its label', () => {
  const now = new Date();
  const at = new Date(now.getTime() - 3600e3);
  const index = {
    leadNameOf: (a) => (a === 'morgan@example.com' ? 'Morgan Lead' : null),
    zolaLeadsById: new Map([[8, { id: 8, client_id: null, couple_label: 'Lee D & Max E' }]]),
  };
  const snap = engine.__fakeSnapshot({ now, index, events: [
    k.gmIn('e-1111111111111111', at, 'Hi', { address: 'jamie@example.com', fromName: 'Jamie Q' }),
    k.gmIn('e-2222222222222222', at, 'Hi', { address: 'morgan@example.com' }),
    k.gmIn('e-3333333333333333', at, 'Hi', { address: 'nobody@example.com' }),
    k.zolaEvent('z-8', at, 'Is June open?', { leadId: 8 }),
  ] });
  const dir = engine.directoryFor(snap);
  const keys = ['e-1111111111111111', 'e-2222222222222222', 'e-3333333333333333', 'z-8'];
  assert.deepEqual(keys.map((key) => dir.nameOf(key)), ['Jamie Q', 'Morgan Lead', 'nobody@example.com', 'Lee D & Max E']);
  assert.deepEqual(keys.map((key) => dir.realNameOf(key)), ['Jamie Q', 'Morgan Lead', null, null], 'never the address as a name');
  assert.deepEqual(keys.map((key) => dir.kindOf(key)), ['unknown', 'unknown', 'unknown', 'zola_lead']);
});

test('getItem: an email person opens Gmail with their address on the card; a Zola couple opens Zola on the lead card', async () => {
  const now = new Date();
  const at = new Date(now.getTime() - 3600e3);
  const uuid = '0b6f2c1e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';
  const index = { zolaLeadsById: new Map([[31, { id: 31, lead_uuid: uuid, couple_label: 'Alex B & Sam C', wedding_date: '2027-06-05', client_id: null }]]) };
  const snap = engine.__fakeSnapshot({ now, index, events: [
    k.gmIn('e-5555555555555555', at, 'Do you travel?', { address: 'jamie@example.com', fromName: 'Jamie Q', threadId: 'th-55' }),
    k.zolaEvent('z-31', at, 'Is June open?', { leadId: 31 }),
  ] });
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  try {
    const mail = await engine.getItem({ personKey: 'e-5555555555555555', viewerId: ids.admin });
    assert.deepEqual([mail.person.name, mail.person.kind, mail.status, mail.reply.mode], ['Jamie Q', 'unknown', 'waiting', 'open']);
    assert.deepEqual(mail.reply.app, { name: 'Gmail', url: gmailThreadUrl('th-55'), caption: 'Closes here on its own once you reply from Gmail.' });
    assert.deepEqual(mail.context, { kind: 'unknown', phone_display: null, address: 'jamie@example.com' });
    const zola = await engine.getItem({ personKey: 'z-31', viewerId: ids.admin });
    assert.deepEqual([zola.person.name, zola.person.kind, zola.reply.mode, zola.reply.app.url], ['Alex B & Sam C', 'zola_lead', 'open', zolaLeadUrl(uuid)]);
    assert.deepEqual(zola.context, { kind: 'zola_lead', couple_label: 'Alex B & Sam C', wedding_date: '2027-06-05', client_id: null });
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

test('getItem: a client whose newest message is an email gets the Open button, not the composer, though they have a phone', async () => {
  const now = new Date();
  const snap = engine.__fakeSnapshot({ now, events: [
    k.smsIn(`c-${ids.w}`, new Date(now.getTime() - 2 * 3600e3), 'Texting first', { phone: P.w }),
    k.gmIn(`c-${ids.w}`, new Date(now.getTime() - 3600e3), 'Then an email', { threadId: 'th-w' }),
  ] });
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  try {
    const item = await engine.getItem({ personKey: `c-${ids.w}`, viewerId: ids.admin });
    assert.deepEqual([item.reply.mode, item.reply.app.name, item.reply.app.url], ['open', 'Gmail', gmailThreadUrl('th-w')]);
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

// ─── Personal mail at the owner alias (spec 2026-10-14 decision 6) ───
assert.equal(PERSONAL_MAILBOX_OWNER_USER_ID, 1, 'the tests below name the owner as viewer 1');
// Viewer 1 is the owner (PERSONAL_MAILBOX_OWNER_USER_ID); viewer 2 is anyone
// else. Three friends' mail the sync stored personal (the reader marks every
// event of a personal person meta.personal); a vendor writes to the business
// mailbox. The personal person is waiting, a second one snoozed, a third
// handled, so every list is checked.
function personalSnapshot(now) {
  const at = (h) => new Date(now.getTime() - h * 3600e3);
  const events = [
    k.gmIn('e-6666666666666666', at(3), 'Dinner on Sunday?', { personal: true, address: 'friend@example.com' }),
    k.gmIn('e-7777777777777777', at(3), 'Coffee next week?', { personal: true, address: 'pal@example.com' }),
    k.gmIn('e-8888888888888888', at(5), 'Are you around?', { personal: true, address: 'buddy@example.com' }),
    k.gmOut('e-8888888888888888', at(4), 'Yes, call me', { personal: true, address: 'buddy@example.com' }),
    k.gmIn('e-9999999999999999', at(2), 'Do you do corporate events?', { address: 'vendor@example.com' }),
  ];
  const actions = [{
    id: 1, person_key: 'e-7777777777777777', action: 'snooze', until_at: new Date(now.getTime() + 3600e3), user_id: 1,
    created_at: at(1), undone_at: null,
  }];
  return engine.__fakeSnapshot({ now, events, actions });
}

test('personal: the list, the badge and the item are the owner\'s alone; every other viewer never sees the person', async () => {
  const snap = personalSnapshot(new Date());
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  try {
    const keysOf = (body) => ({
      waiting: body.waiting.map((r) => r.person_key), snoozed: body.snoozed.map((r) => r.person_key), handled: body.handled.map((r) => r.person_key),
    });
    assert.deepEqual(keysOf(await engine.getInbox({ viewerId: 2 })), { waiting: ['e-9999999999999999'], snoozed: [], handled: [] });
    const owner = await engine.getInbox({ viewerId: 1 });
    assert.deepEqual(keysOf(owner), {
      waiting: ['e-6666666666666666', 'e-9999999999999999'], snoozed: ['e-7777777777777777'], handled: ['e-8888888888888888'],
    });
    assert.deepEqual(owner.waiting.map((r) => r.personal), [true, false]);
    assert.equal(await engine.getWaitingCount({ timeoutMs: 1000, viewerId: 2 }), 1);
    assert.equal(await engine.getWaitingCount({ timeoutMs: 1000, viewerId: 1 }), 2);
    assert.equal(await engine.getWaitingCount({ timeoutMs: 1000 }), 1, 'no viewer is not the owner');
    for (const key of ['e-6666666666666666', 'e-7777777777777777', 'e-8888888888888888']) {
      await assert.rejects(engine.getItem({ personKey: key, viewerId: 2 }),
        (err) => err.statusCode === 404 && err.code === 'NOT_FOUND' && err.message === 'That conversation is not in the inbox.'
          && !(err instanceof engine.InboxMovedError), key);
    }
    const item = await engine.getItem({ personKey: 'e-6666666666666666', viewerId: 1 });
    assert.deepEqual([item.status, item.thread.map((r) => r.text)], ['waiting', ['Dinner on Sunday?']]);
    assert.equal(engine.isPersonalPerson, undefined, 'gone: the routes ask isHiddenKey');
    let loads = 0;
    engine.__setEngineDeps({ computeSnapshot: () => { loads += 1; return Promise.resolve(snap); } });
    assert.deepEqual([await engine.isHiddenKey('c-1', 2), await engine.isHiddenKey('z-1', 2), await engine.isHiddenKey('nope', 2)],
      [false, false, false]);
    assert.equal(loads, 0, 'a key that cannot be personal reads no snapshot');
    engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
    // The write routes' check: an e- key with no mail (missing, or moved to a
    // client) is refused to every viewer, exactly as a personal one is to a
    // non-owner, so the answer never tells them apart.
    assert.deepEqual([
      await engine.isHiddenKey('e-6666666666666666', 2), await engine.isHiddenKey('e-6666666666666666', 1),
      await engine.isHiddenKey('e-0000000000000000', 2), await engine.isHiddenKey('e-0000000000000000', 1),
      await engine.isHiddenKey('e-9999999999999999', 2), await engine.isHiddenKey('c-1', 2),
    ], [true, false, true, true, false, false]);
    const subjects = await engine.getReadSubjects();
    assert.deepEqual(subjects.map((x) => x.personKey), ['e-9999999999999999'], 'the AI never reads personal mail');
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

// Test 3 of the 2026-10-15 brief: one sender, a dallas@-only mail (stored
// personal) and a contact@ mail (business), are two items. Every other viewer
// sees the business one only, and no AI subject or slice line for anyone
// ever holds the personal mail's words.
test('one sender, a personal mail and a business mail: two items, only the business one for anyone else, never the personal words to the AI', async () => {
  const now = new Date();
  const at = (h) => new Date(now.getTime() - h * 3600e3);
  const friend = 'friend.r@example.com';
  const personal = personalEmailKey(friend);
  const business = `e-${emailHash(friend)}`;
  const snap = engine.__fakeSnapshot({ now, events: [
    k.gmIn(personal, at(5), 'Private words about Sunday dinner', { personal: true, address: friend, fromName: 'Robin F' }),
    k.gmOut(personal, at(4), 'Private reply about dinner', { personal: true, address: friend }),
    k.gmIn(personal, at(3), 'Private follow-up', { personal: true, address: friend, fromName: 'Robin F' }),
    k.gmIn(business, at(2), 'Do you do corporate events?', { address: friend, fromName: 'Robin F' }),
  ] });
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  try {
    const rows = async (viewerId) => (await engine.getInbox({ viewerId })).waiting.map((r) => [r.person_key, r.personal, r.need]);
    assert.deepEqual(await rows(2), [[business, false, 'Do you do corporate events?']]);
    assert.deepEqual(await rows(1), [[personal, true, 'Private follow-up'], [business, false, 'Do you do corporate events?']]);
    assert.deepEqual([await engine.getWaitingCount({ timeoutMs: 1000, viewerId: 2 }), await engine.getWaitingCount({ timeoutMs: 1000, viewerId: 1 })], [1, 2]);
    await assert.rejects(engine.getItem({ personKey: personal, viewerId: 2 }),
      (err) => err.statusCode === 404 && err.message === engine.NOT_IN_INBOX && !(err instanceof engine.InboxMovedError));
    const theirs = await engine.getItem({ personKey: business, viewerId: 2 });
    assert.deepEqual(theirs.thread.map((r) => r.text), ['Do you do corporate events?'], 'the business item holds the business mail alone');
    const owners = await engine.getItem({ personKey: personal, viewerId: 1 });
    assert.deepEqual(owners.thread.map((r) => r.text), ['Private words about Sunday dinner', 'Private reply about dinner', 'Private follow-up']);
    const subjects = await engine.getReadSubjects({ fresh: true });
    assert.deepEqual(subjects.map((x) => x.personKey), [business]);
    assert.equal(JSON.stringify(subjects).includes('Private'), false, 'no subject or slice line holds the personal words');
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

// Test 7: a personal key never moves. Its sender is a client now (their
// business mail reads under the client), and the personal key stays hidden
// from everyone else with the plain 404, never moved_to; the owner opens it.
test('the personal key never moves: its sender is a client now, it stays hidden with the plain 404 and no moved_to, and the owner opens it', async () => {
  const now = new Date();
  const at = (h) => new Date(now.getTime() - h * 3600e3);
  const friend = 'friend.r@example.com';
  const personal = personalEmailKey(friend);
  const business = `e-${emailHash(friend)}`;
  const index = { keyByEmailHash: new Map([[business, 'c-2147483005']]), clients: new Map([[2147483005, { id: 2147483005, name: 'Robin F' }]]) };
  const snap = engine.__fakeSnapshot({ now, index, events: [
    k.gmIn(personal, at(3), 'Private words about Sunday dinner', { personal: true, address: friend }),
    k.gmIn('c-2147483005', at(2), 'Can we book the 12th?', { address: friend }),
  ] });
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  try {
    await assert.rejects(engine.getItem({ personKey: personal, viewerId: 2 }), (err) => err.statusCode === 404
      && err.code === 'NOT_FOUND' && err.message === engine.NOT_IN_INBOX && !(err instanceof engine.InboxMovedError) && err.movedTo === undefined);
    assert.equal((await engine.getItem({ personKey: personal, viewerId: 1 })).status, 'waiting');
    await assert.rejects(engine.getItem({ personKey: business, viewerId: 2 }),
      (err) => err instanceof engine.InboxMovedError && err.movedTo === 'c-2147483005', 'the business key moves, as before');
    assert.deepEqual([await engine.isHiddenKey(personal, 2), await engine.isHiddenKey(personal, 1)], [true, false]);
    assert.deepEqual(await engine.resolveKey(personal, snap), {}, 'with mail it stays');
    const empty = engine.__fakeSnapshot({ now, index });
    assert.deepEqual(await engine.resolveKey(personal, empty), { missing: true }, 'with none it is missing, never moved');
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

// Test 1, end to end over the dev DB (the rows seeded in before()): the
// personal row stays on its own person though its sender is a client now.
test('a client made after a dallas@-only mail does not unhide it: the real snapshot keeps it on the personal person, the owner\'s alone', async () => {
  engine.invalidate();
  const snap = await engine.computeSnapshot({ now: new Date() });
  const personal = personalEmailKey(`${GM}-later@example.com`);
  const mine = (key) => (snap.eventsByPerson.get(key) || []).filter((e) => e.meta && String(e.meta.gmailId || '').startsWith(GM));
  assert.deepEqual(mine(personal).map((e) => [e.meta.gmailId, e.meta.personal]), [[`${GM}-personal`, true]]);
  assert.deepEqual(mine(`c-${ids.later}`).map((e) => [e.meta.gmailId, e.meta.personal]), [[`${GM}-business`, false]], 'the client item has the business mail alone');
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  try {
    const keys = async (viewerId) => (await engine.getInbox({ viewerId })).waiting.map((r) => r.person_key);
    assert.equal((await keys(ids.admin)).includes(personal), false, 'not on another admin\'s list');
    assert.equal((await keys(1)).includes(personal), true, 'on the owner\'s');
    await assert.rejects(engine.getItem({ personKey: personal, viewerId: ids.admin }),
      (err) => err.statusCode === 404 && err.message === engine.NOT_IN_INBOX && !(err instanceof engine.InboxMovedError));
    const subjects = await engine.getReadSubjects();
    assert.equal(subjects.some((x) => x.personKey === personal), false, 'no AI subject');
    assert.equal(JSON.stringify(subjects).includes('Private words before they booked'), false);
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

// Pin (a) of the coordinator's correction, over the real snapshot: the
// owner's reply from his alias to a business mail lands on the business item
// and closes it; no personal person exists for that sender.
test('answering decides first: the owner alias answering a contact@ mail from someone nobody knows closes the business item', async () => {
  engine.invalidate();
  const snap = await engine.computeSnapshot({ now: new Date() });
  const business = `e-${emailHash(`${GM}-stranger@example.com`)}`;
  assert.deepEqual((snap.eventsByPerson.get(business) || []).map((e) => [e.meta.gmailId, e.direction, e.meta.personal]),
    [[`${GM}-ask`, 'in', false], [`${GM}-answer`, 'out', false]]);
  assert.equal(snap.eventsByPerson.has(personalEmailKey(`${GM}-stranger@example.com`)), false, 'no personal person for them');
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  try {
    const body = await engine.getInbox({ viewerId: ids.admin });
    assert.equal(body.waiting.some((r) => r.person_key === business), false, 'no longer waiting');
    const handled = body.handled.find((r) => r.person_key === business);
    assert.ok(handled, 'in Recently handled for every viewer');
    assert.equal(handled.reason_text, 'Replied by email');
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

// ─── the review round (2026-10-15) ───

// The sibling hold flag reaches the read job's subjects (markHeldSiblings),
// so a merge order that lands this lane before the read job learns the flag
// still never sends the words written to the held client out.
test('getReadSubjects never hands over a sibling of a Sent mail that reached the held client, as the subject or as context', async () => {
  const now = new Date();
  const at = (h) => new Date(now.getTime() - h * 3600e3);
  const planner = 'e-4444444444444444';
  const heldMail = (held) => k.gmOut(planner, at(4), 'Words written to the held client', {
    to: ['held@example.com', 'planner@example.com'], legalHold: held, gmailId: 'gh1', n: 2,
  });
  const waiting = (held) => engine.__fakeSnapshot({ now, events: [
    k.gmIn(planner, at(5), 'Who is bringing ice?', { address: 'planner@example.com' }),
    heldMail(held),
    k.gmIn(planner, at(3), 'Following up on the ice', { address: 'planner@example.com' }),
  ] });
  const answered = (held) => engine.__fakeSnapshot({ now, events: [
    k.gmIn(planner, at(5), 'Who is bringing ice?', { address: 'planner@example.com' }), heldMail(held),
  ] });
  const subjectsOf = async (snap) => {
    engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
    return (await engine.getReadSubjects()).map((s) => [s.kind, s.subjectRef]);
  };
  try {
    const free = await subjectsOf(waiting(false));
    assert.equal(free.length, 1);
    assert.equal(free[0][0], 'inbound', 'with no hold, the follow-up is read, the Sent mail as its context');
    assert.deepEqual(await subjectsOf(waiting(true)), [], 'a held sibling as a line of context');
    assert.deepEqual(await subjectsOf(answered(false)), [['outbound', 'gm:gh1:2']]);
    assert.deepEqual(await subjectsOf(answered(true)), [], 'a held sibling as the subject');
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

// ─── lane email-ai, the coordinator's round (2026-10-16) ───

test('a pitch: the newest inbound read as a solicitation reaches the list through the snapshot, waiting with pitch true', async () => {
  engine.invalidate();
  const body = await engine.getInbox({ viewerId: ids.admin });
  const vendor = body.waiting.find((r) => r.person_key === `e-${emailHash(`${GM}-vendor@example.com`)}`);
  assert.ok(vendor, 'the pitch waits');
  assert.deepEqual([vendor.pitch, vendor.need, vendor.channels], [true, 'Selling bar stools for events', ['email']]);
  assert.equal(body.waiting.find((r) => r.person_key === `c-${ids.w}`).pitch, false);
});

// The full held key set (spec 2026-10-14 section 6): the address the email
// ledger alone knows is an e- person to the people index, and only the held
// key set ties it to the hold. Every sibling of the Sent mail that reached it
// is flagged, so the planner's copy is never read under the planner's key.
test('a Sent mail to the held client at a ledger-only address and to a planner flags the planner\'s sibling, and the read job refuses it', async () => {
  const { computeInbox } = require('./rules');
  const { isReadable } = require('./aiRead');
  const { runInboxReads } = require('./readJob');
  engine.invalidate();
  const snap = await engine.computeSnapshot({ now: new Date() });
  const ledger = `e-${emailHash(`${GM}-ledger@example.com`)}`;
  const planner = `e-${emailHash(`${GM}-planner2@example.com`)}`;
  const mail = [...snap.eventsByPerson.values()].flat().filter((e) => e.meta.readRef === `gm:${GM}-ledger`);
  assert.deepEqual(mail.map((e) => [e.personKey, e.meta.legalHold]).sort(), [[ledger, true], [planner, true]].sort());
  const [subject] = computeInbox({ events: snap.eventsByPerson.get(planner), now: snap.now, users: snap.index.users }).subjects;
  assert.deepEqual([subject.kind, subject.readRef], ['outbound', `gm:${GM}-ledger`], 'the planner has a subject to refuse');
  assert.equal(isReadable(subject), false);
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  try {
    assert.equal((await engine.getReadSubjects()).some((s) => s.personKey === planner || s.personKey === ledger), false);
    const calls = [];
    const client = { beta: { messages: { create: (r) => { calls.push(r); return Promise.reject(new Error('never called')); } } } };
    const fake = { getReadSubjects: () => Promise.resolve([subject]), invalidate: () => {} };
    const counts = await runInboxReads({ client, engine: fake, legalHoldProposalIds: ids.proposals });
    assert.deepEqual([calls.length, counts.read], [0, 0]);
    const { rows } = await pool.query('SELECT 1 FROM inbox_reads WHERE subject_ref = $1', [`gm:${GM}-ledger`]);
    assert.equal(rows.length, 0, 'nothing reserved');
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

// ─── the fleet's fix round (2026-10-16) ───

test('an address the email ledger kept under the held proposal alone (no client) is held: its owner\'s mail is never offered', async () => {
  engine.invalidate();
  const snap = await engine.computeSnapshot({ now: new Date() });
  const stale = `e-${emailHash(`${GM}-stale@example.com`)}`;
  assert.ok(snap.heldKeys.has(stale), 'in the held key set');
  assert.ok(snap.heldKeys.has(personalEmailKey(`${GM}-stale@example.com`)));
  assert.equal((snap.eventsByPerson.get(stale) || []).length, 1, 'their mail is a person of its own');
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  try {
    const subjects = await engine.getReadSubjects();
    assert.equal(subjects.some((s) => s.personKey === stale), false);
    assert.ok(subjects.some((s) => s.personKey === `c-${ids.w}`), 'others are still offered');
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

test('an inbound mail that copied the held client is held, that mail only, never the rest of its thread; the sender is not read while it is in the slice', async () => {
  const { isReadable } = require('./aiRead');
  const { computeInbox } = require('./rules');
  engine.invalidate();
  const snap = await engine.computeSnapshot({ now: new Date() });
  const counsel = `e-${emailHash(`${GM}-counsel@example.com`)}`;
  const flags = (snap.eventsByPerson.get(counsel) || []).map((e) => [e.meta.gmailId, Boolean(e.meta.legalHold)]);
  assert.deepEqual(flags, [[`${GM}-cc1`, true], [`${GM}-cc2`, false]]);
  const [subject] = computeInbox({ events: snap.eventsByPerson.get(counsel), now: snap.now, users: snap.index.users }).subjects;
  assert.deepEqual([subject.kind, subject.subjectRef], ['inbound', `gm:${GM}-cc2`]);
  assert.equal(isReadable(subject), false, 'the copied mail rides in its slice');
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  try {
    assert.equal((await engine.getReadSubjects()).some((s) => s.personKey === counsel), false);
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

// The fleet's second round (2026-10-16): the hold compares canonical
// addresses (a +tag dropped; for Gmail, dots dropped and googlemail.com read
// as gmail.com), on the From path and the copy path, with plain string
// compares.
test('canonicalAddress: a +tag goes; Gmail drops dots and reads googlemail.com as gmail.com; other domains keep their dots', () => {
  assert.equal(engine.canonicalAddress(' Pat.Q+events@Example.com '), 'pat.q@example.com');
  assert.equal(engine.canonicalAddress('Pat.Q-x+events@GoogleMail.com'), 'patq-x@gmail.com');
  assert.equal(engine.canonicalAddress('p.a.t.q-x@gmail.com'), 'patq-x@gmail.com');
  assert.equal(engine.canonicalAddress(''), null);
  assert.equal(engine.canonicalAddress(null), null);
});

test('a held address in any form Gmail delivers to it holds that mail, as the sender or a copied recipient; a different address does not', async () => {
  const { isReadable } = require('./aiRead');
  const { computeInbox } = require('./rules');
  const { runInboxReads } = require('./readJob');
  engine.invalidate();
  const snap = await engine.computeSnapshot({ now: new Date() });
  const flagOf = (gmailId) => [...snap.eventsByPerson.values()].flat().filter((e) => e.meta.gmailId === gmailId).map((e) => Boolean(e.meta.legalHold));
  for (const v of ['from-tag', 'from-gmail', 'cc-gmail', 'cc-tag']) assert.deepEqual(flagOf(`${GM}-v-${v}`), [true], v);
  assert.deepEqual(flagOf(`${GM}-v-free`), [false]);
  const variant = `e-${emailHash('ZZ-FixtureHeld+x@googlemail.com')}`;
  assert.equal(snap.heldKeys.has(variant), false, 'the variant forms its own person, outside the held keys');
  const [subject] = computeInbox({ events: snap.eventsByPerson.get(variant), now: snap.now, users: snap.index.users }).subjects;
  assert.equal(isReadable(subject), false, 'its own message is held');
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  try {
    const offered = new Set((await engine.getReadSubjects()).map((s) => s.personKey));
    for (const from of [`${GM}-h+law@example.com`, 'ZZ-FixtureHeld+x@googlemail.com', `${GM}-planner3@example.com`, `${GM}-planner4@example.com`]) {
      assert.equal(offered.has(`e-${emailHash(from)}`), false, from);
    }
    assert.equal(offered.has(`e-${emailHash(`${GM}-hx@example.com`)}`), true, 'the different address is offered');
    const calls = [];
    const client = { beta: { messages: { create: (r) => { calls.push(r); return Promise.reject(new Error('never called')); } } } };
    await runInboxReads({ client, engine: { getReadSubjects: () => Promise.resolve([subject]), invalidate: () => {} }, legalHoldProposalIds: ids.proposals });
    assert.equal(calls.length, 0, 'the read job refuses it too');
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

// The fleet's third round (2026-10-16): an address that is ours (a staffer's
// users.email, the personal alias) is never a held address, even when a row
// under a held proposal names it; the held client's own address still is.
test('our own addresses are never held: a staffer and the personal alias on ledger rows hold nothing; a mail copying the held client still is', async () => {
  engine.invalidate();
  const snap = await engine.computeSnapshot({ now: new Date() });
  const flagOf = (gmailId) => [...snap.eventsByPerson.values()].flat().filter((e) => e.meta.gmailId === gmailId).map((e) => Boolean(e.meta.legalHold));
  assert.deepEqual(flagOf(`${GM}-o-staffer`), [false], "the staffer's own mail");
  assert.deepEqual(flagOf(`${GM}-o-alias`), [false], 'a client mail to the personal alias');
  assert.deepEqual(flagOf(`${GM}-o-both`), [true], 'a mail copying the held client and the staffer');
  // The forms the ledger rows actually carry.
  for (const a of [`${TAG}-Staffer+notice@example.com`, PERSONAL_ALIAS]) {
    assert.equal(snap.heldKeys.has(`e-${emailHash(a)}`), false, a);
    assert.equal(snap.heldKeys.has(personalEmailKey(a)), false, a);
  }
  assert.ok(snap.heldKeys.has(`e-${emailHash(`${GM}-h@example.com`)}`), "the held client's own address stays held");
  const { addresses } = await engine.loadLegalHold(pool, ids.proposals);
  assert.equal(addresses.has(engine.canonicalAddress(`${TAG}-staffer@example.com`)), false);
  assert.equal(addresses.has(engine.canonicalAddress(PERSONAL_ALIAS)), false);
  assert.equal(addresses.has(engine.canonicalAddress(`${GM}-h@example.com`)), true);
});

// The fleet's fourth round (2026-10-16): a drop is decided by where the
// address came from, never by a users row that matches it.
test('a registered account naming a held address leaves it held; a consult booked with a staffer\'s address stays held', async () => {
  const { keys, addresses } = await engine.loadLegalHold(pool, ids.proposals);
  for (const a of [`${GM}-ledger@example.com`, `${GM}-stale@example.com`]) {
    assert.ok(addresses.has(engine.canonicalAddress(a)), `${a} (an in_progress or applied account) stays held`);
    assert.ok(keys.has(`e-${emailHash(a)}`), a);
  }
  assert.ok(addresses.has(engine.canonicalAddress(`${TAG}-staffer2@example.com`)), 'a consult booker is never a staff notice');
  assert.equal(addresses.has(engine.canonicalAddress(`${TAG}-staffer@example.com`)), false, 'the staff notice to an approved staffer is dropped');
  assert.equal(addresses.has(engine.canonicalAddress(`${TAG}-staffer3@example.com`)), false, 'the staff notice to a submitted staffer is dropped');
  assert.equal(keys.has(`e-${emailHash(`${TAG}-staffer3@example.com`)}`), false);
  assert.ok(addresses.has(engine.canonicalAddress(`${TAG}-staffer4@example.com`)), 'a service_extension_request row is never a staff notice: held');
  assert.ok(keys.has(`e-${emailHash(`${TAG}-staffer4@example.com`)}`));
  engine.invalidate();
  const snap = await engine.computeSnapshot({ now: new Date() });
  const cc = [...snap.eventsByPerson.values()].flat().filter((e) => e.meta.gmailId === `${GM}-cc1`);
  assert.deepEqual(cc.map((e) => e.meta.legalHold), [true], 'mail copying the registered ledger address is still held');
});

test('the client-row exemption: a held client whose own address is an admin\'s is still held; that admin on a ledger row is not', async () => {
  const { keys, addresses } = await engine.loadLegalHold(pool, [ids.opHold]);
  assert.ok(addresses.has(engine.canonicalAddress(`${TAG}-op2@example.com`)), "the client row's address");
  assert.ok(keys.has(`e-${emailHash(`${TAG}-op2@example.com`)}`));
  assert.equal(addresses.has(engine.canonicalAddress(`${TAG}-admin@example.com`)), false, "an admin's address on a ledger row");
  assert.equal(keys.has(`e-${emailHash(`${TAG}-admin@example.com`)}`), false);
});
