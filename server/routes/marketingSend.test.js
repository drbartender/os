require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.MARKETING_SEND_GAP_MS = '0';   // no pacing delay in tests

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError, QuotaExceededError } = require('../utils/errors');
const emailUtil = require('../utils/email');

// Intercept the real sender BEFORE the route module is required, so the route's
// destructured reference points at the mock. Every test asserts on database
// state, never on "we called Resend".
let sendBehavior = async () => ({ id: `re_${crypto.randomBytes(4).toString('hex')}` });
mock.method(emailUtil, 'sendEmail', (...args) => sendBehavior(...args));

const router = require('./marketingSend');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, base, adminToken, managerToken, campaignId;
let okA, okB, excluded, unsub, dupLower, dupUpper;

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = ''; res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const mkClient = async (label, email, patch = {}) => (await pool.query(
  `INSERT INTO clients (name, email, marketing_excluded, marketing_excluded_reason)
   VALUES ($1,$2,$3,$4) RETURNING id`,
  [`${label} ${NONCE}`, email, patch.excluded || false, patch.excluded ? 'send test' : null]
)).rows[0].id;

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email,password_hash,role,onboarding_status)
     VALUES ($1,'x','admin','approved') RETURNING id`, [`snd-admin-${NONCE}@mkt-test.example`]);
  const m = await pool.query(
    `INSERT INTO users (email,password_hash,role,onboarding_status)
     VALUES ($1,'x','manager','approved') RETURNING id`, [`snd-mgr-${NONCE}@mkt-test.example`]);
  adminToken = jwt.sign({ userId: a.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);
  managerToken = jwt.sign({ userId: m.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);

  campaignId = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','Hello there','<p>hi</p>') RETURNING id`, [`SND ${NONCE}`])).rows[0].id;

  okA = await mkClient('OkA', `snd-a-${NONCE}@mkt-test.example`);
  okB = await mkClient('OkB', `snd-b-${NONCE}@mkt-test.example`);
  excluded = await mkClient('Excl', `snd-x-${NONCE}@mkt-test.example`, { excluded: true });
  unsub = await mkClient('Unsub', `snd-u-${NONCE}@mkt-test.example`);
  await pool.query(
    `UPDATE clients SET communication_preferences =
       jsonb_set(communication_preferences,'{marketing_enabled}','false'::jsonb) WHERE id = $1`, [unsub]);
  // Case variants of ONE address: the unique index is on the raw email, so both
  // rows can exist and both would be mailed without the dedupe.
  dupLower = await mkClient('DupL', `snd-dup-${NONCE}@mkt-test.example`);
  dupUpper = await mkClient('DupU', `SND-DUP-${NONCE}@MKT-TEST.EXAMPLE`);

  const app = express();
  app.use(express.json());
  app.use('/api/marketing', router);
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, fieldErrors: err.fieldErrors });
  });
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  const ids = [okA, okB, excluded, unsub, dupLower, dupUpper].filter(Boolean);
  await pool.query('DELETE FROM email_sends WHERE campaign_id = $1', [campaignId]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM email_campaigns WHERE id = $1', [campaignId]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`snd-%-${NONCE}@mkt-test.example`]);
  if (server) await new Promise(r => server.close(r));
  await pool.end();
});

const sendsFor = async (clientId) => (await pool.query(
  'SELECT status, client_id, lead_id FROM email_sends WHERE campaign_id = $1 AND client_id = $2',
  [campaignId, clientId])).rows;

test('GUARD 1: a suppressed contact is re-checked at send time and never mailed', async () => {
  // The caller's list is a snapshot. Someone excluded between building it and
  // clicking Send is exactly who must not receive the campaign.
  const r = await req('POST', `/api/marketing/campaigns/${campaignId}/send`, adminToken,
    { client_ids: [okA, excluded, unsub] });
  assert.equal(r.status, 200);
  assert.equal(r.body.requested, 3);
  assert.equal(r.body.eligible, 1, 'only the clean contact is eligible');
  assert.equal(r.body.sent, 1);
  assert.equal((await sendsFor(excluded)).length, 0, 'no send row for a do-not-contact client');
  assert.equal((await sendsFor(unsub)).length, 0, 'no send row for an unsubscribed client');
  assert.equal((await sendsFor(okA))[0].status, 'sent');
});

