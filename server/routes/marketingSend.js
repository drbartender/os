/**
 * The campaign send.
 *
 * This is the only path in the redesign that puts mail in a stranger's inbox,
 * so every guard here exists because its absence has a name.
 *
 * WHY THIS REPLACES THE OLD BLAST (retired in lane mkt-f). The old path built
 * its audience from `email_leads` and nothing else, so it structurally could
 * not honor `clients.marketing_excluded`: a different table cannot be filtered
 * by a column it does not have. This route takes explicit `client_ids` and
 * re-checks every one of them against the shared mailability predicate at send
 * time, because a list assembled in the UI minutes ago is a snapshot, and the
 * person who was excluded in between is exactly who must not receive it.
 *
 * THE FOUR GUARDS, and what each one is for:
 *
 *   1. RE-CHECK, never trust the caller's list. `MAILABLE_SQL` runs again here
 *      over the submitted ids. The UI already filtered; that is not the point.
 *   2. DEDUPE by lowercased, trimmed address. One person can hold more than one
 *      row (a `clients` row and a case variant, since the unique index is on
 *      the raw address). Two rows means two identical emails to one human,
 *      which reads as a broken system and burns a Resend quota unit.
 *   3. SEND-ONCE, claimed atomically. The row in `email_sends` is INSERTed
 *      BEFORE Resend is called, against a partial unique index on
 *      (campaign_id, client_id). A duplicate claim raises 23505 and that
 *      recipient is skipped. This is what makes a double-click, or two
 *      operators, safe: the database arbitrates, not a flag we read earlier.
 *   4. PACED SERIAL sending. One at a time with a gap, not Promise.all. Resend
 *      rate-limits, and a burst that trips the limit fails an arbitrary subset,
 *      which is the worst outcome: a partially-sent campaign nobody can resume
 *      confidently.
 *
 * QUOTA vs FAILURE. A 429 or daily-quota rejection is TRANSIENT and stops the
 * whole run: the remaining recipients keep no `email_sends` row, so re-running
 * the send after the quota resets picks them up and the send-once index still
 * protects everyone already mailed. Any other error is that recipient's alone
 * and is recorded `failed` so the run continues.
 */

const express = require('express');
const { pool } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { sendEmail } = require('../utils/email');
const { wrapMarketingEmail } = require('../utils/emailTemplates');
const { sanitizeHtml } = require('../utils/emailSanitize');
const { MAILABLE_SQL, LEAD_UNSUB_LATERAL } = require('../utils/marketingAudience');
const { buildUnsubscribeUrl } = require('../utils/marketingHandlers');
const { logAdminAction } = require('../utils/adminAuditLog');

const router = express.Router();

// Resend's published rate limit is 2 requests/second. 600ms leaves headroom
// without making a 200-recipient send take longer than a coffee break.
const SEND_GAP_MS = Number(process.env.MARKETING_SEND_GAP_MS || 600);
const MAX_RECIPIENTS = 500;

// THESE THREE ARE COUPLED. The run claim below treats a 'sending' campaign as
// abandoned after RUN_STALE_MINUTES, so that window must comfortably exceed the
// longest legitimate run: MAX_RECIPIENTS x SEND_GAP_MS plus per-send round
// trips. At the defaults that is 500 x 600ms, roughly 400 seconds in practice
// against a 900-second window. Raising MARKETING_SEND_GAP_MS past ~1800ms at
// full list size breaks the relationship, and a run that overruns the window
// loses its claim to a newer run mid-flight.
const RUN_STALE_MINUTES = 15;
const PG_INT4_MAX = 2147483647;
/**
 * Exactly ONE of our own addresses, in bare or `Name <addr>` form.
 *
 * The first version anchored on the end of the string, which a comma address
 * list walks straight through: `attacker@evil.com, ops@drbartender.com` is a
 * valid RFC 5322 Reply-To and matched. Reject anything with a separator and
 * match the WHOLE extracted address rather than a suffix of the string.
 */
