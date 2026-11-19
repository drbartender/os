'use strict';

// GV post rules (spec docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md,
// laws 2, 5, 7 and 9; plan Task 3): the kill switch, the daily cap, the
// windows, the whitelisted pre-click reasons, and the body check every GV post
// passes before it is queued. Pure: no DB. Windows are code, not env vars
// (plan decision 2): moving one changes what the sender does, so it goes
// through review like any other rules change.

const { PUBLIC_SITE_URL } = require('../urls');
const { readEnvInt } = require('../envInt');

// One line of at most 320 characters (law 9), and the SendModal's relay cap.
const GV_BODY_MAX = 320;

// Minutes unless named otherwise. staleMin: a queued row never leased goes
// stale. leaseMin: a leased row unreported goes unknown (it must exceed the
// box's per-job budget). spacingMin: no two posts to one number closer than
// this (law 7). pasteBeforeMin: how far before a post a hand-pasted token still
// counts (law 6). notSeenGraceMin: a sent post not yet echoed reads "sent" this
// long. livenessMin: stale rows with no lease this recent open an outage.
// claimStaleMin: a fallback claim this old never finishes (plan decision 11).
// outageFailures: a streak this long opens an outage. leadMaxAgeDays: law 1's
// recycled-number backstop. unknownReportHours: how long after its lease an
// unknown row still takes the box's report (the box reports within minutes,
// or on its restart).
const GV_WINDOWS = Object.freeze({
  staleMin: 5,
  leaseMin: 3,
  spacingMin: 10,
  pasteBeforeMin: 30,
  notSeenGraceMin: 2,
  livenessMin: 30,
  claimStaleMin: 2,
  outageFailures: 3,
  leadMaxAgeDays: 180,
  unknownReportHours: 24,
});

// The failed_preclick reasons a box report may carry (law 5); each one means
// no click happened, so the toll-free fallback goes out. no_thread names no
// real outcome since spike check 3 passed (plan decision 8) but stays listed.
const GV_PRECLICK_REASONS = new Set([
  'no_thread', 'wrong_thread', 'invalid_body', 'invalid_number', 'session_expired',
  'challenge', 'cap', 'spacing', 'identity_mismatch', 'timeout', 'ui_error_before_send',
]);

// Pre-click reasons that never count toward the outage streak: the sender is
// healthy, it was told not to post.
const GV_OUTAGE_EXEMPT = new Set(['cap', 'spacing', 'no_thread']);

// The proposal statuses a GV post may go out under (law 8). The same values as
// RESENDABLE in server/utils/comms/actions/proposalResend.js, pinned by a drift
// test: this module never imports that one, which will import the router.
const GV_SENDABLE_STATUSES = Object.freeze(['sent', 'viewed', 'modified', 'accepted']);

const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Kill switch (law 2): only the literal 'true' enables GV posts. */
function gvPostEnabled() {
  return process.env.GV_PROPOSAL_POST_ENABLED === 'true';
}

/** The server's rolling-24h post cap (law 7). 0, blank or nonsense fall back to 25. */
function gvDailyCap() {
  return readEnvInt('GV_POST_DAILY_CAP', 25);
}

/** Collapse every whitespace run (line breaks included) to one space, then trim. */
function normalizeGvBody(body) {
  return String(body ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The body check (law 9). The normalized body must be at most 320 characters
 * and hold exactly one proposal link, `${PUBLIC_SITE_URL}/proposal/<uuid>`,
 * whose uuid is this proposal's token. Every /proposal/<uuid> counts toward
 * "exactly one", whatever its host, since a second link could be another
 * client's. A trailing period after the link is fine (the template has one).
 *
 * @param {string} body
 * @param {string} token - the proposal's share token
 * @returns {{ok:true, body:string} | {ok:false, reason:'too_long'|'no_link'|'wrong_link'|'multiple_links'}}
 */
function validateGvBody(body, token) {
  const normalized = normalizeGvBody(body);
  if (normalized.length > GV_BODY_MAX) return { ok: false, reason: 'too_long' };
  // A fresh RegExp per call: a shared /g regex keeps lastIndex between calls.
  const links = [...normalized.matchAll(new RegExp(`/proposal/(${UUID_SRC})`, 'gi'))];
  if (links.length === 0) return { ok: false, reason: 'no_link' };
  if (links.length > 1) return { ok: false, reason: 'multiple_links' };
  const [match] = links;
  const onPublicHost = normalized.slice(0, match.index).endsWith(PUBLIC_SITE_URL);
  if (!onPublicHost || match[1].toLowerCase() !== String(token || '').toLowerCase()) {
    return { ok: false, reason: 'wrong_link' };
  }
  return { ok: true, body: normalized };
}

module.exports = {
  GV_BODY_MAX,
  GV_WINDOWS,
  GV_PRECLICK_REASONS,
  GV_OUTAGE_EXEMPT,
  GV_SENDABLE_STATUSES,
  gvPostEnabled,
  gvDailyCap,
  normalizeGvBody,
  validateGvBody,
};
