/**
 * The PUBLIC unsubscribe endpoint. No auth by design: the JWT in the link is
 * the credential.
 *
 * GET CONFIRMS, POST ACTS. This split is not ceremony.
 *
 * A GET must be safe and idempotent, and the things that fetch links in email
 * are not people: corporate mail gateways, security scanners, and link
 * prefetchers all issue GET on every URL in a message before the recipient
 * ever sees it. While the flip lived in the GET, any of them silently
 * unsubscribed a client who never clicked anything, and the retention and New
 * Year touches simply stopped arriving with no trace of why.
 *
 * The confirmation page is a plain HTML form with NO inline JavaScript. Helmet
 * sets `scriptSrc: ["'self'", "https://js.stripe.com"]` (index.js), so an
 * inline handler would be blocked by CSP and the button would do nothing.
 * Inline STYLE is fine: styleSrc allows 'unsafe-inline'.
 *
 * The POST is also the right SHAPE for RFC 8058 one-click unsubscribe, which
 * posts to the unsubscribe URL. Note that nothing emits the `List-Unsubscribe`
 * / `List-Unsubscribe-Post` headers yet, so no mail client will actually use
 * it: `sendEmail` has no headers passthrough. Adding those headers is a phase 2
 * deliverability item, and this route is ready for it.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();

const PAGE = (body) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dr. Bartender</title></head>
<body style="font-family:Georgia,serif;text-align:center;padding:60px 20px;color:#2b2b2b;">
${body}
</body></html>`;

/** Escape for an HTML attribute. The token is signed, but it is still input. */
function attr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Verify an unsubscribe token and say what it authorizes.
 *
 * Two shapes are in circulation: a campaign-blast token ({leadId}) and a
 * lifecycle marketing token ({clientId, marketing}) minted by
 * marketingHandlers.buildUnsubscribeUrl.
 *
 * `typ` is ADVISORY only. New tokens carry typ:'unsub' so a future reader can
 * tell what a token was minted for, but tokens live 365 days and plenty are
 * already in inboxes without it. Requiring it would silently break every
 * unsubscribe link already sent, which is the exact harm this file exists to
 * prevent.
 */
function readToken(token) {
  if (!token) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
  // Accept an ABSENT typ (legacy links), reject a CONFLICTING one. Every token
  // in this app is signed with the same key when UNSUBSCRIBE_SECRET is unset,
  // so a future token type that happens to carry leadId, or clientId plus a
  // truthy marketing, would otherwise become a live 365-day unsubscribe
  // credential. Nothing minted today collides; this keeps it that way without
  // invalidating the links already sitting in inboxes.
  if (decoded.typ && decoded.typ !== 'unsub') return null;
  if (decoded.clientId && decoded.marketing) return { kind: 'client', id: decoded.clientId };
  if (decoded.leadId) return { kind: 'lead', id: decoded.leadId };
  return null;
}

/**
 * The confirmation page embeds a 365-day credential in its HTML. Keep it out of
 * shared caches and out of search indexes.
 */
function noStore(res) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('X-Robots-Tag', 'noindex, nofollow');
}

/** GET /unsubscribe — render a confirmation. Changes nothing. */
router.get('/unsubscribe', asyncHandler(async (req, res) => {
  noStore(res);
  const target = readToken(req.query.token);
  if (!target) {
    return res.status(400).send(PAGE('<h2>This unsubscribe link is invalid or expired.</h2>'));
  }
  res.send(PAGE(`
    <h2>Unsubscribe from marketing emails?</h2>
    <p>You will stop receiving marketing emails from Dr. Bartender.<br>
       Messages about your own events, invoices, and bookings will still reach you.</p>
    <form method="POST" action="/api/email-marketing/unsubscribe">
      <input type="hidden" name="token" value="${attr(req.query.token)}">
      <button type="submit" style="font-family:Georgia,serif;font-size:1rem;padding:12px 28px;
        background:#2b2b2b;color:#fff;border:none;border-radius:4px;cursor:pointer;">
        Yes, unsubscribe me
      </button>
    </form>
  `));
}));

