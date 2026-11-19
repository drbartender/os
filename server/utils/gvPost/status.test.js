'use strict';

// Read-time GV post status (spec 2026-10-17 section 6 "Confirmation is derived
// at read time", law 5; plan Task 8). deriveGvDisplay is pure; the last case
// reads the dev DB. Run ALONE,
//   node --test server/utils/gvPost/status.test.js
// The DB case hand-inserts a stale row (its fallback already sent) and a sent
// row, never a queued one, so no lease could offer them and no sweep arm
// touches them. Every fixture is invented (names, 555-01xx numbers,
// negotiation ids, Thumbtack customer ids) and deleted by id in after(). The
// dev DB ties thumbtack_messages.negotiation_id to thumbtack_leads, so each
// conversation gets an invented lead first.
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('status.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');
const { proposalUrl } = require('../urls');
const { deriveGvDisplay, gvPostStatusForProposal } = require('./status');

const TOKEN = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const NEG = 'gvst-neg-1';
const BODY = `Hi, this is Dallas from Dr. Bartender. Your proposal is ready: ${proposalUrl(TOKEN)}.`;
const NOW = new Date('2026-10-19T15:00:00Z');
const ago = (min) => new Date(NOW.getTime() - min * 60 * 1000);

// A post as gvPostStatusForProposal reads it: the row plus its proposal token.
function mkPost(over = {}) {
  return {
    status: 'sent', reason: null, fallback_status: null, body: BODY, token: TOKEN, negotiation_id: NEG,
    created_at: ago(10), updated_at: ago(5), leased_at: ago(6), clicked_at: ago(5), reported_at: ago(5),
    ...over,
  };
}

// A thumbtack_messages row on the post's conversation, stored after the post.
const mkEcho = (text, over = {}) => ({ negotiation_id: NEG, text, sent_at: ago(4), created_at: ago(4), ...over });

test('exact body echo is in_thread', () => {
  // Thumbtack may break the lines differently; the match is on the normalized body.
  const echo = mkEcho(BODY.replace('Your proposal', '\nYour  proposal'), { sent_at: ago(4.5) });
  assert.deepEqual(deriveGvDisplay(mkPost(), [echo], NOW), {
    display: 'in_thread', in_thread_at: echo.sent_at, hand_pasted: false,
  });
  // It beats every other state: the link is in the thread, whoever thought otherwise.
  for (const status of ['queued', 'leased', 'unknown', 'clicked_unverified', 'skipped_already_posted', 'cancelled']) {
    assert.equal(deriveGvDisplay(mkPost({ status }), [echo], NOW).display, 'in_thread', status);
  }
  assert.equal(deriveGvDisplay(mkPost({ status: 'stale', fallback_status: 'sent' }), [echo], NOW).display, 'in_thread');
  // The earliest matching echo stamps the time.
  const later = mkEcho(BODY, { sent_at: ago(1), created_at: ago(1) });
  assert.equal(deriveGvDisplay(mkPost(), [later, echo], NOW).in_thread_at, echo.sent_at);
  // Only the post's own conversation counts.
  const elsewhere = mkEcho(BODY, { negotiation_id: 'gvst-neg-other' });
  assert.equal(deriveGvDisplay(mkPost(), [elsewhere], NOW).display, 'sent_not_seen');
  // An exact body stored before this post existed is an earlier post's echo (a
  // resend's default text is byte-identical): never this post's confirmation.
  const earlier = mkEcho(BODY, { sent_at: ago(12), created_at: ago(12) });
  assert.deepEqual(deriveGvDisplay(mkPost({ status: 'leased' }), [earlier], NOW), {
    display: 'sending', in_thread_at: null, hand_pasted: false,
  });
});

