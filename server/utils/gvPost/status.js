'use strict';

// Read-time GV post status (spec docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md,
// section 6 "Confirmation is derived at read time", law 5; plan Task 8). The
// proposal page's "Thumbtack message" row reads the proposal's latest GV post
// through gvPostStatusForProposal.
//
// "In the thread" is never written by the webhook: it is derived here from
// thumbtack_messages, Thumbtack's own feed, so the proof of landing is
// Thumbtack's word, not the box's. A message on the post's conversation whose
// normalized text equals the posted body is the post's echo (in_thread). A
// message holding the proposal token without the body is a human paste: it
// sets hand_pasted and never confirms the post, so a hand paste can't hide a
// broken sender.
//
// Reads only. Two plain queries on the passed db (a pool, or the caller's
// client), never a held connection of its own.

const { pool } = require('../../db');
const { GV_WINDOWS, normalizeGvBody } = require('./rules');

const MINUTE_MS = 60 * 1000;

const msOf = (v) => (v === null || v === undefined ? NaN : new Date(v).getTime());

// A stale or failed_preclick post's fallback, as the page reads it. A claim is
// the moment right before the toll-free send, so it reads pending however old
// it is (the sweep turns an old claim failed; plan decision 11), never sent.
// An unclaimed row reads pending for claimStaleMin after its last write
// (updated_at, which every writer stamps): the stale or failed_preclick write
// and the claim are one call apart, and the sweep's retry arm claims a row a
// restart left unclaimed after half a minute. Past that nothing is on its way (the
// retry arm takes no row that old, and the sweep marks it failed), so it
// reads failed and the team pastes.
function fallbackDisplay(post, nowMs) {
  switch (post.fallback_status) {
    case 'sent': return 'fallback';
    case 'suppressed': return 'fallback_suppressed';
    case 'failed': return 'fallback_failed';
    case 'claimed': return 'fallback_pending';
    default: {
      const since = msOf(post.updated_at ?? post.created_at);
      return nowMs - since < GV_WINDOWS.claimStaleMin * MINUTE_MS ? 'fallback_pending' : 'fallback_failed';
    }
  }
}

// The display a post's own state gives when no echo confirms it.
function statusDisplay(post, nowMs) {
  switch (post.status) {
    case 'queued': return 'queued';
    case 'leased': return 'sending';
    case 'sent': {
      // The echo takes about 15 seconds to come back; until the grace runs out
      // a sent post simply reads sent.
      const at = msOf(post.clicked_at ?? post.reported_at ?? post.updated_at);
      return nowMs - at < GV_WINDOWS.notSeenGraceMin * MINUTE_MS ? 'sent' : 'sent_not_seen';
    }
    case 'skipped_already_posted': return 'skipped_already_posted';
    case 'cancelled': return 'cancelled';
    case 'stale':
    case 'failed_preclick': return fallbackDisplay(post, nowMs);
    // clicked_unverified, unknown, and anything newer than this code: the link
    // may already be in the thread, so a human looks before pasting.
    default: return 'check_thread';
  }
}

/**
 * Derive what the proposal page shows for one GV post. Pure.
 *
 * in_thread: an echo on the post's own conversation whose normalized text
 * equals the normalized post body. It beats every other state. An echo stored
 * before the post existed never counts: a resend's default text is
 * byte-identical to the first send's, so that echo is an earlier post's. Of
 * the matching echoes, the earliest stamps in_thread_at.
 *
 * hand_pasted: an echo on the post's conversation that holds the proposal
 * token (case-insensitively) without the body. It never makes in_thread.
 *
 * @param {Object} post - the gv_posts row plus its proposal's token: status,
 *   fallback_status, body, token, negotiation_id, created_at, updated_at,
 *   clicked_at, reported_at
 * @param {Array<{negotiation_id:string, text:string, sent_at:Date|null, created_at:Date|null}>} echoes
 *   thumbtack_messages rows that may be the post's echo or a paste
 * @param {Date} [now]
 * @returns {{display:string, in_thread_at:Date|null, hand_pasted:boolean}} display is one
 *   of queued, sending, sent, sent_not_seen, in_thread, check_thread,
 *   skipped_already_posted, fallback_pending, fallback, fallback_suppressed,
 *   fallback_failed, cancelled
 */
