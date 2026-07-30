// Standalone public SMS opt-in form (POST /api/sms/opt-in).
//
// WHY THIS EXISTS, and why it is not inside routes/sms.js:
// The Twilio A2P 10DLC campaign was rejected twice because a reviewer opening
// /quote never reaches the consent checkbox on step 2 of the wizard (error 30909
// "CTA could not be verified", then 30896 "form lacks a dedicated SMS opt-in
// checkbox"). The remedy is a one-screen public page at /sms whose checkbox is
// visible on load. This is its submit endpoint. routes/sms.js is on
// scripts/sensitive-paths.txt and carries the inbound webhook plus the admin
// manual reply; widening it for a public form would be gratuitous blast radius.
//
// The consent semantics are NOT re-invented here. Every rule lives in
// utils/smsConsent.js (the ownership gate, the row-scoped and phone-scoped STOP
// guards, the audit log) and this route is one more caller of it. See
// docs/superpowers/specs/2026-07-30-sms-opt-in-page.md.

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { publicLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
const { AppError, ValidationError } = require('../utils/errors');
const { validatePhone } = require('../utils/phone');
const { findOrCreateClientDetailed } = require('../utils/clientDedup');
const { recordSmsConsent, consentFieldsFromBody, requestMeta } = require('../utils/smsConsent');
const { getConsentCopy } = require('../data/smsConsentCopy');

const router = express.Router();

// Same shape as the local constants in calcomWebhookHelpers.js and
// tipHandleValidation.js. Deliberately loose: this is a typo guard, and the
// address is only ever used to resolve or create a client row.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LEN = 255;   // clients.name is VARCHAR(255)
const MAX_EMAIL_LEN = 255;  // clients.email is VARCHAR(255)

/**
 * POST /api/sms/opt-in — standalone SMS consent capture.
 *
 * publicLimiter (20 / 15 min / IP), the same limiter the quote wizard's public
 * writes use: this endpoint INSERTs a client row from unauthenticated input.
 */
router.post('/opt-in', publicLimiter, asyncHandler(async (req, res) => {
  const name = String(req.body?.client_name || '').trim();
  const email = String(req.body?.client_email || '').trim();
  const phoneRaw = String(req.body?.client_phone || '').trim();
  const { value: phone10 } = validatePhone(phoneRaw);
  const consent = consentFieldsFromBody(req.body);

  const fieldErrors = {};
  if (!name) fieldErrors.client_name = 'Please enter your name';
  else if (name.length > MAX_NAME_LEN) fieldErrors.client_name = 'Name is too long';
  if (!email) fieldErrors.client_email = 'Please enter your email';
  else if (email.length > MAX_EMAIL_LEN) fieldErrors.client_email = 'Email is too long';
  else if (!EMAIL_RE.test(email)) fieldErrors.client_email = 'Please enter a valid email address';
  if (!phoneRaw) fieldErrors.client_phone = 'Please enter your mobile number';
  else if (!phone10) fieldErrors.client_phone = 'Please enter a valid 10-digit US mobile number';
  // The checkbox is REQUIRED on this form, unlike the quote wizard where it is
  // one optional field on a proposal submit. Signing up for texts is this
  // page's only purpose, so an unticked box is an unfinished form, not a
  // decline — which is also why this endpoint can never record a decline and
  // therefore never stamps the hard sms_opt_out_at.
  if (!consent || consent.consented !== true) {
    fieldErrors.sms_consent = 'Please check the box to agree to receive text messages';
  }
  if (Object.keys(fieldErrors).length) throw new ValidationError(fieldErrors);

  // Resolve the consent version BEFORE touching the database. This ordering is
  // security-relevant, not stylistic: recordSmsConsent checks the ownership gate
  // (`existing_client`) BEFORE it checks the version, so a version check made
  // after the DB work answers 503 for an unknown email and 200 for one that is
  // already a client — a side-effect-free membership oracle for "is this address
  // a Dr. Bartender client", reachable by anyone. Checking here makes the answer
  // identical for every email. (Deploy skew is the real cause of an unknown
  // version: Vercel ships the client bundle before Render ships the server, so a
  // browser can post a version this process does not know yet. We cannot say
  // what they agreed to, so record nothing and ask for a retry rather than show
  // a success screen for an opt-in that does not exist. Self-healing.)
  if (!getConsentCopy(consent.version)) {
    Sentry.captureMessage('sms consent not recorded', {
      level: 'warning',
      tags: { route: 'sms/opt-in', reason: 'unknown_version' },
      // Sliced: consentFieldsFromBody type-checks the version but never caps its
      // length, and the body limit is 1mb.
      extra: { version: String(consent.version).slice(0, 40) },
    });
    throw new AppError(
      'Text signup is briefly unavailable. Please try again in a few minutes.',
      503, 'SMS_CONSENT_VERSION_SKEW'
    );
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // UNAUTHENTICATED: findOrCreateClientDetailed never overwrites a non-null
    // field, and `created` is the ownership gate recordSmsConsent needs. It is
    // NOT purely a reader, though — on a phone+name match against a row whose
    // email IS NULL it backfills the submitted email onto that EXISTING row (the
    // wizard's "Jim fix"). That write is why the rollback below is not gated on
    // `created`; see the note there. source stays 'website' rather than a new
    // enum value — clients.source carries a CHECK constraint whose live
    // definition is a migration block in schema.sql (a sensitive path), and
    // sms_consent_log.source_form already distinguishes these rows.
    const { id: clientId, created } = await findOrCreateClientDetailed(dbClient, {
      name, email, phone: phone10, source: 'website',
    });

    const meta = requestMeta(req);
    const outcome = await recordSmsConsent(dbClient, {
      clientId,
      subjectIsNew: created,
      phone: phone10,
      consented: true,
      version: consent.version,
      sourceForm: 'sms_page',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    // NOTHING COMMITS UNLESS THIS SUBMIT RECORDED AN AFFIRMATIVE OPT-IN.
    //
    // Deliberately NOT gated on `created`, which was a real hole: on the
    // phone+name path findOrCreateClientDetailed backfills the submitted email
    // onto an EXISTING row and returns created=false, so recordSmsConsent
    // correctly refuses (`existing_client`) while the email write sailed through
    // to COMMIT. Since the client portal mails its login code to clients.email
    // (routes/clientAuth.js), that let anyone who knows a phone-only client's
    // name and mobile — both visible in a Thumbtack thread — attach their own
    // address to that client's row and take over their portal. Rolling back on
    // any non-applied outcome closes it: the ordinary email-match case wrote
    // nothing, so the rollback is a no-op there, and this form has no use for
    // the backfill (that exists for the wizard).
    //
    // It also covers the created-row case, which matters because clients
    // defaults communication_preferences.sms_enabled to TRUE, clientDedup's
    // INSERT never sets it, and that flag is the SOLE enforcement of an SMS
    // opt-out on the send path (no per-number suppression list; sendAndLogSms
    // sends whatever it is handed). A row we created whose consent did not
    // record would be SMS-on with no proof of consent — and on prior_opt_out, a
    // number under an active STOP. The wizard must keep such a row (a proposal
    // hangs off it) and settles for forcing sms_enabled=false; here nothing
    // depends on the row, so the whole submit goes back.
    if (!outcome.applied) {
      try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }

      // Only the anomalies are worth reporting. 'existing_client' is the ordinary
      // outcome for any returning client, and reporting it would fire on routine
      // submits and bury the cases worth reading. 'unknown_version' cannot reach
      // here (resolved before the transaction) and is listed for the day someone
      // moves that check back.
      const NOTABLE = new Set(['prior_opt_out', 'no_phone', 'unknown_version', 'no_client']);
      if (NOTABLE.has(outcome.reason)) {
        Sentry.captureMessage('sms consent not recorded', {
          level: 'info',
          tags: { route: 'sms/opt-in', reason: outcome.reason },
        });
      }

      // Generic success, same as the committed path. prior_opt_out means a STOP
      // is on record for this number (on this row or any row carrying it); only
      // the subscriber can lift that, by texting START, so a web form must not.
      // The success copy names START, so nobody is left without a route in, and
      // a per-outcome response would turn this form into an oracle for "is this
      // email one of your clients" / "has this number opted out".
      return res.json({ ok: true });
    }

    await dbClient.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }
}));

module.exports = router;
