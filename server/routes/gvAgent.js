'use strict';

// The GV agent API (spec docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md,
// section 6 "Agent endpoints"; plan Task 7). The box's Google Voice sender
// (gv-agent/) leases one queued post at a time, asks once more right before it
// clicks Send, reports what happened, and reports a signed-out or challenged
// session. Mounted at /api/gv-agent in server/index.js: its own prefix and its
// own rate limiter, so neither the Thumbtack agent's limiter (thumbtackAgent.js,
// shared with the first-reply poll from the same box) nor the admin router's
// JWT auth ever applies.
//
// Auth: x-gv-agent-secret against GV_AGENT_SECRET, timing-safe and failing
// closed (401) in every environment. BLAST RADIUS: a leaked secret can read
// queued post bodies (each a bearer proposal link to the client's details and
// to sign-and-pay) and the full relay numbers they go to (GET /pending); lease
// rows away from the box, so those clients get no text at all and the rows end
// unknown; force the toll-free text onto a leased row, or an unknown row
// leased in the last 24 hours, with a false failed_preclick report (a possible
// double text when the box already posted), or block a row's fallback with a
// false sent report; and feed or reset the outage streaks. It cannot choose a
// number or a body: both come from the proposal's own rows. /report keeps
// answering with the kill switch off (the box must be able to settle the job
// in its hand), so the switch alone does not stop a leaked secret. Leak
// response: rotate it on Render and in gv-agent/.env (the real stop), and flip
// GV_PROPOSAL_POST_ENABLED off.
//
// The two gates (laws 2 and 3): with the kill switch off, or with real sends
// off (a lane or dev server on the shared database), /pending hands out
// nothing and reads nothing, /precheck says no-go and touches no row, and
// /status opens no outage. /report is deliberately not gated.
//
// At most once (law 4): a leased row is never offered again, a report moves
// only a leased or unknown row, and every toll-free fallback goes through
// sendGvFallback's one claim. One pooled connection per request: the lease's
// transaction holds one client and releases it before any fallback, which
// takes its own connections. A transaction that writes both tables locks
// gv_posts before gv_sender_state.
//
// Logs: one line per lease, precheck, report and status, with the post id and
// at most a number's last 4. Never a full number in a log or in Sentry.

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const realSentry = require('@sentry/node');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { AppError, ValidationError } = require('../utils/errors');
const { last10 } = require('../utils/phone');
const { notificationsEnabled: realNotificationsEnabled } = require('../utils/notificationsEnabled');
const { THUMBTACK_PROXY_ROLLOUT } = require('../utils/inbox/constants');
const { resolveGvTarget: realResolveGvTarget } = require('../utils/gvPost/identity');
const { loadGvContext, gvSuppression } = require('../utils/gvPost/suppression');
const { checkGvCapacity } = require('../utils/gvPost/queue');
const { GV_WINDOWS, GV_PRECLICK_REASONS, gvPostEnabled } = require('../utils/gvPost/rules');
const { sendGvFallback: realSendGvFallback } = require('../utils/gvPost/fallback');
const outage = require('../utils/gvPost/outage');

let deps = {
  resolveGvTarget: realResolveGvTarget,
  sendGvFallback: realSendGvFallback,
  noteOutage: outage.noteOutage,
  noteSuccess: outage.noteSuccess,
  notePreclickFailure: outage.notePreclickFailure,
  noteUnverified: outage.noteUnverified,
  notificationsEnabled: realNotificationsEnabled,
  Sentry: realSentry,
  now: Date.now,
};

const REPORT_OUTCOMES = new Set(['sent', 'clicked_unverified', 'failed_preclick', 'skipped_already_posted']);
const STATUS_STATES = new Set(['session_expired', 'challenge']);
const MAX_INT4 = 2147483647;

const router = express.Router();

// One box polling every 10 s, plus a precheck and a report per job: 30 a
// minute is headroom, and a burst is a signal, not normal.
const gvAgentLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many requests' } });

