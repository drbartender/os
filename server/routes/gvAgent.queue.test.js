'use strict';

// The GV agent API's queue (spec 2026-10-17 laws 1, 4, 5, 6, 7 and 8, section
// 6; plan Task 7): the lease and its re-validation, the pre-click check, the
// box's report and its session status. The real router on express() with the
// node:http helper of thumbtackAgent.replies.test.js. DB suite on the shared
// dev database: run ALONE,
//   node --test server/routes/gvAgent.queue.test.js
// Nothing can send: both toll-free senders are stubbed through
// fallback.__setDeps (the claim and fallback_status writes stay real), the
// admin email through outage.__setDeps, Sentry through the router's
// __setDeps, and SEND_NOTIFICATIONS stays 'false'. The lease honors the
// notifications gate (law 3), so the suite opens it through the router's
// __setDeps rather than the env var. The lease takes the oldest
// queued row on the whole dev DB, so the suite refuses to start while any
// queued row exists, and every test consumes the queued row it makes. Every
// fixture is invented (names, 555-01xx numbers, customer ids) and deleted by
// id in after(); gv_sender_state is reset with UPDATE, never DELETE, and
// restored after.
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('gvAgent.queue.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { proposalUrl } = require('../utils/urls');
const { sendInitialProposalText } = require('../utils/sendProposalSentEmail');
const { load, sendResendText } = require('../utils/comms/actions/proposalResend');
const { notifyAdminCategory } = require('../utils/adminNotifications');
const { notificationsEnabled } = require('../utils/notificationsEnabled');
const { resolveGvTarget } = require('../utils/gvPost/identity');
const fallback = require('../utils/gvPost/fallback');
const outage = require('../utils/gvPost/outage');
const gvAgentRouter = require('./gvAgent');

const SECRET = `gv-agent-queue-${Date.now()}-abcdefghijklmnopqrstuvwxyz`;
const RUN = `gvag-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const ORIG = {
  secret: process.env.GV_AGENT_SECRET,
  flag: process.env.GV_PROPOSAL_POST_ENABLED,
  cap: process.env.GV_POST_DAILY_CAP,
};
const STATE_COLUMNS = [
  'outage_since', 'outage_reason', 'outage_alerted_at', 'last_lease_at', 'last_success_at',
  'consecutive_preclick_failures', 'consecutive_unknown', 'consecutive_unverified',
];
const created = { posts: [], messages: [], leads: [], proposals: [], clients: [], users: [] };
let server, baseUrl, userId, snapshot;
let seq = 0;
let npa;
let nextLine = 0;
let sends = [];
let mails = [];
let warnings = [];

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        'x-gv-agent-secret': SECRET,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const lease = () => request('GET', '/api/gv-agent/pending');
const precheck = (id) => request('POST', '/api/gv-agent/precheck', { id });
const report = (id, outcome, reason) => request('POST', '/api/gv-agent/report', { id, outcome, reason });
const status = (state) => request('POST', '/api/gv-agent/status', { state });
const postRow = async (id) => (await pool.query('SELECT * FROM gv_posts WHERE id = $1', [id])).rows[0];
const state = async () => (await pool.query('SELECT * FROM gv_sender_state WHERE id = 1')).rows[0];
const warned = (event) => warnings.filter((w) => w.ctx && w.ctx.tags && w.ctx.tags.event === event);

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

async function mkClient(phone) {
  seq += 1;
  const { rows } = await pool.query(
    'INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id',
    [`Gv Agent ${RUN} ${seq}`, phone]
  );
  created.clients.push(rows[0].id);
  return rows[0].id;
}

async function mkLead({ phone, clientId, customerId, proposalId = null }) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO thumbtack_leads
       (negotiation_id, client_id, customer_id, customer_name, customer_phone, status, raw_payload, proposal_id)
     VALUES ($1, $2, $3, $4, $5, 'new', '{}'::jsonb, $6)
     RETURNING id, negotiation_id`,
    [`${RUN}-${seq}`, clientId, customerId, `Gv Agent Lead ${seq}`, `+1${phone}`, proposalId]
  );
  created.leads.push(rows[0].id);
  return rows[0];
}