test('the send row names the CLIENT, never a lead', async () => {
  const row = (await sendsFor(okA))[0];
  assert.equal(row.client_id, okA);
  assert.equal(row.lead_id, null, 'the recipient CHECK allows exactly one of the two');
});

test('GUARD 3: re-sending the same campaign to the same client sends nothing twice', async () => {
  // A double-click, or two operators. The database arbitrates via the partial
  // unique index; it is not a flag we read earlier and hoped stayed true.
  const before = (await sendsFor(okA)).length;
  const r = await req('POST', `/api/marketing/campaigns/${campaignId}/send`, adminToken,
    { client_ids: [okA] });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, 0);
  assert.equal(r.body.skipped_already_sent, 1);
  assert.equal((await sendsFor(okA)).length, before, 'no second row, no second email');
});

test('GUARD 2: two rows for one address are deduped to a single send', async () => {
  const r = await req('POST', `/api/marketing/campaigns/${campaignId}/send`, adminToken,
    { client_ids: [dupLower, dupUpper] });
  assert.equal(r.status, 200);
  assert.equal(r.body.eligible, 1, 'one human, one email, regardless of row count');
  assert.equal(r.body.sent, 1);
  const total = (await sendsFor(dupLower)).length + (await sendsFor(dupUpper)).length;
  assert.equal(total, 1);
});

test('a per-recipient failure is recorded and the run continues', async () => {
  const prev = sendBehavior;
  let n = 0;
  sendBehavior = async () => { n += 1; if (n === 1) throw new Error('mailbox full'); return { id: 're_ok' }; };
  try {
    const r = await req('POST', `/api/marketing/campaigns/${campaignId}/send`, adminToken,
      { client_ids: [okB] });
    assert.equal(r.status, 200);
    assert.equal(r.body.failed, 1);
    const row = (await sendsFor(okB))[0];
    assert.equal(row.status, 'failed', 'the failure is recorded against that recipient');
  } finally { sendBehavior = prev; }
});

test('a QUOTA rejection stops the run and leaves the rest re-sendable', async () => {
  // The critical difference from an ordinary failure. A quota error is about
  // the ACCOUNT, not the recipient: marking everyone remaining as failed would
  // be a lie, and would block the re-run that should just work tomorrow.
  const c2 = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','Quota test','<p>hi</p>') RETURNING id`, [`SNDQ ${NONCE}`])).rows[0].id;
  const q1 = await mkClient('Q1', `snd-q1-${NONCE}@mkt-test.example`);
  const q2 = await mkClient('Q2', `snd-q2-${NONCE}@mkt-test.example`);
  const prev = sendBehavior;
  sendBehavior = async () => { throw new QuotaExceededError('daily quota reached'); };
  try {
    const r = await req('POST', `/api/marketing/campaigns/${c2}/send`, adminToken,
      { client_ids: [q1, q2] });
    assert.equal(r.status, 200);
    assert.equal(r.body.stopped_early, 'quota');
    assert.equal(r.body.sent, 0);
    assert.equal(r.body.failed, 0, 'a quota stop must not mark anyone failed');
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM email_sends WHERE campaign_id = $1', [c2]);
    assert.equal(rows[0].n, 0, 'no claim survives, so a re-run picks everyone up');
  } finally {
    sendBehavior = prev;
    await pool.query('DELETE FROM email_sends WHERE campaign_id = $1', [c2]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [[q1, q2]]);
    await pool.query('DELETE FROM email_campaigns WHERE id = $1', [c2]);
  }
});

test('a send where everyone is suppressed is an error, not a silent success', async () => {
  const r = await req('POST', `/api/marketing/campaigns/${campaignId}/send`, adminToken,
    { client_ids: [excluded, unsub] });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.body.fieldErrors), /None of those contacts can be emailed/i);
});

