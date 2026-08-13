const express = require('express');
const { pool } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { MARKETING_TAGS, isValidTag, DO_NOT_CONTACT_ID } = require('../utils/marketingTags');
const { logAdminAction } = require('../utils/adminAuditLog');
const {
  MAILABLE_SQL, HELD_BACK_SQL, LEAD_UNSUB_LATERAL, CONTACT_AGGREGATES,
  LAST_EVENT, AUDIENCES, AUDIENCE_BY_ID, heldBackReason,
} = require('../utils/marketingAudience');
const { suggestTag } = require('../utils/marketingSuggestions');
const { getContactMessageHistory } = require('../utils/contactMessageHistory');

const router = express.Router();

// adminOnly throughout, deliberately tighter than emailMarketing.js's
// requireAdminOrManager. These routes write the marketing classification and
// (from the read routes) expose names, emails, and lifetime spend across the
// whole client base, so a manager should not reach them.

const TAG_ORDER = MARKETING_TAGS.map(t => t.id);
const sortTags = (tags) => [...tags].sort((a, b) => TAG_ORDER.indexOf(a) - TAG_ORDER.indexOf(b));

const MAX_REASON_LENGTH = 500;

/**
 * `Number.isInteger(parseInt('3000000000', 10))` is true, but the value is out
 * of int4 range, so it reaches an integer column and raises 22003 -> generic
 * 500 + Sentry noise. Same class as the repo's UUID-token-guard convention.
 */
function parseClientId(raw) {
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
    throw new ValidationError({ id: 'Invalid contact id.' });
  }
  return id;
}

/**
 * PUT /api/marketing/contacts/:id/tags
 * Body: { tags: string[] } — the FULL desired set, not a delta.
 */