// A relay client: a sent proposal and one post-rollout lead on the client's
// number, linked to it, of the same client and customer.
async function mkRelay() {
  const phone = await freshPhone();
  const clientId = await mkClient(phone);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'sent', 'wedding-reception', 1000, 'America/Chicago')
     RETURNING id, token`,
    [clientId]
  );
  created.proposals.push(p.rows[0].id);
  const customerId = `${RUN}-cust-${clientId}`;
  const lead = await mkLead({ phone, clientId, customerId, proposalId: p.rows[0].id });
  return { phone, clientId, customerId, proposalId: p.rows[0].id, token: p.rows[0].token, lead };
}

// A hand-inserted post. leased and unknown rows carry a lease time.
async function mkPost(f, opts = {}) {
  const {
    status: rowStatus = 'queued', sendPath = 'auto', createdMinAgo = 0, leasedMinAgo = 1,
    negotiationId = f.lead.negotiation_id, leadId = f.lead.id,
  } = opts;
  const body = `Hi, this is Dallas from Dr. Bartender. Your proposal is ready: ${proposalUrl(f.token)}.`;
  const { rows } = await pool.query(
    `INSERT INTO gv_posts (proposal_id, client_id, lead_id, negotiation_id, body, send_path, sent_by, status, leased_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             CASE WHEN $8 IN ('leased','unknown') THEN now() - ($9::int * interval '1 minute') END,
             now() - ($10::int * interval '1 minute'))
     RETURNING *`,
    [f.proposalId, f.clientId, leadId, negotiationId, body, sendPath, userId, rowStatus, leasedMinAgo, createdMinAgo]
  );
  created.posts.push(rows[0].id);
  return rows[0];
}

// A message in a Thumbtack thread, as the webhook stores it.
async function mkMessage(negotiationId, text, fromType) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO thumbtack_messages (message_id, negotiation_id, from_type, sender_name, text, sent_at, raw_payload)
     VALUES ($1, $2, $3, 'Gv Agent Pro', $4, now(), '{}'::jsonb)
     RETURNING id`,
    [`${RUN}-msg-${seq}`, negotiationId, fromType, text]
  );
  created.messages.push(rows[0].id);
  return rows[0].id;
}