test('input is bounded and validated', async () => {
  assert.equal((await req('POST', `/api/marketing/campaigns/${campaignId}/send`, adminToken, {})).status, 400);
  assert.equal((await req('POST', `/api/marketing/campaigns/${campaignId}/send`, adminToken, { client_ids: [] })).status, 400);
  const huge = await req('POST', `/api/marketing/campaigns/${campaignId}/send`, adminToken,
    { client_ids: Array.from({ length: 501 }, (_, i) => i + 1) });
  assert.equal(huge.status, 400, 'an unbounded recipient list is refused');
  assert.equal((await req('POST', '/api/marketing/campaigns/abc/send', adminToken, { client_ids: [okA] })).status, 400);
  assert.equal((await req('POST', '/api/marketing/campaigns/99999999/send', adminToken, { client_ids: [okA] })).status, 404);
});

test('a manager cannot send a campaign, and nor can an anonymous caller', async () => {
  assert.equal((await req('POST', `/api/marketing/campaigns/${campaignId}/send`, managerToken, { client_ids: [okA] })).status, 403);
  assert.equal((await req('POST', `/api/marketing/campaigns/${campaignId}/send`, null, { client_ids: [okA] })).status, 401);
});

// ─── Review round 1 (database-review) ──────────────────────────────

test('a FAILED recipient can be retried; they are never reported as already sent', async () => {
  // The claim row occupies the send-once index the moment it is inserted, so a
  // failed send used to lock that person out of the campaign permanently while
  // the re-run counted them as skipped_already_sent, which the UI renders as
  // "Already had this campaign". A false statement about somebody never mailed.
  const c2 = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','Retry me','<p>hi</p>') RETURNING id`, [`SNDR ${NONCE}`])).rows[0].id;
  const who = await mkClient('Retry', `snd-retry-${NONCE}@mkt-test.example`);
  const prev = sendBehavior;
  try {
    sendBehavior = async () => { throw new Error('transient 503'); };
    const first = await req('POST', `/api/marketing/campaigns/${c2}/send`, adminToken, { client_ids: [who] });
    assert.equal(first.body.failed, 1);

    sendBehavior = async () => ({ id: 're_retry_ok' });
    const second = await req('POST', `/api/marketing/campaigns/${c2}/send`, adminToken, { client_ids: [who] });
    assert.equal(second.body.sent, 1, 'a failed recipient must be retryable');
    assert.equal(second.body.skipped_already_sent, 0, 'and must NOT be reported as already sent');

    const rows = (await pool.query(
      'SELECT status FROM email_sends WHERE campaign_id=$1 AND client_id=$2', [c2, who])).rows;
    assert.equal(rows.length, 1, 'the retry reclaims the row rather than adding a second');
    assert.equal(rows[0].status, 'sent');
  } finally {
    sendBehavior = prev;
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [c2]);
    await pool.query('DELETE FROM clients WHERE id=$1', [who]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [c2]);
  }
});

test('a genuinely sent recipient is still skipped on a re-run', async () => {
  // The reclaim must not become a re-send. Only queued/failed rows reclaim.
  const r = await req('POST', `/api/marketing/campaigns/${campaignId}/send`, adminToken, { client_ids: [okA] });
  assert.equal(r.body.sent, 0);
  assert.equal(r.body.skipped_already_sent, 1);
});

test('a SECOND request naming a different row of the same person sends nothing', async () => {
  // Send-once is keyed on client_id; the dedupe is keyed on the address. Within
  // one request DISTINCT ON reconciles them. Across requests they disagreed, so
  // two sends naming different case-variant rows mailed that human twice.
  const before = (await pool.query(
    'SELECT COUNT(*)::int n FROM email_sends WHERE campaign_id=$1 AND client_id = ANY($2::int[])',
    [campaignId, [dupLower, dupUpper]])).rows[0].n;
  assert.equal(before, 1, 'the earlier dedupe test left exactly one');

  const other = (await pool.query(
    'SELECT id FROM email_sends WHERE campaign_id=$1 AND client_id=$2', [campaignId, dupLower])).rowCount
    ? dupUpper : dupLower;
  const r = await req('POST', `/api/marketing/campaigns/${campaignId}/send`, adminToken, { client_ids: [other] });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, 0, 'that human already received this campaign');
  assert.equal(r.body.skipped_already_sent, 1,
    'reported as already sent, NOT as "cannot be emailed": those are different facts '
    + 'and only one of them means check the suppression list');

  const after = (await pool.query(
    'SELECT COUNT(*)::int n FROM email_sends WHERE campaign_id=$1 AND client_id = ANY($2::int[])',
    [campaignId, [dupLower, dupUpper]])).rows[0].n;
  assert.equal(after, 1, 'still one send for one human');
});