const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

// The two sha256 digests are always 32 bytes, so timingSafeEqual never throws
// (the shared safeEqual does on a same-length header holding a non-ASCII
// character, which is more bytes in UTF-8: a 500 instead of a 401) and the
// compare says nothing about the secret's length.
function verifyGvAgentSecret(req) {
  const secret = process.env.GV_AGENT_SECRET;
  if (!secret) return false; // unset or empty: fail closed, every environment
  return crypto.timingSafeEqual(sha256(String(req.headers['x-gv-agent-secret'] || '')), sha256(secret));
}

// Auth-failure warnings: one per path per 10 minutes, in memory (queue.js's
// warnThrottled; a restart may send one more), so a box polling with a stale
// secret is one signal, not a page a poll. The bucket is the route's own path,
// and every path no route serves shares one, so made-up paths can neither
// flood Sentry nor grow this map.
const AUTH_WARN_THROTTLE_MS = 10 * 60 * 1000;
const ROUTE_PATHS = new Set(['/pending', '/precheck', '/report', '/status']);
const lastAuthWarnAt = new Map();

function warnAuthFailure(req) {
  const bucket = ROUTE_PATHS.has(req.path) ? req.path : 'other';
  const now = deps.now();
  const last = lastAuthWarnAt.get(bucket);
  if (last !== undefined && now - last < AUTH_WARN_THROTTLE_MS) return;
  lastAuthWarnAt.set(bucket, now);
  deps.Sentry.captureMessage('GV agent auth failure', {
    level: 'warning',
    tags: { feature: 'gv_post', event: 'agent_auth' },
    // The path alone: never a header, never a query string.
    extra: { method: req.method, path: `${req.baseUrl}${req.path}` },
  });
}

function requireGvAgentSecret(req, res, next) {
  if (verifyGvAgentSecret(req)) return next();
  try {
    warnAuthFailure(req);
  } catch (warnErr) {
    // Logging never breaks the response.
    console.error('[gvAgent] auth warning failed:', cause(warnErr));
  }
  return next(new AppError('Unauthorized', 401, 'NO_AGENT_SECRET'));
}

router.use(gvAgentLimiter);
router.use(requireGvAgentSecret);

// Laws 2 and 3 as one question: the kill switch is on and this server really
// sends. Read per request, never cached, so a Render flip takes effect on the
// box's next call.
const senderLive = () => gvPostEnabled() && deps.notificationsEnabled();

const last4 = (phone) => (phone ? String(phone).slice(-4) : '----');
const cause = (err) => (err && (err.code || err.name)) || 'unknown';

function parsePostId(raw) {
  let text = '';
  if (typeof raw === 'number') text = String(raw);
  else if (typeof raw === 'string') text = raw.trim();
  if (!/^[1-9][0-9]{0,9}$/.test(text) || Number(text) > MAX_INT4) {
    throw new ValidationError({ id: 'id must be a positive integer.' }, 'id must be a positive integer.');
  }
  return Number(text);
}

/**
 * Law 6: is the proposal token already in a Thumbtack thread? Any message,
 * from any sender (the legacy parse stores from_type NULL), on any proxy-era
 * conversation whose lead carries this number or on one the row names, from
 * pasteBeforeMin before the post onward. Matching the token, not the URL,
 * survives www., slashes and the trailing period.
 *
 * The echo of this proposal's OWN earlier post is not a paste: a message on
 * that post's conversation whose text is that post's body (whitespace
 * collapsed, as normalizeGvBody does), stored at or after the post was made,
 * is left out, for an earlier post the box worked (sent, clicked_unverified
 * or unknown). Without that, an intentional resend inside the look-back of a
 * landed post was settled skipped_already_posted, with no post and no text
 * (verify, 2026-11-19). A hand paste in any other words still counts.
 */
