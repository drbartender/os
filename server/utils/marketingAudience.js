const { isPlaceholderEmail } = require('./emailValidation');

/**
 * THE single definition of who may receive marketing.
 *
 * Nothing else in the codebase may restate these conditions. The contact list
 * filters with MAILABLE_SQL, the held-back panel buckets with HELD_BACK_SQL,
 * and the send path re-checks with isMailable — and tests hold all three in
 * agreement over identical database rows. Three hand-written copies is how a
 * suppression rule drifts and someone who asked not to be emailed gets emailed.
 *
 * `communication_preferences` is TRI-STATE. Every existing check in the
 * codebase is `prefs.x === false`, and the column is JSONB NOT NULL with a
 * three-key default, so an absent key means enabled. The SQL therefore tests
 * `IS DISTINCT FROM 'false'` rather than `= 'true'`: a row whose JSONB lacks
 * the key would otherwise be silently excluded.
 *
 * SCOPE: this governs the MARKETING surface. The live gate for the automated
 * lifecycle touches (drip, retention nudge, New Year) is
 * scheduledMessageDispatcher.js, which reads only
 * communication_preferences.marketing_enabled and does NOT yet honor
 * marketing_excluded. Lane mkt-f-compliance owns closing that gap; until it
 * does, an excluded contact is out of campaigns and still gets the automated
 * touches. See ARCHITECTURE.md.
 */

// Alias `c` = clients. Alias `lu` = LEAD_UNSUB_LATERAL, which MUST be joined.
const MAILABLE_SQL = `
  (c.communication_preferences->>'marketing_enabled') IS DISTINCT FROM 'false'
  AND (c.communication_preferences->>'email_enabled') IS DISTINCT FROM 'false'
  AND c.marketing_excluded = false
  AND c.email IS NOT NULL
  AND btrim(c.email) <> ''
  -- btrim before the suffix test, because isPlaceholderEmail trims first
  -- (emailValidation.js:82). Without it 'x@y.invalid ' is mailable in SQL and
  -- held back in JS, exactly the drift the one-predicate rule exists to stop.
  AND lower(btrim(c.email)) NOT LIKE '%.invalid'
  AND COALESCE(c.email_status, '') <> 'bad'
  AND NOT COALESCE(lu.unsubscribed, false)
`;

/**
 * The SQL twin of heldBackReason, with the SAME precedence, returning exactly
 * one bucket per row or NULL when mailable. Aggregates use this instead of
 * restating the conditions, so counts are mutually exclusive by construction,
 * sum to `total - mailable`, and cannot disagree with the chip on the row.
 */
const HELD_BACK_SQL = `
  CASE
    WHEN c.marketing_excluded THEN 'do_not_contact'
    WHEN (c.communication_preferences->>'marketing_enabled') = 'false' THEN 'unsubscribed'
    WHEN (c.communication_preferences->>'email_enabled') = 'false' THEN 'unsubscribed'
    WHEN COALESCE(lu.unsubscribed, false) THEN 'unsubscribed'
    WHEN c.email IS NULL OR btrim(c.email) = '' THEN 'no_address'
    WHEN lower(btrim(c.email)) LIKE '%.invalid' THEN 'no_address'
    WHEN COALESCE(c.email_status, '') = 'bad' THEN 'bounced'
    ELSE NULL
  END
`;

/**
 * Supplies `lu.unsubscribed`. Kept beside MAILABLE_SQL so the two cannot be
 * used apart. 9 of the 16 email_leads rows are also clients, so someone who
 * unsubscribed from the one historical blast must not be re-mailable here.
 */
const LEAD_UNSUB_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT true AS unsubscribed
      FROM email_leads el
     WHERE lower(btrim(el.email)) = lower(btrim(c.email))
       AND el.status = 'unsubscribed'
     LIMIT 1
  ) lu ON true