// ─── Review round 2 (security-review): CONCURRENCY ─────────────────
//
// Every "two operators" claim above was tested SEQUENTIALLY, which is exactly
// how the reclaim regression slipped through: 'queued' is the state of an
// in-flight claim as well as a stranded one, so a second run could re-claim a
// row the first was actively sending. These run the sends genuinely in
// parallel.

test('two SIMULTANEOUS runs of the same campaign send each recipient once', async () => {
  const c2 = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','Concurrent','<p>hi</p>') RETURNING id`, [`SNDC ${NONCE}`])).rows[0].id;
  const people = [];
  for (let i = 0; i < 4; i++) people.push(await mkClient(`Con${i}`, `snd-con${i}-${NONCE}@mkt-test.example`));
  const prev = sendBehavior;
  let calls = 0;
  // A realistic Resend round trip, so the in-flight window is real.
  sendBehavior = async () => { calls += 1; await new Promise(r => setTimeout(r, 120)); return { id: 're_con' }; };
  try {
    const [a, b] = await Promise.all([
      req('POST', `/api/marketing/campaigns/${c2}/send`, adminToken, { client_ids: people }),
      req('POST', `/api/marketing/campaigns/${c2}/send`, adminToken, { client_ids: people }),
    ]);
    const statuses = [a.status, b.status].sort();
    // Either the loser is refused outright (the run claim) or it runs and
    // claims nothing. Both are correct; sending twice is not.
    assert.ok(statuses[0] === 200, `at least one run must succeed: ${JSON.stringify(statuses)}`);

    const rows = (await pool.query(
      'SELECT client_id, COUNT(*)::int n FROM email_sends WHERE campaign_id=$1 GROUP BY client_id', [c2])).rows;
    assert.equal(rows.length, people.length, 'one row per recipient');
    assert.ok(rows.every(r => r.n === 1), 'never two rows for one recipient');
    assert.equal(calls, people.length,
      `Resend must be called exactly once per recipient, got ${calls} for ${people.length}`);
  } finally {
    sendBehavior = prev;
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [c2]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [people]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [c2]);
  }
});

test('a campaign whose reply_to is not ours is refused', async () => {
  // Campaign CRUD is requireAdminOrManager; this send is adminOnly. Without the
  // check a manager could point reply_to at an address they control and harvest
  // every reply to a blast an admin sent.
  const c3 = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body,reply_to)
     VALUES ($1,'blast','draft','Hijack','<p>hi</p>','attacker@evil.example') RETURNING id`,
    [`SNDH ${NONCE}`])).rows[0].id;
  const who = await mkClient('Hij', `snd-hij-${NONCE}@mkt-test.example`);
  try {
    const r = await req('POST', `/api/marketing/campaigns/${c3}/send`, adminToken, { client_ids: [who] });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body.fieldErrors), /reply_to/);
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM email_sends WHERE campaign_id=$1', [c3]);
    assert.equal(rows[0].n, 0, 'refused before anything was claimed or sent');
  } finally {
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [c3]);
    await pool.query('DELETE FROM clients WHERE id=$1', [who]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [c3]);
  }
});

test('our own reply_to is accepted, including a Name <addr> form', async () => {
  const c4 = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body,reply_to)
     VALUES ($1,'blast','draft','Ours','<p>hi</p>','Dr. Bartender <contact@drbartender.com>') RETURNING id`,
    [`SNDO ${NONCE}`])).rows[0].id;
  const who = await mkClient('Ours', `snd-ours-${NONCE}@mkt-test.example`);
  try {
    const r = await req('POST', `/api/marketing/campaigns/${c4}/send`, adminToken, { client_ids: [who] });
    assert.equal(r.status, 200, 'must not over-reject our own address');
    assert.equal(r.body.sent, 1);
  } finally {
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [c4]);
    await pool.query('DELETE FROM clients WHERE id=$1', [who]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [c4]);
  }
});