async function tokenInThread({ phoneLast10, negotiationIds, token, since, proposalId, postId }, db) {
  const { rows } = await db.query(
    `SELECT 1
       FROM thumbtack_messages tm
      WHERE (tm.negotiation_id = ANY($2::text[])
             OR tm.negotiation_id IN (
               SELECT tl.negotiation_id FROM thumbtack_leads tl
                WHERE RIGHT(REGEXP_REPLACE(tl.customer_phone, '\\D', '', 'g'), 10) = $1::text
                  AND tl.created_at >= $3::timestamptz))
        AND (tm.created_at >= $4::timestamptz - make_interval(mins => $5)
             OR tm.sent_at >= $4::timestamptz - make_interval(mins => $5))
        AND strpos(lower(COALESCE(tm.text, '')), lower($6::text)) > 0
        AND NOT EXISTS (
          SELECT 1 FROM gv_posts own
           WHERE own.proposal_id = $7::int AND own.id <> $8::int
             AND own.status IN ('sent','clicked_unverified','unknown')
             AND own.negotiation_id = tm.negotiation_id
             AND own.created_at <= COALESCE(tm.sent_at, tm.created_at)
             AND btrim(regexp_replace(own.body, '\\s+', ' ', 'g'))
                 = btrim(regexp_replace(COALESCE(tm.text, ''), '\\s+', ' ', 'g')))
      LIMIT 1`,
    [phoneLast10, negotiationIds, THUMBTACK_PROXY_ROLLOUT, since, GV_WINDOWS.pasteBeforeMin, String(token),
      proposalId, postId]
  );
  return rows.length > 0;
}

/**
 * The lease's re-validation of one queued row (laws 1, 6, 7 and 8), on the
 * lease's own client. Returns the row's next status and reason, the lead it
 * now names, whether a toll-free fallback follows, and the job when leased.
 */
async function revalidate(row, client) {
  const target = await deps.resolveGvTarget(row.proposal_id, client);
  if (!target.ok) {
    return {
      status: 'failed_preclick', reason: 'identity_mismatch',
      negotiationId: row.negotiation_id, leadId: row.lead_id,
      fallback: true, warn: 'lease_identity_mismatch', identityReason: target.reason,
    };
  }
  // The client's number may have moved to another relay lead of the same
  // client since the send: the row follows it, so the status row and the Inbox
  // keep matching.
  const fresh = { negotiationId: target.negotiationId, leadId: target.leadId };
  const ctx = await loadGvContext(row.proposal_id, client);
  const suppressed = ctx
    ? await gvSuppression({ ...ctx, phone: target.phone }, client)
    : { ok: false, reason: 'not_sendable' };
  if (!suppressed.ok) return { status: 'cancelled', reason: suppressed.reason, ...fresh };

  const phoneLast10 = last10(target.phone);
  const pasted = await tokenInThread({
    phoneLast10,
    negotiationIds: [...new Set([row.negotiation_id, fresh.negotiationId])],
    token: ctx.proposal.token,
    since: row.created_at,
    proposalId: row.proposal_id,
    postId: row.id,
  }, client);
  if (pasted) return { status: 'skipped_already_posted', reason: null, ...fresh };

  // The proposal's own rows are left out, as the router does: an intentional
  // resend minutes after a landed post is not turned into a toll-free text.
  const capacity = await checkGvCapacity(
    { phoneLast10, excludeProposalId: row.proposal_id, excludePostId: row.id }, client
  );
  if (!capacity.ok) {
    return { status: 'failed_preclick', reason: capacity.reason, ...fresh, fallback: true, warn: `lease_${capacity.reason}` };
  }
  return {
    status: 'leased', reason: null, ...fresh,
    job: {
      id: row.id, phone: target.phone, body: row.body, negotiation_id: fresh.negotiationId,
      prior_bodies: await priorBodies(row, fresh.negotiationId, client),
    },
  };
}

