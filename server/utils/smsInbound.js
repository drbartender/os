// Inbound-SMS processing for the Twilio webhook (POST /api/sms/inbound).
// Pure helpers here; DB-touching helpers and the orchestrator are appended
// in later tasks.

const { pool } = require('../db');
const Sentry = require('@sentry/node');
const { notifyAdminCategory } = require('./adminNotifications');
const { getEventTypeLabel } = require('./eventTypes');
const { chicagoTodayYmd } = require('./businessTime');
// The opt-keyword alert COPY lives in its own module: this file is at its size
// cap, and the wording is the substance of that fix, not decoration.
const { buildOptKeywordAlert } = require('./smsOptKeywordCopy');
// The one last-10-digit phone matcher, shared with smsShiftCommands.js so a
// phone matches the same way everywhere. It lives in phone.js because that
// module requires nothing, so anything can import it without a load cycle.
const { last10 } = require('./phone');
// The staff shift commands (CONFIRM, CANT and the shift pick they act on)
// live in smsShiftCommands.js since 2026-10-06; re-exported below unchanged.
const {
  findStaffCandidatesByPhone, findNearestApprovedShift, resolveShiftResponder,
  handleConfirm, handleCant, latestDrbTextWasAutomated,
} = require('./smsShiftCommands');
// Which DRB line a text came in on, and the per-phone opt-out record (spec
// 2026-10-06, Inbox). Neither requires this file, so there is no load cycle.
const { lineKeyForNumber } = require('./smsLines');
const { recordOptOut, clearOptOut } = require('./smsOptOut');

// Twilio's default opt-out keywords. STOPALL, OPTOUT and REVOKE joined on
// 2026-10-06 (spec Inbox, section 9): Twilio honors them, and the OS did not.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'end', 'cancel', 'quit', 'optout', 'revoke']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
// Only these two take a number off sms_optouts (spec 2026-10-06, amendment 32).
// YES stays in START_WORDS, so it still runs the preference opt-in as it always
// has; but on the toll-free 888 Twilio does not treat YES as an opt-in, so the
// OS record stays in force until an explicit START or UNSTOP.
const OPTOUT_CLEAR_WORDS = new Set(['start', 'unstop']);
// The two default HELP keywords a Twilio Advanced Opt-Out HELP response answers.
const HELP_WORDS = new Set(['help', 'info']);

// Shared "talk to a human" line for replies where this automated number cannot
// act. The 312 line is the company Google Voice number staffed by Dallas/Zul.
const HUMAN_CONTACT_LINE = 'contact Dallas or Zul at (312) 588-9401';
const AMBIGUOUS_RESPONSE_REPLY = `Dr. Bartender: we couldn't match this text to a single shift. Please ${HUMAN_CONTACT_LINE}.`;
const NO_CONFIRM_SHIFT_REPLY = `Dr. Bartender: we did not find an upcoming shift to confirm for you. Please ${HUMAN_CONTACT_LINE} if that seems wrong.`;
const NO_CANT_SHIFT_REPLY = `Dr. Bartender: we did not find an upcoming shift to release for you. Please ${HUMAN_CONTACT_LINE} if that seems wrong.`;
const FREEFORM_STAFF_REPLY = `Dr. Bartender: this number is automated. For anything else, please ${HUMAN_CONTACT_LINE}.`;
// Decision 17's admin note on a CONFIRM or CANT it turned into conversation.
const NOT_APPLIED_NOTE = 'It was not applied as a shift command because the latest text DRB sent them came from a person, or it came in on a 224 line. Answer them directly, and change the shift by hand if they meant it.';
// Carrier/CTIA-shaped HELP reply: brand, message scope, rate disclosure, opt-out
// keyword, and a support contact. Sent in code (not via Twilio Advanced Opt-Out)
// so the promise the client SMS consent copy makes ("HELP for help") does not
// depend on a console toggle.
const HELP_REPLY = 'Dr. Bartender: we text about your quote, booking, payments, and event details. Msg & data rates may apply. Reply STOP to opt out. Help: contact@drbartender.com';

/**
 * Classify a message body as an opt-out / opt-in keyword.
 * Matches only when the ENTIRE trimmed body is a single keyword (Twilio's
 * own STOP handling works the same way — "stop by later" is not an opt-out).
 *
 * @param {string} body
 * @returns {'stop'|'start'|null}
 */
