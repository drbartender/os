'use strict';

// The GV post's toll-free fallback (spec 2026-10-17 law 5, plan Task 6): a
// stale or failed_preclick row gets today's 888 proposal text, claimed once,
// re-checked against law 8, and sent back through the path that queued it.
// DB suite on the shared dev database: run ALONE,
//   node --test server/utils/gvPost/fallback.test.js
// Both senders are stubbed through fallback.__setDeps, so nothing is texted;
// SEND_NOTIFICATIONS stays 'false' besides. Every fixture is invented (names,
// 555-01xx numbers) and deleted by id or key in after(). The hand-inserted
// gv_posts rows are stale or failed_preclick, never queued, so no lease could
// ever offer them.
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('fallback.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');
const { proposalUrl } = require('../urls');
const { sendInitialProposalText } = require('../sendProposalSentEmail');
const { load, sendResendText } = require('../comms/actions/proposalResend');
const fallback = require('./fallback');

const { sendGvFallback } = fallback;
const RUN = `gvfb-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const created = { posts: [], proposals: [], clients: [], optouts: [], users: [] };
let seq = 0;
let npa;
let nextLine = 0;
let userId;
let calls;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The senders, stubbed. Each takes a few milliseconds, so the result write's
// updated_at lands visibly after the claim's fallback_at.
function stubSenders({ initial = 'sent', resend = { status: 'sent' } } = {}) {
  calls = { initial: [], resend: [] };
  fallback.__setDeps({
    sendInitialProposalText: async (proposal, opts) => {
      calls.initial.push({ proposal, opts });
      await pause(5);
      return initial;
    },
    sendResendText: async (args) => {
      calls.resend.push(args);
      await pause(5);
      return resend;
    },
  });
}

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

// A client and a sent proposal. optedOut adds an active per-number opt-out.
async function mkProposal({ optedOut = false } = {}) {
  seq += 1;
  const phone = await freshPhone();
  const c = await pool.query(
    'INSERT INTO clients (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
    [`Gv Fallback ${RUN} ${seq}`, `gv-fallback-${RUN}-${seq}@example.test`, phone]
  );
  created.clients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'sent', 'wedding-reception', 1000, 'America/Chicago')
     RETURNING id, token`,
    [c.rows[0].id]
  );
  created.proposals.push(p.rows[0].id);
  if (optedOut) {
    await pool.query(
      "INSERT INTO sms_optouts (phone_last10, opted_out_at, source) VALUES ($1, now() - interval '1 day', 'keyword')",
      [phone]
    );
    created.optouts.push(phone);
  }
  return { phone, clientId: c.rows[0].id, proposalId: p.rows[0].id, token: p.rows[0].token };
}

async function mkPost(f, { sendPath = 'auto', status = 'stale', reason = null } = {}) {
  seq += 1;
  const body = `Hi, this is Dallas from Dr. Bartender. Your proposal is ready: ${proposalUrl(f.token)}.`;
  const { rows } = await pool.query(
    `INSERT INTO gv_posts (proposal_id, client_id, negotiation_id, body, send_path, sent_by, status, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [f.proposalId, f.clientId, `${RUN}-neg-${seq}`, body, sendPath, userId, status, reason]
  );
  created.posts.push(rows[0].id);
  return rows[0];
}

const postRow = async (id) => (await pool.query('SELECT * FROM gv_posts WHERE id = $1', [id])).rows[0];

before(async () => {
  npa = 200 + crypto.randomInt(0, 600);
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id`,
    [`gv-fallback-${RUN}@example.test`]
  );
  userId = u.rows[0].id;
  created.users.push(userId);
});

// Fixtures first: nothing that can throw runs before the deletes.
after(async () => {
  try {
    if (created.posts.length) await pool.query('DELETE FROM gv_posts WHERE id = ANY($1::int[])', [created.posts]);
    if (created.optouts.length) await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [created.optouts]);
    if (created.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [created.proposals]);
    if (created.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [created.clients]);
    if (created.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [created.users]);
  } finally {
    if (typeof fallback.__setDeps === 'function') {
      fallback.__setDeps({ sendInitialProposalText, sendResendText, load });
    }
    await pool.end();
  }
});

