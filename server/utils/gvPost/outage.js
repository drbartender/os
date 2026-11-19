'use strict';

// GV sender outage tracking (spec docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md,
// section 6 "Sweep"; plan Task 6), on the single gv_sender_state row (id 1).
// An outage episode opens at the first signal and emails the admins once
// (routine_thumbtack, email only, never a text); the next successful send
// closes it and zeroes every streak, so a later outage alerts again. The
// signals: the sweep's no-lease liveness check, the box's session_expired or
// challenge status, and three streaks of 3 (non-exempt pre-click failures,
// leases gone unknown, unverified clicks). The status email and the streak
// emails share the one episode, so an outage sends one email, not two.
//
// Every write is UPDATE ... WHERE id = 1, so a missing state row updates
// nothing and reads as already alerted: a lost seed can never become an email
// storm. Plain pooled queries, none held across the email, which takes its own
// connections. An episode email that reaches nobody (no admin subscribed to
// routine_thumbtack, or the recipient lookup failed) sends one Sentry warning
// and keeps the alerted stamp, so it is never retried into a storm.

const realSentry = require('@sentry/node');
const { pool } = require('../../db');
const { notifyAdminCategory: realNotifyAdminCategory } = require('../adminNotifications');
const { GV_OUTAGE_EXEMPT, GV_WINDOWS } = require('./rules');

let deps = { notifyAdminCategory: realNotifyAdminCategory, Sentry: realSentry };

const SUBJECT = 'Google Voice sender is down: Thumbtack customers are getting the toll-free text';
const SUBJECT_CHECK = 'Google Voice sender needs a look: some Thumbtack posts may not have gone through';

// The two reasons whose posts get NO toll-free text (law 5: either may
// already be in the thread), so "nothing is lost" would be false for them and
// the admins would have no reason to open those proposals.
const NO_FALLBACK_REASONS = new Set(['unknown_streak', 'verify_unconfirmed']);

function outageSubject(reason) {
  return NO_FALLBACK_REASONS.has(reason) ? SUBJECT_CHECK : SUBJECT;
}

