'use strict';

// The proposal-text router and the GV post queue (spec
// docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md, laws 2,
// 3, 4, 7 and 8; plan Task 4). The two proposal-text choke points ask
// routeProposalText whether to queue a Google Voice post into the customer's
// Thumbtack thread or to text from the toll-free line as today. Every answer
// but 'gv' and 'merged' means "text as today", and so does any throw: a router
// failure must never cost the client the proposal text (law 5, fail open).
//
// Plain pooled queries, no held client: the router runs post-commit inside the
// send paths, and each read stands alone. The partial unique index
// uq_gv_posts_open_per_proposal is what makes a double click one row (law 4).

const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { last10 } = require('../phone');
const { notificationsEnabled } = require('../notificationsEnabled');
const { THUMBTACK_PROXY_ROLLOUT } = require('../inbox/constants');
const { resolveGvTarget } = require('./identity');
const { loadGvContext, gvSuppression } = require('./suppression');
const { GV_WINDOWS, gvPostEnabled, gvDailyCap, validateGvBody } = require('./rules');
const { gvSweepRegistered } = require('./sweepState');

// Rows that are, or may already be, a post: these count toward the cap and the
// spacing rule. stale, failed_preclick, skipped and cancelled never posted.
const COUNTED_STATUSES = ['queued', 'leased', 'sent', 'clicked_unverified', 'unknown'];
const SEND_PATHS = new Set(['auto', 'compose']);
const WARN_THROTTLE_MS = 60 * 60 * 1000;
const lastWarnAt = new Map();

let deps = { resolveGvTarget, notificationsEnabled, sweepRegistered: gvSweepRegistered, Sentry };

/**
 * Law 7's server-side volume rules. Cap: posts made in the last 24 hours, at
 * most gvDailyCap(). Spacing: no post to a conversation on this number (any
 * proxy-era lead carrying it) in the last 10 minutes. Both leave out the rows
 * of excludeProposalId (an intentional resend of the same proposal is not a
 * second post) and the row excludePostId (the one being leased).
 *
 * @param {{phoneLast10:string, excludeProposalId?:number|null, excludePostId?:number|null}} args
 * @param {Object} [db] pg pool or client
 * @returns {Promise<{ok:true} | {ok:false, reason:'cap'|'spacing'}>}
 */