// The bodies of this proposal's earlier worked posts on the job's
// conversation, newest first, repeats kept (a resend's default text is the
// first send's, so the box needs the count, not the set). The box looks for
// the proposal token in the open Google Voice thread before it types and
// again to confirm its click; its own earlier posts are in that thread too,
// and without this list it could not tell them from a hand paste, so an
// intentional resend would be skipped at the box as it once was at the lease
// (verify, 2026-11-19). Each body carries only this proposal's own link.
async function priorBodies(row, negotiationId, db) {
  const { rows } = await db.query(
    `SELECT body FROM gv_posts
      WHERE proposal_id = $1 AND id <> $2
        AND status IN ('sent','clicked_unverified','unknown')
        AND negotiation_id = ANY($3::text[])
      ORDER BY created_at DESC, id DESC
      LIMIT 10`,
    [row.proposal_id, row.id, [...new Set([row.negotiation_id, negotiationId])]]
  );
  return rows.map((r) => r.body);
}

// The re-check inside a savepoint. A query that fails inside revalidate aborts
// the lease's transaction, and without the savepoint the row would stay queued
// and be picked again on every poll until the sweep staled it. Rolled back to
// the savepoint, the lease can still settle the row: it was never handed out,
// so no click can have happened and the toll-free text is safe (law 5).
// recheck_error is the server's own reason, never one a box report may carry.
// If the rollback itself fails the connection is gone: the throw reaches
// leaseOne's ROLLBACK, the row stays queued, and the sweep stales it.
async function revalidateInSavepoint(row, client) {
  await client.query('SAVEPOINT gv_recheck');
  try {
    const outcome = await revalidate(row, client);
    await client.query('RELEASE SAVEPOINT gv_recheck');
    return outcome;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT gv_recheck');
    return {
      status: 'failed_preclick', reason: 'recheck_error',
      negotiationId: row.negotiation_id, leadId: row.lead_id,
      fallback: true, warn: 'lease_recheck_error', cause: cause(err),
    };
  }
}

// Take the oldest queued row and settle it in one transaction on one client,
// released before anything else runs. null when nothing is queued.
async function leaseOne() {
  const client = await pool.connect();
  let row = null;
  let outcome = null;
  try {
    await client.query('BEGIN');
    const picked = await client.query(
      `SELECT * FROM gv_posts
        WHERE status = 'queued'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED`
    );
    row = picked.rows[0] || null;
    if (row) {
      outcome = await revalidateInSavepoint(row, client);
      await client.query(
        `UPDATE gv_posts
            SET status = $2::text, reason = $3, negotiation_id = $4, lead_id = $5,
                leased_at = CASE WHEN $2::text = 'leased' THEN now() ELSE leased_at END,
                updated_at = now()
          WHERE id = $1`,
        [row.id, outcome.status, outcome.reason, outcome.negotiationId, outcome.leadId]
      );
      // gv_posts first, then the state row: the lock order every writer keeps.
      await client.query('UPDATE gv_sender_state SET last_lease_at = now(), updated_at = now() WHERE id = 1');
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the original error matters */ }
    throw err;
  } finally {
    client.release();
  }
  return row ? { row, outcome } : null;
}

// A toll-free fallback, after every client is released. sendGvFallback throws
// only when its claim fails, in which case nothing was sent and the sweep's
// retry arm picks the row up.
async function fallBack(postId, stage) {
  try {
    await deps.sendGvFallback(postId);
  } catch (err) {
    deps.Sentry.captureException(new Error('gv_post fallback claim failed'), {
      tags: { feature: 'gv_post', stage },
      extra: { postId, cause: cause(err) },
    });
  }
}

