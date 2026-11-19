'use strict';

// The GV post sweep (spec 2026-10-17 section 6 "Sweep", laws 2, 4 and 5; plan
// Task 9): stale and unknown rows, the toll-free fallback retry, the
// interrupted claim, and the outage signals. DB suite on the shared dev
// database: run ALONE,
//   node --test server/utils/gvPostSweepScheduler.test.js
// The sweep acts on every gv_posts row on the database, so the suite refuses
// to start while any row it would touch exists (queued, leased, an unclaimed
// stale or failed_preclick, or a claim). Nothing can send: both toll-free
// senders are stubbed through fallback.__setDeps (the claim and the
// fallback_status writes stay real), the admin email through
// outage.__setDeps, Sentry through the sweep's __setDeps, and
// SEND_NOTIFICATIONS stays 'false'. A queued row lives only inside the test
// that makes it, which sweeps it at once; any row a later sweep would still
// act on is dropped by id at the end of its test. Every fixture is invented
// (names, 555-01xx numbers, negotiation ids) and deleted by id in after();
// gv_sender_state is reset with UPDATE, never DELETE, and restored after.
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('gvPostSweepScheduler.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { proposalUrl } = require('./urls');
const { sendInitialProposalText } = require('./sendProposalSentEmail');
const { load, sendResendText } = require('./comms/actions/proposalResend');
const { notifyAdminCategory } = require('./adminNotifications');
const fallback = require('./gvPost/fallback');
const outage = require('./gvPost/outage');
const sweep = require('./gvPostSweepScheduler');

const { runGvPostSweep } = sweep;
const RUN = `gvsw-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const ORIG_FLAG = process.env.GV_PROPOSAL_POST_ENABLED;
const STATE_COLUMNS = [
  'outage_since', 'outage_reason', 'outage_alerted_at', 'last_lease_at', 'last_success_at',
  'consecutive_preclick_failures', 'consecutive_unknown', 'consecutive_unverified',
];
const created = { posts: [], proposals: [], clients: [], users: [] };
let userId, snapshot;
let seq = 0;
let npa;
let nextLine = 0;
let sends = [];
let mails = [];
let warnings = [];

const postRow = async (id) => (await pool.query('SELECT * FROM gv_posts WHERE id = $1', [id])).rows[0];
const state = async () => (await pool.query('SELECT * FROM gv_sender_state WHERE id = 1')).rows[0];
const warned = (event) => warnings.filter((w) => w.ctx && w.ctx.tags && w.ctx.tags.event === event);
const drop = (ids) => pool.query('DELETE FROM gv_posts WHERE id = ANY($1::int[])', [ids]);

// A 555-01xx number nothing on the dev DB carries yet.
async function freshPhone() {
  for (;;) {
    if (nextLine > 99) { npa += 1; nextLine = 0; }
    const digits = `${npa}55501${String(nextLine).padStart(2, '0')}`;
    nextLine += 1;
    const { rows } = await pool.query(
      `SELECT 1 FROM thumbtack_leads WHERE RIGHT(REGEXP_REPLACE(customer_phone, '\\D', '', 'g'), 10) = $1
       UNION ALL SELECT 1 FROM clients WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
       UNION ALL SELECT 1 FROM sms_optouts WHERE phone_last10 = $1
       LIMIT 1`,
      [digits]
    );
    if (rows.length === 0) return digits;
  }
}

// A client and a sent proposal, textable.
async function mkProposal() {
  seq += 1;
  const phone = await freshPhone();
  const c = await pool.query(
    'INSERT INTO clients (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
    [`Gv Sweep ${RUN} ${seq}`, `gv-sweep-${RUN}-${seq}@example.test`, phone]
  );
  created.clients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'sent', 'wedding-reception', 1000, 'America/Chicago')
     RETURNING id, token`,
    [c.rows[0].id]
  );
  created.proposals.push(p.rows[0].id);
  return { phone, clientId: c.rows[0].id, proposalId: p.rows[0].id, token: p.rows[0].token };
}