function isOurAddress(raw) {
  const v = String(raw).trim();
  if (!v) return false;
  if (/[,;]/.test(v)) return false;                      // no address lists
  const m = v.match(/^(?:.*<\s*([^<>\s]+)\s*>|([^<>\s]+))$/);
  const addr = (m && (m[1] || m[2])) || '';
  return /^[^\s@]+@(?:[a-z0-9-]+\.)*drbartender\.com$/i.test(addr);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Resolve the submitted ids to recipients that are STILL mailable, deduped.
 *
 * Returns `{ recipients, mailableCount }`. The count is BEFORE the dedupe, so
 * the caller can report "held back by suppression" and "two rows, one person"
 * as the different facts they are. Rows come back in a stable order (by id) so
 * a resumed run walks the same list; the dedupe keeps the lowest id per
 * address, which is arbitrary but stable.
 */
async function resolveRecipients(clientIds) {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (lower(btrim(c.email)))
           c.id, c.name, c.email
      FROM clients c
      ${LEAD_UNSUB_LATERAL}
     WHERE c.id = ANY($1::int[])
       AND (${MAILABLE_SQL})
     ORDER BY lower(btrim(c.email)), c.id
  `, [clientIds]);
  // Count the mailable set BEFORE the dedupe, with the identical predicate, so
  // the two numbers cannot drift apart.
  const { rows: cnt } = await pool.query(`
    SELECT COUNT(*)::int AS n
      FROM clients c
      ${LEAD_UNSUB_LATERAL}
     WHERE c.id = ANY($1::int[])
       AND (${MAILABLE_SQL})
  `, [clientIds]);

  // DISTINCT ON forces its own ORDER BY; re-sort for a stable send order.
  return { recipients: rows.sort((a, b) => a.id - b.id), mailableCount: cnt[0].n };
}

/**
 * POST /api/marketing/campaigns/:id/send
 * Body: { client_ids: number[] }
 */
router.post('/campaigns/:id/send', auth, adminOnly, asyncHandler(async (req, res) => {
  const campaignId = parseInt(req.params.id, 10);
  if (!Number.isInteger(campaignId) || campaignId < 1 || campaignId > 2147483647) {
    throw new ValidationError({ id: 'Invalid campaign id.' });
  }

  const ids = Array.isArray(req.body?.client_ids) ? req.body.client_ids : null;
  if (!ids || ids.length === 0) {
    throw new ValidationError({ client_ids: 'Pick at least one recipient.' });
  }
  if (ids.length > MAX_RECIPIENTS) {
    throw new ValidationError({
      client_ids: `That is ${ids.length} recipients. Send at most ${MAX_RECIPIENTS} at a time.`,
    });
  }
  // Bounded to int4: an out-of-range id parses as a valid integer and then
  // raises 22003 against an integer column, which exits as a generic 500 with
  // no fieldErrors instead of telling the caller what was wrong.
  const clean = [...new Set(
    ids.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= PG_INT4_MAX)
  )];
  if (clean.length === 0) throw new ValidationError({ client_ids: 'No valid recipient ids.' });

  const camp = await pool.query(
    'SELECT id, name, type, subject, html_body, from_email, reply_to, status, sent_at FROM email_campaigns WHERE id = $1',
    [campaignId]
  );
  const c = camp.rows[0];
  if (!c) throw new NotFoundError('Campaign not found.');
  if (c.status === 'archived') throw new ConflictError('That campaign is archived.');
  const fieldErrors = {};
  // A sequence campaign's status IS its on-switch: emailSequenceScheduler and
  // the public capture-lead enrolment both gate on status = 'active'. Claiming
  // it as 'sending' and releasing it to 'sent' would silently stop the drip for
  // every enrollment, recoverable only by someone noticing and re-activating.
  if (c.type && c.type !== 'blast') {
    throw new ValidationError({
      type: 'Only blast campaigns are sent this way. A sequence runs on its own schedule.',
    });
  }
  if (!c.subject) fieldErrors.subject = 'Add a subject before sending.';
  if (!c.html_body) fieldErrors.html_body = 'Add some content before sending.';

  // Campaign CRUD is requireAdminOrManager; this send is adminOnly. Without
  // this check a manager could set a campaign's reply_to to an address they
  // control, and every reply to a blast an ADMIN later sent would go to them.
  // from_email is bounded in practice by Resend's domain verification; reply_to
  // is verified by nobody, so verify it here.
  for (const [field, value] of [['from_email', c.from_email], ['reply_to', c.reply_to]]) {
    if (value && !isOurAddress(value)) {
      fieldErrors[field] = `${field} must be a drbartender.com address.`;
    }
  }
  if (Object.keys(fieldErrors).length) throw new ValidationError(fieldErrors);

  // ONE RUN PER CAMPAIGN, claimed as a ROW rather than an advisory lock.
  //
  // The first version of this used pg_try_advisory_lock. That is a no-op on
  // this deployment and was actively harmful. DATABASE_URL points at Neon's
  // PgBouncer `-pooler` endpoint, so many app connections are multiplexed onto
  // one server session: probed live, six pool checkouts shared one backend pid,
  // and two of them acquired the SAME advisory lock (session locks are
  // re-entrant within a session). Worse, an unlock issued on a different
  // checkout can release a lock another request owns, or silently return false
  // and strand it, permanently 409-ing that campaign.
  //
  // A conditional UPDATE is atomic in one statement regardless of pooling. It
  // also makes an in-flight send visible: the campaigns list shows 'sending'.
  //
  // The staleness escape matters as much as the claim. Without it a process
  // death mid-send would leave the row 'sending' forever and lock the campaign
  // out with no way back except hand-editing the database.
  //
  // ARCHIVED is re-checked HERE, not only at the read above. The archive writer
  // (emailMarketing/campaigns.js) guards on `status <> 'sending'`, so between
  // this request's SELECT and this UPDATE a campaign can be archived and still
  // satisfy a WHERE that only asks about 'sending' -- archived is <> 'sending'.
  // The read-side check would pass, the claim would flip it back to 'sending',
  // and an archived campaign would mail. Small window, real send.
  const claimRun = await pool.query(
    `UPDATE email_campaigns
        SET status = 'sending', sent_at = NOW(), updated_at = NOW()
      WHERE id = $1
        AND status <> 'archived'
        AND (status <> 'sending' OR sent_at IS NULL
             OR sent_at < NOW() - make_interval(mins => $2::int))
      -- Return the stamp we just wrote. The release matches on it, so a run
      -- that overran the staleness window and lost its claim to a newer run
      -- cannot release the NEWER run's claim on its way out. Without this the
      -- loser's restore wins and a campaign that just mailed forty people can
      -- finish as draft with a null send date. Same ownership defect as the
      -- cross-connection advisory unlock this claim replaced.
      -- ::text, not the bare timestamptz. RETURNING a timestamptz hands
      -- node-postgres a JS Date, which is MILLISECOND precision, while Postgres
      -- stores microseconds. Round-tripping the Date back into the release's
      -- equality silently dropped digits, matched nothing, and left every
      -- campaign wedged in 'sending'. Text compares exactly.
      RETURNING sent_at::text AS claim_stamp`,
    [campaignId, RUN_STALE_MINUTES]
  );
  if (claimRun.rowCount === 0) {
    // Two ways to lose the claim now, and they are different facts to an
    // operator. Re-read rather than guess: telling someone to "wait for it to
    // finish" about a campaign they just archived sends them looking for a run
    // that does not exist.
    const lost = await pool.query('SELECT status FROM email_campaigns WHERE id = $1', [campaignId]);
    if (lost.rows[0] && lost.rows[0].status === 'archived') {
      throw new ConflictError('That campaign is archived.');
    }
    throw new ConflictError('That campaign is already sending. Wait for it to finish.');
  }
  const claimStamp = claimRun.rows[0].claim_stamp;
  // priorStatus can itself be 'sending' when this run recovered a stale claim.
  // Restoring that would leave the campaign displaying "sending" forever with
  // no run behind it, so a recovered stale claim releases to 'draft'.
  const priorStatus = c.status === 'sending' ? 'draft' : c.status;
  // The claim overwrites sent_at (the staleness escape needs a fresh stamp), so
  // the release has to put the real one back when nothing actually went out.
  // Otherwise a refused or all-suppressed run leaves a draft displaying a send
  // date, or overwrites the genuine send date of a campaign that really did go.
  const priorSentAt = c.sent_at;
  // Declared OUTSIDE the try: the finally reads it, and several paths inside
  // (all-suppressed, a bad campaign) throw before `result` exists. Referencing
  // `result` there was a temporal-dead-zone ReferenceError that turned a clean
  // 400 into a 500 and masked the real error.
  let anySent = 0;

  try {
  const { recipients, mailableCount } = await resolveRecipients(clean);

  // Everyone submitted is suppressed. Say so plainly rather than reporting a
  // successful send of zero emails. This is specifically the SUPPRESSION case;
  // "already sent" is a different fact and is counted, not refused.
  if (recipients.length === 0) {
    throw new ValidationError({
      client_ids: 'None of those contacts can be emailed right now. Check the held-back panel.',
    });
  }

  // The send-once index is keyed on client_id; the dedupe above is keyed on the
  // ADDRESS. Within one request DISTINCT ON reconciles them, but across requests
  // they disagree: two sends naming different client rows of the same human
  // (case variants exist, the unique index is on the raw email) would each claim
  // cleanly and mail that person twice. Subtract addresses this campaign already
  // reached, and COUNT them rather than dropping them, so the operator is told
  // "already had it" instead of the misleading "cannot be emailed".
  const alreadySent = new Set(
    (await pool.query(`
      SELECT DISTINCT lower(btrim(c3.email)) AS addr
        FROM email_sends es JOIN clients c3 ON c3.id = es.client_id
       WHERE es.campaign_id = $1
         AND COALESCE(es.status, '') NOT IN ('failed', 'queued')
    `, [campaignId])).rows.map(r => r.addr)
  );

  // Deduped is reported apart from suppression. `eligible` is reduced by BOTH,
  // and calling the whole gap "held back" tells an operator somebody was
  // suppressed when in fact two rows were one person.
  const dedupedAway = mailableCount - recipients.length;

  const result = {
    campaign_id: campaignId,
    requested: clean.length,
    deduped: dedupedAway,
    // The gap between these two is the suppression working, and an operator
    // should see it rather than wonder why 40 became 37.
    eligible: recipients.length,
    sent: 0,
    skipped_already_sent: 0,
    failed: 0,
    stopped_early: null,
  };

  for (const r of recipients) {
    if (alreadySent.has(String(r.email || '').trim().toLowerCase())) {
      result.skipped_already_sent += 1;
      continue;
    }

    // ── Guard 3: claim BEFORE sending. 23505 means somebody already has. ──
    // A claim that never reached 'sent' must be RECLAIMABLE. The row occupies
    // the unique index the moment it is inserted, so without this a failed send
    // (any non-quota Resend error) or a process death between the claim and the
    // UPDATE locks that recipient out of the campaign permanently — and the
    // re-run reports them as `skipped_already_sent`, which the UI renders as
    // "Already had this campaign". That is a false statement about somebody who
    // was never mailed, and it is worse than the duplicate it prevents.
    //
    // ON CONFLICT re-claims a row still sitting in 'queued' or 'failed'. A row
    // in any other state genuinely went out, so the update matches nothing,
    // RETURNING is empty, and that is a real skip.
    const claim = await pool.query(
      `INSERT INTO email_sends (campaign_id, client_id, subject, status)
       VALUES ($1, $2, $3, 'queued')
       ON CONFLICT (campaign_id, client_id) WHERE campaign_id IS NOT NULL AND client_id IS NOT NULL
       DO UPDATE SET status = 'queued', error_message = NULL, sent_at = NOW()
         -- 'queued' is ALSO the state of an IN-FLIGHT claim: the insert commits,
         -- then we await Resend for a few hundred ms before flipping to 'sent'.
         -- Reclaiming on bare 'queued' therefore let a second concurrent run
         -- re-claim a row the first run was actively sending, and because both
         -- runs pace at the same fixed cadence their offset stays roughly
         -- constant, so it would not be one unlucky duplicate: it would be
         -- every remaining recipient, twice. Only a claim old enough to be
         -- genuinely stranded (process death mid-send) is reclaimable.
         WHERE email_sends.status = 'failed'
            OR (email_sends.status = 'queued'
                AND email_sends.sent_at < NOW() - INTERVAL '10 minutes')
       RETURNING id`,
      [campaignId, r.id, c.subject]
    );
    if (claim.rowCount === 0) { result.skipped_already_sent += 1; continue; }
    const sendRowId = claim.rows[0].id;

    try {
      // Re-sanitized at the boundary. Every current writer sanitizes on the way
      // in, but this is the one place admin-authored HTML crosses into a
      // stranger's inbox, and a future writer (an import, a script) would not be
      // caught by those. Self-defending beats trusting every caller forever.
      const html = wrapMarketingEmail(sanitizeHtml(c.html_body), buildUnsubscribeUrl(r.id));
      const sent = await sendEmail({
        to: r.email,
        subject: c.subject,
        html,
        from: c.from_email || undefined,
        replyTo: c.reply_to || undefined,
        // The campaign row IS the log entry; skipLog avoids a duplicate.
        meta: { skipLog: true },
      });
      await pool.query(
        `UPDATE email_sends SET status = 'sent', resend_id = $2, sent_at = NOW() WHERE id = $1`,
        [sendRowId, sent?.id || null]
      );
      result.sent += 1;
      anySent += 1;
    } catch (err) {
      // A quota rejection is TRANSIENT and applies to the whole run, not this
      // recipient. Release the claim so a re-run picks them up, and stop:
      // continuing would burn through the remaining list turning every one of
      // them into a spurious `failed`.
      if (err.name === 'QuotaExceededError') {
        // Deleted rather than left 'failed': a quota stop is not this
        // recipient's failure, and a deleted row keeps the analytics
        // denominators honest. Reclaim would also work now, but "no row at all"
        // is the truthful record of "we never tried this person".
        await pool.query('DELETE FROM email_sends WHERE id = $1', [sendRowId]);
        result.stopped_early = 'quota';
        break;
      }
      await pool.query(
        `UPDATE email_sends SET status = 'failed', error_message = $2 WHERE id = $1`,
        [sendRowId, String(err.message || err).slice(0, 500)]
      );
      result.failed += 1;
    }

    if (SEND_GAP_MS > 0) await sleep(SEND_GAP_MS);
  }

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: 'marketing.campaign.sent',
    metadata: result,
  });

  res.json(result);
  } finally {
    // Release the run claim. 'sent' when anything went out, otherwise back to
    // where it was, so a refused or empty run does not strand the campaign.
    await pool.query(
      `UPDATE email_campaigns
          SET status = $2,
              sent_at = CASE WHEN $3::boolean THEN NOW() ELSE $4::timestamptz END,
              updated_at = NOW()
        WHERE id = $1 AND status = 'sending' AND sent_at::text = $5`,
      [campaignId, anySent > 0 ? 'sent' : priorStatus, anySent > 0, priorSentAt, claimStamp]
    ).catch(err => console.error('[marketingSend] releasing the run claim failed:', err.message));
  }
}));

module.exports = router;