`;

const HELD_BACK_REASONS = ['do_not_contact', 'unsubscribed', 'bounced', 'no_address'];

/**
 * One normalization for every event-type comparison. The Check Cherry import
 * left two spelling conventions side by side: 33 raw values in prod
 * (2026-08-13) for 23 actual event types. Case alone does not reconcile them,
 * because punctuation survives a naive space-to-dash swap: 'Fundraiser / Gala'
 * becomes 'fundraiser-/-gala' and then fails to match 'fundraiser-gala'.
 * Collapsing every run of non-alphanumerics to a single dash and trimming the
 * ends folds all 33 onto the 23.
 */
const NORM_EVENT_TYPE = `btrim(lower(regexp_replace(p.event_type, '[^a-zA-Z0-9]+', '-', 'g')), '-')`;

/**
 * Event types that count as corporate work, normalized by NORM_EVENT_TYPE.
 */
const CORPORATE_EVENT_TYPES = [
  'corporate-event', 'holiday-party', 'corporate-happy-hour', 'fundraiser-gala',
];

/**
 * Event types that SUPPRESS a corporate suggestion. Deliberately generous: it
 * includes the ambiguous ones (private party, cocktail party) because a missed
 * suggestion costs a click, while a wrong Corporate tag on someone's wedding is
 * the exact false positive this module exists to prevent.
 */
const PERSONAL_EVENT_TYPES = [
  'wedding-reception', 'wedding', 'birthday-party', 'milestone-birthday',
  'baby-shower', 'bridal-shower', 'graduation-party', 'anniversary',
  'cocktail-party', 'private-party', 'engagement-party', 'rehearsal-dinner',
  'bachelor-bachelorette', 'bachelor-bachelorette-party', 'housewarming',
  'celebration-of-life', 'celebration-of-life-memorial', 'derby-party',
  '420-party',
];

/**
 * Types we deliberately refuse to classify, so a test that demands total
 * coverage does not force a coin-flip. 'other', 'cocktail-class' and
 * 'festival-outdoor' are not a person's private event or a company's;
 * 'retirement-party' is genuinely both (an employer throws one as often as a
 * family does), and letting it decide either way would be a guess wearing
 * evidence's clothes. Unclassified means the domain-only path handles it and
 * says out loud that it is guessing.
 */
const UNCLASSIFIED_EVENT_TYPES = [
  'other', 'cocktail-class', 'festival-outdoor', 'retirement-party',
];

const sqlList = (arr) => arr.map(t => `'${t}'`).join(',');

/**
 * Per-client aggregates every audience `where` depends on. Aliases:
 *   c   = clients          agg = native proposals
 *   cc  = Check Cherry ledger   tt = inbound Thumbtack activity
 *   tg  = tags             lc  = last contacted
 *
 * MONEY UNITS DIFFER BY SOURCE. `proposals.amount_paid` is NUMERIC(10,2)
 * DOLLARS; `legacy_cc_proposals.total_cost_cents` is CENTS. Summed naively a
 * $760 Check Cherry booking reads as $76,000 and the entire Check Cherry
 * cohort (176 clients as of 2026-08-13) floats to the top of any spend sort.
 * Divide by 100.0.
 *
 * The Check Cherry join is on EMAIL, not client_id: client_id is populated on
 * only 197 of that table's 1,230 rows.
 */
const CONTACT_AGGREGATES = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)                                                                     AS proposal_count,
      COUNT(*) FILTER (WHERE p.status IN ('deposit_paid','balance_paid','confirmed','completed')) AS paid_count,
      COALESCE(SUM(p.amount_paid) FILTER (
        WHERE p.status IN ('deposit_paid','balance_paid','confirmed','completed')), 0)            AS paid_dollars,
      MIN(p.created_at)                                                            AS first_quoted,
      MAX(p.event_date) FILTER (WHERE p.event_date < CURRENT_DATE
        AND p.status IN ('deposit_paid','balance_paid','confirmed','completed'))                  AS last_finished,
      -- Compared through NORM_EVENT_TYPE, never against the raw column: see
      -- the note on that constant for why case-folding alone is not enough.
      --
      -- corporate_events counts only events actually PAID FOR, because
      -- suggestTag renders it as a BOOKING. Counting quotes here made two
      -- thirds of suggestions assert a booking that never happened.
      COUNT(*) FILTER (WHERE ${NORM_EVENT_TYPE} IN (${sqlList(CORPORATE_EVENT_TYPES)})
        AND p.status IN ('deposit_paid','balance_paid','confirmed','completed'))                   AS corporate_events,
      -- personal_events suppresses a corporate suggestion. Quoted counts here
      -- too, unlike corporate_events: intent alone is enough to suppress.
      COUNT(*) FILTER (WHERE ${NORM_EVENT_TYPE} IN (${sqlList(PERSONAL_EVENT_TYPES)}))             AS personal_events,
      MAX(p.guest_count)                                                           AS largest_guests,
      MAX(p.venue_name)                                                            AS a_venue
    FROM proposals p
    WHERE p.client_id = c.id AND p.status <> 'archived'
  ) agg ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)                                     AS booked_count,
      COALESCE(SUM(l.total_cost_cents), 0) / 100.0 AS paid_dollars,
      -- PAST events only. This ledger runs to 2027-12-04; without the filter a
      -- future-only booking makes someone a "past client" and sorts them first.
      MAX(l.event_date) FILTER (WHERE l.event_date < CURRENT_DATE) AS last_event
    FROM legacy_cc_proposals l
    WHERE l.client_email_normalized = lower(btrim(c.email)) AND l.status = 'booked'
  ) cc ON true
  LEFT JOIN LATERAL (
    -- thumbtack_messages has no client_id, so the path is
    -- thumbtack_leads.client_id -> negotiation_id -> messages, filtered to
    -- from_type='Customer' (the CHECK values are 'Customer' | 'Business').
    SELECT MAX(tm.sent_at) AS last_inbound
      FROM thumbtack_leads tl
      JOIN thumbtack_messages tm ON tm.negotiation_id = tl.negotiation_id
     WHERE tl.client_id = c.id AND tm.from_type = 'Customer'
  ) tt ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(array_agg(ct.tag ORDER BY ct.tag), '{}') AS tags
      FROM client_tags ct WHERE ct.client_id = c.id
  ) tg ON true
  LEFT JOIN LATERAL (
    -- Last contacted. Mirrors contactMessageHistory.js's two phase-1 legs; the
    -- campaign leg joins when email_sends.client_id lands in phase 2. Any
    -- change to the status treatment there must be mirrored here.
    SELECT MAX(t.at) AS last_contacted FROM (
      SELECT ml.created_at AS at FROM message_log ml
       WHERE ml.client_id = c.id AND ml.status NOT IN ('failed', 'bounced')
      UNION ALL
      SELECT sm.sent_at FROM scheduled_messages sm
       WHERE sm.recipient_type = 'client' AND sm.recipient_id = c.id
         AND sm.status = 'sent' AND sm.sent_at IS NOT NULL
    ) t
  ) lc ON true
`;