before(async () => {
  npa = 200 + crypto.randomInt(0, 600);
  process.env.GV_AGENT_SECRET = SECRET;
  process.env.GV_PROPOSAL_POST_ENABLED = 'true';
  // The cap is global across the shared dev DB; only the cap case lowers it.
  process.env.GV_POST_DAILY_CAP = '1000';

  const queued = await pool.query("SELECT COUNT(*)::int AS n FROM gv_posts WHERE status = 'queued'");
  assert.equal(queued.rows[0].n, 0, 'precondition: queued gv_posts rows on the dev DB; the lease would take them');
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
  gvAgentRouter.__setDeps({
    Sentry: {
      captureMessage: (message, ctx) => { warnings.push({ message, ctx }); },
      captureException: (err, ctx) => { warnings.push({ message: err.message, ctx }); },
    },
    notificationsEnabled: () => true,
  });

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id`,
    [`gv-agent-${RUN}@example.test`]
  );
  userId = u.rows[0].id;
  created.users.push(userId);

  const app = express();
  app.use(express.json());
  app.use('/api/gv-agent', gvAgentRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

beforeEach(async () => {
  // The router's own limiter (30 a minute, keyed on 127.0.0.1) is cleared per
  // test in this process only; its configuration is never touched.
  gvAgentRouter.gvAgentLimiter.resetKey('127.0.0.1');
  sends = [];
  mails = [];
  warnings = [];
  await pool.query(
    `UPDATE gv_sender_state
        SET outage_since = NULL, outage_reason = NULL, outage_alerted_at = NULL, last_lease_at = NULL,
            consecutive_preclick_failures = 0, consecutive_unknown = 0, consecutive_unverified = 0,
            updated_at = now()
      WHERE id = 1`
  );
});

// Fixtures first: nothing that can throw runs before the deletes.
after(async () => {
  if (ORIG.secret === undefined) delete process.env.GV_AGENT_SECRET;
  else process.env.GV_AGENT_SECRET = ORIG.secret;
  if (ORIG.flag === undefined) delete process.env.GV_PROPOSAL_POST_ENABLED;
  else process.env.GV_PROPOSAL_POST_ENABLED = ORIG.flag;
  if (ORIG.cap === undefined) delete process.env.GV_POST_DAILY_CAP;
  else process.env.GV_POST_DAILY_CAP = ORIG.cap;
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (created.posts.length) await pool.query('DELETE FROM gv_posts WHERE id = ANY($1::int[])', [created.posts]);
    if (created.messages.length) await pool.query('DELETE FROM thumbtack_messages WHERE id = ANY($1::int[])', [created.messages]);
    if (created.leads.length) await pool.query('DELETE FROM thumbtack_leads WHERE id = ANY($1::int[])', [created.leads]);
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
    if (typeof gvAgentRouter.__setDeps === 'function') {
      gvAgentRouter.__setDeps({ Sentry, notificationsEnabled, resolveGvTarget });
    }
    await pool.end();
  }
});

test('lease returns one job with phone, body and negotiation_id and marks it leased', async () => {
  const f = await mkRelay();
  const post = await mkPost(f);
  const res = await lease();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{
    id: post.id, phone: `+1${f.phone}`, body: post.body, negotiation_id: f.lead.negotiation_id, prior_bodies: [],
  }]);
  const row = await postRow(post.id);
  assert.equal(row.status, 'leased');
  assert.ok(row.leased_at);
  assert.ok((await state()).last_lease_at, 'the lease stamps last_lease_at');
  // A leased row is never offered again (law 4).
  assert.deepEqual((await lease()).body, []);
});

test('pending with notifications off returns []', async () => {
  // Law 3: a lane or dev server on the shared DB, or an instance with sends
  // forced off, never hands the box a job, and answers before any DB read.
  const f = await mkRelay();
  const post = await mkPost(f);
  const reads = [];
  const { connect, query } = pool;
  gvAgentRouter.__setDeps({ notificationsEnabled: () => false });
  pool.connect = (...args) => { reads.push('connect'); return connect.apply(pool, args); };
  pool.query = (...args) => { reads.push('query'); return query.apply(pool, args); };
  let res;
  try {
    res = await lease();
  } finally {
    pool.connect = connect;
    pool.query = query;
    gvAgentRouter.__setDeps({ notificationsEnabled: () => true });
  }
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
  assert.deepEqual(reads, [], 'no DB read');
  const row = await postRow(post.id);
  assert.equal(row.status, 'queued', 'the row is not touched');
  assert.equal(row.leased_at, null);
  assert.equal((await state()).last_lease_at, null, 'no lease stamp');
  // The gate open again, the same row leases (each test consumes its queued row).
  assert.deepEqual((await lease()).body.map((j) => j.id), [post.id]);
});

test('lease does not trip spacing or cap on the row being leased', async () => {
  const f = await mkRelay();
  const post = await mkPost(f);
  // The cap is global across the shared dev DB: set it one above every other
  // counted post of the last 24 hours, so only this row itself could reach it,
  // and it is also the only post to this number inside the spacing window.
  const others = await pool.query(
    `SELECT COUNT(*)::int AS n FROM gv_posts
      WHERE status IN ('queued','leased','sent','clicked_unverified','unknown')
        AND created_at > now() - interval '24 hours' AND proposal_id <> $1`,
    [f.proposalId]
  );
  process.env.GV_POST_DAILY_CAP = String(others.rows[0].n + 1);
  let res;
  try {
    res = await lease();
  } finally {
    process.env.GV_POST_DAILY_CAP = '1000';
  }
  assert.deepEqual(res.body.map((j) => j.id), [post.id]);
  assert.equal((await postRow(post.id)).status, 'leased');
  assert.equal(sends.length, 0);
});

test("lease does not trip spacing on the proposal's own earlier post", async () => {
  // An intentional resend minutes after a landed post: the router let it
  // through, and the lease must not turn it into a toll-free text beside it.
  const f = await mkRelay();
  await mkPost(f, { status: 'sent', createdMinAgo: 3 });
  const post = await mkPost(f);
  const res = await lease();
  assert.deepEqual(res.body.map((j) => j.id), [post.id]);
  assert.equal((await postRow(post.id)).status, 'leased');
  assert.equal(sends.length, 0);
});

test("a resend is not skipped for the echo of the proposal's own earlier post", async () => {
  // The first post landed and Thumbtack's feed stored its echo, which holds
  // the proposal token. A resend minutes later is intentional (law 4): the
  // lease must not read that echo as a hand paste and drop the resend.
  const f = await mkRelay();
  const first = await mkPost(f, { status: 'sent', createdMinAgo: 8 });
  await mkMessage(f.lead.negotiation_id, first.body, 'Business');
  // A post that never posted (stale) and another proposal's post are no part
  // of what the box may find in this thread.
  await mkPost(f, { status: 'stale', createdMinAgo: 20 });
  const resend = await mkPost(f);
  const res = await lease();
  assert.deepEqual(res.body.map((j) => j.id), [resend.id]);
  assert.equal((await postRow(resend.id)).status, 'leased');
  // The job tells the box which words in the thread are its own earlier
  // post, so the box's own already-in-the-thread check leaves them out too.
  assert.deepEqual(res.body[0].prior_bodies, [first.body]);
  // The precheck reads the same way: the earlier echo is no reason to stop.
  assert.deepEqual((await precheck(resend.id)).body, { go: true });
  assert.equal(sends.length, 0);

  // A hand paste in other words, beside the same echo, still stops a resend.
  const g = await mkRelay();
  const earlier = await mkPost(g, { status: 'sent', createdMinAgo: 8 });
  await mkMessage(g.lead.negotiation_id, earlier.body, 'Business');
  await mkMessage(g.lead.negotiation_id, `Here is your link again: https://drbartender.com/proposal/${g.token}`, 'Business');
  const stopped = await mkPost(g);
  assert.deepEqual((await lease()).body, []);
  assert.equal((await postRow(stopped.id)).status, 'skipped_already_posted');

  // Only a post the box worked can have an echo: the same words beside a
  // post that went stale (it never posted) are a paste.
  const h = await mkRelay();
  const body = `Hi, this is Dallas from Dr. Bartender. Your proposal is ready: ${proposalUrl(h.token)}.`;
  await mkMessage(h.lead.negotiation_id, body, 'Business');
  await mkPost(h, { status: 'stale', createdMinAgo: 1 });
  const afterPaste = await mkPost(h);
  assert.deepEqual((await lease()).body, []);
  assert.equal((await postRow(afterPaste.id)).status, 'skipped_already_posted', 'a stale post never posted, so the words are a paste');
  assert.equal(sends.length, 0);
});

