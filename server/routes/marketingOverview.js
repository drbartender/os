/**
 * The Overview and Sent surfaces.
 *
 * Overview answers "what should I do today". It leads with moments, then puts
 * the real numbers on the wall, then a work queue of things only a human can
 * decide. The numbers are deliberately unflattering: "past clients never asked
 * back" is the whole reason this section exists, and a dashboard that hid it
 * behind a vanity metric would be worse than no dashboard.
 */

const express = require('express');
const { pool } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const {
  MAILABLE_SQL, HELD_BACK_SQL, LEAD_UNSUB_LATERAL, CONTACT_AGGREGATES,
  AUDIENCE_BY_ID, HAS_PAID, NORM_EVENT_TYPE, CORPORATE_EVENT_TYPES, PAID_STATUS_IN,
} = require('../utils/marketingAudience');

// Built from the shared list so the two can never disagree. Values are module
// constants, never user input.
const CORPORATE_IN = CORPORATE_EVENT_TYPES.map(t => `'${t}'`).join(',');
const {
  MOMENT_BY_ID, EDITABLE_FIELDS, DAILY_SEND_CAP, AUTOMATIONS, resolveMoments, isLive, needsSetup,
} = require('../utils/marketingMoments');
const { logAdminAction } = require('../utils/adminAuditLog');

const router = express.Router();

const MAX_FIELD_LENGTH = 2000;

/** Emailable headcount for an audience id, or 0 for an unknown one. */
async function audienceCount(audienceId) {
  const a = AUDIENCE_BY_ID.get(audienceId);
  if (!a) return 0;
  const { rows } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE ${MAILABLE_SQL})::int AS n
      FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES}
     WHERE ${a.where}
  `);
  return rows[0].n;
}

/**
 * GET /api/marketing/overview
 */
router.get('/overview', auth, adminOnly, asyncHandler(async (_req, res) => {
  const now = new Date();
  const moments = await resolveMoments(now, audienceCount);

  // "The year, honestly." One round trip; every number is a plain count over a
  // local table, so nothing here can drift from what the other tabs show.
  const { rows: [numbers] } = await pool.query(`
    SELECT
      -- Every marketing email ever actually delivered, lead-side and
      -- client-side. 'queued' and 'failed' never left, so they are not sends.
      (SELECT COUNT(*)::int FROM email_sends
        WHERE sent_at IS NOT NULL
          AND COALESCE(status,'') NOT IN ('queued','failed'))                AS emails_sent_all_time,

      -- Past clients who have never been asked back. The uncomfortable one,
      -- and the reason this section exists.
      (SELECT COUNT(*)::int
         FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES}
        WHERE ${HAS_PAID}
          AND NOT EXISTS (
            SELECT 1 FROM email_sends es
             WHERE es.client_id = c.id AND es.campaign_id IS NOT NULL
               AND es.sent_at IS NOT NULL
               AND COALESCE(es.status,'') NOT IN ('queued','failed')))       AS past_clients_never_asked_back,

      -- Repeat corporate bookings: a client with more than one PAID corporate
      -- event. Historically zero, which is the thesis this whole feature bets
      -- against, so it is shown rather than buried.
      (SELECT COUNT(*)::int FROM (
         SELECT p.client_id
           FROM proposals p
          WHERE p.status IN (${PAID_STATUS_IN})
            -- IMPORTED, not restated. marketingAudience.js's header says nothing
            -- else in the codebase may restate these conditions, and a dashboard
            -- number that silently diverged from every audience when the
            -- corporate list changed is exactly the drift it warns about.
            AND ${NORM_EVENT_TYPE} IN (${CORPORATE_IN})
            -- proposals.client_id is nullable (ON DELETE SET NULL). Without
            -- this, every orphaned proposal lands in ONE null group, and two
            -- of them read as a phantom repeat booking — poisoning the single
            -- metric whose whole thesis is that it has always been zero.
            AND p.client_id IS NOT NULL
          GROUP BY p.client_id HAVING COUNT(*) > 1
       ) r)                                                                   AS repeat_corporate_bookings
  `);

  // "Needs you": only things a human has to decide. Nothing here is automatable,
  // which is the entry criterion — a queue that fills with machine-fixable rows
  // trains people to ignore it.
  //
  // Bucketed with HELD_BACK_SQL, the SAME precedence-ordered CASE the base
  // breakdown below and the contacts screen use. Restating the conditions here
  // put two different "bounced" numbers on one page: a client who is both
  // do-not-contact and hard-bounced counted in this queue's bounced line AND in
  // the breakdown's do-not-contact line. It also gets the work-queue semantics
  // right — somebody already marked do-not-contact is a decision already made,
  // so they do not need you again for having also bounced.
  const { rows: [needs] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(array_length(tg.tags,1),0) = 0)::int        AS never_classified,
      COUNT(*) FILTER (WHERE ${HELD_BACK_SQL} = 'do_not_contact')::int           AS do_not_contact,
      COUNT(*) FILTER (WHERE ${HELD_BACK_SQL} = 'bounced')::int                  AS bounced
      FROM clients c
      ${LEAD_UNSUB_LATERAL}
      LEFT JOIN LATERAL (
        SELECT COALESCE(array_agg(ct.tag), '{}') AS tags
          FROM client_tags ct WHERE ct.client_id = c.id
      ) tg ON true
  `);

  // The reachable base, bucketed by the same CASE the contacts screen uses, so
  // the two surfaces cannot disagree about who is held back or why.
  const { rows: [base] } = await pool.query(`
    SELECT COUNT(*)::int                                          AS total,
           COUNT(*) FILTER (WHERE ${MAILABLE_SQL})::int           AS mailable,
           COUNT(*) FILTER (WHERE ${HELD_BACK_SQL} = 'do_not_contact')::int AS do_not_contact,
           COUNT(*) FILTER (WHERE ${HELD_BACK_SQL} = 'unsubscribed')::int   AS unsubscribed,
           COUNT(*) FILTER (WHERE ${HELD_BACK_SQL} = 'bounced')::int        AS bounced,
           COUNT(*) FILTER (WHERE ${HELD_BACK_SQL} = 'no_address')::int     AS no_address
      FROM clients c ${LEAD_UNSUB_LATERAL}
  `);

  // Today's send budget, since local midnight in Chicago.
  //
  // HONEST SCOPE: this counts CAMPAIGN sends (email_sends) only. Resend's daily
  // allowance is consumed by every email the system sends — proposals,
  // invoices, the lifecycle touches — none of which write here, so "remaining"
  // is an upper bound on a busy transactional day, not a guarantee. The failure
  // mode is graceful: the send path treats a quota 429 as a resumable stop, so
  // the worst case is a run that pauses, not one that loses recipients.
  const { rows: [budget] } = await pool.query(`
    SELECT COUNT(*)::int AS used
      FROM email_sends
     WHERE sent_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Chicago')
                        AT TIME ZONE 'America/Chicago'
       AND COALESCE(status,'') NOT IN ('queued','failed')
  `);

  res.json({
    today: now.toISOString(),
    moments,
    open_moment_count: moments.filter(isLive).length,
    // Deliberately a SEPARATE number rather than folded into the one above.
    // open_moment_count means "sendable now" and the header, the badge and the
    // optimistic dismiss all lean on that meaning; widening it in place would
    // have changed all three silently. This one means "open, but its audience is
    // empty, so it needs a person" — the state that used to render as nothing.
    moments_needing_setup: moments.filter(needsSetup).length,
    numbers,
    needs_you: needs,
    base,
    automations: AUTOMATIONS,
    send_budget: {
      cap: DAILY_SEND_CAP,
      used: budget.used,
      remaining: Math.max(0, DAILY_SEND_CAP - budget.used),
    },
  });
}));