test('token-only echo is hand_pasted, not in_thread', () => {
  const paste = mkEcho(`Here is your proposal: https://www.drbartender.com/proposal/${TOKEN.toUpperCase()}/`);
  assert.deepEqual(deriveGvDisplay(mkPost(), [paste], NOW), {
    display: 'sent_not_seen', in_thread_at: null, hand_pasted: true,
  });
  // A paste made just before the send counts too (the read looks 30 minutes back).
  const before = mkEcho(`proposal ${TOKEN}`, { sent_at: ago(25), created_at: ago(25) });
  assert.equal(deriveGvDisplay(mkPost({ status: 'queued' }), [before], NOW).hand_pasted, true);
  // Both kinds at once: in the thread, and a hand-pasted link beside it.
  assert.deepEqual(deriveGvDisplay(mkPost(), [paste, mkEcho(BODY)], NOW), {
    display: 'in_thread', in_thread_at: ago(4), hand_pasted: true,
  });
  // A paste in another conversation is not this post's.
  const elsewhere = mkEcho(`proposal ${TOKEN}`, { negotiation_id: 'gvst-neg-other' });
  assert.equal(deriveGvDisplay(mkPost(), [elsewhere], NOW).hand_pasted, false);
  // A message without the token is neither.
  assert.deepEqual(deriveGvDisplay(mkPost(), [mkEcho('Thanks, we will take a look!')], NOW), {
    display: 'sent_not_seen', in_thread_at: null, hand_pasted: false,
  });
});

test('sent within 2 minutes is sent', () => {
  assert.equal(deriveGvDisplay(mkPost({ clicked_at: ago(1) }), [], NOW).display, 'sent');
  assert.equal(deriveGvDisplay(mkPost({ clicked_at: ago(1.9) }), [], NOW).display, 'sent');
});

test('sent past 2 minutes with no echo is sent_not_seen', () => {
  assert.deepEqual(deriveGvDisplay(mkPost({ clicked_at: ago(3) }), [], NOW), {
    display: 'sent_not_seen', in_thread_at: null, hand_pasted: false,
  });
  assert.equal(deriveGvDisplay(mkPost({ clicked_at: ago(2) }), [], NOW).display, 'sent_not_seen');
});

test('stale with fallback sent is fallback', () => {
  assert.equal(deriveGvDisplay(mkPost({ status: 'stale', fallback_status: 'sent' }), [], NOW).display, 'fallback');
  assert.equal(deriveGvDisplay(
    mkPost({ status: 'failed_preclick', reason: 'session_expired', fallback_status: 'sent' }), [], NOW
  ).display, 'fallback');
  // A client who can't be texted got nothing.
  assert.equal(deriveGvDisplay(mkPost({ status: 'stale', fallback_status: 'suppressed' }), [], NOW).display,
    'fallback_suppressed');
});

test('stale with fallback claimed is fallback_pending, never fallback', () => {
  // A claim is the moment right before the toll-free send: the text may not
  // have gone out, so it never reads as sent, however old (the sweep turns an
  // old claim failed; until then it is pending).
  assert.equal(deriveGvDisplay(mkPost({ status: 'stale', fallback_status: 'claimed' }), [], NOW).display,
    'fallback_pending');
  assert.equal(deriveGvDisplay(
    mkPost({ status: 'failed_preclick', reason: 'timeout', fallback_status: 'claimed', updated_at: ago(30) }), [], NOW
  ).display, 'fallback_pending');
  // Not yet claimed: pending for 2 minutes after the row's last write
  // (updated_at, which every writer stamps), whatever its age.
  assert.equal(deriveGvDisplay(
    mkPost({ status: 'stale', created_at: ago(8), updated_at: ago(0.5) }), [], NOW
  ).display, 'fallback_pending');
  // Still unclaimed after that, nothing is on its way: the team pastes.
  assert.equal(deriveGvDisplay(
    mkPost({ status: 'failed_preclick', reason: 'challenge', created_at: ago(8), updated_at: ago(3) }), [], NOW
  ).display, 'fallback_failed');
});