test('an out-of-int4-range recipient id is a 400, not a 500', async () => {
  const r = await req('POST', `/api/marketing/campaigns/${campaignId}/send`, adminToken,
    { client_ids: [9999999999] });
  assert.equal(r.status, 400);
});

test('a FRESH queued claim is not reclaimable; a STALE one is', async () => {
  // Pins the reclaim predicate directly, because the advisory lock would
  // otherwise mask it: the concurrency test above passes even with a bad
  // predicate, since the second run never gets in. This exercises the SQL.
  const c5 = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','Reclaim','<p>hi</p>') RETURNING id`, [`SNDX ${NONCE}`])).rows[0].id;
  const who = await mkClient('Rec', `snd-rec-${NONCE}@mkt-test.example`);
  const claim = async () => pool.query(
    `INSERT INTO email_sends (campaign_id, client_id, subject, status)
     VALUES ($1,$2,'Reclaim','queued')
     ON CONFLICT (campaign_id, client_id) WHERE campaign_id IS NOT NULL AND client_id IS NOT NULL
     DO UPDATE SET status = 'queued', error_message = NULL, sent_at = NOW()
       WHERE email_sends.status = 'failed'
          OR (email_sends.status = 'queued'
              AND email_sends.sent_at < NOW() - INTERVAL '10 minutes')
     RETURNING id`, [c5, who]);
  try {
    const first = await claim();
    assert.equal(first.rowCount, 1, 'the first claim succeeds');

    // A claim seconds old is IN FLIGHT, not stranded. Re-claiming it is what
    // made two concurrent runs mail everyone twice.
    const fresh = await claim();
    assert.equal(fresh.rowCount, 0, 'a fresh in-flight claim must NOT be reclaimable');

    // Age it past the staleness bound: now it is genuinely stranded.
    await pool.query(
      "UPDATE email_sends SET sent_at = NOW() - INTERVAL '11 minutes' WHERE campaign_id=$1 AND client_id=$2",
      [c5, who]);
    const stale = await claim();
    assert.equal(stale.rowCount, 1, 'a stranded claim must be reclaimable, or that recipient is locked out forever');

    // A row that genuinely went out is never reclaimable at any age.
    await pool.query(
      "UPDATE email_sends SET status='sent', sent_at = NOW() - INTERVAL '99 minutes' WHERE campaign_id=$1 AND client_id=$2",
      [c5, who]);
    const sent = await claim();
    assert.equal(sent.rowCount, 0, 'a delivered send is never re-sent, however old');
  } finally {
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [c5]);
    await pool.query('DELETE FROM clients WHERE id=$1', [who]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [c5]);
  }
});

// ─── Review round 3 (code-review) ──────────────────────────────────

test('the run claim is a real mutex, unlike the advisory lock it replaced', async () => {
  // pg_try_advisory_lock was a NO-OP here: DATABASE_URL is Neon's PgBouncer
  // -pooler endpoint, so many pool checkouts share one server session and
  // session locks are re-entrant within it. Probed live: six checkouts, one
  // backend pid, two of them acquiring the SAME lock. A conditional UPDATE is
  // atomic in one statement regardless of pooling.
  const c6 = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','Mutex','<p>hi</p>') RETURNING id`, [`SNDM ${NONCE}`])).rows[0].id;
  const claim = () => pool.query(
    `UPDATE email_campaigns SET status='sending', sent_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND (status <> 'sending' OR sent_at IS NULL OR sent_at < NOW() - INTERVAL '15 minutes')
      RETURNING id`, [c6]);
  try {
    const [a, b] = await Promise.all([claim(), claim()]);
    assert.equal(a.rowCount + b.rowCount, 1, 'exactly one of two simultaneous claims wins');

    // A run that died mid-send must not lock the campaign out forever.
    await pool.query("UPDATE email_campaigns SET sent_at = NOW() - INTERVAL '16 minutes' WHERE id=$1", [c6]);
    assert.equal((await claim()).rowCount, 1, 'a stale sending claim is recoverable');
  } finally {
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [c6]);
  }
});