// GET /api/gv-agent/pending: [] before any database read while the kill switch
// is off (law 2) or real sends are off (law 3), else at most one job,
// [{ id, phone, body, negotiation_id, prior_bodies }], re-validated first
// (prior_bodies: this proposal's earlier worked posts on that conversation,
// which the box leaves out of its own already-in-the-thread check).
router.get('/pending', asyncHandler(async (req, res) => {
  if (!senderLive()) return res.json([]);
  const leased = await leaseOne();
  if (!leased) return res.json([]);
  const { row, outcome } = leased;
  console.log(`[gvAgent] lease post ${row.id}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`
    + `${outcome.job ? `, number ending ${last4(outcome.job.phone)}` : ''}`);
  if (outcome.warn) {
    deps.Sentry.captureMessage(`GV post lease: ${outcome.status} (${outcome.reason})`, {
      level: 'warning',
      tags: { feature: 'gv_post', event: outcome.warn },
      // cause is a driver code or an error name, never a driver message
      // (which can quote a parameter, and one of them is the number).
      extra: {
        postId: row.id, proposalId: row.proposal_id,
        identityReason: outcome.identityReason || null, cause: outcome.cause || null,
      },
    });
  }
  if (outcome.fallback) await fallBack(row.id, 'lease');
  return res.json(outcome.job ? [outcome.job] : []);
}));