/** POST /unsubscribe — the acting verb. Also the RFC 8058 one-click target. */
router.post('/unsubscribe', asyncHandler(async (req, res) => {
  noStore(res);
  const target = readToken(req.body?.token || req.query.token);
  if (!target) {
    return res.status(400).send(PAGE('<h2>This unsubscribe link is invalid or expired.</h2>'));
  }

  // ONE CLICK MUST SILENCE THE WHOLE PERSON.
  //
  // A human can hold two identity rows: a `clients` row and an `email_leads`
  // row, joined by nothing but the address. Writing only the row the token
  // happens to name is how an honored opt-out still produces email: a lead-side
  // unsubscribe left `clients` untouched, so the campaign resolver dropped them
  // while the scheduled-message dispatcher kept sending the drip; a client-side
  // unsubscribe left `email_leads` untouched, so the sequence scheduler kept
  // running its steps.
  //
  // Both readers were also taught to check across, but this is the root fix:
  // suppression is written once, to every identity the address owns, so a
  // future reader cannot reintroduce the bug by forgetting to join.
  //
  // Transactional: a half-applied opt-out is the failure being fixed.
  // DB errors propagate to asyncHandler → global error middleware (500 + Sentry).
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    // LOCK ORDER IS FIXED: email_leads -> email_sequence_enrollments -> clients,
    // in BOTH branches. The first draft had the client branch take clients
    // first, which is an ABBA inversion against the Resend webhook (which locks
    // leads then clients) and against the other branch of this same route. Two
    // correlated events, someone hitting "spam" in Gmail while clicking the
    // unsubscribe link, could deadlock and 500 an opt-out.
    const addr = target.kind === 'client'
      ? (await db.query('SELECT email FROM clients WHERE id = $1', [target.id])).rows[0]?.email
      : (await db.query('SELECT email FROM email_leads WHERE id = $1', [target.id])).rows[0]?.email;
    const hasAddr = typeof addr === 'string' && addr.trim() !== '';

    if (hasAddr) {
      await db.query(
        `UPDATE email_leads SET status = 'unsubscribed', unsubscribed_at = NOW()
          WHERE lower(btrim(email)) = lower(btrim($1)) AND status <> 'unsubscribed'`,
        [addr]
      );
      await db.query(
        `UPDATE email_sequence_enrollments SET status = 'unsubscribed'
          WHERE status = 'active'
            AND lead_id IN (SELECT id FROM email_leads WHERE lower(btrim(email)) = lower(btrim($1)))`,
        [addr]
      );
    } else if (target.kind === 'lead') {
      // A lead with a blank address: still silence the row the token names.
      await db.query(
        `UPDATE email_leads SET status = 'unsubscribed', unsubscribed_at = NOW() WHERE id = $1`,
        [target.id]
      );
      await db.query(
        `UPDATE email_sequence_enrollments SET status = 'unsubscribed' WHERE lead_id = $1 AND status = 'active'`,
        [target.id]
      );
    }

    // Clients last, and by id OR address. `clients` has no UNIQUE on email, so
    // duplicate rows sharing an address are real; matching on both means a
    // client-token unsubscribe cannot leave a twin row still mailable. A NULL
    // $2 makes the address arm NULL, so the id arm still matches on its own.
    await db.query(
      `UPDATE clients
       SET communication_preferences = jsonb_set(
             COALESCE(communication_preferences, '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb),
             '{marketing_enabled}', 'false'::jsonb)
       WHERE ($1::int IS NOT NULL AND id = $1::int)
          OR ($2::text IS NOT NULL AND lower(btrim(email)) = lower(btrim($2::text)))`,
      [target.kind === 'client' ? target.id : null, hasAddr ? addr : null]
    );

    await db.query('COMMIT');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_e) { /* already rolled back */ }
    throw err;
  } finally {
    db.release();
  }

  res.send(PAGE(`
    <h2>You've been unsubscribed</h2>
    <p>You will no longer receive marketing emails from Dr. Bartender.</p>
  `));
}));

module.exports = router;