test('a comma address list cannot smuggle an outside reply_to', async () => {
  // The first guard anchored on the END of the string, so
  // "attacker@evil.com, ops@drbartender.com" — a valid RFC 5322 address list —
  // walked straight through.
  const c7 = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body,reply_to)
     VALUES ($1,'blast','draft','List','<p>hi</p>','attacker@evil.example, ops@drbartender.com') RETURNING id`,
    [`SNDL ${NONCE}`])).rows[0].id;
  const who = await mkClient('List', `snd-list-${NONCE}@mkt-test.example`);
  try {
    const r = await req('POST', `/api/marketing/campaigns/${c7}/send`, adminToken, { client_ids: [who] });
    assert.equal(r.status, 400, 'an address list must be refused outright');
    assert.match(JSON.stringify(r.body.fieldErrors), /reply_to/);
  } finally {
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [c7]);
    await pool.query('DELETE FROM clients WHERE id=$1', [who]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [c7]);
  }
});

test('deduped is reported apart from suppression', async () => {
  // Two case-variant rows of one person is NOT somebody being held back, and
  // the operator should not be told it was.
  const c8 = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','Counts','<p>hi</p>') RETURNING id`, [`SNDD ${NONCE}`])).rows[0].id;
  const addr = `snd-cnt-${NONCE}@mkt-test.example`;
  const a = await mkClient('CntA', addr);
  const b = await mkClient('CntB', addr.toUpperCase());
  const x = await mkClient('CntX', `snd-cntx-${NONCE}@mkt-test.example`, { excluded: true });
  try {
    const r = await req('POST', `/api/marketing/campaigns/${c8}/send`, adminToken, { client_ids: [a, b, x] });
    assert.equal(r.status, 200);
    assert.equal(r.body.requested, 3);
    assert.equal(r.body.deduped, 1, 'two rows, one person');
    assert.equal(r.body.eligible, 1);
    assert.equal(r.body.sent, 1);
    // requested - eligible is 2, but only ONE of those was suppression.
    assert.equal(r.body.requested - r.body.eligible - r.body.deduped, 1,
      'exactly one contact was actually held back');
  } finally {
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [c8]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [[a, b, x]]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [c8]);
  }
});

// ─── Review round 4 (consistency-check) ────────────────────────────

test('a SEQUENCE campaign is refused: its status is the drip on-switch', async () => {
  // emailSequenceScheduler and the public capture-lead enrolment both gate on
  // status='active'. Claiming it 'sending' and releasing it 'sent' would stop
  // the drip for every enrollment, recoverable only by someone noticing.
  const cs = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'sequence','active','Drip','<p>hi</p>') RETURNING id`, [`SNDSEQ ${NONCE}`])).rows[0].id;
  const who = await mkClient('Seq', `snd-seq-${NONCE}@mkt-test.example`);
  try {
    const r = await req('POST', `/api/marketing/campaigns/${cs}/send`, adminToken, { client_ids: [who] });
    assert.equal(r.status, 400);
    const { rows } = await pool.query('SELECT status FROM email_campaigns WHERE id=$1', [cs]);
    assert.equal(rows[0].status, 'active', 'the sequence must still be running');
  } finally {
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [cs]);
    await pool.query('DELETE FROM clients WHERE id=$1', [who]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [cs]);
  }
});

test('a refused run does not stamp a send date on a campaign that never sent', async () => {
  // The run claim overwrites sent_at so the staleness escape has a fresh stamp.
  // Without restoring it, an all-suppressed run left a draft displaying a send
  // date, and a re-run overwrote the real date of one that had genuinely gone.
  const cd = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','NoStamp','<p>hi</p>') RETURNING id`, [`SNDNS ${NONCE}`])).rows[0].id;
  try {
    const r = await req('POST', `/api/marketing/campaigns/${cd}/send`, adminToken, { client_ids: [excluded] });
    assert.equal(r.status, 400, 'everyone submitted is suppressed');
    const { rows } = await pool.query('SELECT status, sent_at FROM email_campaigns WHERE id=$1', [cd]);
    assert.equal(rows[0].status, 'draft', 'status restored');
    assert.equal(rows[0].sent_at, null, 'and no send date invented');
  } finally {
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [cd]);
  }
});