test('a second fallback for the same post returns already', async () => {
  stubSenders();
  const f = await mkProposal();
  const post = await mkPost(f);
  assert.equal(await sendGvFallback(post.id), 'sent');
  assert.equal(await sendGvFallback(post.id), 'already');
  assert.equal(calls.initial.length, 1, 'one text, ever');

  // Two callers at once (the sweep and a late box report): one claim wins.
  const g = await mkProposal();
  const racing = await mkPost(g, { status: 'failed_preclick', reason: 'session_expired' });
  const results = (await Promise.all([sendGvFallback(racing.id), sendGvFallback(racing.id)])).sort();
  assert.deepEqual(results, ['already', 'sent']);
  assert.equal(calls.initial.length, 2);

  // Only stale and failed_preclick rows may fall back (gv_posts_fallback_pair_check):
  // a row that may already be in the thread is never claimed.
  const h = await mkProposal();
  const unknown = await mkPost(h, { status: 'unknown' });
  assert.equal(await sendGvFallback(unknown.id), 'already');
  const row = await postRow(unknown.id);
  assert.equal(row.fallback_status, null);
  assert.equal(row.fallback_at, null);
  assert.equal(calls.initial.length, 2, 'no text for an unknown row');
});

test('a suppressed client gets no text and fallback_status suppressed', async () => {
  // The opt-out check needs the number, which the fallback passes explicitly.
  stubSenders();
  const f = await mkProposal({ optedOut: true });
  const post = await mkPost(f, { sendPath: 'compose', status: 'failed_preclick', reason: 'ui_error_before_send' });
  assert.equal(await sendGvFallback(post.id), 'suppressed');
  assert.equal(calls.initial.length + calls.resend.length, 0, 'nothing was texted');
  const row = await postRow(post.id);
  assert.equal(row.fallback_status, 'suppressed');
  assert.ok(row.fallback_at, 'the claim stamped fallback_at');
  assert.equal(row.status, 'failed_preclick', 'the post status is untouched');
  assert.equal(row.reason, 'ui_error_before_send');
});

test('an auto post falls back through sendInitialProposalText with via twilio', async () => {
  stubSenders();
  const f = await mkProposal();
  const post = await mkPost(f, { sendPath: 'auto', status: 'stale' });
  assert.equal(await sendGvFallback(post.id), 'sent');
  assert.equal(calls.resend.length, 0);
  assert.equal(calls.initial.length, 1);
  const { proposal, opts } = calls.initial[0];
  assert.deepEqual(opts, { sentBy: userId, via: 'twilio' });
  assert.deepEqual(Object.keys(proposal).sort(), [
    'client_email', 'client_id', 'client_name', 'client_phone', 'communication_preferences',
    'email_status', 'event_date', 'event_type', 'event_type_custom', 'id', 'phone_status',
    'status', 'token',
  ]);
  assert.equal(proposal.id, f.proposalId);
  assert.equal(proposal.token, f.token);
  assert.equal(proposal.client_id, f.clientId);
  assert.equal(proposal.client_phone, f.phone);
  const row = await postRow(post.id);
  assert.equal(row.fallback_status, 'sent');
  assert.ok(row.fallback_at);
  assert.ok(row.updated_at > row.fallback_at, 'the result write stamps updated_at');

  // A text that could not go out (no usable phone) is a failed fallback.
  stubSenders({ initial: 'skipped' });
  const g = await mkProposal();
  const skipped = await mkPost(g, { sendPath: 'auto', status: 'stale' });
  assert.equal(await sendGvFallback(skipped.id), 'failed');
  assert.equal((await postRow(skipped.id)).fallback_status, 'failed');
});

test('a compose post falls back through sendResendText with its stored body', async () => {
  stubSenders();
  const f = await mkProposal();
  const post = await mkPost(f, { sendPath: 'compose', status: 'failed_preclick', reason: 'session_expired' });
  assert.equal(await sendGvFallback(post.id), 'sent');
  assert.equal(calls.initial.length, 0);
  assert.equal(calls.resend.length, 1);
  const args = calls.resend[0];
  assert.equal(args.body, post.body, 'the stored (collapsed) body, not a fresh template');
  assert.equal(args.phone, `+1${f.phone}`, 'the live client phone in E.164');
  assert.deepEqual(args.ctx, { sentBy: userId });
  assert.deepEqual(args.row, await load(f.proposalId), "proposalResend's own load() row");
  const row = await postRow(post.id);
  assert.equal(row.fallback_status, 'sent');
  assert.ok(row.updated_at > row.fallback_at, 'the result write stamps updated_at');

  stubSenders({ resend: { status: 'failed', error: 'Twilio down' } });
  const g = await mkProposal();
  const failing = await mkPost(g, { sendPath: 'compose', status: 'stale' });
  assert.equal(await sendGvFallback(failing.id), 'failed');
  assert.equal((await postRow(failing.id)).fallback_status, 'failed');
});
