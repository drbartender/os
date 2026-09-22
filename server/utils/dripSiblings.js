/**
 * Cross-proposal ownership of the unsigned-proposal drip: one drip per client
 * per EVENT.
 *
 * Why this exists (Jan Carabelli, 2026-09-19): a hosted quote came in from the
 * website wizard and enrolled the six-touch drip; twelve minutes later a BYOB
 * option was sent solo for the same October 17 event and enrolled its own.
 * The dispatcher's idempotency key is per proposal, and the 24h per-channel
 * cooldown only DEFERS a collision by a day, so she got "Did you get the
 * proposal?" twice, the second one hours after she had replied. Ten clients
 * hit the same shape between June and September.
 *
 * Two rules, both keyed on (client_id, event_date):
 *
 *  - hasLiveSiblingDrip: a second option sent while an OPEN sibling's drip is
 *    still in flight joins that conversation instead of starting another (the
 *    caller skips enrollment). "In flight" is pending / processing / deferred
 *    only. Delivered rows do not count, so a revised quote sent after the
 *    sequence finished is a fresh conversation. Only sent/viewed/modified
 *    siblings count: a booked sibling's drip is moot whatever state its rows
 *    are in. Spec 7.10's "new drip per proposal" is about a second EVENT: a
 *    different event_date never matches, so a repeat customer still gets
 *    their own drip. A NULL event_date never matches either, so undated
 *    proposals keep the old per-proposal behavior. event_date is compared in
 *    SQL (no JS Date round trip through a DATE column).
 *
 *  - handOffDripToSibling: when the option that OWNS the drip is archived,
 *    the touches it had not delivered are RE-CREATED on the surviving open
 *    option, on the archived option's original timeline, so the client keeps
 *    the nurture without a repeat of anything already sent. Re-created, not
 *    moved: three of the four archive doors (the admin archive endpoint, the
 *    booking cancel, the stale sweep) DELETE the archived proposal's pending
 *    rows inside their transaction and only reach this helper afterwards, so
 *    there may be nothing left to move. The delivered set survives (sent rows
 *    are never deleted) and the anchor is derived from any remaining row, or
 *    from sent_at / created_at when none remain. A survivor is a
 *    sent/viewed/modified sibling that has never been nurtured for this event
 *    (no drip row pending, processing, deferred, or sent): a booked sibling
 *    never inherits, a sibling that already ran its own sequence never gets
 *    it twice, and the compare-group loser archives run after the winner is
 *    paid, so they find no survivor. Inserts use the same natural-key
 *    ON CONFLICT as scheduleMessage.
 *
 * Not addressed: two solo sends for the same client + date that overlap in
 * flight can both pass hasLiveSiblingDrip (read-then-write). Advisory locks
 * are a no-op through the Neon pooler and the action is human-driven; the
 * cooldown still spaces the two touches a day apart.
 */
const { pool } = require('../db');

/** The six touches of spec 1.3, offsets from the moment of send. */
const DRIP_TOUCHES = [
  { messageType: 'drip_touch_1',       channel: 'sms',   offsetDays: 1 },
  { messageType: 'drip_touch_2',       channel: 'email', offsetDays: 7 },
  { messageType: 'drip_touch_3',       channel: 'sms',   offsetDays: 10 },
  { messageType: 'drip_touch_4',       channel: 'email', offsetDays: 14 },
  { messageType: 'drip_touch_5_email', channel: 'email', offsetDays: 21 },
  { messageType: 'drip_touch_5_sms',   channel: 'sms',   offsetDays: 21 },
];
const DAY_MS = 86400000;
const OPEN_STATUSES = "('sent', 'viewed', 'modified')";
const IN_FLIGHT = "('pending', 'processing', 'deferred')";

async function hasLiveSiblingDrip(proposalId) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM proposals me
       JOIN proposals sib
         ON sib.client_id = me.client_id
        AND sib.id <> me.id
        AND sib.event_date = me.event_date
        AND sib.status IN ${OPEN_STATUSES}
       JOIN scheduled_messages sm
         ON sm.entity_type = 'proposal'
        AND sm.entity_id = sib.id
        AND sm.message_type LIKE 'drip_touch_%'
        AND sm.status IN ${IN_FLIGHT}
      WHERE me.id = $1
      LIMIT 1`,
    [proposalId]
  );
  return rows.length > 0;
}

/**
 * @returns {Promise<{survivorId:number, created:number}|null>} null when there
 * is no eligible survivor; the caller's suppress then runs exactly as before.
 */
async function handOffDripToSibling(archivedProposalId) {
  const { rows } = await pool.query(
    `SELECT sib.id AS survivor_id, me.client_id,
            COALESCE(me.sent_at, me.created_at) AS fallback_anchor
       FROM proposals me
       JOIN proposals sib
         ON sib.client_id = me.client_id
        AND sib.id <> me.id
        AND sib.event_date = me.event_date
        AND sib.status IN ${OPEN_STATUSES}
      WHERE me.id = $1
        AND me.status = 'archived'
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_messages x
           WHERE x.entity_type = 'proposal'
             AND x.entity_id = sib.id
             AND x.message_type LIKE 'drip_touch_%'
             AND x.status IN ('pending', 'processing', 'deferred', 'sent'))
      ORDER BY sib.sent_at DESC NULLS LAST, sib.created_at DESC
      LIMIT 1`,
    [archivedProposalId]
  );
  const s = rows[0];
  if (!s) return null;

  // What the archived option already delivered, and its original anchor.
  const hist = await pool.query(
    `SELECT message_type, status, scheduled_for
       FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND message_type LIKE 'drip_touch_%'`,
    [archivedProposalId]
  );
  const delivered = new Set(
    hist.rows.filter((r) => r.status === 'sent' || r.status === 'processing').map((r) => r.message_type)
  );
  // min(scheduled_for - offset) over the rows that remain: an un-deferred row
  // yields the true anchor, a deferred one yields anchor + 24h, so min wins.
  let anchorMs = Infinity;
  for (const r of hist.rows) {
    const t = DRIP_TOUCHES.find((x) => x.messageType === r.message_type);
    if (!t) continue;
    anchorMs = Math.min(anchorMs, new Date(r.scheduled_for).getTime() - t.offsetDays * DAY_MS);
  }
  if (!Number.isFinite(anchorMs)) anchorMs = new Date(s.fallback_anchor).getTime();

  let created = 0;
  for (const t of DRIP_TOUCHES) {
    if (delivered.has(t.messageType)) continue;
    const r = await pool.query(
      `INSERT INTO scheduled_messages
         (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, payload)
       VALUES ($1, 'proposal', $2, 'client', $3, $4, $5, jsonb_build_object('handed_off_from', $6::int))
       ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
         WHERE status = 'pending'
       DO NOTHING
       RETURNING id`,
      [s.survivor_id, t.messageType, s.client_id, t.channel, new Date(anchorMs + t.offsetDays * DAY_MS), archivedProposalId]
    );
    created += r.rowCount;
  }
  // Whatever the archived option still holds in flight is now the survivor's.
  await pool.query(
    `UPDATE scheduled_messages
        SET status = 'suppressed', error_message = $2
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND message_type LIKE 'drip_touch_%'
        AND status IN ('pending', 'deferred')`,
    [archivedProposalId, `handed off to proposal ${s.survivor_id} on archive`]
  );
  return { survivorId: s.survivor_id, created };
}

module.exports = { DRIP_TOUCHES, hasLiveSiblingDrip, handOffDripToSibling };