test('failed_preclick with fallback failed is fallback_failed', () => {
  assert.equal(deriveGvDisplay(
    mkPost({ status: 'failed_preclick', reason: 'session_expired', fallback_status: 'failed' }), [], NOW
  ).display, 'fallback_failed');
  // A claim the sweep found interrupted reads the same.
  assert.equal(deriveGvDisplay(
    mkPost({ status: 'stale', reason: 'interrupted', fallback_status: 'failed' }), [], NOW
  ).display, 'fallback_failed');
});

test('unknown is check_thread', () => {
  assert.equal(deriveGvDisplay(mkPost({ status: 'unknown', clicked_at: null }), [], NOW).display, 'check_thread');
  assert.equal(deriveGvDisplay(mkPost({ status: 'clicked_unverified' }), [], NOW).display, 'check_thread');
  // The other statuses map one to one.
  assert.equal(deriveGvDisplay(mkPost({ status: 'queued', clicked_at: null }), [], NOW).display, 'queued');
  assert.equal(deriveGvDisplay(mkPost({ status: 'leased', clicked_at: null }), [], NOW).display, 'sending');
  assert.equal(deriveGvDisplay(mkPost({ status: 'skipped_already_posted' }), [], NOW).display, 'skipped_already_posted');
  assert.equal(deriveGvDisplay(mkPost({ status: 'cancelled', reason: 'archived' }), [], NOW).display, 'cancelled');
});

// ─── DB ───────────────────────────────────────────────────────────

const RUN = `gvst-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const created = { posts: [], messages: [], leads: [], proposals: [], clients: [] };
let npa;
let nextLine = 0;
let seq = 0;

// A 555-01xx number nothing on the dev DB carries yet.
async function freshPhone() {
  for (;;) {
    if (nextLine > 99) { npa += 1; nextLine = 0; }
    const digits = `${npa}55501${String(nextLine).padStart(2, '0')}`;
    nextLine += 1;
    const { rows } = await pool.query(
      `SELECT 1 FROM thumbtack_leads WHERE RIGHT(REGEXP_REPLACE(customer_phone, '\\D', '', 'g'), 10) = $1
       UNION ALL SELECT 1 FROM clients WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
       LIMIT 1`,
      [digits]
    );
    if (rows.length === 0) return digits;
  }
}

// A conversation for the messages below (never a relay match the router
// could act on: the fixture posts are hand-inserted and never queued).
async function mkLead(negotiationId, clientId, phone) {
  const { rows } = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_id, customer_name, customer_phone, status, raw_payload)
     VALUES ($1, $2, $3, 'Gv Status Lead', $4, 'new', '{}'::jsonb)
     RETURNING id`,
    [negotiationId, clientId, `${RUN}-cust`, `+1${phone}`]
  );
  created.leads.push(rows[0].id);
}