/**
 * PUT /api/marketing/moments/:id — rewrite a moment's copy.
 *
 * Accepts only the three authored fields. The rule, the audience and the window
 * logic are code and are not editable here: a moment whose rule drifted from
 * its prose would put authored reasoning in front of the wrong people.
 *
 * Sending null for a field CLEARS the override, so the field goes back to
 * tracking the authored default rather than being stuck at whatever it was
 * rewritten to once.
 */
router.put('/moments/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const def = MOMENT_BY_ID.get(req.params.id);
  if (!def) throw new NotFoundError('Unknown moment.');

  const body = req.body || {};
  const present = EDITABLE_FIELDS.filter(f => f in body);
  if (present.length === 0) {
    throw new ValidationError({ fields: `Send at least one of: ${EDITABLE_FIELDS.join(', ')}.` });
  }
  const unknown = Object.keys(body).filter(k => !EDITABLE_FIELDS.includes(k));
  if (unknown.length) {
    throw new ValidationError({
      fields: `Only the words are editable. A moment's rule and window are code, not data. Rejected: ${unknown.join(', ')}.`,
    });
  }

  // VALIDATE EVERY FIELD FIRST, then write. These ran in one loop, so
  // {title: 'ok', why: <too long>} persisted the title and still returned 400 —
  // a response saying "rejected" over a database that had accepted half of it.
  for (const field of present) {
    const raw = body[field];
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) continue;
    if (typeof raw !== 'string') throw new ValidationError({ [field]: 'Must be text.' });
    if (raw.trim().length > MAX_FIELD_LENGTH) {
      throw new ValidationError({ [field]: `Keep it under ${MAX_FIELD_LENGTH} characters.` });
    }
  }

  for (const field of present) {
    const raw = body[field];
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      // Clear: back to the authored default.
      await pool.query(
        'DELETE FROM marketing_moment_overrides WHERE moment_id = $1 AND field = $2',
        [def.id, field]
      );
      continue;
    }
    const value = raw.trim();   // already validated above
    await pool.query(`
      INSERT INTO marketing_moment_overrides (moment_id, field, value, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (moment_id, field)
      DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `, [def.id, field, value, req.user.id]);
  }

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: 'marketing.moment.edited',
    metadata: { moment_id: def.id, fields: present },
  });

  const moments = await resolveMoments(new Date(), audienceCount);
  res.json(moments.find(m => m.id === def.id));
}));