test('lease rewrites a changed negotiation id', async () => {
  // Queued for the lead on the client's first relay number; by lease time the
  // client's number has moved to another relay lead of the same client.
  const f = await mkRelay();
  const post = await mkPost(f);
  const moved = await freshPhone();
  await pool.query('UPDATE thumbtack_leads SET proposal_id = NULL WHERE id = $1', [f.lead.id]);
  const lead2 = await mkLead({ phone: moved, clientId: f.clientId, customerId: `${f.customerId}-2`, proposalId: f.proposalId });
  await pool.query('UPDATE clients SET phone = $1 WHERE id = $2', [moved, f.clientId]);
  const res = await lease();
  assert.deepEqual(res.body, [{
    id: post.id, phone: `+1${moved}`, body: post.body, negotiation_id: lead2.negotiation_id, prior_bodies: [],
  }]);
  const row = await postRow(post.id);
  assert.equal(row.status, 'leased');
  assert.equal(row.negotiation_id, lead2.negotiation_id);
  assert.equal(row.lead_id, lead2.id);
});

test('lease cancels an archived proposal without a fallback', async () => {
  const f = await mkRelay();
  const post = await mkPost(f);
  await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [f.proposalId]);
  assert.deepEqual((await lease()).body, []);
  const row = await postRow(post.id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.reason, 'archived');
  assert.equal(row.fallback_status, null);
  assert.equal(sends.length, 0, 'no toll-free text');
});

