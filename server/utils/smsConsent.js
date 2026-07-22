const { getConsentCopy } = require('../data/smsConsentCopy');
const { validatePhone } = require('./phone');

/**
 * Pull the consent fields off a request body.
 *
 * Accepts boolean `true` OR the exact string `'true'`, and nothing else. The
 * quote wizard posts JSON, so a real boolean is what arrives today; the string
 * form is accepted because any multipart caller stringifies every field, and a
 * strict `=== true` check would then silently drop a real opt-in.
 *
 * The whitelist stays exactly those two so no other truthy value ('yes', '1',
 * 'on', a stray object) can opt someone in. Consent is the one field where a
 * generous coercion is a compliance problem, not a convenience.
 *
 * Returns null when the body carries no consent field at all, which is how an
 * older cached client bundle stays harmless.
 *
 * copy_text is deliberately NOT read. The audit record resolves its own text.
 *
 * @param {Object} body
 * @returns {{consented: boolean, version: string}|null}
 */
function consentFieldsFromBody(body) {
  if (!body || body.sms_consent === undefined || body.sms_consent === null) return null;
  return {
    consented: body.sms_consent === true || body.sms_consent === 'true',
    version: typeof body.sms_consent_version === 'string' ? body.sms_consent_version : '',
  };
}

/**
 * Best-effort request metadata for the audit row.
 * @param {Object} req
 * @returns {{ip: string|null, userAgent: string|null}}
 */
function requestMeta(req) {
  if (!req) return { ip: null, userAgent: null };
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || null;
  const ua = (req.get && req.get('user-agent')) || null;
  return {
    ip: ip ? String(ip).slice(0, 100) : null,
    userAgent: ua ? String(ua).slice(0, 500) : null,
  };
}

/**
 * Persist a client's SMS consent answer: flip the preference, stamp the audit
 * timestamp, and append a proof row.
 *
 * The preference write mirrors setSmsEnabled in server/utils/smsInbound.js so
 * a form answer and an inbound STOP land in the same shape. The audit path is
 * a static literal because jsonb_set needs a text[] path; it is a controlled
 * internal constant, never user input.
 *
 * The log is a record of consent CHANGES, not of page submits: an unchanged
 * repeat (same value, same version) appends nothing, so a client who edits and
 * resubmits a quote does not accumulate identical rows.
 *
 * CLIENTS ONLY, by scope decision. Staff SMS consent already exists on the
 * contractor agreement (agreements.sms_consent) and is what
 * server/routes/messages.js gates staff sends on; routing staff through here
 * too would create a second, competing gate.
 *
 * @param {Object} db pg pool or an in-transaction client
 * @param {Object} opts
 * @param {number} opts.clientId
 * @param {boolean} opts.subjectIsNew REQUIRED. True only when this same submit
 *   INSERTed the client row (`findOrCreateClientDetailed().created`). This is
 *   the ownership gate; omitting it yields `undefined`, which is falsy, and the
 *   call becomes a permanent silent no-op.
 * @param {string} opts.phone raw; normalized here via validatePhone
 * @param {boolean} opts.consented
 * @param {string} opts.version
 * @param {string} opts.sourceForm currently always 'quote_wizard'
 * @param {string} [opts.ip]
 * @param {string} [opts.userAgent]
 * @returns {Promise<{applied: boolean, logged: boolean, reason: string}>}
 *   `reason` is one of: no_client, existing_client, unknown_version, no_phone,
 *   prior_opt_out, unchanged, recorded. Callers use it to decide what is worth
 *   reporting; see the Sentry branch in routes/proposals/public.js.
 */