// "Has paid us" must accept a Check Cherry ledger booking, not only a native
// proposal. Gating on agg.paid_count alone silently excludes 169 people (measured
// 2026-08-13), the largest cohort in the business, from every past-client audience.
const HAS_PAID = `(agg.paid_count > 0 OR cc.booked_count > 0)`;

// cc.last_event is already filtered to the past inside CONTACT_AGGREGATES.
const LAST_EVENT = `GREATEST(COALESCE(agg.last_finished, '-infinity'::date),
                             COALESCE(cc.last_event, '-infinity'::date))`;

/**
 * The seven audiences from the approved design. Each is a saved RULE,
 * re-resolved every time, never a frozen list of people.
 *
 * Event type is deliberately absent from every rule: legacy_cc_proposals
 * .event_type is NULL on all 1,230 rows and package_name describes the bar
 * package, not the occasion, so an event-type rule would silently drop the
 * entire Check Cherry cohort.
 */
const AUDIENCES = [
  {
    id: 'past-corporate',
    name: 'Past clients · corporate',
    rule: 'Paid us · tagged Corporate',
    includes: ['Has paid us', 'Tagged Corporate', 'Event finished'],
    where: `${HAS_PAID} AND ${LAST_EVENT} > '-infinity'::date AND 'corporate' = ANY(tg.tags)`,
  },
  {
    id: 'past-all',
    name: 'Past clients · everyone',
    rule: 'Paid us · event finished',
    includes: ['Has paid us', 'Event finished'],
    where: `${HAS_PAID} AND ${LAST_EVENT} > '-infinity'::date`,
  },
  {
    id: 'one-year-on',
    name: 'One year on',
    rule: 'Last event 11 to 13 months ago',
    includes: ['Event finished 11 to 13 months ago'],
    where: `${LAST_EVENT} BETWEEN (CURRENT_DATE - INTERVAL '13 months')
                              AND (CURRENT_DATE - INTERVAL '11 months')`,
  },
  {
    id: 'cold-quotes-spring',
    name: 'Cold quotes · spring',
    rule: 'Quoted March to June, never booked',
    includes: ['Has a proposal', 'Never paid', 'Quoted March to June'],
    where: `agg.proposal_count > 0 AND NOT ${HAS_PAID}
            AND EXTRACT(MONTH FROM agg.first_quoted) BETWEEN 3 AND 6`,
  },
  {
    id: 'quoted-never-booked',
    name: 'Quoted, never booked',
    rule: 'Has a proposal · never paid',
    includes: ['Has a proposal', 'Never paid'],
    where: `agg.proposal_count > 0 AND NOT ${HAS_PAID}`,
  },
  {
    id: 'thumbtack-live',
    name: 'Thumbtack · in conversation',
    rule: 'Thumbtack lead · replied in the last 14 days',
    includes: ['Thumbtack lead', 'Replied in 14 days'],
    where: `tt.last_inbound >= (NOW() - INTERVAL '14 days')`,
  },
  {
    id: 'never-classified',
    name: 'Never classified',
    rule: 'No marketing tag set by a human',
    includes: ['No human-set tag'],
    where: `COALESCE(array_length(tg.tags, 1), 0) = 0`,
  },
];