test('lease skips a row whose token is already in the thread', async () => {
  // A hand paste in ANY conversation on the number counts (law 6), whatever
  // its URL form, and from_type may be NULL (the legacy parse branch).
  const f = await mkRelay();
  const other = await mkLead({ phone: f.phone, clientId: f.clientId, customerId: f.customerId });
  const post = await mkPost(f);
  await mkMessage(other.negotiation_id, `Here you go: https://www.drbartender.com/proposal/${f.token}/`, null);
  assert.deepEqual((await lease()).body, []);
  const row = await postRow(post.id);
  assert.equal(row.status, 'skipped_already_posted');
  assert.equal(row.fallback_status, null);
  assert.equal(sends.length, 0);
});

test('lease turns an identity mismatch into failed_preclick and sends one fallback', async () => {
  // Another client's lead turns up on the number: law 1 fails at lease.
  const f = await mkRelay();
  const post = await mkPost(f);
  const stranger = await mkClient(null);
  await mkLead({ phone: f.phone, clientId: stranger, customerId: `${RUN}-stranger` });
  assert.deepEqual((await lease()).body, []);
  const row = await postRow(post.id);
  assert.equal(row.status, 'failed_preclick');
  assert.equal(row.reason, 'identity_mismatch');
  assert.equal(row.fallback_status, 'sent');
  assert.deepEqual(sends.map((s) => [s.path, s.proposalId, s.opts.via]), [['auto', f.proposalId, 'twilio']]);
  assert.equal(warned('lease_identity_mismatch').length, 1);
  assert.ok(!JSON.stringify(warnings).includes(f.phone.slice(-7)), 'no number in Sentry');
});

test('a lease whose re-check throws marks the row failed and sends one fallback', async () => {
  // A query inside the re-check fails, which aborts the lease's transaction;
  // the savepoint keeps the lease able to settle the row. The row was never
  // handed out, so no click can have happened: the toll-free text is safe
  // (law 5).
  const f = await mkRelay();
  const post = await mkPost(f);
  // division_by_zero (22012) on the lease's own client.
  gvAgentRouter.__setDeps({ resolveGvTarget: (proposalId, client) => client.query('SELECT 1/0') });
  let res;
  try {
    res = await lease();
  } finally {
    gvAgentRouter.__setDeps({ resolveGvTarget });
  }
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [], 'no job this tick');
  const row = await postRow(post.id);
  assert.equal(row.status, 'failed_preclick');
  assert.equal(row.reason, 'recheck_error');
  assert.equal(row.leased_at, null, 'never handed out');
  assert.ok(row.updated_at > post.updated_at, 'the write stamps updated_at');
  assert.equal(row.fallback_status, 'sent');
  assert.deepEqual(sends.map((s) => [s.path, s.proposalId, s.opts.via]), [['auto', f.proposalId, 'twilio']]);
  const warn = warned('lease_recheck_error');
  assert.equal(warn.length, 1);
  assert.equal(warn[0].ctx.level, 'warning');
  assert.equal(warn[0].ctx.extra.cause, '22012', 'the driver code, never its message');
  assert.ok(!JSON.stringify(warnings).includes(f.phone.slice(-7)), 'no number in Sentry');
  assert.ok((await state()).last_lease_at, 'the poll still counts as a lease');
  // Never offered again: one text, ever.
  assert.deepEqual((await lease()).body, []);
  assert.equal(sends.length, 1);
});