router.put('/contacts/:id/tags', auth, adminOnly, asyncHandler(async (req, res) => {
  const clientId = parseClientId(req.params.id);

  const { tags } = req.body || {};
  if (!Array.isArray(tags)) throw new ValidationError({ tags: 'tags must be an array of tag ids.' });

  const unique = [...new Set(tags)];
  const bad = unique.filter(t => !isValidTag(t));
  if (bad.length > 0) {
    // 'do-not-contact' lands here on purpose: it is backed by clients columns,
    // needs a reason, and has its own endpoint, so it must never reach
    // client_tags. The DB CHECK rejects it too, as a backstop.
    //
    // Bounded echo: the raw value is caller-controlled and could be a megabyte,
    // which would land in the response body and in any log capturing 4xx.
    const shown = bad.slice(0, 5).map(t => String(t).slice(0, 40)).join(', ');
    throw new ValidationError({ tags: `Unknown tag(s): ${shown}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE, not a bare existence check: this is replace-the-set, so two
    // admins saving different sets for the same contact at once can interleave
    // delete-then-insert and land on the UNION of both — a set neither of them
    // asked for. Locking the contact row serializes tag edits per contact.
    const exists = await client.query('SELECT 1 FROM clients WHERE id = $1 FOR UPDATE', [clientId]);
    if (exists.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Contact not found.');
    }
    // Replace-the-set semantics: the UI sends the full desired set, so removal
    // is expressed by omission. `tag <> ALL('{}')` is TRUE for every row, so an
    // empty array correctly clears everything. Deleting only the difference
    // would leave a concurrent edit's tag behind.
    await client.query(
      'DELETE FROM client_tags WHERE client_id = $1 AND tag <> ALL($2::text[])',
      [clientId, unique]
    );
    if (unique.length > 0) {
      await client.query(
        `INSERT INTO client_tags (client_id, tag, set_by)
         SELECT $1, t, $3 FROM unnest($2::text[]) AS t
         ON CONFLICT (client_id, tag) DO NOTHING`,
        [clientId, unique, req.user.id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }

  // Removals delete the row and its set_by/set_at with it, so client_tags
  // cannot answer "who untagged this and when". Tags drive audience
  // membership, so the change needs a trail. Logged AFTER release(), because
  // logAdminAction takes its own pooled connection and calling it while
  // holding one is the pool-deadlock trap CLAUDE.md flags.
  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: 'marketing.tags.set',
    metadata: { client_id: clientId, tags: unique },
  });

  res.json({ tags: sortTags(unique) });
}));

/**
 * The house do-not-contact rule, ENFORCED on all three marketing senders as of
 * lane mkt-f: the campaign resolver (MAILABLE_SQL), the scheduled-message
 * dispatcher (drip / retention / New Year), and the sequence scheduler.
 * Operational mail is deliberately unaffected: an excluded client still gets
 * their invoice.
 */
router.put('/contacts/:id/do-not-contact', auth, adminOnly, asyncHandler(async (req, res) => {
  const clientId = parseClientId(req.params.id);

  const { excluded, reason } = req.body || {};
  if (typeof excluded !== 'boolean') {
    throw new ValidationError({ excluded: 'excluded must be true or false.' });
  }
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (excluded && !trimmed) {
    throw new ValidationError({ reason: 'A reason is required to stop marketing to someone.' });
  }
  // Bounded, because logAdminAction silently drops the whole audit row when
  // metadata exceeds 8 KB (it reports to Sentry and returns normally), so an
  // unbounded reason means the suppression succeeds with no trail and a 200.
  if (trimmed.length > MAX_REASON_LENGTH) {
    throw new ValidationError({ reason: `Keep the reason under ${MAX_REASON_LENGTH} characters.` });
  }

  const { rows, rowCount } = await pool.query(
    `UPDATE clients SET
       marketing_excluded = $2,
       marketing_excluded_reason = CASE WHEN $2 THEN $3 ELSE NULL END,
       marketing_excluded_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
       -- $4::int is load-bearing. An untyped bind parameter inside a CASE
       -- resolves to text, and this column is integer, so without the cast
       -- every write raises 42804. The $3 branch needs no cast only because
       -- that column is TEXT, which is why the bug looks symmetric and is not.
       marketing_excluded_by = CASE WHEN $2 THEN $4::int ELSE NULL END,
       updated_at = NOW()
     WHERE id = $1
     RETURNING marketing_excluded, marketing_excluded_reason`,
    [clientId, excluded, trimmed || null, req.user.id]
  );
  if (rowCount === 0) throw new NotFoundError('Contact not found.');

  // target_user_id FKs to users(id) and a client is not a user, so the client
  // id rides in metadata (precedent: admin/ccImport/proposalActions.js:74-81).
  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: excluded ? 'marketing.do_not_contact.set' : 'marketing.do_not_contact.cleared',
    metadata: { client_id: clientId, reason: trimmed || null },
  });

  res.json({ excluded: rows[0].marketing_excluded, reason: rows[0].marketing_excluded_reason });
}));

/**
 * PUT /contacts/:id/email-status — clear a bad address flag.
 *
 * `email_status = 'bad'` is set by the Resend webhook on a permanent bounce and
 * gates far more than marketing: proposals, invoices and service agreements all
 * check it. Nothing in the product ever wrote it back, so a single bounce was a
 * one-way door, and the only repair was hand-editing the database.
 *
 * That happens for recoverable reasons. A full mailbox, a typo the client later
 * fixed, a domain that was briefly misconfigured. When the address is corrected
 * or the client says "try again", an operator needs a way to say so.
 *
 * Deliberately narrow: this only ever sets 'ok', and only from 'bad'. It cannot
 * mark an address bad (that is the webhook's job, from real delivery evidence)
 * and it does not touch marketing_excluded, which is a separate decision with
 * its own endpoint and its own reason.
 */
router.put('/contacts/:id/email-status', auth, adminOnly, asyncHandler(async (req, res) => {
  const clientId = parseClientId(req.params.id);

  const { status } = req.body || {};
  if (status !== 'ok') {
    throw new ValidationError({
      status: "Only 'ok' can be set here. An address is marked bad by delivery evidence, never by hand.",
    });
  }

  // Guarded so a no-op repair does not write an audit row, but the guard must
  // not make a repeat call look like a missing contact: two admins clicking, or
  // one double-submit, would get a 404 that lies about existence. Check the row
  // separately and treat an already-ok address as success.
  const { rows, rowCount } = await pool.query(
    `UPDATE clients SET email_status = 'ok', updated_at = NOW()
      WHERE id = $1 AND COALESCE(email_status, '') = 'bad'
      RETURNING email_status`,
    [clientId]
  );
  if (rowCount === 0) {
    const existing = await pool.query('SELECT email_status FROM clients WHERE id = $1', [clientId]);
    if (existing.rowCount === 0) throw new NotFoundError('Contact not found.');
    return res.json({ email_status: existing.rows[0].email_status, changed: false });
  }

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: 'marketing.email_status.cleared',
    metadata: { client_id: clientId },
  });

  res.json({ email_status: rows[0].email_status, changed: true });
}));


// ─── Read surface: contacts and audiences ──────────────────────────

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE = 100000;

/**
 * Builds the two WHERE scopes every contact query needs, over ONE shared
 * parameter list.
 *
 *   whereFull = audience + search + mailable_only + the active quick filter.
 *               Scopes the rows AND the held-back panel, which describes what
 *               you are looking at right now.
 *   whereBase = the same MINUS the active filter. Scopes the quick-filter
 *               chips, which must answer "what would each filter give".
 *
 * Computing the chips from whereFull makes selecting Untagged read
 * "All N / Untagged N / Corporate 0" for whatever N the untagged filter
 * returned, which is nonsense: every chip collapses onto the active one.
 */
function buildContactFilters(query) {
  const params = [];
  const base = [];
  const only = [];

  if (query.audience) {
    const aud = AUDIENCE_BY_ID.get(query.audience);
    if (!aud) throw new ValidationError({ audience: 'Unknown audience.' });
    base.push(`(${aud.where})`);
  }
  if (query.search) {
    params.push(`%${String(query.search).trim().toLowerCase()}%`);
    base.push(`(lower(c.name) LIKE $${params.length} OR lower(c.email) LIKE $${params.length})`);
  }
  // The recipient picker passes mailable_only. The default view shows everyone,
  // so held-back contacts stay visible and correctable.
  if (query.mailable_only === 'true') base.push(`(${MAILABLE_SQL})`);

  if (query.filter === 'untagged') {
    only.push('COALESCE(array_length(tg.tags, 1), 0) = 0');
  } else if (query.filter === DO_NOT_CONTACT_ID) {
    only.push('c.marketing_excluded = true');
  } else if (query.filter && query.filter !== 'all') {
    // Anything else is a tag id, validated against the vocabulary so a typo is
    // a 400 rather than a silently empty list.
    if (!isValidTag(query.filter)) throw new ValidationError({ filter: 'Unknown filter.' });
    params.push(query.filter);
    only.push(`$${params.length} = ANY(tg.tags)`);
  }

  const clause = (parts) => (parts.length ? `WHERE ${parts.join(' AND ')}` : '');
  return { params, whereBase: clause(base), whereFull: clause([...base, ...only]) };
}

/** GET /api/marketing/contacts */
router.get('/contacts', auth, adminOnly, asyncHandler(async (req, res) => {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE));
  // Bound the ceiling too. parseClientId documents this exact class one
  // function up: an unbounded page overflows OFFSET into 22P02 and a generic
  // 500 + Sentry noise, rather than an empty list.
  const page = Math.min(MAX_PAGE, Math.max(1, parseInt(req.query.page, 10) || 1));
  const { params, whereBase, whereFull } = buildContactFilters(req.query);
  const rowParams = [...params, limit, (page - 1) * limit];

  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.email, c.source, c.email_status,
           c.marketing_excluded, c.marketing_excluded_reason, c.communication_preferences,
           COALESCE(lu.unsubscribed, false)  AS lead_unsubscribed,
           tg.tags,
           agg.proposal_count::int, agg.paid_count::int, cc.booked_count::int,
           agg.corporate_events::int, agg.personal_events::int,
           agg.largest_guests::int, agg.a_venue,
           ${LAST_EVENT}                     AS last_event,
           lc.last_contacted,
           (COALESCE(agg.paid_dollars, 0) + COALESCE(cc.paid_dollars, 0))::float8 AS lifetime_dollars,
           (${MAILABLE_SQL})                 AS mailable
      FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES} ${whereFull}
     ORDER BY ${LAST_EVENT} DESC, c.id DESC
     LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}
  `, rowParams);

  // Counts over the whole base, never the page. Buckets come from
  // HELD_BACK_SQL, the SQL twin of heldBackReason, so they are mutually
  // exclusive by construction and sum to total - mailable. Independent
  // COUNT FILTERs would double-count a row that is both excluded and bounced.
  //
  // `total` comes from here rather than a COUNT(*) OVER () on the row query,
  // which reports 0 on a page past the end while the base is non-empty.
  const agg = await pool.query(`
    WITH held AS (
      SELECT ${HELD_BACK_SQL} AS reason
        FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES} ${whereFull}
    ), chips AS (
      SELECT tg.tags, c.marketing_excluded
        FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES} ${whereBase}
    )
    SELECT
      (SELECT COUNT(*) FILTER (WHERE reason = 'do_not_contact') FROM held)::int AS do_not_contact,
      (SELECT COUNT(*) FILTER (WHERE reason = 'unsubscribed')   FROM held)::int AS unsubscribed,
      (SELECT COUNT(*) FILTER (WHERE reason = 'bounced')        FROM held)::int AS bounced,
      (SELECT COUNT(*) FILTER (WHERE reason = 'no_address')     FROM held)::int AS no_address,
      (SELECT COUNT(*) FILTER (WHERE reason IS NULL)            FROM held)::int AS mailable,
      (SELECT COUNT(*) FROM held)::int                                          AS total,
      (SELECT COUNT(*) FROM chips)::int                                         AS chip_all,
      (SELECT COUNT(*) FILTER (WHERE COALESCE(array_length(tags,1),0) = 0) FROM chips)::int AS chip_untagged,
      (SELECT COUNT(*) FILTER (WHERE 'corporate' = ANY(tags)) FROM chips)::int  AS chip_corporate,
      (SELECT COUNT(*) FILTER (WHERE marketing_excluded) FROM chips)::int       AS chip_dnc
  `, params);

  const counts = agg.rows[0];
  res.json({
    total: counts.total,
    page,
    limit,
    held_back: {
      do_not_contact: counts.do_not_contact,
      unsubscribed: counts.unsubscribed,
      bounced: counts.bounced,
      no_address: counts.no_address,
      mailable: counts.mailable,
    },
    filter_counts: {
      all: counts.chip_all,
      untagged: counts.chip_untagged,
      corporate: counts.chip_corporate,
      [DO_NOT_CONTACT_ID]: counts.chip_dnc,
    },
    contacts: rows.map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      source: r.source,
      tags: r.tags || [],
      // Derived states are computed here and NEVER stored.
      derived: (r.paid_count > 0 || r.booked_count > 0) ? 'paid'
        : (r.proposal_count > 0 ? 'quoted' : null),
      untagged: (r.tags || []).length === 0,
      // GREATEST(-infinity) comes back as the JS number -Infinity, not a
      // string, so Number.isFinite is the correct guard.
      last_event: Number.isFinite(Date.parse(r.last_event)) ? r.last_event : null,
      last_contacted: r.last_contacted,
      lifetime_dollars: r.lifetime_dollars,
      mailable: r.mailable,
      held_back_reason: r.mailable ? null : heldBackReason(r),
      do_not_contact: r.marketing_excluded,
      do_not_contact_reason: r.marketing_excluded_reason,
      suggestion: (r.tags || []).length === 0 ? suggestTag({
        email: r.email,
        corporateEventCount: r.corporate_events,
        personalEventCount: r.personal_events,
        largestGuestCount: r.largest_guests,
        venueName: r.a_venue,
      }) : null,
    })),
  });
}));

