'use strict';

// The toll-free fallback for a GV post that definitely did not happen (spec
// docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md, law 5;
// plan Task 6). A stale row (never leased in time) or a failed_preclick row
// (the box, or the lease, said no click happened) gets today's 888 proposal
// text, sent back through the path that queued the post (plan decision 5):
// sendInitialProposalText for 'auto', sendResendText for 'compose'. Those two
// stay the one writer of initial_proposal and proposal_sent_sms.
//
// At most once. The claim (fallback_status NULL to 'claimed', stamping
// fallback_at) is one conditional UPDATE, so the sweep and a late box report
// can never both send. It also requires a stale or failed_preclick row, the
// pairing gv_posts_fallback_pair_check enforces: sent, clicked_unverified,
// unknown and skipped rows may already be in the thread and never fall back.
// A claim that never finishes is never retried (plan decision 11); the sweep
// reads it failed after 2 minutes.
//
// Never gated by the kill switch: a rollback drains queued rows to the 888.
// Plain pooled queries, no held client: both senders take their own
// connections.

const realSentry = require('@sentry/node');
const { pool } = require('../../db');
const { normalizePhone } = require('../sms');
const { sendInitialProposalText: realSendInitialProposalText } = require('../sendProposalSentEmail');
const { load: realLoad, sendResendText: realSendResendText } = require('../comms/actions/proposalResend');
const { gvSuppression } = require('./suppression');

let deps = {
  sendInitialProposalText: realSendInitialProposalText,
  sendResendText: realSendResendText,
  load: realLoad,
  Sentry: realSentry,
};

// A sender's answer, as the fallback's result: a text that could not go out
// (skipped: no usable phone) is a failed fallback, and the team pastes.
const RESULT_BY_SEND = new Map([
  ['sent', 'sent'],
  ['suppressed', 'suppressed'],
  ['skipped', 'failed'],
  ['failed', 'failed'],
]);

// The joined row sendInitialProposalText reads, live from the proposal and
// its client at the moment of the fallback, never from the queue row.
async function loadForFallback(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_type, p.event_type_custom, p.event_date, p.client_id,
            c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
            c.communication_preferences, c.email_status, c.phone_status
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  return rows[0] || null;
}

// Re-check law 8 (minutes may have passed since the send), then send through
// the post's own path. Returns { result, why }.
async function runFallback(post) {
  const loaded = await loadForFallback(post.proposal_id);
  // The proposal is gone (its delete cascades to this row, too): nothing to send.
  if (!loaded) return { result: 'failed', why: 'no_proposal' };
  const phone = normalizePhone(loaded.client_phone);
  const check = await gvSuppression({
    proposal: { id: loaded.id, status: loaded.status },
    client: loaded.client_id === null ? null : {
      communication_preferences: loaded.communication_preferences,
      email_status: loaded.email_status,
      phone_status: loaded.phone_status,
    },
    // The one number the opt-out check reads: the number the text would go
    // to. Without a usable number there is nothing to text, and the senders
    // below end 'failed'.
    phone,
  });
  if (!check.ok) return { result: 'suppressed', why: check.reason };

  if (post.send_path === 'auto') {
    const sent = await deps.sendInitialProposalText(loaded, { sentBy: post.sent_by, via: 'twilio' });
    return { result: RESULT_BY_SEND.get(sent) || 'failed', why: sent };
  }
  if (post.send_path === 'compose') {
    // sendSMS does not normalize, so the number goes in as E.164. No usable
    // number is the auto path's 'skipped': nothing to text.
    if (!phone) return { result: 'failed', why: 'no_phone' };
    const sent = await deps.sendResendText({
      row: await deps.load(post.proposal_id), phone, body: post.body, ctx: { sentBy: post.sent_by },
    });
    const status = sent && sent.status;
    return { result: RESULT_BY_SEND.get(status) || 'failed', why: status || 'unknown' };
  }
  return { result: 'failed', why: 'unknown_send_path' };
}

const cause = (err) => (err && (err.code || err.name)) || 'unknown';

/**
 * Send today's toll-free proposal text for a GV post that definitely did not
 * happen (law 5), once. Claims the row, re-checks law 8, sends through the
 * post's own path, and writes the result to fallback_status.
 *
 * Throws only when the claim itself fails, in which case nothing was claimed
 * or sent and the sweep's retry arm picks the row up. Every later failure is
 * caught: before or around the send it ends 'failed'; a failed result write
 * leaves the claim 'claimed', which the sweep reads failed (never re-sent).
 *
 * @param {number} postId
 * @returns {Promise<'sent'|'suppressed'|'failed'|'already'>} 'already' when the
 *   row was claimed before, or is not a stale or failed_preclick row
 */
async function sendGvFallback(postId) {
  const claim = await pool.query(
    `UPDATE gv_posts
        SET fallback_status = 'claimed', fallback_at = now(), updated_at = now()
      WHERE id = $1 AND fallback_status IS NULL AND status IN ('stale','failed_preclick')
      RETURNING *`,
    [postId]
  );
  const post = claim.rows[0];
  if (!post) return 'already';

  let outcome;
  try {
    outcome = await runFallback(post);
  } catch (err) {
    // A sanitized error: a driver message can quote a parameter, and one of
    // them may be the client's number.
    deps.Sentry.captureException(new Error('gv_post fallback failed'), {
      tags: { feature: 'gv_post', stage: 'fallback' },
      extra: { postId: post.id, proposalId: post.proposal_id, cause: cause(err) },
    });
    outcome = { result: 'failed', why: 'error' };
  }

  try {
    await pool.query(
      `UPDATE gv_posts SET fallback_status = $2, updated_at = now()
        WHERE id = $1 AND fallback_status = 'claimed'`,
      [post.id, outcome.result]
    );
  } catch (err) {
    deps.Sentry.captureException(new Error('gv_post fallback result write failed'), {
      tags: { feature: 'gv_post', stage: 'fallback_write' },
      extra: { postId: post.id, result: outcome.result, cause: cause(err) },
    });
  }
  console.log(`[gvPost] post ${post.id} fallback ${outcome.result} (${outcome.why}; proposal ${post.proposal_id}, ${post.send_path})`);
  return outcome.result;
}

// Test seam: the two senders, proposalResend's load, and Sentry.
sendGvFallback.__setDeps = (d) => { deps = { ...deps, ...d }; };

module.exports = { sendGvFallback, __setDeps: sendGvFallback.__setDeps };