test('precheck says no-go once the token lands after the lease and flips the row', async () => {
  const f = await mkRelay();
  const post = await mkPost(f);
  assert.deepEqual((await lease()).body.map((j) => j.id), [post.id]);
  assert.deepEqual((await precheck(post.id)).body, { go: true });
  // The team pastes the link in the Thumbtack app while the box holds the lease.
  await mkMessage(f.lead.negotiation_id, `Your proposal: https://drbartender.com/proposal/${f.token}`, 'Business');
  const res = await precheck(post.id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { go: false, outcome: 'skipped_already_posted' });
  const row = await postRow(post.id);
  assert.equal(row.status, 'skipped_already_posted');
  assert.ok(row.reported_at);
  assert.equal(row.fallback_status, null);
  assert.equal(sends.length, 0);
});

test('precheck on an unknown row says no-go timeout', async () => {
  const f = await mkRelay();
  const post = await mkPost(f, { status: 'unknown', leasedMinAgo: 4 });
  assert.deepEqual((await precheck(post.id)).body, { go: false, outcome: 'timeout' });
  assert.equal((await postRow(post.id)).status, 'unknown', 'the precheck never moves an unknown row');
  // A deleted proposal takes its rows with it (ON DELETE CASCADE): no-go too.
  const g = await mkRelay();
  const gone = await mkPost(g, { status: 'leased' });
  await pool.query('DELETE FROM proposals WHERE id = $1', [g.proposalId]);
  assert.equal(await postRow(gone.id), undefined);
  assert.deepEqual((await precheck(gone.id)).body, { go: false, outcome: 'timeout' });
});

test('precheck with the flag off says no-go timeout', async () => {
  // Law 2: after a rollback flip the job in the box's hand gets no go and is
  // never clicked; the box reports failed_preclick timeout and the toll-free
  // text goes out, today's behavior. The precheck touches no row, not even one
  // whose link is in the thread, which the switch on turns into a skip.
  const f = await mkRelay();
  const pasted = await mkPost(f, { status: 'leased' });
  await mkMessage(f.lead.negotiation_id, `Your proposal: https://drbartender.com/proposal/${f.token}`, 'Business');
  const g = await mkRelay();
  const held = await mkPost(g, { status: 'leased' });
  process.env.GV_PROPOSAL_POST_ENABLED = 'false';
  try {
    for (const post of [pasted, held]) {
      const res = await precheck(post.id);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { go: false, outcome: 'timeout' });
      const row = await postRow(post.id);
      assert.equal(row.status, 'leased', 'the row is not touched');
      assert.equal(row.reported_at, null);
      assert.equal(row.updated_at.getTime(), post.updated_at.getTime());
    }
    // The box's next step: the report is not gated, so the toll-free text goes.
    assert.deepEqual((await report(held.id, 'failed_preclick', 'timeout')).body, { ok: true });
  } finally {
    process.env.GV_PROPOSAL_POST_ENABLED = 'true';
  }
  assert.equal((await postRow(held.id)).fallback_status, 'sent');
  assert.deepEqual(sends.map((s) => s.proposalId), [g.proposalId]);
  // The switch back on, the same precheck sees the paste and moves the row.
  assert.deepEqual((await precheck(pasted.id)).body, { go: false, outcome: 'skipped_already_posted' });
  assert.equal(sends.length, 1);
});