async function checkGvCapacity({ phoneLast10, excludeProposalId = null, excludePostId = null }, db = pool) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS day_count,
            COUNT(*) FILTER (
              WHERE gp.created_at > now() - make_interval(mins => $4)
                AND gp.negotiation_id IN (
                  SELECT tl.negotiation_id FROM thumbtack_leads tl
                   WHERE RIGHT(REGEXP_REPLACE(tl.customer_phone, '\\D', '', 'g'), 10) = $1
                     AND tl.created_at >= $5::timestamptz)
            )::int AS spacing_count
       FROM gv_posts gp
      WHERE gp.status = ANY($6::text[])
        AND gp.created_at > now() - interval '24 hours'
        AND ($2::int IS NULL OR gp.proposal_id <> $2::int)
        AND ($3::int IS NULL OR gp.id <> $3::int)`,
    [phoneLast10, excludeProposalId, excludePostId, GV_WINDOWS.spacingMin,
      THUMBTACK_PROXY_ROLLOUT, COUNTED_STATUSES]
  );
  if (rows[0].day_count >= gvDailyCap()) return { ok: false, reason: 'cap' };
  if (rows[0].spacing_count > 0) return { ok: false, reason: 'spacing' };
  return { ok: true };
}

// One Sentry warning per reason per hour, in memory (a restart may send one more).
function warnThrottled(reason, proposalId) {
  const now = Date.now();
  if (now - (lastWarnAt.get(reason) || 0) < WARN_THROTTLE_MS) return;
  lastWarnAt.set(reason, now);
  deps.Sentry.captureMessage(`GV post ${reason}: the toll-free text went instead`, {
    level: 'warning',
    tags: { feature: 'gv_post', event: reason },
    extra: { proposalId },
  });
}

// Every "text as today" answer logs one line (proposal id and reason, never a
// number), except 'disabled': with the kill switch off the send must look
// exactly like today (law 2). Cap and spacing also warn, since they mean GV
// volume is the limit.
function twilio(proposalId, reason) {
  if (reason !== 'disabled') {
    console.log(`[gvPost] proposal ${proposalId} texts from the toll-free line (${reason})`);
  }
  if (reason === 'cap' || reason === 'spacing' || reason === 'sweep_off') warnThrottled(reason, proposalId);
  return { route: 'twilio', reason };
}

// id is null when the open row this send collided with turned terminal before
// it could be read back: a post is, or was, already under way, so the answer
// is still "no toll-free text" (law 4).
function merged(proposalId, id) {
  console.log(`[gvPost] proposal ${proposalId} merged into open GV post ${id === null ? '(already closed)' : id}`);
  return { route: 'merged', id };
}

async function findOpenPost(proposalId) {
  const { rows } = await pool.query(
    "SELECT id FROM gv_posts WHERE proposal_id = $1 AND status IN ('queued','leased') ORDER BY id LIMIT 1",
    [proposalId]
  );
  return rows[0] ? rows[0].id : null;
}

/**
 * Queue a GV post for this proposal text, or say to text as today. In order:
 *   1. the kill switch (disabled), 2. the notifications gate
 *   (notifications_off), then whether this process runs the sweep (sweep_off:
 *   nothing else would drain a queued row, so it texts as today and warns
 *   Sentry at most hourly), 3. an open row for this proposal (merged), 4. the
 *   identity rule (its reason), 5. suppression (its reason), 6. the body check
 *   (its reason), 7. the cap and spacing rules (cap, spacing), 8. the insert,
 *   which on losing a race reads the open row back (merged).
 *
 * The open-row check comes before identity, suppression and the body: while a
 * post is open, a second send merges into it whatever it carries, so the 888
 * never texts beside an open post (law 4). The open row keeps its first body
 * (plan decision 9), and the lease re-checks identity and suppression.
 *
 * @param {Object} args
 * @param {number} args.proposalId
 * @param {string} args.token - the proposal's share token, as the caller loaded it
 * @param {string} args.body - the proposal text that would go out
 * @param {number|null} [args.sentBy] - the admin who clicked Send
 * @param {'auto'|'compose'} args.sendPath - which send path, so a fallback goes back through it
 * @returns {Promise<{route:'gv', id:number} | {route:'merged', id:number|null} | {route:'twilio', reason:string}>}
 */
async function routeProposalText({ proposalId, token, body, sentBy = null, sendPath }) {
  try {
    if (!gvPostEnabled()) return twilio(proposalId, 'disabled');
    if (!deps.notificationsEnabled()) return twilio(proposalId, 'notifications_off');
    if (!deps.sweepRegistered()) return twilio(proposalId, 'sweep_off');
    if (!SEND_PATHS.has(sendPath)) throw new Error('routeProposalText: unknown sendPath');

    const openId = await findOpenPost(proposalId);
    if (openId !== null) return merged(proposalId, openId);

    const target = await deps.resolveGvTarget(proposalId);
    if (!target.ok) return twilio(proposalId, target.reason);

    const ctx = await loadGvContext(proposalId);
    if (!ctx) return twilio(proposalId, 'not_sendable');
    const suppressed = await gvSuppression({ ...ctx, phone: target.phone });
    if (!suppressed.ok) return twilio(proposalId, suppressed.reason);

    // The body is checked against the token on the row, the source of truth;
    // a caller holding another token is confused, so it texts as today.
    if (token && String(token) !== String(ctx.proposal.token)) return twilio(proposalId, 'wrong_link');
    const valid = validateGvBody(body, ctx.proposal.token);
    if (!valid.ok) return twilio(proposalId, valid.reason);

    const capacity = await checkGvCapacity({ phoneLast10: last10(target.phone), excludeProposalId: proposalId });
    if (!capacity.ok) return twilio(proposalId, capacity.reason);

    // The inference clause must match the partial index's predicate exactly:
    // without the WHERE, Postgres finds no arbiter index and raises 42P10.
    const ins = await pool.query(
      `INSERT INTO gv_posts (proposal_id, client_id, lead_id, negotiation_id, body, send_path, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (proposal_id) WHERE status IN ('queued','leased') DO NOTHING
       RETURNING id`,
      [proposalId, target.clientId, target.leadId, target.negotiationId, valid.body, sendPath, sentBy]
    );
    if (ins.rows[0]) {
      console.log(`[gvPost] proposal ${proposalId} queued GV post ${ins.rows[0].id} (${sendPath})`);
      return { route: 'gv', id: ins.rows[0].id };
    }
    // Lost the race to a concurrent send of the same proposal.
    return merged(proposalId, await findOpenPost(proposalId));
  } catch (err) {
    // A sanitized error: a driver message can quote a parameter, and one of
    // them is the client's number.
    deps.Sentry.captureException(new Error('gv_post route failed'), {
      tags: { feature: 'gv_post', stage: 'route' },
      extra: { proposalId, cause: (err && (err.code || err.name)) || 'unknown' },
    });
    console.error(`[gvPost] proposal ${proposalId} route failed (${(err && (err.code || err.name)) || 'unknown'}); texting as today`);
    return { route: 'twilio', reason: 'error' };
  }
}

// Test seam: the identity lookup, the notifications gate, the sweep flag and Sentry.
routeProposalText.__setDeps = (d) => { deps = { ...deps, ...d }; };

module.exports = { routeProposalText, checkGvCapacity };
