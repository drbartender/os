// runInboxReads against the dev DB's inbox_reads, with a fake engine (fixture
// subjects) and a stub Anthropic client: nothing here can reach Anthropic.
// Every subject_ref carries a 'sms:aitest-' prefix and is removed in before(),
// afterEach() and after(); the one client and proposal (the legal-hold checks)
// carry an 'aitest-' email and are removed the same way, and the client's one
// outbound text (to the history number) is removed by cleanPeople() before
// the client is. Names and numbers are invented. The dev DB is shared, so cap
// math is relative to a baseline.
const launchedEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';
require('dotenv').config();

const { test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Anthropic } = require('@anthropic-ai/sdk');
const { pool, initDb } = require('../../db');
const { readStats } = require('./aiStatus');
const { CALL_DEADLINE_MS, _resetModelWarningForTest } = require('./aiRead');
const {
  TICK_LIMIT, STALE_PENDING_MINUTES, WARN_THROTTLE_MS, runInboxReads, makeInboxReadTick, subjectTime,
  __setReadJobDeps, _resetReadJobWarningsForTest,
} = require('./readJob');
const { BADGE_MAX_AGE_MS } = require('./constants');

if (launchedEnv === 'production') {
  throw new Error('readJob.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const REF_PREFIX = `sms:aitest-${NONCE}-`;
const ref = (n) => `${REF_PREFIX}${String(n).padStart(2, '0')}`;
const T0 = Date.parse('2026-10-05T14:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const HELD_PHONE = '3315550161'; // the held client's own number
const HISTORY_PHONE = '3315550162'; // a number we once texted that client
const OTHER_PHONE = '3315550163'; // a stranger
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'INBOX_AI_DAILY_CAP', 'INBOX_AI_MODEL'];
let saved = {};
let clientId;
let proposalId;
const sentryCalls = [];

async function cleanReads() {
  await pool.query("DELETE FROM inbox_reads WHERE subject_ref LIKE 'sms:aitest-%'");
}
async function cleanPeople() {
  await pool.query("DELETE FROM sms_messages WHERE client_id IN (SELECT id FROM clients WHERE email LIKE 'aitest-%@example.com')");
  await pool.query("DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE 'aitest-%@example.com')");
  await pool.query("DELETE FROM clients WHERE email LIKE 'aitest-%@example.com'");
}

before(async () => {
  await initDb();
  await cleanReads();
  await cleanPeople();
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('Holdie Testerton', $1, $2) RETURNING id",
    [`aitest-${NONCE}@example.com`, `+1${HELD_PHONE}`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query("INSERT INTO proposals (client_id, status) VALUES ($1, 'draft') RETURNING id", [clientId]);
  proposalId = p.rows[0].id;
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, recipient_name, body, message_type, status)
     VALUES ('outbound', $1, $2, 'Holdie Testerton', 'held fixture', 'general', 'sent')`,
    [clientId, `+1${HISTORY_PHONE}`]
  );
});
after(async () => {
  await cleanReads();
  await cleanPeople();
  await pool.end();
});
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  process.env.INBOX_AI_DAILY_CAP = '1000000';
  delete process.env.INBOX_AI_MODEL;
  _resetReadJobWarningsForTest();
  sentryCalls.length = 0;
  __setReadJobDeps({ sentry: { captureMessage: (msg, ctx) => { sentryCalls.push({ msg, ctx }); } } });
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  mock.restoreAll();
  _resetReadJobWarningsForTest();
  _resetModelWarningForTest();
  await cleanReads();
});

// Lane inbox-engine's subject shape: at on the subject, channel the list tag.
function inbound(n, { minute = n, personKey = `c-${900000 + n}`, legalHold = false, text = `Can we add a mocktail station? (${n})` } = {}) {
  return {
    kind: 'inbound', subjectRef: ref(n), personKey, name: 'Jordan Testerton', at: new Date(at(minute)), legalHold,
    slice: [{ ref: ref(n), context: false, who: 'THEM', authorFirstName: null, channel: 'text_888', at: at(minute), text }],
  };
}
function outbound(n) {
  return {
    kind: 'outbound', subjectRef: ref(n), personKey: `c-${900000 + n}`, name: 'Casey Exampleton', at: new Date(at(n)), legalHold: false,
    slice: [
      { ref: `${ref(n)}q`, context: true, who: 'THEM', authorFirstName: null, channel: 'text_888', at: at(n - 5), text: 'Is the price final?' },
      { ref: ref(n), context: false, who: 'US', authorFirstName: 'Zul', channel: 'text_888', at: at(n), text: 'Let me check and get back to you Monday.' },
    ],
  };
}
function fakeEngine(subjects) {
  const engine = {
    asked: 0,
    args: [],
    invalidations: 0,
    getReadSubjects: (...args) => { engine.asked += 1; engine.args.push(args); return Promise.resolve(subjects); },
    invalidate: () => { engine.invalidations += 1; },
  };
  return engine;
}
function stub(answer) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: (request) => { calls.push(request); return Promise.resolve().then(() => answer(request, calls.length)); } } },
  };
}
// A message as create() returns it: the answer is one text block (the SDK's
// parse() helper and its parsed_output are no longer used; see aiRead.js).
const said = (parsed, extra = {}) => ({
  model: 'claude-opus-5-5', stop_reason: 'end_turn',
  content: parsed === null ? [] : [{ type: 'text', text: JSON.stringify(parsed) }],
  ...extra,
});
const thanks = () => said({ needs_reply: false, what_they_need: 'Said thanks', reason: 'Only a thank-you' });
const rowsFor = async () => (await pool.query(
  `SELECT kind, subject_ref, person_key, status, needs_reply, holding, summary, promised_by, reason, model, attempts, error
     FROM inbox_reads WHERE subject_ref LIKE $1 ORDER BY subject_ref`,
  [`${REF_PREFIX}%`]
)).rows;
const run = (opts) => runInboxReads({ legalHoldProposalIds: [proposalId], ...opts });

test('with ANTHROPIC_API_KEY unset the tick does nothing', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const engine = fakeEngine([inbound(1)]);
  const client = stub(thanks);
  assert.deepEqual(await run({ client, engine }), { skipped: 'off' });
  assert.equal(client.calls.length, 0);
  assert.equal(engine.asked, 0);
  assert.deepEqual(await rowsFor(), []);
});

test('under NODE_ENV=test, with no stub, the tick refuses before reserving anything', async () => {
  await assert.rejects(run({ engine: fakeEngine([inbound(1)]) }), /NODE_ENV=test/);
  assert.deepEqual(await rowsFor(), []);
});

test('a read is reserved as pending before the call, then stored, and the cache is cleared', async () => {
  const seen = [];
  const client = stub(async () => {
    const { rows } = await pool.query('SELECT status, attempts FROM inbox_reads WHERE subject_ref = $1', [ref(1)]);
    seen.push(rows[0]);
    return thanks();
  });
  const engine = fakeEngine([inbound(1)]);
  const counts = await run({ client, engine });
  assert.deepEqual(seen, [{ status: 'pending', attempts: 1 }]);
  assert.deepEqual(counts, { read: 1, ok: 1, refused: 0, error: 0, raced: 0 });
  const [row] = await rowsFor();
  assert.equal(row.status, 'ok');
  assert.equal(row.kind, 'inbound');
  assert.equal(row.person_key, 'c-900001');
  assert.equal(row.needs_reply, false);
  assert.equal(row.summary, 'Said thanks');
  assert.equal(row.reason, 'Only a thank-you');
  assert.equal(row.model, 'claude-opus-5-5');
  assert.equal(row.error, null);
  assert.equal(engine.invalidations, 1);
  assert.deepEqual(engine.args, [[{ maxAgeMs: BADGE_MAX_AGE_MS }]], 'the badge\'s snapshot: the tick never recomputes the inbox every minute');
});

test('oldest first, at most 20 a tick; an ok read is never repeated', async () => {
  // 22 subjects whose times run backwards against their numbers: subject 22
  // is the oldest message, subject 1 the newest.
  const subjects = Array.from({ length: 22 }, (_, i) => inbound(i + 1, { minute: 100 - i }));
  const engine = fakeEngine(subjects);
  const client = stub(thanks);
  assert.equal(TICK_LIMIT, 20);
  await run({ client, engine });
  assert.equal(client.calls.length, 20);
  const firstTick = new Set((await rowsFor()).map((r) => r.subject_ref));
  assert.equal(firstTick.size, 20);
  assert.equal(firstTick.has(ref(1)), false, 'the newest waits for the next tick');
  assert.equal(firstTick.has(ref(2)), false);
  assert.equal(firstTick.has(ref(22)), true, 'the oldest goes first');
  await run({ client, engine });
  assert.equal(client.calls.length, 22);
  await run({ client, engine });
  assert.equal(client.calls.length, 22, 'no subject is read twice');
});

test('an outbound read stores holding and promised_by, and nothing inbound', async () => {
  const client = stub(() => said({ holding: true, promised_by: 'Monday', reason: 'Promises to check' }));
  await run({ client, engine: fakeEngine([outbound(10)]) });
  const [row] = await rowsFor();
  assert.equal(row.kind, 'outbound');
  assert.equal(row.status, 'ok');
  assert.equal(row.holding, true);
  assert.equal(row.promised_by, 'Monday');
  assert.equal(row.needs_reply, null);
  assert.equal(row.summary, null);
});

test('a refusal is stored as refused, with no content, and never read again', async () => {
  const client = stub(() => said(null, { stop_reason: 'refusal' }));
  const engine = fakeEngine([inbound(1)]);
  await run({ client, engine });
  const [row] = await rowsFor();
  assert.equal(row.status, 'refused');
  assert.equal(row.summary, null);
  assert.equal(row.reason, null);
  assert.equal(row.error, null);
  await run({ client, engine });
  assert.equal(client.calls.length, 1);
});

test('an error row holds only class, status and request id; it retries and stops at 3 attempts', async () => {
  const leak = 'Can you do Oct 20 for the Testerton wedding, call 312-555-0100';
  // The leak's words and its number, the number both as written and as digits
  // only, all taken from the leak itself. Never a bare 555: subject_ref holds
  // the run's random nonce, whose digits can contain it.
  const dashed = /\d{3}-\d{3}-\d{4}/.exec(leak)[0];
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from this test's own leak literal, never input
  const leaked = new RegExp(`Testerton|Oct 20|${dashed}|${dashed.replace(/\D/g, '')}`);
  const client = {
    calls: 0,
    beta: { messages: { create: () => {
      client.calls += 1;
      return Promise.reject(new Anthropic.RateLimitError(
        429, { type: 'error', error: { type: 'rate_limit_error', message: leak } }, undefined,
        { get: (name) => (name === 'request-id' ? 'req_test_rl' : null) },
      ));
    } } },
  };
  const engine = fakeEngine([inbound(1, { text: leak })]);
  await run({ client, engine });
  let [row] = await rowsFor();
  assert.equal(row.status, 'error');
  assert.equal(row.attempts, 1);
  assert.equal(row.error, 'RateLimitError 429 req_test_rl');
  assert.doesNotMatch(JSON.stringify(row), leaked);
  await run({ client, engine });
  await run({ client, engine });
  [row] = await rowsFor();
  assert.equal(row.attempts, 3);
  await run({ client, engine });
  assert.equal(client.calls, 3, 'no fourth attempt');
  assert.equal(sentryCalls.length, 1, 'one warning an hour');
  assert.equal(sentryCalls[0].ctx.extra.error, 'RateLimitError 429 req_test_rl');
  assert.doesNotMatch(JSON.stringify(sentryCalls), leaked);
});

test('a pending row older than 5 minutes is an error and is retried; a fresh one is left alone', async () => {
  assert.ok(CALL_DEADLINE_MS < STALE_PENDING_MINUTES * 60000, 'a reservation whose call is in flight is never stale');
  await pool.query(
    `INSERT INTO inbox_reads (kind, subject_ref, person_key, status, attempts, created_at, updated_at)
     VALUES ('inbound', $1, 'c-900001', 'pending', 1, NOW() - INTERVAL '6 minutes', NOW() - INTERVAL '6 minutes'),
            ('inbound', $2, 'c-900002', 'pending', 1, NOW(), NOW())`,
    [ref(1), ref(2)]
  );
  const client = stub(thanks);
  await run({ client, engine: fakeEngine([inbound(1), inbound(2)]) });
  assert.equal(client.calls.length, 1);
  const rows = await rowsFor();
  assert.deepEqual(rows.map((r) => [r.subject_ref, r.status, r.attempts]), [
    [ref(1), 'ok', 2],
    [ref(2), 'pending', 1],
  ]);
});

test('the daily cap is counted from inbox_reads: reads pause at it, warning at most once an hour', async () => {
  const { attempts24h } = await readStats(pool);
  process.env.INBOX_AI_DAILY_CAP = String(attempts24h + 1);
  const client = stub(thanks);
  const engine = fakeEngine([inbound(1), inbound(2), inbound(3)]);
  const capWarnings = () => sentryCalls.filter((c) => c.ctx.tags.issue === 'daily_cap').length;
  await run({ client, engine });
  assert.equal(client.calls.length, 1, 'the budget is what is left under the cap');
  const paused = await run({ client, engine });
  assert.equal(paused.skipped, 'paused');
  await run({ client, engine });
  assert.equal(client.calls.length, 1);
  assert.equal(capWarnings(), 1);
  // The count dips under the cap (here the cap rises by one), a read runs,
  // and the cap is hit again: under sustained load that is every couple of
  // minutes, and it is still one warning in the hour.
  process.env.INBOX_AI_DAILY_CAP = String(attempts24h + 2);
  await run({ client, engine });
  assert.equal(client.calls.length, 2);
  assert.equal((await run({ client, engine })).skipped, 'paused');
  assert.equal(capWarnings(), 1, 'a dip under the cap does not re-arm the warning');
  const later = Date.now() + WARN_THROTTLE_MS + 1000;
  mock.method(Date, 'now', () => later);
  assert.equal((await run({ client, engine })).skipped, 'paused');
  mock.restoreAll();
  assert.equal(capWarnings(), 2, 'an hour on, it warns again');
});

test('the legal-hold person is never read: not by the flag, not by their client key', async () => {
  const client = stub(thanks);
  await run({
    client,
    engine: fakeEngine([
      inbound(1, { legalHold: true }),
      inbound(2, { personKey: `c-${clientId}` }),
    ]),
  });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(await rowsFor(), []);
});

test('the legal hold covers every number on record for the held client, under a p- key', async () => {
  const client = stub(thanks);
  await run({
    client,
    engine: fakeEngine([
      inbound(1, { personKey: `p-${HELD_PHONE}` }),
      inbound(2, { personKey: `p-${HISTORY_PHONE}` }),
      inbound(3, { personKey: `p-${OTHER_PHONE}` }),
    ]),
  });
  assert.equal(client.calls.length, 1, 'only the number with no tie to the held client is read');
  assert.deepEqual((await rowsFor()).map((r) => r.person_key), [`p-${OTHER_PHONE}`]);
});

test('picture-only, empty and keyword-row subjects are never read', async () => {
  const client = stub(thanks);
  const engine = fakeEngine([
    inbound(1, { text: '' }), inbound(2, { text: '  ' }), inbound(3, { text: 'STOP' }), inbound(4, { text: '[photo]' }),
  ]);
  await run({ client, engine });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(await rowsFor(), []);
  assert.equal(engine.invalidations, 0, 'nothing read, nothing to clear');
});

test('the tick guard skips an overlapping tick and is released when a tick throws', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let runs = 0;
  const tick = makeInboxReadTick(async () => {
    runs += 1;
    if (runs === 1) { await gate; return { read: 0 }; }
    if (runs === 2) throw new Error('boom');
    return { read: 0 };
  });
  const first = tick();
  assert.deepEqual(await tick(), { skipped: 'in_flight' });
  release();
  await first;
  await assert.rejects(tick(), /boom/);
  assert.deepEqual(await tick(), { read: 0 });
  assert.equal(runs, 3);
});

test('a bad INBOX_AI_MODEL warns once, when the tick is built at boot', () => {
  const warn = mock.method(console, 'warn', () => {});
  process.env.INBOX_AI_MODEL = 'claude-opus-5-5';
  makeInboxReadTick(() => Promise.resolve({}));
  assert.equal(warn.mock.callCount(), 0);
  process.env.INBOX_AI_MODEL = 'claude-3-opus';
  makeInboxReadTick(() => Promise.resolve({}));
  makeInboxReadTick(() => Promise.resolve({}));
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /INBOX_AI_MODEL=claude-3-opus .* using claude-opus-5-5/);
});

test("subjectTime is the subject's at, else its message's; an unknown time sorts last", () => {
  assert.equal(subjectTime(inbound(1, { minute: 30 })), T0 + 30 * 60000);
  const noAt = { ...inbound(1, { minute: 40 }), at: undefined };
  assert.equal(subjectTime(noAt), T0 + 40 * 60000);
  assert.equal(subjectTime({ ...noAt, subjectRef: 'sms:missing' }), Number.POSITIVE_INFINITY);
  const odd = { ...inbound(1), at: 'not a date' };
  assert.equal(subjectTime(odd), Number.POSITIVE_INFINITY);
});
