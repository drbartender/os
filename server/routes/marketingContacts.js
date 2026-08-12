const express = require('express');
const { pool } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { MARKETING_TAGS, isValidTag } = require('../utils/marketingTags');
const { logAdminAction } = require('../utils/adminAuditLog');

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
 * PUT /api/marketing/contacts/:id/do-not-contact
 * Body: { excluded: boolean, reason?: string }
 *
 * The house rule, distinct from the client's own unsubscribe. Gates MARKETING
 * ONLY: an excluded client who books still gets proposals, invoices, and every
 * operational message.
 *
 * RECORDED ONLY, NOT YET ENFORCED. Nothing reads this column today. The live
 * marketing gate is scheduledMessageDispatcher.js's marketing-category check,
 * which consults communication_preferences.marketing_enabled and nothing else.
 *
 * Two lanes close that, and they are NOT the same lane:
 *   - mkt-c-resolver adds MAILABLE_SQL, which keeps an excluded contact out of
 *     new campaigns.
 *   - mkt-f-compliance patches the DISPATCHER gate, which is what stops the
 *     automated touches. That one is deliberately deferred here so a
 *     comms-critical file is opened by the lane that already touches it.
 *
 * Until both land the flag only records intent. It can be set by a direct API
 * call; no UI writes it before lane mkt-d.
 *
 * Deliberately its own endpoint rather than a field on PUT /api/clients/:id,
 * which destructures a fixed 5-field body and updates via COALESCE($n, col)
 * where null means "leave unchanged" — so that route structurally cannot clear
 * this flag or null the reason (clients.js:121-150).
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

module.exports = router;