function deriveGvDisplay(post, echoes, now = new Date()) {
  const nowMs = msOf(now);
  const body = normalizeGvBody(post.body);
  const token = String(post.token || '').toLowerCase();
  const postMs = msOf(post.created_at);
  let inThreadAt = null;
  let handPasted = false;

  for (const echo of echoes || []) {
    if (!echo || String(echo.negotiation_id) !== String(post.negotiation_id)) continue;
    const text = String(echo.text ?? '');
    if (body && normalizeGvBody(text) === body) {
      const storedMs = msOf(echo.created_at ?? echo.sent_at);
      if (Number.isFinite(postMs) && !(storedMs >= postMs)) continue;
      const at = echo.sent_at ?? echo.created_at;
      if (inThreadAt === null || msOf(at) < msOf(inThreadAt)) inThreadAt = at;
    } else if (token && text.toLowerCase().includes(token)) {
      handPasted = true;
    }
  }

  return {
    display: inThreadAt !== null ? 'in_thread' : statusDisplay(post, nowMs),
    in_thread_at: inThreadAt,
    hand_pasted: handPasted,
  };
}

/**
 * The proposal's latest GV post, as the proposal page shows it, or null when
 * the proposal has none. Reads the latest row with its proposal token and the
 * client's last 4, then the thumbtack_messages on the row's conversation from
 * pasteBeforeMin before the post onward whose text holds the token.
 *
 * @param {number} proposalId
 * @param {Object} [db] pg pool or client
 * @returns {Promise<null | {status:string, display:string, reason:string|null,
 *   fallback_status:string|null, created_at:Date, clicked_at:Date|null,
 *   in_thread_at:Date|null, hand_pasted:boolean, phone_last4:string|null}>}
 *   reason is the row's own: a stale row carries none unless its fallback
 *   claim was interrupted.
 */
async function gvPostStatusForProposal(proposalId, db = pool) {
  const { rows } = await db.query(
    `SELECT gp.status, gp.reason, gp.fallback_status, gp.body, gp.negotiation_id,
            gp.created_at, gp.updated_at, gp.clicked_at, gp.reported_at,
            p.token,
            NULLIF(RIGHT(REGEXP_REPLACE(COALESCE(c.phone, ''), '\\D', '', 'g'), 4), '') AS phone_last4
       FROM gv_posts gp
       JOIN proposals p ON p.id = gp.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE gp.proposal_id = $1
      ORDER BY gp.created_at DESC, gp.id DESC
      LIMIT 1`,
    [proposalId]
  );
  const post = rows[0];
  if (!post) return null;

  const echoes = await db.query(
    `SELECT tm.negotiation_id, tm.text, tm.sent_at, tm.created_at
       FROM thumbtack_messages tm
      WHERE tm.negotiation_id = $1
        AND (tm.created_at >= $2::timestamptz - make_interval(mins => $3)
             OR tm.sent_at >= $2::timestamptz - make_interval(mins => $3))
        AND strpos(lower(COALESCE(tm.text, '')), lower($4::text)) > 0
      ORDER BY tm.id
      LIMIT 50`,
    [post.negotiation_id, post.created_at, GV_WINDOWS.pasteBeforeMin, String(post.token)]
  );
  const derived = deriveGvDisplay(post, echoes.rows);

  return {
    status: post.status,
    display: derived.display,
    reason: post.reason,
    fallback_status: post.fallback_status,
    created_at: post.created_at,
    clicked_at: post.clicked_at,
    in_thread_at: derived.in_thread_at,
    hand_pasted: derived.hand_pasted,
    phone_last4: post.phone_last4,
  };
}

module.exports = { deriveGvDisplay, gvPostStatusForProposal };