function outageText(reason) {
  if (reason === 'unknown_streak') {
    return `The box's Google Voice sender took proposal posts and never reported back (reason: ${reason}). Those customers were not sent the toll-free text, because the post may already be in their Thumbtack thread. Open each proposal whose Thumbtack message line says to check the thread, and paste the link if it is not there. Then check the box and sign GV back in if it is signed out (gv-agent/README.md).`;
  }
  if (reason === 'verify_unconfirmed') {
    return `The box's Google Voice sender clicked Send on proposal posts but could not confirm they went through (reason: ${reason}). They most likely landed, so no toll-free text was sent. Open each proposal whose Thumbtack message line says to check the thread, and paste the link if it is not there. If this keeps happening, the Google Voice page may have changed (gv-agent/README.md).`;
  }
  return `The box's Google Voice sender stopped posting proposal links (reason: ${reason}). Thumbtack customers are getting today's toll-free text instead, so nothing is lost. To fix it, sign GV back in on the box (gv-agent/README.md); the sender picks up on its next poll.`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// One fixed statement per streak (no column name is ever built from a value).
const BUMP_PRECLICK = `UPDATE gv_sender_state
    SET consecutive_preclick_failures = consecutive_preclick_failures + 1, updated_at = now()
  WHERE id = 1
  RETURNING consecutive_preclick_failures AS n`;
const BUMP_UNKNOWN = `UPDATE gv_sender_state
    SET consecutive_unknown = consecutive_unknown + 1, updated_at = now()
  WHERE id = 1
  RETURNING consecutive_unknown AS n`;
const BUMP_UNVERIFIED = `UPDATE gv_sender_state
    SET consecutive_unverified = consecutive_unverified + 1, updated_at = now()
  WHERE id = 1
  RETURNING consecutive_unverified AS n`;

/**
 * Open the outage episode if it is closed, and email the admins once per
 * episode. The conditional UPDATE on outage_alerted_at is the dedupe, so two
 * signals at once still send one email.
 *
 * @param {string} reason - preclick_failures, unknown_streak, verify_unconfirmed,
 *   no_lease, session_expired or challenge
 * @returns {Promise<boolean>} true when this call raised the episode's alert
 *   (its one email, sent whether or not it reached anyone)
 */
async function noteOutage(reason) {
  await pool.query(
    `UPDATE gv_sender_state
        SET outage_since = now(), outage_reason = $1, updated_at = now()
      WHERE id = 1 AND outage_since IS NULL`,
    [reason]
  );
  const { rows } = await pool.query(
    `UPDATE gv_sender_state
        SET outage_alerted_at = now(), updated_at = now()
      WHERE id = 1 AND outage_alerted_at IS NULL
      RETURNING outage_reason`
  );
  if (!rows[0]) return false;
  // The episode's own reason: the signal that opened it.
  const episodeReason = rows[0].outage_reason || reason;
  const text = outageText(episodeReason);
  console.warn(`[gvPost] GV sender outage (${episodeReason}): emailing the admins once for this episode`);
  let emailed = 0;
  try {
    const sent = await deps.notifyAdminCategory({
      category: 'routine_thumbtack',
      subject: outageSubject(episodeReason),
      emailHtml: `<p>${escapeHtml(text)}</p>`,
      emailText: text,
    });
    emailed = (sent && sent.emailed) || 0;
  } catch (err) {
    console.error('[gvPost] outage email failed:', (err && (err.code || err.name)) || 'unknown');
  }
  // Nobody was reached: Sentry is the one signal left. The alerted stamp
  // stays, so this episode never re-sends. The reason only, no address.
  if (emailed === 0) {
    console.warn(`[gvPost] the outage email reached nobody (${episodeReason}); the episode stays alerted`);
    deps.Sentry.captureMessage('GV sender outage email reached nobody', {
      level: 'warning',
      tags: { feature: 'gv_post', event: 'outage_email_unsent' },
      extra: { reason: episodeReason },
    });
  }
  return true;
}

/** A successful send: close the episode, stamp last_success_at, zero all three streaks. */
async function noteSuccess() {
  await pool.query(
    `UPDATE gv_sender_state
        SET outage_since = NULL, outage_reason = NULL, outage_alerted_at = NULL,
            last_success_at = now(),
            consecutive_preclick_failures = 0, consecutive_unknown = 0, consecutive_unverified = 0,
            updated_at = now()
      WHERE id = 1`
  );
}

// Bump one streak; at 3 (and past it, idempotently) the episode opens.
async function bump(sql, outageReason) {
  const { rows } = await pool.query(sql);
  if (rows[0] && rows[0].n >= GV_WINDOWS.outageFailures) return noteOutage(outageReason);
  return false;
}

/**
 * A box report of failed_preclick. cap, spacing and no_thread never count:
 * the sender is healthy, it was told not to post.
 *
 * @param {string} reason - the whitelisted pre-click reason
 * @returns {Promise<boolean>} true when this call sent the episode's email
 */
function notePreclickFailure(reason) {
  if (GV_OUTAGE_EXEMPT.has(reason)) return Promise.resolve(false);
  return bump(BUMP_PRECLICK, 'preclick_failures');
}

/** A lease gone unknown (a box that leases and then dies never reports). */
function noteUnknown() {
  return bump(BUMP_UNKNOWN, 'unknown_streak');
}

/** A clicked_unverified report (the verify surface broke; the sends may be fine). */
function noteUnverified() {
  return bump(BUMP_UNVERIFIED, 'verify_unconfirmed');
}

// Test seam: the admin email and Sentry.
function __setDeps(d) { deps = { ...deps, ...d }; }

module.exports = {
  noteOutage, noteSuccess, notePreclickFailure, noteUnknown, noteUnverified, __setDeps,
};