test('a quota stop leaves the campaign resumable, not re-sendable from scratch', async () => {
  // Both duplicate defenses are keyed on campaign_id, so resuming MUST mean
  // re-sending the same campaign. The UI keeps campaignId when stopped_early
  // is set; this pins the server half: everyone already sent stays recorded.
  const cq = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','Resume','<p>hi</p>') RETURNING id`, [`SNDRS ${NONCE}`])).rows[0].id;
  const a = await mkClient('Res1', `snd-res1-${NONCE}@mkt-test.example`);
  const b = await mkClient('Res2', `snd-res2-${NONCE}@mkt-test.example`);
  const prev = sendBehavior;
  let n = 0;
  try {
    // First recipient succeeds, then the quota trips.
    sendBehavior = async () => { n += 1; if (n === 1) return { id: 're_first' };
      const { QuotaExceededError } = require('../utils/errors'); throw new QuotaExceededError('quota'); };
    const first = await req('POST', `/api/marketing/campaigns/${cq}/send`, adminToken, { client_ids: [a, b] });
    assert.equal(first.body.stopped_early, 'quota');
    assert.equal(first.body.sent, 1);

    // Resume the SAME campaign: the one already sent is skipped, the other goes.
    sendBehavior = async () => ({ id: 're_second' });
    const second = await req('POST', `/api/marketing/campaigns/${cq}/send`, adminToken, { client_ids: [a, b] });
    assert.equal(second.body.sent, 1, 'only the untried recipient is sent');
    assert.equal(second.body.skipped_already_sent, 1, 'the one already mailed is not mailed twice');

    const rows = (await pool.query(
      'SELECT client_id, COUNT(*)::int n FROM email_sends WHERE campaign_id=$1 GROUP BY client_id', [cq])).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.n === 1), 'one send row per person across both runs');
  } finally {
    sendBehavior = prev;
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [cq]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [[a, b]]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [cq]);
  }
});

// ─── Review round 5 ────────────────────────────────────────────────

test('a run that lost its claim cannot release the newer run on its way out', async () => {
  // Ownership, not just presence. Run A claims; A overruns the staleness window;
  // B claims via the escape; A finishes and its release must NOT match B's row.
  // Otherwise A's restore wins and a campaign that just mailed forty people
  // finishes as draft with a null send date. Same defect class as the
  // cross-connection advisory unlock this claim replaced.
  const cw = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','Own','<p>hi</p>') RETURNING id`, [`SNDOWN ${NONCE}`])).rows[0].id;
  const claim = () => pool.query(
    `UPDATE email_campaigns SET status='sending', sent_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND (status <> 'sending' OR sent_at IS NULL OR sent_at < NOW() - make_interval(mins => $2::int))
      RETURNING sent_at::text AS claim_stamp`, [cw, 15]);
  const release = (stamp, status) => pool.query(
    `UPDATE email_campaigns SET status=$2, updated_at=NOW()
      WHERE id=$1 AND status='sending' AND sent_at::text=$3 RETURNING id`, [cw, status, stamp]);
  try {
    const a = await claim();
    const stampA = a.rows[0].claim_stamp;

    // Age A's claim past the window, then let B take over.
    await pool.query("UPDATE email_campaigns SET sent_at = NOW() - INTERVAL '16 minutes' WHERE id=$1", [cw]);
    const staleStampA = (await pool.query('SELECT sent_at::text AS s FROM email_campaigns WHERE id=$1', [cw])).rows[0].s;
    const b = await claim();
    assert.equal(b.rowCount, 1, 'B takes over the stale claim');

    // A now finishes. Its release names ITS stamp, which B has overwritten.
    assert.equal((await release(staleStampA, 'draft')).rowCount, 0,
      'the loser must not release the winner');
    assert.notEqual(stampA, b.rows[0].claim_stamp);

    const still = await pool.query('SELECT status FROM email_campaigns WHERE id=$1', [cw]);
    assert.equal(still.rows[0].status, 'sending', "B's claim survives A's exit");

    // B releases its own claim normally.
    assert.equal((await release(b.rows[0].claim_stamp, 'sent')).rowCount, 1);
  } finally {
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [cw]);
  }
});