// POST /api/gv-agent/precheck { id }: the box asks right before it journals
// and clicks (law 6). A paste made in the Thumbtack app reaches only our
// webhook, so this is the last look. A row no longer leased (the sweep moved
// it, or its proposal was deleted) is no-go, and the box reports
// failed_preclick timeout. The same no-go, touching no row, while the kill
// switch or real sends are off: after a rollback flip the job in the box's
// hand is never clicked, and its timeout report sends today's text.
router.post('/precheck', asyncHandler(async (req, res) => {
  const id = parsePostId(req.body && req.body.id);
  if (!senderLive()) {
    console.log(`[gvAgent] precheck post ${id}: no-go timeout (the sender is switched off)`);
    return res.json({ go: false, outcome: 'timeout' });
  }
  const { rows } = await pool.query(
    `SELECT gp.id, gp.status, gp.negotiation_id, gp.created_at, gp.proposal_id, p.token, c.phone
       FROM gv_posts gp
       JOIN proposals p ON p.id = gp.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE gp.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row || row.status !== 'leased') {
    console.log(`[gvAgent] precheck post ${id}: no-go timeout (${row ? row.status : 'missing'})`);
    return res.json({ go: false, outcome: 'timeout' });
  }
  const pasted = await tokenInThread({
    phoneLast10: last10(row.phone), negotiationIds: [row.negotiation_id], token: row.token, since: row.created_at,
    proposalId: row.proposal_id, postId: row.id,
  }, pool);
  if (!pasted) {
    console.log(`[gvAgent] precheck post ${id}: go`);
    return res.json({ go: true });
  }
  // The server moves the row itself, so a lost box report cannot strand it.
  // If the sweep moved it first, the answer stands: the link is already in
  // the thread, and the box's skipped report upgrades the unknown row.
  const moved = await pool.query(
    `UPDATE gv_posts SET status = 'skipped_already_posted', reported_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'leased'
      RETURNING id`,
    [id]
  );
  console.log(`[gvAgent] precheck post ${id}: no-go, the link is already in the thread${moved.rows[0] ? '' : ' (the row had moved on)'}`);
  return res.json({ go: false, outcome: 'skipped_already_posted' });
}));

// POST /api/gv-agent/report { id, outcome, reason? }: what the box did. The
// box is authoritative about what happened before the sweep's guess, so a
// leased or unknown row takes the report; any other row is terminal and the
// report is ignored. An unknown row takes it only within
// GV_WINDOWS.unknownReportHours of its lease: the box reports within minutes,
// or on its restart, so a report on a day-old lease is not its word about a
// job in hand, and taking it would let a leaked secret force the toll-free
// text onto any old unknown row. A reason is kept only for failed_preclick,
// from the whitelist. Not gated by the kill switch: the box settles the job
// it already holds.
router.post('/report', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const id = parsePostId(body.id);
  const { outcome } = body;
  if (typeof outcome !== 'string' || !REPORT_OUTCOMES.has(outcome)) {
    throw new ValidationError({ outcome: 'Unknown report outcome.' }, 'Unknown report outcome.');
  }
  let reason = null;
  if (outcome === 'failed_preclick') {
    if (typeof body.reason !== 'string' || !GV_PRECLICK_REASONS.has(body.reason)) {
      throw new ValidationError({ reason: 'Unknown pre-click reason.' }, 'Unknown pre-click reason.');
    }
    reason = body.reason;
  }
  const { rows } = await pool.query(
    `UPDATE gv_posts
        SET status = $2::text, reason = $3, reported_at = now(), updated_at = now(),
            clicked_at = CASE WHEN $2::text IN ('sent','clicked_unverified') THEN now() END
      WHERE id = $1
        AND (status = 'leased'
             OR (status = 'unknown' AND leased_at > now() - make_interval(hours => $4)))
      RETURNING id, proposal_id`,
    [id, outcome, reason, GV_WINDOWS.unknownReportHours]
  );
  if (!rows[0]) {
    console.log(`[gvAgent] report post ${id}: ${outcome} ignored (the row is terminal, gone, or an unknown row past its report window)`);
    return res.json({ ignored: true });
  }
  console.log(`[gvAgent] report post ${id}: ${outcome}${reason ? ` (${reason})` : ''}`);
  if (outcome === 'clicked_unverified' || outcome === 'failed_preclick') {
    deps.Sentry.captureMessage(`GV post report: ${outcome}${reason ? ` (${reason})` : ''}`, {
      level: 'warning',
      tags: { feature: 'gv_post', event: `report_${outcome}` },
      extra: { postId: id, proposalId: rows[0].proposal_id, reason },
    });
  }
  // The row is already moved; a failed streak write must not cost the box
  // its 2xx (it would retry, and the retry is ignored).
  try {
    if (outcome === 'sent') await deps.noteSuccess();
    else if (outcome === 'clicked_unverified') await deps.noteUnverified();
    else if (outcome === 'failed_preclick') await deps.notePreclickFailure(reason);
  } catch (err) {
    deps.Sentry.captureException(new Error('gv_post outage note failed'), {
      tags: { feature: 'gv_post', stage: 'report_outage' },
      extra: { postId: id, outcome, cause: cause(err) },
    });
  }
  if (outcome === 'failed_preclick') await fallBack(id, 'report');
  return res.json({ ok: true });
}));

// POST /api/gv-agent/status { state }: the box met Google's sign-in or a
// challenge and idles until Dallas signs in by hand. One admin email per
// outage episode, shared with the sweep's and the streaks' (outage.js). With
// the kill switch or real sends off the box idles by design, so a signed-out
// session it still notices is no outage: no email, no Sentry warning, no
// episode, and the box keeps its 2xx.
router.post('/status', asyncHandler(async (req, res) => {
  const state = req.body && req.body.state;
  if (typeof state !== 'string' || !STATUS_STATES.has(state)) {
    throw new ValidationError({ state: 'Unknown sender state.' }, 'Unknown sender state.');
  }
  if (!senderLive()) {
    console.log(`[gvAgent] status ${state}: not an outage (the sender is switched off)`);
    return res.json({ ok: true });
  }
  deps.Sentry.captureMessage(`GV sender reported ${state}`, {
    level: 'warning',
    tags: { feature: 'gv_post', event: state },
  });
  const alerted = await deps.noteOutage(state);
  console.log(`[gvAgent] status ${state}${alerted ? ': the admins were emailed for this outage' : ''}`);
  return res.json({ ok: true });
}));

// Test seams (the thumbtackAgent.js convention): the identity lookup, the
// fallback, the outage notes, the notifications gate, Sentry and the clock;
// and the limiter and the auth-warning throttle, which a suite clears per
// test in its own process.
router.__setDeps = (d) => { deps = { ...deps, ...d }; };
router.__resetAuthWarnThrottle = () => { lastAuthWarnAt.clear(); };
router.gvAgentLimiter = gvAgentLimiter;

module.exports = router;