/**
 * POST /api/marketing/moments/:id/dismiss — clear THIS occurrence only.
 * DELETE the same path brings it back.
 */
router.post('/moments/:id/dismiss', auth, adminOnly, asyncHandler(async (req, res) => {
  const def = MOMENT_BY_ID.get(req.params.id);
  if (!def) throw new NotFoundError('Unknown moment.');
  const key = def.occurrenceKey(new Date());

  await pool.query(`
    INSERT INTO marketing_moment_dismissals (moment_id, occurrence_key, dismissed_by)
    VALUES ($1, $2, $3) ON CONFLICT (moment_id, occurrence_key) DO NOTHING
  `, [def.id, key, req.user.id]);

  res.json({ moment_id: def.id, occurrence_key: key, dismissed: true });
}));

router.delete('/moments/:id/dismiss', auth, adminOnly, asyncHandler(async (req, res) => {
  const def = MOMENT_BY_ID.get(req.params.id);
  if (!def) throw new NotFoundError('Unknown moment.');
  const key = def.occurrenceKey(new Date());
  await pool.query(
    'DELETE FROM marketing_moment_dismissals WHERE moment_id = $1 AND occurrence_key = $2',
    [def.id, key]
  );
  res.json({ moment_id: def.id, occurrence_key: key, dismissed: false });
}));

/**
 * GET /api/marketing/sent — what went out, and what it produced.
 *
 * BOOKED ATTRIBUTION is the number this table exists for, and it is the one
 * most easily overstated. Definition: a recipient created a proposal within 30
 * days of receiving that campaign, attributed by client id. Counted DISTINCT
 * per client, so one person who sent three quotes is one booking, not three.
 * Both sides are local tables, so nothing here depends on Resend.
 */
router.get('/sent', auth, adminOnly, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      ec.id, ec.name, ec.subject, ec.status, ec.sent_at,
      COUNT(es.id) FILTER (
        WHERE es.sent_at IS NOT NULL
          AND COALESCE(es.status,'') NOT IN ('queued','failed'))::int        AS sent,
      COUNT(es.id) FILTER (WHERE es.opened_at IS NOT NULL)::int              AS opened,
      COUNT(es.id) FILTER (WHERE es.clicked_at IS NOT NULL)::int             AS clicked,
      -- The SAME send guard the sent column applies. A failed row carries a
      -- real sent_at (the claim INSERT lets the column default to NOW() and the
      -- failure UPDATE leaves it), so without this a send that never left could
      -- take credit for a booking — on the one number this tab exists to state
      -- honestly.
      COUNT(DISTINCT es.client_id) FILTER (
        WHERE es.sent_at IS NOT NULL
          AND COALESCE(es.status,'') NOT IN ('queued','failed')
          AND EXISTS (
            SELECT 1 FROM proposals p
             WHERE p.client_id = es.client_id
               AND p.created_at >= es.sent_at
               AND p.created_at <  es.sent_at + INTERVAL '30 days'
          ))::int                                                            AS booked
      FROM email_campaigns ec
      LEFT JOIN email_sends es ON es.campaign_id = ec.id
     WHERE ec.type = 'blast'
       AND ec.status IN ('sent','sending')
     GROUP BY ec.id
     ORDER BY ec.sent_at DESC NULLS LAST
     LIMIT 100
  `);

  res.json({
    campaigns: rows,
    // Read-only here. Named so the Sent tab accounts for EVERY email a contact
    // receives from us, not just the ones sent from this screen: an operator
    // deciding whether to reach out needs the whole picture, and these are
    // managed in Settings.
    automations: AUTOMATIONS,
  });
}));

module.exports = router;