test('report sent closes the outage episode', async () => {
  await pool.query(
    `UPDATE gv_sender_state
        SET outage_since = now(), outage_reason = 'session_expired', outage_alerted_at = now(),
            consecutive_preclick_failures = 2, consecutive_unknown = 1, consecutive_unverified = 1
      WHERE id = 1`
  );
  const f = await mkRelay();
  const post = await mkPost(f, { status: 'leased' });
  const res = await report(post.id, 'sent');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  const row = await postRow(post.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.reason, null);
  assert.ok(row.clicked_at);
  assert.ok(row.reported_at);
  assert.equal(row.fallback_status, null);
  const s = await state();
  assert.equal(s.outage_since, null);
  assert.equal(s.outage_alerted_at, null);
  assert.ok(s.last_success_at);
  assert.deepEqual([s.consecutive_preclick_failures, s.consecutive_unknown, s.consecutive_unverified], [0, 0, 0]);
  assert.equal(sends.length, 0);
});

test('report failed_preclick with a whitelisted reason sends one fallback', async () => {
  const f = await mkRelay();
  const post = await mkPost(f, { status: 'leased', sendPath: 'compose' });
  const res = await report(post.id, 'failed_preclick', 'session_expired');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  const row = await postRow(post.id);
  assert.equal(row.status, 'failed_preclick');
  assert.equal(row.reason, 'session_expired');
  assert.equal(row.clicked_at, null);
  assert.equal(row.fallback_status, 'sent');
  assert.deepEqual(sends, [{ path: 'compose', proposalId: f.proposalId, body: post.body }]);
  assert.equal((await state()).consecutive_preclick_failures, 1);
  assert.equal(warned('report_failed_preclick').length, 1);
  // The box retries a report it thinks was lost: ignored, never a second text.
  assert.deepEqual((await report(post.id, 'failed_preclick', 'session_expired')).body, { ignored: true });
  assert.equal(sends.length, 1);
});

test('report failed_preclick on an unknown row is accepted and sends one fallback', async () => {
  // The box is authoritative about "no click happened", even after the sweep's guess.
  const f = await mkRelay();
  const post = await mkPost(f, { status: 'unknown', leasedMinAgo: 4 });
  const res = await report(post.id, 'failed_preclick', 'timeout');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  const row = await postRow(post.id);
  assert.equal(row.status, 'failed_preclick');
  assert.equal(row.reason, 'timeout');
  assert.equal(row.fallback_status, 'sent');
  assert.deepEqual(sends.map((s) => s.proposalId), [f.proposalId]);
});

test('report sent on an unknown row upgrades it with no fallback', async () => {
  const f = await mkRelay();
  const post = await mkPost(f, { status: 'unknown', leasedMinAgo: 4 });
  const res = await report(post.id, 'sent');
  assert.deepEqual(res.body, { ok: true });
  const row = await postRow(post.id);
  assert.equal(row.status, 'sent');
  assert.ok(row.clicked_at);
  assert.equal(row.fallback_status, null);
  assert.equal(sends.length, 0);
});

test('report with an unknown reason is 400', async () => {
  const f = await mkRelay();
  const post = await mkPost(f, { status: 'leased' });
  for (const [outcome, reason] of [
    ['failed_preclick', 'exploded'], ['failed_preclick', undefined], ['delivered', undefined], ['cancelled', undefined],
  ]) {
    assert.equal((await report(post.id, outcome, reason)).status, 400, `${outcome} ${reason}`);
  }
  assert.equal((await request('POST', '/api/gv-agent/report', { id: 'abc', outcome: 'sent' })).status, 400);
  const row = await postRow(post.id);
  assert.equal(row.status, 'leased', 'a rejected report changes nothing');
  assert.equal(row.reason, null);
  assert.equal(sends.length, 0);
});