// A hand-inserted post, its times in minutes ago. leased and unknown rows
// carry a lease time; a fallback status carries its claim time.
async function mkPost(f, opts = {}) {
  const {
    status = 'queued', sendPath = 'auto', reason = null, createdMinAgo = 0, leasedMinAgo = 1,
    updatedMinAgo = createdMinAgo, fallbackStatus = null, fallbackMinAgo = 1,
  } = opts;
  seq += 1;
  const body = `Hi, this is Dallas from Dr. Bartender. Your proposal is ready: ${proposalUrl(f.token)}.`;
  const { rows } = await pool.query(
    `INSERT INTO gv_posts (proposal_id, client_id, negotiation_id, body, send_path, sent_by, status, reason,
                           leased_at, fallback_status, fallback_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text, $8,
             CASE WHEN $7::text IN ('leased','unknown') THEN now() - ($9::float8 * interval '1 minute') END,
             $10::text, CASE WHEN $10::text IS NOT NULL THEN now() - ($11::float8 * interval '1 minute') END,
             now() - ($12::float8 * interval '1 minute'), now() - ($13::float8 * interval '1 minute'))
     RETURNING *`,
    [f.proposalId, f.clientId, `${RUN}-neg-${seq}`, body, sendPath, userId, status, reason,
      leasedMinAgo, fallbackStatus, fallbackMinAgo, createdMinAgo, updatedMinAgo]
  );
  created.posts.push(rows[0].id);
  return rows[0];
}