function detectOptKeyword(body) {
  if (!body || typeof body !== 'string') return null;
  const word = body.trim().toLowerCase();
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

/**
 * Classify a message body as a HELP/INFO info request. Whole-body match only,
 * same discipline as detectOptKeyword ("help me" is free-form, not HELP). We
 * answer these in code rather than relying on Twilio Advanced Opt-Out, because
 * the client SMS consent copy promises "HELP for help".
 *
 * @param {string} body
 * @returns {'help'|null}
 */
function detectHelpKeyword(body) {
  if (!body || typeof body !== 'string') return null;
  return HELP_WORDS.has(body.trim().toLowerCase()) ? 'help' : null;
}

/**
 * Classify a message body as a staff shift response code (spec section 3).
 * Whole-body match only — a code buried in a sentence is treated as
 * free-form text and routed to the admin instead.
 *
 * @param {string} body
 * @returns {'confirm'|'cant'|null}
 */
function detectResponseCode(body) {
  if (!body || typeof body !== 'string') return null;
  const word = body.trim().toLowerCase().replace(/['’]/g, '');
  if (word === 'confirm') return 'confirm';
  if (word === 'cant') return 'cant';
  return null;
}

// ─── Thumbtack proxy-relay detection (spec 2026-06-11) ─────────────────────
// Leads created on or after this date carry a per-lead Thumbtack proxy number
// as customer_phone (rollout completed 2026-06-08). Pre-rollout leads hold the
// customer's REAL number, so they must never match: a real client texting in
// has to keep alerting. Explicit UTC instant; created_at is TIMESTAMPTZ.
const THUMBTACK_PROXY_ROLLOUT = '2026-06-08T00:00:00Z';

/**
 * Match an inbound sender number against post-rollout Thumbtack proxy numbers.
 * Returns the newest matching lead's client link, or null when not relay
 * traffic. Exported for reuse by the public proposal route (phone prefill).
 *
 * @param {string} phone - inbound E.164 number
 * @returns {Promise<{clientId:number|null}|null>}
 */
async function findThumbtackProxyLead(phone) {
  const key = last10(phone);
  if (!key) return null;
  const r = await pool.query(
    `SELECT client_id FROM thumbtack_leads
      WHERE RIGHT(REGEXP_REPLACE(customer_phone, '\\D', '', 'g'), 10) = $1
        AND created_at >= $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [key, THUMBTACK_PROXY_ROLLOUT]
  );
  return r.rows[0] ? { clientId: r.rows[0].client_id } : null;
}

// Test seam (mirrors thumbtack.js): lets the suite prove detection failures
// fail OPEN (message still alerts) without monkeypatching the pool.
// notifyAdminCategory rides the same seam so a suite can read the alert copy an
// admin would actually receive (lead-time label, SMS-or-email choice) instead
// of sending one; the default is the real sender.
let _deps = { findThumbtackProxyLead, notifyAdminCategory };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

/**
 * Resolve an inbound phone number to its sender. Clients are checked first.
 *
 * @param {string} fromPhone - the inbound E.164 number (Twilio `From`)
 * @returns {Promise<
 *   {type:'client', client:{id:number,name:string,phone:string,communication_preferences:object,phone_status:string}} |
 *   {type:'staff', staffUserId:number, staff:{id:number,communication_preferences:object}} |
 *   {type:'unknown'}
 * >}
 */
async function lookupSender(fromPhone) {
  const key = last10(fromPhone);
  if (!key) return { type: 'unknown' };

  const c = await pool.query(
    `SELECT id, name, phone, communication_preferences, phone_status
     FROM clients
     WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [key]
  );
  if (c.rows[0]) return { type: 'client', client: c.rows[0] };

  const s = await pool.query(
    // Blocked statuses mirror the auth middleware block-list (auth.js): a
    // deactivated/rejected/suspended account cannot use the portal, so it must
    // not be able to act on a shift by text either. COALESCE keeps NULL-status
    // (legacy) rows eligible.
    `SELECT u.id, u.communication_preferences
     FROM contractor_profiles cp
     JOIN users u ON u.id = cp.user_id
     WHERE RIGHT(REGEXP_REPLACE(cp.phone, '\\D', '', 'g'), 10) = $1
       AND COALESCE(u.onboarding_status, '') NOT IN ('deactivated', 'rejected', 'suspended')
     ORDER BY cp.updated_at DESC
     LIMIT 1`,
    [key]
  );
  if (s.rows[0]) return { type: 'staff', staffUserId: s.rows[0].id, staff: s.rows[0] };

  return { type: 'unknown' };
}

/**
 * Human-readable labels for staff user ids, for ADMIN-facing alert copy only.
 * These alerts used to say "A staff member", which left the reader guessing
 * from a phone number alone. Audience is internal, so this prefers the fullest
 * identification available (display name, else preferred name, else the login
 * email) rather than the client-facing display name on its own.
 *
 * Never throws and never blocks: an alert must still go out if this lookup
 * fails, so every failure path degrades to the bare "user <id>" it replaced.
 *
 * @param {number[]|number} userIds
 * @returns {Promise<string[]>} one label per id, input order preserved
 */
async function describeStaff(userIds) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds])
    .filter((id) => id !== null && id !== undefined);
  if (!ids.length) return [];
  try {
    const r = await pool.query(
      `SELECT u.id, u.email, cp.display_name, cp.preferred_name
         FROM users u
         LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
        WHERE u.id = ANY($1::int[])`,
      [ids]
    );
    const byId = new Map(r.rows.map((row) => [row.id, row]));
    return ids.map((id) => {
      const row = byId.get(id);
      const name = row && (row.display_name || row.preferred_name || row.email);
      return name ? `${name} (user ${id})` : `user ${id}`;
    });
  } catch {
    return ids.map((id) => `user ${id}`);
  }
}