/** GET /api/marketing/audiences — the seven definitions with live counts. */
router.get('/audiences', auth, adminOnly, asyncHandler(async (_req, res) => {
  const out = [];
  for (const a of AUDIENCES) {
    const { rows } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE ${MAILABLE_SQL})::int AS emailable, COUNT(*)::int AS total
        FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES}
       WHERE ${a.where}`);
    out.push({ id: a.id, name: a.name, rule: a.rule, includes: a.includes, ...rows[0] });
  }
  res.json(out);
}));

/**
 * GET /api/marketing/contacts/:id — the drawer.
 *
 * The message history here is what makes the design's promise true: an
 * operator deciding whether to reach out can see the system already nudged
 * this person. Automated and human sends are distinguished per row.
 */
router.get('/contacts/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = parseClientId(req.params.id);

  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.email, c.phone, c.source, c.email_status,
           c.marketing_excluded, c.marketing_excluded_reason, c.marketing_excluded_at,
           c.communication_preferences,
           COALESCE(lu.unsubscribed, false) AS lead_unsubscribed,
           tg.tags,
           agg.proposal_count::int, agg.paid_count::int, cc.booked_count::int,
           agg.corporate_events::int, agg.personal_events::int,
           agg.largest_guests::int, agg.a_venue,
           ${LAST_EVENT}                    AS last_event,
           lc.last_contacted,
           (COALESCE(agg.paid_dollars, 0) + COALESCE(cc.paid_dollars, 0))::float8 AS lifetime_dollars,
           (${MAILABLE_SQL})                AS mailable
      FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES}
     WHERE c.id = $1`, [id]);
  if (rows.length === 0) throw new NotFoundError('Contact not found.');
  const r = rows[0];

  // Native proposals only. Check Cherry history has no event_type in prod
  // (NULL on all 1,230 rows), so it cannot be rendered as an event list; it is
  // already reflected in lifetime_dollars and last_event above.
  const events = await pool.query(`
    SELECT p.id, p.event_date, p.event_type, p.event_type_custom, p.venue_name,
           p.status, p.amount_paid::float8 AS amount
      FROM proposals p
     WHERE p.client_id = $1 AND p.status <> 'archived'
     ORDER BY p.event_date DESC NULLS LAST LIMIT 20`, [id]);

  const messages = await getContactMessageHistory(id, { limit: 50 });

  res.json({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    source: r.source,
    tags: r.tags || [],
    derived: (r.paid_count > 0 || r.booked_count > 0) ? 'paid'
      : (r.proposal_count > 0 ? 'quoted' : null),
    last_event: Number.isFinite(Date.parse(r.last_event)) ? r.last_event : null,
    last_contacted: r.last_contacted,
    lifetime_dollars: r.lifetime_dollars,
    mailable: r.mailable,
    held_back_reason: r.mailable ? null : heldBackReason(r),
    do_not_contact: r.marketing_excluded,
    do_not_contact_reason: r.marketing_excluded_reason,
    do_not_contact_at: r.marketing_excluded_at,
    suggestion: (r.tags || []).length === 0 ? suggestTag({
      email: r.email,
      corporateEventCount: r.corporate_events,
      personalEventCount: r.personal_events,
      largestGuestCount: r.largest_guests,
      venueName: r.a_venue,
    }) : null,
    events: events.rows,
    messages,
  });
}));

module.exports = router;