async function recordSmsConsent(db, {
  clientId, subjectIsNew, phone, consented, version, sourceForm, ip = null, userAgent = null,
}) {
  if (!clientId) return { applied: false, logged: false, reason: 'no_client' };

  // THE OWNERSHIP RULE. findOrCreateClient resolves an existing row by email
  // ALONE, and this endpoint is unauthenticated, so knowing a stranger's email
  // is enough to be handed their row. A submitter proves nothing about a row
  // they did not create: writing to one would let anyone flip a real client's
  // SMS on or off, resurrect an opt-out they never made, and append a forged
  // row to the very log we would hand a carrier. So a public form may write
  // ONLY to a row this same submit inserted. Existing clients stay grandfathered
  // on whatever preference they already had. See clientDedup.js, which states
  // the same rule for the phone field: "Email is trusted only to RESOLVE the
  // row, never to mutate it."
  if (!subjectIsNew) return { applied: false, logged: false, reason: 'existing_client' };

  const copyText = getConsentCopy(version);
  // An unknown version means we cannot say what they agreed to, so we record
  // nothing rather than record a lie. Nothing is thrown: a stale client bundle
  // must never break a submit. Callers should report this, though — see the
  // Sentry breadcrumb at the public.js call site.
  if (!copyText) return { applied: false, logged: false, reason: 'unknown_version' };

  // The consent sentence says "at the mobile number provided". With no usable
  // number there is no subject to consent, and the audit row would prove
  // nothing to a carrier. Normalizing here (rather than storing the raw body
  // value) is also what makes the phone index on sms_consent_log usable: the
  // rest of the codebase looks phones up as 10 normalized digits.
  const { value: phone10 } = validatePhone(phone);
  if (!phone10) return { applied: false, logged: false, reason: 'no_phone' };

  const DEFAULT_PREFS = '\'{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}\'::jsonb';
  const auditPath = consented ? "'{sms_opt_in_at}'" : "'{sms_opt_out_at}'";

  const upd = await db.query(
    `UPDATE clients
     SET communication_preferences = jsonb_set(
           jsonb_set(COALESCE(communication_preferences, ${DEFAULT_PREFS}), '{sms_enabled}', $2::jsonb),
           ${auditPath}, to_jsonb(NOW()::text))
     WHERE id = $1
       -- Defense in depth behind the subjectIsNew gate: an inbound STOP is a
       -- hard opt-out that only the subject may lift, so no web form ever
       -- overrides one. A freshly inserted row cannot carry this stamp, so this
       -- predicate is invisible on the live path and guards future callers.
       AND communication_preferences->'sms_opt_out_at' IS NULL
       -- ...and the same check scoped to the NUMBER, not just this row.
       -- subjectIsNew proves the submitter owns the ROW, which is not the same
       -- as owning the phone: anyone can pair a throwaway email with someone
       -- else's real number, get a brand-new row, and sail through the gate
       -- above. Consent evidence is keyed by phone and a carrier dispute
       -- arrives as a phone, so a STOP on ANY row carrying this number blocks
       -- the write. Uses the same normalized form as idx_clients_phone_normalized.
       AND NOT EXISTS (
         SELECT 1 FROM clients v
          WHERE RIGHT(REGEXP_REPLACE(COALESCE(v.phone, ''), '\\D', '', 'g'), 10) = $3
            AND v.communication_preferences->'sms_opt_out_at' IS NOT NULL
       )`,
    [clientId, JSON.stringify(consented), phone10]
  );
  if (upd.rowCount !== 1) return { applied: false, logged: false, reason: 'prior_opt_out' };

  const prior = await db.query(
    `SELECT consented, copy_version, phone FROM sms_consent_log
      WHERE client_id = $1
      ORDER BY id DESC LIMIT 1`,
    [clientId]
  );
  const last = prior.rows[0];
  // Consent evidence is per NUMBER, not per person, so a changed phone always
  // earns its own row even when the answer and the copy version are unchanged.
  if (last && last.consented === consented && last.copy_version === version && last.phone === phone10) {
    return { applied: true, logged: false, reason: 'unchanged' };
  }

  await db.query(
    `INSERT INTO sms_consent_log
       (client_id, phone, consented, copy_version, copy_text, source_form, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [clientId, phone10, consented, version, copyText, sourceForm, ip, userAgent]
  );

  return { applied: true, logged: true, reason: 'recorded' };
}

module.exports = { recordSmsConsent, consentFieldsFromBody, requestMeta };