/**
 * Insert an inbound message into sms_messages. For an inbound row,
 * recipient_phone holds the SENDER's number (the external party) so the
 * column reads as "the other party's phone" for both directions; client_id
 * is the canonical link for the thread UI. The body is truncated and the
 * sender phone is defaulted so a malformed Twilio payload cannot violate the
 * NOT NULL / length constraints.
 *
 * @param {Object} args
 * @param {string} args.fromPhone - inbound E.164 sender number
 * @param {string} [args.toPhone] - the DRB number texted (Twilio To)
 * @param {string} args.body - message text (may be empty)
 * @param {number|null} args.clientId - matched clients.id, or null
 * @param {string} [args.twilioSid] - Twilio MessageSid
 * @param {Array<{url:string, content_type:string|null}>} [args.media] - picture messages
 * @param {Object} [args.metadata] - extra metadata to merge
 * @returns {Promise<Object|null>} the inserted row, or null when a concurrent
 *   retry already recorded this twilio_sid
 */
async function recordInboundMessage({ fromPhone, toPhone, body, clientId, twilioSid, media, metadata }) {
  const phone = (fromPhone || 'unknown').slice(0, 50);
  const text = (body || '').slice(0, 2000);
  // metadata.to is the DRB number actually texted (spec 2026-10-06). A caller
  // with no To falls back to the 888, which is what every row said before.
  const meta = {
    from: fromPhone || null,
    to: toPhone ? String(toPhone).slice(0, 50) : (process.env.TWILIO_PHONE_NUMBER || null),
    ...(Array.isArray(media) && media.length ? { media } : {}),
    ...(metadata || {}),
  };
  // ON CONFLICT makes a concurrent Twilio retry that raced past the
  // processInboundSms SELECT-dedup a graceful no-op instead of a 23505 → 500.
  // The partial unique index idx_sms_messages_twilio_sid is the arbiter; a null
  // twilio_sid can't conflict, so it still inserts. Returns null on a conflict.
  // processed=false: an inbound row starts UNSETTLED and is flipped true only
  // after its side-effect succeeds (audit F1b strand heal). The column DEFAULT is
  // true, so this explicit false is what marks the row as needing settlement.
  const result = await pool.query(
    `INSERT INTO sms_messages
       (direction, client_id, recipient_phone, body, message_type, status, twilio_sid, metadata, processed)
     VALUES ('inbound', $1, $2, $3, 'general', 'received', $4, $5, false)
     ON CONFLICT (twilio_sid) WHERE twilio_sid IS NOT NULL DO NOTHING
     RETURNING *`,
    [clientId || null, phone, text, twilioSid || null, JSON.stringify(meta)]
  );
  return result.rows[0] || null;
}

/**
 * Flip an inbound row to processed=true once its side-effect has succeeded,
 * and stamp the outcome it settled with as metadata.outcome (spec 2026-10-06:
 * the Inbox reader skips a staff text that ran as a shift command). No-op
 * without a twilio_sid: a SID-less inbound can't be deduped or healed, and it
 * carries no outcome, so a reader treats it like a pre-2026-10-06 row.
 */
async function markProcessed(twilioSid, outcome) {
  if (!twilioSid) return;
  await pool.query(
    `UPDATE sms_messages
        SET processed = true,
            metadata = metadata || jsonb_build_object('outcome', $2::text)
      WHERE twilio_sid = $1 AND direction = 'inbound'`,
    [twilioSid, outcome]
  );
}

/**
 * Settle the inbound row (processed=true, outcome stamped) AFTER its
 * side-effect succeeded, then return the handler result. On a thrown
 * side-effect this is never reached, so the row stays processed=false and
 * Twilio's retry re-runs the (idempotent) handler, which is the heal.
 */
async function settle(twilioSid, result) {
  await markProcessed(twilioSid, result.outcome);
  return result;
}

/**
 * Record the inbound row and decide whether to run its side-effect (audit F1b):
 *  - fresh insert    -> true  (process it)
 *  - settled dup     -> false (a true replay; skip)
 *  - unsettled dup   -> true  (a prior attempt stranded it; re-run to heal)
 * The top-level dedupe already skips settled rows, so a conflict here is almost
 * always a strand; the re-check guards the narrow gap where a concurrent
 * delivery settled it between the dedupe SELECT and this insert. All inbound
 * side-effects are idempotent, so a re-run never double-applies.
 */