async function mkMessage(negotiationId, text, minAgo) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO thumbtack_messages (message_id, negotiation_id, from_type, sender_name, text, sent_at, raw_payload, created_at)
     VALUES ($1, $2, 'Business', 'Gv Status Pro', $3, now() - ($4::float8 * interval '1 minute'), '{}'::jsonb,
             now() - ($4::float8 * interval '1 minute'))
     RETURNING id, sent_at`,
    [`${RUN}-msg-${seq}`, negotiationId, text, minAgo]
  );
  created.messages.push(rows[0].id);
  return rows[0];
}

before(() => {
  npa = 200 + crypto.randomInt(0, 600);
});

// Fixtures first: nothing that can throw runs before the deletes.
after(async () => {
  try {
    if (created.posts.length) await pool.query('DELETE FROM gv_posts WHERE id = ANY($1::int[])', [created.posts]);
    if (created.messages.length) await pool.query('DELETE FROM thumbtack_messages WHERE id = ANY($1::int[])', [created.messages]);
    if (created.leads.length) await pool.query('DELETE FROM thumbtack_leads WHERE id = ANY($1::int[])', [created.leads]);
    if (created.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [created.proposals]);
    if (created.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [created.clients]);
  } finally {
    await pool.end();
  }
});

test('gvPostStatusForProposal returns null with no post and the latest post otherwise', async () => {
  const phone = await freshPhone();
  const c = await pool.query('INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id', [`Gv Status ${RUN}`, phone]);
  created.clients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'sent', 'wedding-reception', 1000, 'America/Chicago')
     RETURNING id, token`,
    [c.rows[0].id]
  );
  created.proposals.push(p.rows[0].id);
  const proposalId = p.rows[0].id;
  const { token } = p.rows[0];

  assert.equal(await gvPostStatusForProposal(proposalId), null, 'no post');
  assert.equal(await gvPostStatusForProposal(2 ** 31 - 2), null, 'no proposal');

  const body = `Hi, this is Dallas from Dr. Bartender. Your proposal is ready: ${proposalUrl(token)}.`;
  const negOld = `${RUN}-neg-old`;
  const negNew = `${RUN}-neg-new`;
  await mkLead(negOld, c.rows[0].id, phone);
  await mkLead(negNew, c.rows[0].id, phone);
  // An older post whose fallback went out, then the latest post, clicked 5 minutes ago.
  const old = await pool.query(
    `INSERT INTO gv_posts (proposal_id, client_id, negotiation_id, body, send_path, status, fallback_status, fallback_at, created_at)
     VALUES ($1, $2, $3, $4, 'auto', 'stale', 'sent', now() - interval '19 minutes', now() - interval '20 minutes')
     RETURNING id`,
    [proposalId, c.rows[0].id, negOld, body]
  );
  created.posts.push(old.rows[0].id);
  const latest = await pool.query(
    `INSERT INTO gv_posts (proposal_id, client_id, negotiation_id, body, send_path, status, leased_at, reported_at, clicked_at, created_at)
     VALUES ($1, $2, $3, $4, 'compose', 'sent', now() - interval '6 minutes', now() - interval '5 minutes',
             now() - interval '5 minutes', now() - interval '6 minutes')
     RETURNING id, created_at, clicked_at`,
    [proposalId, c.rows[0].id, negNew, body]
  );
  created.posts.push(latest.rows[0].id);

  // The echo of the latest post (Thumbtack broke a line), a hand paste of the
  // link, a message without the token, and the exact body on the old post's
  // conversation, which is not the latest post's.
  const echo = await mkMessage(negNew, body.replace('Your proposal', '\nYour proposal'), 4);
  await mkMessage(negNew, `link again: https://drbartender.com/proposal/${token}`, 3);
  await mkMessage(negNew, 'Thanks! Looking now.', 2);
  await mkMessage(negOld, body, 18);

  const status = await gvPostStatusForProposal(proposalId);
  assert.deepEqual(Object.keys(status).sort(), [
    'clicked_at', 'created_at', 'display', 'fallback_status', 'hand_pasted', 'in_thread_at', 'phone_last4',
    'reason', 'status',
  ]);
  assert.equal(status.status, 'sent');
  assert.equal(status.display, 'in_thread');
  assert.equal(status.reason, null);
  assert.equal(status.fallback_status, null);
  assert.equal(status.hand_pasted, true);
  assert.equal(status.phone_last4, phone.slice(-4));
  assert.equal(status.created_at.getTime(), latest.rows[0].created_at.getTime());
  assert.equal(status.clicked_at.getTime(), latest.rows[0].clicked_at.getTime());
  assert.equal(status.in_thread_at.getTime(), echo.sent_at.getTime());
  assert.ok(!JSON.stringify(status).includes(phone.slice(-7)), 'last-4 only');

  // Without the echo, the latest post has not shown up in the thread yet.
  await pool.query('DELETE FROM thumbtack_messages WHERE id = ANY($1::int[])', [created.messages]);
  created.messages = [];
  const unseen = await gvPostStatusForProposal(proposalId);
  assert.equal(unseen.display, 'sent_not_seen');
  assert.equal(unseen.in_thread_at, null);
  assert.equal(unseen.hand_pasted, false);
});
