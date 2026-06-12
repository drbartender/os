/**
 * broadcastCoverRequest — fans a cover-needed broadcast out to every qualified
 * teammate when a staffer flips their approved shift_request into the cover-
 * requested state (spec §6.5).
 *
 * NOT a transaction. The caller (POST /requests/:id/request-cover) MUST have
 * already committed the cover_requested_at flip; otherwise a teammate's
 * concurrent claim could land before the broadcast and the row's
 * cover_requested_at would still be NULL.
 *
 * Qualification filter:
 *   - role staff with onboarding_status = 'approved'
 *   - position matches the shift's positions_needed
 *   - NOT the requester
 *   - NOT muted (staff_notification_preferences.channels.cover_needed != [])
 *   - NOT already on a same-date approved-AND-not-dropped shift (event_date eq)
 *
 * Capacity:
 *   - 500-cap with LIMIT 501 to detect truncation (broadcast_truncated flag).
 *   - chunked enqueue at 25 rows / batch with a 250ms application delay between
 *     batches; the DB itself never sees a 500-row burst.
 *
 * positions_needed tolerance:
 *   - The column carries one of three shapes across legacy + current rows
 *     (string scalar 'bartender', array of strings ['bartender','barback'], or
 *     array of objects [{position:'bartender'}, ...]). Defaults to ['bartender']
 *     if the JSON is missing or unparseable.
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { enqueueCategorizedMessage } = require('./messageScheduling');
const { STAFF_URL } = require('./urls');

const MAX_TARGETS = 500;
const PROBE_LIMIT = MAX_TARGETS + 1; // SELECT one extra so we can detect truncation
const CHUNK_SIZE = 25;
const CHUNK_DELAY_MS = 250;

/**
 * Parse a `shifts.positions_needed` JSON column into a flat array of position
 * strings. Tolerant: a missing column or invalid JSON returns the default
 * ['bartender']; an empty array (intentionally unstaffed) returns []. Caller
 * passes the result into a `= ANY($::text[])` SQL predicate.
 */
function parsePositionsNeeded(raw) {
  if (raw === null || raw === undefined || raw === '') return ['bartender'];
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // Bare string (legacy 'bartender'); treat as a single-position array.
      return [String(raw)];
    }
  }
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return ['bartender'];
  const out = [];
  for (const entry of value) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === 'string') {
      out.push(entry);
    } else if (typeof entry === 'object' && typeof entry.position === 'string') {
      out.push(entry.position);
    }
  }
  return out;
}

/**
 * Format an event_date for the cover SMS body — short, GSM-7 friendly.
 * Example: "Sat, May 30". Treats the input as a calendar date string so the
 * pg Date object (built at local midnight) doesn't shift on positive-offset
 * machines. Falls through to 'soon' on parse failure.
 */