async function recordAndShouldProcess(args) {
  const row = await recordInboundMessage(args);
  if (row) return true;
  if (!args.twilioSid) return true;
  const ex = await pool.query(
    "SELECT processed FROM sms_messages WHERE twilio_sid = $1 AND direction = 'inbound' LIMIT 1",
    [args.twilioSid]
  );
  return !(ex.rows[0] && ex.rows[0].processed);
}

/**
 * Set communication_preferences.sms_enabled = <value> for the matched sender
 * and append a STOP/START audit timestamp. No-op for an unknown sender (a
 * number with no client/staff row). The audit path is a static literal
 * (auditPath is a controlled internal constant, not user input) because
 * jsonb_set requires a text[] path.
 *
 * @param {Object} sender - a lookupSender(...) result
 * @param {boolean} enabled
 */
async function setSmsEnabled(sender, enabled) {
  // Static-literal jsonb path — '{sms_opt_in_at}' or '{sms_opt_out_at}'.
  const auditPath = enabled ? "'{sms_opt_in_at}'" : "'{sms_opt_out_at}'";
  // COALESCE guards a NULL communication_preferences column.
  if (sender.type === 'client') {
    await pool.query(
      `UPDATE clients
       SET communication_preferences = jsonb_set(
             jsonb_set(COALESCE(communication_preferences, '{"sms_enabled":true,"marketing_enabled":true}'::jsonb), '{sms_enabled}', $2::jsonb),
             ${auditPath}, to_jsonb(NOW()::text))
       WHERE id = $1`,
      [sender.client.id, JSON.stringify(enabled)]
    );
  } else if (sender.type === 'staff') {
    await pool.query(
      `UPDATE users
       SET communication_preferences = jsonb_set(
             jsonb_set(COALESCE(communication_preferences, '{"sms_enabled":true,"marketing_enabled":true}'::jsonb), '{sms_enabled}', $2::jsonb),
             ${auditPath}, to_jsonb(NOW()::text))
       WHERE id = $1`,
      [sender.staffUserId, JSON.stringify(enabled)]
    );
  }
  // sender.type === 'unknown' → nothing to update
}

/** Opt the sender OUT of SMS (STOP keyword). */
async function applyOptOut(sender) {
  await setSmsEnabled(sender, false);
}

/** Opt the sender back IN to SMS (START keyword). */
async function applyOptIn(sender) {
  await setSmsEnabled(sender, true);
}

/** Escape HTML metacharacters so untrusted inbound text is safe in email HTML. */
function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** " (1 attachment)" or " (N attachments)" after an alert's quoted body; Twilio media is not always a picture. */
function attachmentNote(media) {
  const n = Array.isArray(media) ? media.length : 0;
  return n ? ` (${n} attachment${n === 1 ? '' : 's'})` : '';
}

/** Run an alert send without letting a failure escape. */
async function safeAlert(label, fn) {
  try {
    await fn();
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { feature: 'sms-inbound-alert', alert: label } });
    }
    console.error(`[smsInbound] admin alert "${label}" failed (non-blocking):`, err.message);
  }
}

/** Notify subscribed admins that a client texted in (urgent_client_reply). */
async function alertInboundClient(client, body, media) {
  await safeAlert('inbound_client', async () => {
    const name = client.name || 'A client';
    // Truncate the inbound text so the outbound alert SMS cannot exceed
    // Twilio's 1600-char limit and fail to send.
    const snippet = (body || '').slice(0, 600);
    const line = `${name} texted Dr. Bartender: "${snippet}"${attachmentNote(media)}. Reply in the admin Messages page.`;
    await _deps.notifyAdminCategory({
      category: 'urgent_client_reply',
      subject: `${name} replied by text`,
      emailHtml: `<p>${escapeHtml(line)}</p>`,
      emailText: line,
      smsBody: line,
    });
  });
}

/**
 * The calendar day of a bare SQL DATE column, as YYYY-MM-DD. pg builds a DATE
 * at LOCAL midnight, so toISOString() recovers the same calendar day on any
 * machine at or west of UTC (Render is UTC, the dev box is Chicago). Same
 * reasoning and same limit as paystubData.js ymd(). Never pass a TIMESTAMPTZ
 * through here — use chicagoYmdOf() for a true instant.
 */