before(async () => {
  npa = 200 + crypto.randomInt(0, 600);
  const busy = await pool.query(
    `SELECT COUNT(*)::int AS n FROM gv_posts
      WHERE status IN ('queued','leased')
         OR (fallback_status IS NULL AND status IN ('stale','failed_preclick'))
         OR fallback_status = 'claimed'`
  );
  assert.equal(busy.rows[0].n, 0, 'precondition: gv_posts rows on the dev DB the sweep would act on');
  snapshot = await state();
  assert.ok(snapshot, 'precondition: the gv_sender_state seed row (id 1) exists; run initDb');

  fallback.__setDeps({
    sendInitialProposalText: (proposal, opts) => {
      sends.push({ path: 'auto', proposalId: proposal.id, opts });
      return Promise.resolve('sent');
    },
    sendResendText: (args) => {
      sends.push({ path: 'compose', proposalId: args.row.id, body: args.body });
      return Promise.resolve({ status: 'sent' });
    },
  });
  outage.__setDeps({
    notifyAdminCategory: (args) => { mails.push(args); return Promise.resolve({ emailed: 1, texted: 0, pushQueued: 0 }); },
  });
  sweep.__setDeps({
    Sentry: {
      captureMessage: (message, ctx) => { warnings.push({ message, ctx }); },
      captureException: (err, ctx) => { warnings.push({ message: err.message, ctx }); },
    },
  });

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id`,
    [`gv-sweep-${RUN}@example.test`]
  );
  userId = u.rows[0].id;
  created.users.push(userId);
});

beforeEach(async () => {
  process.env.GV_PROPOSAL_POST_ENABLED = 'true';
  sends = [];
  mails = [];
  warnings = [];
  // A box that leased a moment ago, so the no-lease check stays quiet unless
  // a test says otherwise.
  await pool.query(
    `UPDATE gv_sender_state
        SET outage_since = NULL, outage_reason = NULL, outage_alerted_at = NULL, last_lease_at = now(),
            consecutive_preclick_failures = 0, consecutive_unknown = 0, consecutive_unverified = 0,
            updated_at = now()
      WHERE id = 1`
  );
});

// Fixtures first: nothing that can throw runs before the deletes.
after(async () => {
  if (ORIG_FLAG === undefined) delete process.env.GV_PROPOSAL_POST_ENABLED;
  else process.env.GV_PROPOSAL_POST_ENABLED = ORIG_FLAG;
  try {
    if (created.posts.length) await drop(created.posts);
    if (created.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [created.proposals]);
    if (created.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [created.clients]);
    if (created.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [created.users]);
    if (snapshot) {
      await pool.query(
        `UPDATE gv_sender_state
            SET outage_since = $1, outage_reason = $2, outage_alerted_at = $3, last_lease_at = $4,
                last_success_at = $5, consecutive_preclick_failures = $6, consecutive_unknown = $7,
                consecutive_unverified = $8, updated_at = now()
          WHERE id = 1`,
        STATE_COLUMNS.map((c) => snapshot[c]) // eslint-disable-line security/detect-object-injection
      );
    }
  } finally {
    if (typeof fallback.__setDeps === 'function') fallback.__setDeps({ sendInitialProposalText, sendResendText, load });
    if (typeof outage.__setDeps === 'function') outage.__setDeps({ notifyAdminCategory });
    if (typeof sweep.__setDeps === 'function') sweep.__setDeps({ Sentry });
    await pool.end();
  }
});

test('a queued row older than 5 minutes goes stale and sends one fallback across two sweeps', async () => {
  const f = await mkProposal();
  const old = await mkPost(f, { createdMinAgo: 6 });
  const young = await mkPost(await mkProposal(), { createdMinAgo: 1 });
  try {
    assert.deepEqual(await runGvPostSweep(), { staled: 1, unknowned: 0, alerted: false });
    const row = await postRow(old.id);
    assert.equal(row.status, 'stale');
    assert.equal(row.reason, null);
    assert.ok(row.updated_at > old.updated_at, 'the stale write stamps updated_at');
    assert.equal(row.fallback_status, 'sent');
    assert.deepEqual(sends.map((s) => [s.path, s.proposalId, s.opts.via]), [['auto', f.proposalId, 'twilio']]);
    assert.equal((await postRow(young.id)).status, 'queued', 'a 1-minute-old row waits for the box');
    assert.equal(warned('stale').length, 1);
    assert.equal(warned('stale')[0].ctx.extra.count, 1);

    assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 0, alerted: false });
    assert.equal(sends.length, 1, 'one fallback, ever');
    assert.equal(warned('stale').length, 1, 'a run that staled nothing sends no warning');
    assert.equal(mails.length, 0);
  } finally {
    await drop([young.id]);
  }
});

test('a leased row older than 3 minutes goes unknown with no fallback', async () => {
  const old = await mkPost(await mkProposal(), { status: 'leased', createdMinAgo: 5, leasedMinAgo: 4 });
  const fresh = await mkPost(await mkProposal(), { status: 'leased', createdMinAgo: 2, leasedMinAgo: 1 });
  try {
    assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 1, alerted: false });
    const row = await postRow(old.id);
    assert.equal(row.status, 'unknown');
    assert.ok(row.updated_at > old.updated_at, 'the unknown write stamps updated_at');
    assert.equal(row.fallback_status, null, 'unknown may be in the thread: never a fallback');
    assert.equal((await postRow(fresh.id)).status, 'leased', 'a lease inside its window is left alone');
    assert.equal(sends.length, 0);
    assert.equal((await state()).consecutive_unknown, 1);
    assert.equal(warned('unknown').length, 1);
    assert.equal(warned('unknown')[0].ctx.extra.count, 1);

    assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 0, alerted: false });
    assert.equal(sends.length, 0);
    assert.equal((await state()).consecutive_unknown, 1, 'each row counts once');
  } finally {
    await drop([fresh.id]);
  }
});

test('stale rows with no lease in 30 minutes email once', async () => {
  await pool.query("UPDATE gv_sender_state SET last_lease_at = now() - interval '31 minutes' WHERE id = 1");
  await mkPost(await mkProposal(), { createdMinAgo: 6 });
  assert.deepEqual(await runGvPostSweep(), { staled: 1, unknowned: 0, alerted: true });
  assert.equal(mails.length, 1);
  assert.equal(mails[0].category, 'routine_thumbtack');
  assert.ok(mails[0].emailText.includes('(reason: no_lease)'));
  assert.equal(mails[0].smsBody, undefined, 'email only');
  assert.equal((await state()).outage_reason, 'no_lease');

  await mkPost(await mkProposal(), { createdMinAgo: 7 });
  assert.deepEqual(await runGvPostSweep(), { staled: 1, unknowned: 0, alerted: false });
  assert.equal(mails.length, 1, 'one email per episode');
  assert.equal(sends.length, 2, 'every stale row still gets its fallback');

  // A box that leased recently is alive: stale rows alone never alert.
  await pool.query(
    `UPDATE gv_sender_state SET outage_since = NULL, outage_reason = NULL, outage_alerted_at = NULL,
            last_lease_at = now() - interval '5 minutes' WHERE id = 1`
  );
  await mkPost(await mkProposal(), { createdMinAgo: 6 });
  assert.deepEqual(await runGvPostSweep(), { staled: 1, unknowned: 0, alerted: false });
  // No lease ever, but nothing went stale: an idle sender with nothing to send is fine.
  await pool.query('UPDATE gv_sender_state SET last_lease_at = NULL WHERE id = 1');
  assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 0, alerted: false });
  assert.equal(mails.length, 1);
  // No lease ever, and a row went stale: an outage.
  await mkPost(await mkProposal(), { createdMinAgo: 6 });
  assert.deepEqual(await runGvPostSweep(), { staled: 1, unknowned: 0, alerted: true });
  assert.equal(mails.length, 2);
});

test('flag off still drains queued rows to one fallback each and emails nobody', async () => {
  // Review Focus 4: the switch is flipped off with rows queued, and the box
  // idles (the lease returns []), so nothing will ever lease them.
  process.env.GV_PROPOSAL_POST_ENABLED = 'false';
  await pool.query('UPDATE gv_sender_state SET last_lease_at = NULL WHERE id = 1');
  const f = await mkProposal();
  const g = await mkProposal();
  const autoPost = await mkPost(f, { createdMinAgo: 6, sendPath: 'auto' });
  const composePost = await mkPost(g, { createdMinAgo: 7, sendPath: 'compose' });
  assert.deepEqual(await runGvPostSweep(), { staled: 2, unknowned: 0, alerted: false });
  for (const post of [autoPost, composePost]) {
    const row = await postRow(post.id);
    assert.equal(row.status, 'stale');
    assert.equal(row.fallback_status, 'sent');
  }
  const byProposal = Object.fromEntries(sends.map((s) => [s.proposalId, s]));
  assert.equal(sends.length, 2);
  assert.equal(byProposal[f.proposalId].path, 'auto');
  assert.equal(byProposal[g.proposalId].path, 'compose');
  assert.equal(byProposal[g.proposalId].body, composePost.body, 'the stored body');

  assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 0, alerted: false });
  assert.equal(sends.length, 2, 'one fallback each');
  assert.equal(mails.length, 0, 'a rollback is not an outage');
  assert.equal((await state()).outage_since, null);
});

test('an unclaimed failed_preclick row gets its fallback on the next sweep', async () => {
  // A restart between the status write and the fallback call leaves the row
  // unclaimed; the retry arm takes it once its last write is half a minute old.
  const f = await mkProposal();
  const g = await mkProposal();
  const failed = await mkPost(f, {
    status: 'failed_preclick', reason: 'session_expired', sendPath: 'compose', createdMinAgo: 6, updatedMinAgo: 1.5,
  });
  const stale = await mkPost(g, { status: 'stale', createdMinAgo: 9, updatedMinAgo: 1.2 });
  // Written 12 seconds ago: its own fallback call may still be on the way.
  // Old by created_at, young by updated_at, which is what the retry reads.
  const recent = await mkPost(await mkProposal(), {
    status: 'failed_preclick', reason: 'timeout', createdMinAgo: 10, updatedMinAgo: 0.2,
  });
  // unknown may be in the thread: no arm ever texts it.
  const unknown = await mkPost(await mkProposal(), {
    status: 'unknown', createdMinAgo: 10, leasedMinAgo: 8, updatedMinAgo: 5,
  });
  try {
    assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 0, alerted: false });
    const failedRow = await postRow(failed.id);
    assert.equal(failedRow.fallback_status, 'sent');
    assert.equal(failedRow.status, 'failed_preclick');
    assert.equal(failedRow.reason, 'session_expired');
    assert.equal((await postRow(stale.id)).fallback_status, 'sent');
    assert.equal((await postRow(recent.id)).fallback_status, null, 'its last write is under half a minute old');
    const unknownRow = await postRow(unknown.id);
    assert.equal(unknownRow.status, 'unknown');
    assert.equal(unknownRow.fallback_status, null);
    assert.equal(sends.length, 2);
    assert.deepEqual(sends.find((s) => s.path === 'compose'), { path: 'compose', proposalId: f.proposalId, body: failed.body });
    assert.equal(sends.find((s) => s.path === 'auto').proposalId, g.proposalId);

    await runGvPostSweep();
    assert.equal(sends.length, 2, 'the claim makes the retry safe: one text each');
  } finally {
    await drop([recent.id]);
  }
});

test('a row left unclaimed past 2 minutes is marked failed and never texted late', async () => {
  // From 2 minutes the proposal page reads "the fallback failed" and the team
  // pastes by hand (status.js), so a text sent after that could land beside a
  // hand paste. A sweep that was down, or whose claims kept failing, closes
  // the row instead of sending.
  const late = await mkPost(await mkProposal(), { status: 'stale', createdMinAgo: 30, updatedMinAgo: 2.5 });
  const lateWithReason = await mkPost(await mkProposal(), {
    status: 'failed_preclick', reason: 'timeout', createdMinAgo: 30, updatedMinAgo: 20,
  });
  // 45 seconds old: inside the window, which opens at half a minute.
  const inWindow = await mkPost(await mkProposal(), { status: 'stale', createdMinAgo: 9, updatedMinAgo: 0.75 });
  assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 0, alerted: false });
  const row = await postRow(late.id);
  assert.equal(row.status, 'stale');
  assert.equal(row.fallback_status, 'failed');
  assert.equal(row.reason, 'interrupted');
  assert.ok(row.fallback_at, 'the pair check: a fallback status carries its time');
  assert.ok(row.updated_at > late.updated_at, 'the failed write stamps updated_at');
  const kept = await postRow(lateWithReason.id);
  assert.equal(kept.fallback_status, 'failed');
  assert.equal(kept.reason, 'timeout', 'the box\'s reason is kept');
  assert.equal((await postRow(inWindow.id)).fallback_status, 'sent', 'a row inside the window is still retried');
  assert.equal(sends.length, 1, 'only the row inside the window was texted');
  assert.deepEqual(warned('fallback_abandoned').map((w) => w.ctx.extra.postId).sort((a, b) => a - b),
    [late.id, lateWithReason.id].sort((a, b) => a - b));

  assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 0, alerted: false });
  assert.equal(sends.length, 1, 'a closed row is never texted on a later tick');
  assert.equal(warned('fallback_abandoned').length, 2, 'each closed row warns once');
});

test('a claim older than 2 minutes becomes failed interrupted and is never re-sent', async () => {
  // A restart mid-send: the Twilio call may have completed, and a second text
  // is worse than a hand paste (plan decision 11).
  const interrupted = await mkPost(await mkProposal(), {
    status: 'stale', createdMinAgo: 10, fallbackStatus: 'claimed', fallbackMinAgo: 3, updatedMinAgo: 3,
  });
  // A failed_preclick row keeps the reason the box gave (COALESCE).
  const withReason = await mkPost(await mkProposal(), {
    status: 'failed_preclick', reason: 'challenge', createdMinAgo: 10, fallbackStatus: 'claimed',
    fallbackMinAgo: 4, updatedMinAgo: 4,
  });
  // A send still under way.
  const inFlight = await mkPost(await mkProposal(), {
    status: 'stale', createdMinAgo: 10, fallbackStatus: 'claimed', fallbackMinAgo: 1, updatedMinAgo: 1,
  });
  try {
    assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 0, alerted: false });
    const row = await postRow(interrupted.id);
    assert.equal(row.fallback_status, 'failed');
    assert.equal(row.reason, 'interrupted');
    assert.equal(row.status, 'stale');
    assert.ok(row.updated_at > interrupted.updated_at, 'the failed write stamps updated_at');
    const kept = await postRow(withReason.id);
    assert.equal(kept.fallback_status, 'failed');
    assert.equal(kept.reason, 'challenge');
    assert.equal((await postRow(inFlight.id)).fallback_status, 'claimed', 'a claim under 2 minutes old is left alone');
    assert.equal(sends.length, 0, 'never re-sent');
    assert.deepEqual(warned('fallback_interrupted').map((w) => w.ctx.extra.postId).sort((a, b) => a - b),
      [interrupted.id, withReason.id].sort((a, b) => a - b));

    assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 0, alerted: false });
    assert.equal(sends.length, 0, 'a failed fallback is never retried');
    assert.equal(warned('fallback_interrupted').length, 2, 'each interrupted claim warns once');
    assert.equal((await postRow(interrupted.id)).fallback_status, 'failed');
  } finally {
    await drop([inFlight.id]);
  }
});

test('three unknown rows in a row email once', async () => {
  // Review Focus 7: a box that leases and then dies never reports.
  for (const leasedMinAgo of [4, 5, 6]) {
    await mkPost(await mkProposal(), { status: 'leased', createdMinAgo: leasedMinAgo + 1, leasedMinAgo });
  }
  assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 3, alerted: true });
  assert.equal(mails.length, 1);
  assert.ok(mails[0].emailText.includes('(reason: unknown_streak)'));
  assert.equal(mails[0].smsBody, undefined, 'email only');
  const s = await state();
  assert.equal(s.consecutive_unknown, 3);
  assert.equal(s.outage_reason, 'unknown_streak');
  assert.equal(warned('unknown').length, 1);
  assert.equal(warned('unknown')[0].ctx.extra.count, 3);

  await mkPost(await mkProposal(), { status: 'leased', createdMinAgo: 5, leasedMinAgo: 4 });
  assert.deepEqual(await runGvPostSweep(), { staled: 0, unknowned: 1, alerted: false });
  assert.equal(mails.length, 1, 'one email per episode');
  assert.equal((await state()).consecutive_unknown, 4);
  assert.equal(sends.length, 0, 'unknown never falls back');
});