test('the campaign PUT cannot set or clear the send mutex', async () => {
  // The send's mutex lives in a column requireAdminOrManager can write, while
  // the send itself is adminOnly. Setting 'sending' parks a campaign and blocks
  // admin sends; clearing it mid-run lets a second run claim alongside the first.
  const cm = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','Mutexcol','<p>hi</p>') RETURNING id`, [`SNDMC ${NONCE}`])).rows[0].id;
  const put = (status) => pool.query(`
    UPDATE email_campaigns SET
      status = CASE
                 WHEN $2::text = 'sending' THEN status
                 WHEN status = 'sending' THEN status
                 ELSE COALESCE($2, status)
               END
    WHERE id = $1 RETURNING status`, [cm, status]);
  try {
    assert.equal((await put('sending')).rows[0].status, 'draft', 'cannot PUT a campaign into sending');
    assert.equal((await put('paused')).rows[0].status, 'paused', 'ordinary status writes still work');

    await pool.query("UPDATE email_campaigns SET status='sending', sent_at=NOW() WHERE id=$1", [cm]);
    assert.equal((await put('draft')).rows[0].status, 'sending', 'cannot PUT a sending campaign out of it');
  } finally {
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [cm]);
  }
});

test('a run that completes WITH FAILURES keeps the campaign retryable', async () => {
  // The server reclaims a 'failed' row and the already-sent set excludes
  // 'failed', so the retry is built. Clearing campaignId here would make the
  // operator's natural next action mint a NEW campaign, and both duplicate
  // defenses are keyed on campaign_id: the blast radius is not the failures,
  // it is everyone in the run, twice.
  const cf = (await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body)
     VALUES ($1,'blast','draft','Retryable','<p>hi</p>') RETURNING id`, [`SNDRT ${NONCE}`])).rows[0].id;
  const a = await mkClient('Rt1', `snd-rt1-${NONCE}@mkt-test.example`);
  const b = await mkClient('Rt2', `snd-rt2-${NONCE}@mkt-test.example`);
  const prev = sendBehavior;
  let n = 0;
  try {
    sendBehavior = async () => { n += 1; if (n === 1) return { id: 're_ok' }; throw new Error('mailbox full'); };
    const first = await req('POST', `/api/marketing/campaigns/${cf}/send`, adminToken, { client_ids: [a, b] });
    assert.equal(first.body.sent, 1);
    assert.equal(first.body.failed, 1);
    assert.equal(first.body.stopped_early, null, 'a completed-with-failures run does not stop early');

    sendBehavior = async () => ({ id: 're_retry' });
    const second = await req('POST', `/api/marketing/campaigns/${cf}/send`, adminToken, { client_ids: [a, b] });
    assert.equal(second.body.sent, 1, 'only the failure is retried');
    assert.equal(second.body.skipped_already_sent, 1, 'the delivered one is not mailed twice');

    const rows = (await pool.query(
      'SELECT client_id, COUNT(*)::int n FROM email_sends WHERE campaign_id=$1 GROUP BY client_id', [cf])).rows;
    assert.ok(rows.every(r => r.n === 1), 'one row per person across both runs');
  } finally {
    sendBehavior = prev;
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [cf]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [[a, b]]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [cf]);
  }
});