test('report on a terminal row is ignored', async () => {
  const f = await mkRelay();
  const post = await mkPost(f, { status: 'sent' });
  const res = await report(post.id, 'failed_preclick', 'timeout');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ignored: true });
  const row = await postRow(post.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.reason, null);
  assert.equal(row.fallback_status, null);
  // A row law 8 cancelled at lease never wakes up either.
  const g = await mkRelay();
  const cancelled = await mkPost(g, { status: 'cancelled' });
  assert.deepEqual((await report(cancelled.id, 'sent')).body, { ignored: true });
  assert.equal((await postRow(cancelled.id)).status, 'cancelled');
  assert.equal(sends.length, 0);
});

test('report on an unknown row leased over 24 hours ago is ignored', async () => {
  // The box reports within minutes, or on its restart. A report on a lease a
  // day old is not its word about a job in hand, and taking it would let a
  // leaked secret force the toll-free text onto any old unknown row.
  await pool.query('UPDATE gv_sender_state SET consecutive_unknown = 2 WHERE id = 1');
  const f = await mkRelay();
  const old = await mkPost(f, { status: 'unknown', createdMinAgo: 25 * 60 + 5, leasedMinAgo: 25 * 60 });
  for (const [outcome, reason] of [['failed_preclick', 'timeout'], ['sent', undefined]]) {
    const res = await report(old.id, outcome, reason);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ignored: true }, outcome);
  }
  const row = await postRow(old.id);
  assert.equal(row.status, 'unknown');
  assert.equal(row.reason, null);
  assert.equal(row.reported_at, null);
  assert.equal(row.fallback_status, null);
  assert.equal(sends.length, 0, 'no toll-free text');
  const s = await state();
  assert.equal(s.consecutive_preclick_failures, 0, 'an ignored report counts toward no streak');
  assert.equal(s.consecutive_unknown, 2, 'and an ignored sent resets none');
  assert.equal(warnings.length, 0);
  // Leased inside the day, the box's word still counts (law 5).
  const g = await mkRelay();
  const recent = await mkPost(g, { status: 'unknown', createdMinAgo: 23 * 60 + 5, leasedMinAgo: 23 * 60 });
  assert.deepEqual((await report(recent.id, 'failed_preclick', 'timeout')).body, { ok: true });
  assert.equal((await postRow(recent.id)).fallback_status, 'sent');
  assert.deepEqual(sends.map((x) => x.proposalId), [g.proposalId]);
});

test('status session_expired emails once per episode', async () => {
  assert.equal((await status('session_expired')).status, 200);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].category, 'routine_thumbtack');
  assert.equal(mails[0].smsBody, undefined, 'email only');
  assert.ok(mails[0].emailText.includes('(reason: session_expired)'));
  assert.equal((await status('challenge')).status, 200);
  assert.equal((await status('session_expired')).status, 200);
  assert.equal(mails.length, 1, 'one email per episode');
  assert.equal((await state()).outage_reason, 'session_expired');
  assert.equal((await status('logged_out')).status, 400);
  assert.equal(warned('session_expired').length + warned('challenge').length, 3);
});

test('status with the flag off emails nobody', async () => {
  // Law 2: with the switch off the box idles by design, so a signed-out
  // session it still notices is no outage. The box keeps its 2xx.
  process.env.GV_PROPOSAL_POST_ENABLED = 'false';
  try {
    for (const s of ['session_expired', 'challenge']) {
      const res = await status(s);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    }
    assert.equal((await status('logged_out')).status, 400, 'an unknown state is still refused');
  } finally {
    process.env.GV_PROPOSAL_POST_ENABLED = 'true';
  }
  assert.equal(mails.length, 0, 'no outage email');
  assert.equal(warnings.length, 0, 'no Sentry warning');
  const st = await state();
  assert.equal(st.outage_since, null, 'no episode opened');
  assert.equal(st.outage_alerted_at, null);
});