const AUDIENCE_BY_ID = new Map(AUDIENCES.map(a => [a.id, a]));

/**
 * Why a contact is held back, or null when mailable. Covers all seven
 * conditions. isMailable is defined in terms of this so the two can never
 * disagree. Precedence is deliberate and mirrors HELD_BACK_SQL exactly: the
 * house rule outranks an unsubscribe (it is the more actionable fact for an
 * operator), and a missing address outranks a bad status.
 */
function heldBackReason(row) {
  if (!row) return 'no_address';
  if (row.marketing_excluded === true) return 'do_not_contact';
  const prefs = row.communication_preferences || {};
  if (prefs.marketing_enabled === false) return 'unsubscribed';
  if (prefs.email_enabled === false) return 'unsubscribed';
  if (row.lead_unsubscribed === true) return 'unsubscribed';
  const email = typeof row.email === 'string' ? row.email.trim() : '';
  if (!email) return 'no_address';
  if (isPlaceholderEmail(email)) return 'no_address';
  if (row.email_status === 'bad') return 'bounced';
  return null;
}

function isMailable(row) {
  return heldBackReason(row) === null;
}

module.exports = {
  MAILABLE_SQL,
  HELD_BACK_SQL,
  LEAD_UNSUB_LATERAL,
  CONTACT_AGGREGATES,
  NORM_EVENT_TYPE,
  CORPORATE_EVENT_TYPES,
  PERSONAL_EVENT_TYPES,
  UNCLASSIFIED_EVENT_TYPES,
  HELD_BACK_REASONS,
  AUDIENCES,
  AUDIENCE_BY_ID,
  HAS_PAID,
  LAST_EVENT,
  isMailable,
  heldBackReason,
};