function formatShortDate(value) {
  if (value === null || value === undefined || value === '') return 'soon';
  let ymd;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return 'soon';
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    ymd = `${y}-${m}-${d}`;
  } else {
    ymd = String(value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return 'soon';
  }
  // Anchor at noon UTC so the local-day rollover never bumps the formatted day.
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'soon';
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Broadcast a cover request to qualified teammates.
 *
 * @param {number} shiftId               the shifts.id whose cover is being requested
 * @param {number} requestingUserId      users.id of the requester (excluded from broadcast)
 * @returns {Promise<{broadcast_count:number, broadcast_truncated:boolean}>}
 */
async function broadcastCoverRequest(shiftId, requestingUserId) {
  if (!Number.isInteger(shiftId) || !Number.isInteger(requestingUserId)) {
    throw new Error('broadcastCoverRequest: shiftId and requestingUserId must be integers');
  }

  // Step 1: read shift context (no row lock; the cover-request endpoint already
  // committed the flip).
  const { rows: shiftRows } = await pool.query(
    `SELECT s.id AS shift_id, s.positions_needed, s.event_date,
            COALESCE(c.name, s.client_name) AS client_name,
            p.id AS proposal_id
       FROM shifts s
       LEFT JOIN proposals p ON p.id = s.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE s.id = $1`,
    [shiftId]
  );
  if (shiftRows.length === 0) {
    return { broadcast_count: 0, broadcast_truncated: false };
  }
  const shift = shiftRows[0];
  const positionsNeeded = parsePositionsNeeded(shift.positions_needed);

  // Defensive: a shift with no positions yields no broadcast.
  if (positionsNeeded.length === 0) {
    return { broadcast_count: 0, broadcast_truncated: false };
  }

  // Step 2: qualified teammate set.
  // - same position (positions_needed array)
  // - not the requester
  // - not muted for cover_needed (channels list non-empty)
  // - not already booked on the same event_date (approved + not dropped)
  // Sorted by user_id ASC for deterministic chunk ordering across runs.
  const { rows: teammates } = await pool.query(
    `SELECT u.id
       FROM users u
       JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.role IN ('staff', 'manager')
        AND u.onboarding_status = 'approved'
        AND u.id <> $1
        AND cp.position = ANY($2::text[])
        AND (
          u.staff_notification_preferences IS NULL
          OR (u.staff_notification_preferences->'channels'->'cover_needed') IS NULL
          OR (u.staff_notification_preferences->'channels'->'cover_needed') <> '[]'::jsonb
        )
        AND NOT EXISTS (
          SELECT 1
            FROM shift_requests sr
            JOIN shifts s2 ON s2.id = sr.shift_id
           WHERE sr.user_id = u.id
             AND sr.status = 'approved'
             AND sr.dropped_at IS NULL
             AND s2.event_date = $3
        )
      ORDER BY u.id ASC
      LIMIT ${PROBE_LIMIT}`,
    [requestingUserId, positionsNeeded, shift.event_date]
  );

  const truncated = teammates.length > MAX_TARGETS;
  const targets = teammates.slice(0, MAX_TARGETS);

  if (targets.length === 0) {
    return { broadcast_count: 0, broadcast_truncated: truncated };
  }

  // Step 3: requester display initial. We use a single initial when no last
  // name is known — better than rendering "undefined." in the SMS preview.
  const { rows: requesterRows } = await pool.query(
    `SELECT cp.preferred_name
       FROM contractor_profiles cp
      WHERE cp.user_id = $1`,
    [requestingUserId]
  );
  const requesterName = (requesterRows[0]?.preferred_name || '').trim();
  const requesterParts = requesterName.split(/\s+/).filter(Boolean);
  const firstI = requesterParts[0]?.[0]?.toUpperCase() || '?';
  const lastI = requesterParts.length > 1 ? requesterParts[requesterParts.length - 1][0].toUpperCase() : '';
  const initials = lastI ? `${firstI}.${lastI}.` : `${firstI}.`;

  const dateShort = formatShortDate(shift.event_date);
  const role = positionsNeeded[0] || 'bartender';
  const shiftUrl = `${STAFF_URL}/shifts/${shift.shift_id}`;
  const clientName = shift.client_name || 'a client';

  // Step 4: chunk enqueue (25 rows per batch, 250ms application-level delay
  // between batches). enqueueCategorizedMessage does its own per-channel
  // fanout via the resolver; one call per recipient.
  const now = new Date();
  let totalEnqueued = 0;
  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const chunk = targets.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(chunk.map((t) => enqueueCategorizedMessage({
      userId: t.id,
      category: 'cover_needed',
      payload: {
        title: 'Cover needed',
        body: `${initials} needs a cover on ${dateShort}`,
        url: shiftUrl,
        sms_template: 'cover_broadcast_sms',
        sms_args: {
          first_initial_last_initial: initials,
          client_name: clientName,
          event_date_short: dateShort,
          shift_role: role,
          shift_url: shiftUrl,
        },
      },
      sendAt: now,
      entityType: 'shift',
      entityId: shift.shift_id,
      messageType: 'cover_broadcast',
    }).catch((err) => {
      // Per-recipient enqueue failure must not abort the broadcast — log and
      // continue. Pattern mirrors adminNotifications.js' per-recipient try/catch.
      Sentry.captureException(err, {
        tags: { feature: 'cover-broadcast', entity: 'shift' },
        extra: { shift_id: shift.shift_id, user_id: t.id },
      });
      console.error(`[coverBroadcast] enqueue failed for user ${t.id}:`, err.message);
      return null;
    })));
    totalEnqueued += results.filter(Boolean).length;
    if (i + CHUNK_SIZE < targets.length) {
      await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    }
  }

  return { broadcast_count: totalEnqueued, broadcast_truncated: truncated };
}

module.exports = {
  broadcastCoverRequest,
  // Exported for tests.
  parsePositionsNeeded,
  formatShortDate,
};