function dateColumnYmd(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days from one YYYY-MM-DD to another. Mirrors
 *  wholeDaysBetween() in routes/proposals/cancel.js. */
function wholeDaysBetween(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) return 0;
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const [ty, tm, td] = toYmd.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

/**
 * Alert the admin that a staffer texted CANT. Channel by lead time: event
 * under 7 days out and ADMIN_PHONE configured fires SMS (urgent); otherwise
 * fires email. The alert is dropped only if BOTH ADMIN_PHONE and ADMIN_EMAIL
 * are unset.
 *
 * LEAD TIME IS COUNTED IN CHICAGO CALENDAR DAYS ON BOTH SIDES. It used to
 * subtract Date.now() from the pg DATE, which pg materializes at LOCAL
 * midnight: a drop at 19:30 Chicago on the DAY of the event came out at -0.81
 * days, floored to -1, and the most urgent drop there is — "they just bailed on
 * tonight" — was labelled "past due", which reads as an event that already
 * happened and nothing to scramble for. That case is precisely what this spec
 * makes reachable (findNearestApprovedShift now matches an evening-of shift up
 * to its end instant), so it went from unreachable to the flagship path.
 *
 * @param {Object} cant - a successful handleCant(...) result
 */
async function alertStaffCant(cant) {
  await safeAlert('staff_cant', async () => {
    const eventYmd = dateColumnYmd(cant.eventDate);
    const daysOut = wholeDaysBetween(chicagoTodayYmd(), eventYmd);
    const eventLabel = getEventTypeLabel({ event_type: cant.eventType, event_type_custom: cant.eventTypeCustom });
    const who = cant.clientName ? `${eventLabel} for ${cant.clientName}` : `shift #${cant.shiftId}`;
    // shifts.event_date is NOT NULL and findNearestApprovedShift filters on it,
    // so eventYmd is always present in practice; the guard just keeps a
    // can't-happen null out of the admin's alert as "Invalid Date (TODAY)".
    const dateStr = eventYmd
      ? new Date(`${eventYmd}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' })
      : 'an unknown date';
    const outLabel = !eventYmd ? 'date unknown'
      : daysOut < 0 ? 'past due'
        : daysOut === 0 ? 'TODAY'
          : daysOut === 1 ? 'tomorrow'
            : `${daysOut} days out`;

    // Always email subscribed admins. An event under 7 days out is urgent
    // enough to also text them. notifyAdminCategory sends SMS only when
    // smsBody is provided, so the lead-time branch just gates that argument.
    const smsLine = `Staffing alert: a bartender dropped the ${who} on ${dateStr} (${outLabel}). The shift is re-opened and needs restaffing.`;
    await _deps.notifyAdminCategory({
      category: 'urgent_staffing',
      subject: `Bartender dropped the ${dateStr} shift`,
      emailHtml: `<p>A bartender texted CANT for the <strong>${escapeHtml(who)}</strong> on <strong>${escapeHtml(dateStr)}</strong> (${escapeHtml(outLabel)}).</p><p>The shift has been re-opened and needs restaffing. It will show as unstaffed on the Events dashboard.</p>`,
      emailText: `A bartender texted CANT for the ${who} on ${dateStr} (${outLabel}). The shift has been re-opened and needs restaffing.`,
      ...(daysOut < 7 ? { smsBody: smsLine } : {}),
    });
  });
}

/**
 * Tell the admin an opt keyword arrived and what the system did with it.
 *
 * The compliance action has ALREADY run by the time this fires — that ordering
 * is deliberate, so the copy can state what happened rather than what is about
 * to. Like every alert here it runs through safeAlert, so a dead Resend or a
 * Twilio failure can never block a carrier-mandated opt-out.
 *
 * Fires for EVERY opt keyword, not only the ambiguous ones: an opt-out changes
 * how DRB is allowed to reach someone who may have a live booking, and that is
 * operational news even when they typed a plain STOP. Volume makes that cheap —
 * prod has seen seven opt keywords in the two months to 2026-08-25.
 *
 * Channel matches what an inbound from that sender would already have got: a
 * client is urgent_client_reply (email + SMS, same as alertInboundClient), and
 * anyone else is the routine email path.
 */
async function alertOptKeyword({ sender, from, body, optKeyword }) {
  const isClient = sender.type === 'client';
  // detectOptKeyword matches only when the WHOLE trimmed body is one keyword,
  // so this is the keyword itself; the slice is belt-and-braces against a
  // future looser matcher putting unbounded text into an SMS.
  const word = (body || '').trim().slice(0, 100);
  // Name a staffer the way the other staff alerts here do. A bartender who opts
  // out stops receiving the CANT/CONFIRM prompts their shifts depend on, so
  // "which one" is the whole content of that alert. describeStaff never throws.
  const staffWho = sender.type === 'staff' ? (await describeStaff(sender.staffUserId))[0] : null;
  const who = isClient
    ? (sender.client.name || 'A client')
    : (staffWho || (sender.type === 'staff' ? 'A staff member' : 'An unrecognized number'));
  const { subject, line } = buildOptKeywordAlert({
    senderType: sender.type, who, word, optKeyword, from,
    isClearingWord: optKeyword === 'start' && OPTOUT_CLEAR_WORDS.has(word.toLowerCase()),
  });

  if (isClient) {
    await safeAlert('opt_keyword', async () => {
      await _deps.notifyAdminCategory({
        category: 'urgent_client_reply',
        subject,
        emailHtml: `<p>${escapeHtml(line)}</p>`,
        emailText: line,
        smsBody: line,
      });
    });
    return;
  }
  await alertAdminEmail(subject, line);
}

/** Notify subscribed admins about an inbound text the system took no action on. */
async function alertAdminEmail(subject, body) {
  await safeAlert('admin_email', async () => {
    await _deps.notifyAdminCategory({
      category: 'routine_admin',
      subject,
      emailHtml: `<p>${escapeHtml(body)}</p>`,
      emailText: body,
    });
  });
}

/** Format a date for staff-facing reply copy, e.g. "June 15". */
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

/**
 * Orchestrate one inbound SMS: classify, look up the sender, store the row,
 * run keyword/response-code actions, dispatch admin alerts. Returns a short
 * `outcome` for logging plus an optional `reply`. Never throws for an expected
 * condition. Dedupes on `twilioSid`: a re-delivered MessageSid is a no-op.
 *
 * Line-aware (spec 2026-10-06, Inbox): every recorded row carries the DRB
 * number that was texted (metadata.to) and any picture media, and settles
 * with its outcome. A STOP-set word writes sms_optouts and START or UNSTOP
 * clears it (a YES does not), for every sender on every line.
 *
 * @param {Object} args
 * @param {string} args.from - inbound E.164 number
 * @param {string} [args.to] - the DRB number texted (Twilio `To`)
 * @param {string} args.body - message text
 * @param {string} [args.twilioSid]
 * @param {Array<{url:string, content_type:string|null}>} [args.media] - picture messages
 * @returns {Promise<{outcome:string, reply:string|null}>}
 */
async function processInboundSms({ from, to, body, twilioSid, media }) {
  const text = (body || '').trim();
  // A To that is not one of our lines is stored as-is and treated as the 888.
  const line = lineKeyForNumber(to) || '888';
  // What every recorded row shares: who texted, which number, any pictures.
  const base = { fromPhone: from, toPhone: to, media, twilioSid };

  // Idempotency + strand heal (audit F1b): only a SETTLED (processed=true) row
  // short-circuits as a true replay. An unsettled row — a prior attempt that
  // recorded then failed before its side-effect committed — falls through so
  // Twilio's retry re-runs the idempotent handler instead of losing the action.
  if (twilioSid) {
    const dup = await pool.query(
      "SELECT 1 FROM sms_messages WHERE twilio_sid = $1 AND direction = 'inbound' AND processed = TRUE LIMIT 1",
      [twilioSid]
    );
    if (dup.rowCount > 0) return { outcome: 'duplicate', reply: null };
  }

  const sender = await lookupSender(from);

  // Thumbtack relay traffic: Thumbtack pings our Twilio number from per-lead
  // proxy numbers ("X replied to you on Thumbtack...", access-code challenges,
  // conversation echoes). Record for audit, tagged, with NO alerts: Thumbtack
  // already notifies the admin directly (app push, SMS to the GV line, email).
  // Fail OPEN: a detection error must never silence a real client, so any
  // throw falls through to the normal alerting paths below.
  let proxyLead = null;
  try {
    proxyLead = await _deps.findThumbtackProxyLead(from);
  } catch (detectErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(detectErr, { tags: { feature: 'sms-inbound', step: 'thumbtack_relay_detect' } });
    }
    console.error('[smsInbound] thumbtack relay detection failed (failing open):', detectErr.message);
  }
  if (proxyLead) {
    // Client link: prefer the live clients.phone match; after real-number
    // capture the proxy no longer matches a client row, so fall back to the
    // lead's client_id. Skipped on purpose: the client's STOP/START preference
    // (opt semantics do not transfer from a proxy), all alerts, all auto-replies.
    const relayClientId = sender.type === 'client' ? sender.client.id : (proxyLead.clientId || null);
    // A proxy's STOP is still a STOP to this line from that number, and Twilio
    // now blocks it, so the per-phone record covers it like any sender's
    // (decision 10). The client's preference is left alone.
    const relayOpt = detectOptKeyword(text);
    const proceed = await recordAndShouldProcess({
      ...base,
      body: text,
      clientId: relayClientId,
      metadata: relayOpt ? { thumbtack_relay: true, opt_keyword: relayOpt } : { thumbtack_relay: true },
    });
    if (!proceed) return { outcome: 'duplicate', reply: null };
    if (relayOpt === 'stop') await recordOptOut({ phone: from, source: 'keyword', line });
    if (relayOpt === 'start' && OPTOUT_CLEAR_WORDS.has(text.toLowerCase())) await clearOptOut({ phone: from });
    console.log(`[smsInbound] thumbtack_relay suppressed (sender ...${(last10(from) || '').slice(-4)}, client ${relayClientId || 'none'})`);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.addBreadcrumb({
        category: 'sms-inbound',
        message: 'thumbtack_relay suppressed',
        level: 'info',
        data: { clientId: relayClientId },
      });
    }
    return settle(twilioSid, { outcome: 'thumbtack_relay', reply: null });
  }

  // STOP/START — handled before sender-type branching, for any sender. We
  // record the preference internally and tag metadata for audit. We do NOT
  // send our own reply: US carrier rules make Twilio send the mandated
  // STOP/START compliance reply itself.
  //
  // This branch used to return here, before any alert, so a matching message
  // produced no admin alert, no reply and a silent preference flip — and four
  // of the mandated keywords ("cancel", "end", "quit", "yes") are words a
  // client plausibly means literally. A client texting "Cancel" about their
  // event was unsubscribed and nobody was told. The compliance action still
  // runs first and unchanged; it is now followed by an alert a human sees.
  const optKeyword = detectOptKeyword(text);
  if (optKeyword) {
    const clientId = sender.type === 'client' ? sender.client.id : null;
    const proceed = await recordAndShouldProcess({ ...base, body: text, clientId, metadata: { opt_keyword: optKeyword } });
    if (!proceed) return { outcome: 'duplicate', reply: null };
    // The preference (a known client or staffer) and the per-phone record (any
    // sender, unknown numbers included) both land BEFORE the alert. Both are
    // idempotent, so a throw here leaves the row unsettled for Twilio's retry.
    if (optKeyword === 'stop') {
      await applyOptOut(sender);
      await recordOptOut({ phone: from, source: 'keyword', line });
    } else {
      await applyOptIn(sender);
      // A YES runs the preference opt-in but never clears the record (amendment 32).
      if (OPTOUT_CLEAR_WORDS.has(text.toLowerCase())) await clearOptOut({ phone: from });
    }
    await alertOptKeyword({ sender, from, body: text, optKeyword });
    return settle(twilioSid, { outcome: `opt_${optKeyword}`, reply: null });
  }

  // HELP/INFO — a mandated info reply, handled before sender-type branching for
  // any sender and answered even after an opt-out. Twilio does not auto-reply to
  // HELP unless Advanced Opt-Out is enabled console-side, so we send our own copy
  // via TwiML (the route renders `reply`). Recorded + deduped like STOP/START; it
  // never changes an opt preference.
  const helpKeyword = detectHelpKeyword(text);
  if (helpKeyword) {
    const clientId = sender.type === 'client' ? sender.client.id : null;
    const proceed = await recordAndShouldProcess({ ...base, body: text, clientId, metadata: { help_keyword: true } });
    if (!proceed) return { outcome: 'duplicate', reply: null };
    return settle(twilioSid, { outcome: 'help', reply: HELP_REPLY });
  }

  // Record the message (client_id set only for a client sender). Heal-aware: an
  // unsettled prior record (stranded by a failed side-effect) is re-processed.
  const clientId = sender.type === 'client' ? sender.client.id : null;
  const proceed = await recordAndShouldProcess({ ...base, body: text, clientId });
  if (!proceed) return { outcome: 'duplicate', reply: null };

  if (sender.type === 'client') {
    // No auto-reply to clients — the admin replies personally from the
    // Messages page. We just alert the admin a client texted in.
    await alertInboundClient(sender.client, text, media);
    return settle(twilioSid, { outcome: 'client_message', reply: null });
  }

  if (sender.type === 'staff') {
    // Decision 17 (spec 2026-10-06, Inbox): CONFIRM, CANT and the automated
    // staff replies run only on the 888, and only when the latest text DRB sent
    // this staffer was automated. On a 224 line, or after a human text, every
    // staff text is conversation: stored, emailed to the admin, answered by a
    // person. Otherwise a "Can't" answering Zul's "Can you cover Saturday?"
    // would release the staffer's own shift.
    const commandLane = line === '888'
      && await latestDrbTextWasAutomated({ staffUserId: sender.staffUserId, phone: from });
    if (!commandLane) {
      const convoWho = await describeStaff(sender.staffUserId);
      // A CONFIRM or CANT it did not apply says so in the subject, so a real
      // drop never reads like any other text. Still the routine email, no SMS.
      const convoCode = detectResponseCode(text);
      await alertAdminEmail(
        convoCode ? `Staff texted ${convoCode.toUpperCase()} but no shift was changed` : 'Staff texted Dr. Bartender',
        `${convoWho.join('; ') || 'A staff member'} texted the ${line} line from ${from}: "${text}"${attachmentNote(media)}. It was treated as conversation, so no shift was changed and no automated reply was sent.${convoCode ? ` ${NOT_APPLIED_NOTE}` : ''}`);
      return settle(twilioSid, { outcome: 'conversation', reply: null });
    }
    const code = detectResponseCode(text);
    if (code === 'confirm' || code === 'cant') {
      // A phone can match more than one active staff account (e.g. a shared
      // company line). Re-resolve from scratch here rather than trusting
      // sender.staffUserId (lookupSender's single most-recently-updated pick,
      // which is exactly what mis-routed the original bug): disambiguate by
      // which staffer actually has a matching upcoming approved shift, and
      // never guess when more than one does.
      const candidates = await findStaffCandidatesByPhone(from);
      const resolved = await resolveShiftResponder(candidates);

      if (resolved.status === 'ambiguous') {
        const ambiguousWho = await describeStaff(resolved.userIds);
        await alertAdminEmail(`Ambiguous staff ${code.toUpperCase()} text`,
          `A "${text}" text from ${from} matched multiple active staff with upcoming shifts: ${ambiguousWho.join('; ')}. No shift was changed; please follow up.`);
        return settle(twilioSid, { outcome: `staff_${code}_ambiguous`, reply: AMBIGUOUS_RESPONSE_REPLY });
      }

      if (code === 'confirm') {
        if (resolved.status === 'no_shift') {
          return settle(twilioSid, { outcome: 'staff_confirm_no_shift', reply: NO_CONFIRM_SHIFT_REPLY });
        }
        const r = await handleConfirm(resolved.staffUserId);
        const reply = r.ok
          ? `Confirmed from Dr. Bartender: you're acknowledged for the ${fmtDate(r.eventDate)} shift${r.clientName ? ' (' + r.clientName + ')' : ''}. See you there.`
          : NO_CONFIRM_SHIFT_REPLY;
        return settle(twilioSid, { outcome: r.ok ? 'staff_confirm' : 'staff_confirm_no_shift', reply });
      }

      // code === 'cant'
      if (resolved.status === 'no_shift') {
        const noShiftWho = await describeStaff(candidates);
        await alertAdminEmail('Staff texted CANT but has no upcoming shift',
          `${noShiftWho.join('; ') || 'An unidentified staff account'} texted CANT from ${from}, but the system found no approved upcoming shift for them. Inbound text: "${text}"`);
        return settle(twilioSid, { outcome: 'staff_cant_no_shift', reply: NO_CANT_SHIFT_REPLY });
      }
      const cant = await handleCant(resolved.staffUserId, twilioSid);
      if (cant.ok) {
        await alertStaffCant(cant);
        return {
          outcome: 'staff_cant',
          reply: `Got it from Dr. Bartender: you are off the ${fmtDate(cant.eventDate)} shift${cant.clientName ? ' (' + cant.clientName + ')' : ''}. We will take it from here.`,
        };
      }
      // The resolver saw a matching shift but handleCant did not: it was
      // released or changed between the two reads (cover swap accepted, admin
      // edit, etc.). Flag this distinctly so an admin is not sent chasing a
      // "never had a shift" trail.
      const raceWho = await describeStaff(resolved.staffUserId);
      await alertAdminEmail('Staff CANT could not be applied (shift changed mid-request)',
        `${raceWho.join('; ') || 'A staff member'} texted CANT from ${from} and had a matching upcoming shift, but it was already released or changed before we could act. Inbound text: "${text}"`);
      return settle(twilioSid, { outcome: 'staff_cant_race', reply: NO_CANT_SHIFT_REPLY });
    }
    // Free-form staff text — route to admin, redirect the texter.
    const freeformWho = await describeStaff(sender.staffUserId);
    await alertAdminEmail('Staff texted Dr. Bartender',
      `${freeformWho.join('; ') || 'A staff member'} texted from ${from}: "${text}". No response code matched, so no system action was taken.`);
    return settle(twilioSid, {
      outcome: 'staff_freeform',
      reply: FREEFORM_STAFF_REPLY,
    });
  }

  // Unknown sender.
  await alertAdminEmail('Text from an unknown number',
    `An unrecognized number (${from}) texted Dr. Bartender: "${text}"${attachmentNote(media)}.`);
  return settle(twilioSid, { outcome: 'unknown_sender', reply: null });
}

module.exports = {
  detectOptKeyword,
  detectHelpKeyword,
  detectResponseCode,
  last10,
  lookupSender,
  findStaffCandidatesByPhone,
  resolveShiftResponder,
  recordInboundMessage,
  applyOptOut,
  applyOptIn,
  handleConfirm,
  findNearestApprovedShift,
  handleCant,
  latestDrbTextWasAutomated,
  alertInboundClient,
  alertOptKeyword,
  alertStaffCant,
  alertAdminEmail,
  processInboundSms,
  findThumbtackProxyLead,
  __setDeps,
};
