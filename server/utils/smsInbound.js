// Inbound-SMS processing for the Twilio webhook (POST /api/sms/inbound).
// Pure helpers here; DB-touching helpers and the orchestrator are appended
// in later tasks.

const { pool } = require('../db');
const Sentry = require('@sentry/node');
const { notifyAdminCategory } = require('./adminNotifications');
const { getEventTypeLabel } = require('./eventTypes');
const { releaseOutOfAreaLock, reaccrueDutyForProposal } = require('./serviceArea');
const { chicagoTodayYmd } = require('./businessTime');
// The opt-keyword alert COPY lives in its own module: this file is at its size
// cap, and the wording is the substance of that fix, not decoration.
const { buildOptKeywordAlert } = require('./smsOptKeywordCopy');
// THE shift-visibility predicate — see server/utils/shiftEndInstant.js.
const { shiftNotFinishedSql, shiftEndInstantSql } = require('./shiftEndInstant');

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'end', 'cancel', 'quit']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
// The two default HELP keywords a Twilio Advanced Opt-Out HELP response answers.
const HELP_WORDS = new Set(['help', 'info']);

// Shared "talk to a human" line for replies where this automated number cannot
// act. The 312 line is the company Google Voice number staffed by Dallas/Zul.
const HUMAN_CONTACT_LINE = 'contact Dallas or Zul at (312) 588-9401';
const AMBIGUOUS_RESPONSE_REPLY = `Dr. Bartender: we couldn't match this text to a single shift. Please ${HUMAN_CONTACT_LINE}.`;
const NO_CONFIRM_SHIFT_REPLY = `Dr. Bartender: we did not find an upcoming shift to confirm for you. Please ${HUMAN_CONTACT_LINE} if that seems wrong.`;
const NO_CANT_SHIFT_REPLY = `Dr. Bartender: we did not find an upcoming shift to release for you. Please ${HUMAN_CONTACT_LINE} if that seems wrong.`;
const FREEFORM_STAFF_REPLY = `Dr. Bartender: this number is automated. For anything else, please ${HUMAN_CONTACT_LINE}.`;
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

/**
 * Extract the last 10 digits of a phone number for matching. Inbound numbers
 * arrive E.164 (+1XXXXXXXXXX); stored numbers are free-text. Returns null when
 * fewer than 10 digits are present.
 *
 * @param {string} phone
 * @returns {string|null}
 */
function last10(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
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
 * Return the ids of every ACTIVE staff account whose contractor_profiles phone
 * matches an inbound number (by last-10 digits). A shared line (e.g. a company
 * Google Voice number) can map to several accounts. Blocked statuses
 * (deactivated/rejected/suspended, mirroring the auth.js block-list) are excluded
 * so a stale account can never win the match; COALESCE keeps NULL-status legacy
 * rows eligible. contractor_profiles.user_id is UNIQUE, so this is one row per
 * user without DISTINCT. ORDER BY makes the LIMIT cap deterministic across Twilio
 * retries, and the cap stops a placeholder/shared number spread across many rows
 * from piling up enough per-candidate work to blow the webhook timeout.
 *
 * @param {string} fromPhone - inbound E.164 number
 * @returns {Promise<number[]>} matching active user ids (may be empty)
 */
async function findStaffCandidatesByPhone(fromPhone) {
  const key = last10(fromPhone);
  if (!key) return [];
  const r = await pool.query(
    `SELECT u.id
       FROM contractor_profiles cp
       JOIN users u ON u.id = cp.user_id
      WHERE RIGHT(REGEXP_REPLACE(cp.phone, '\\D', '', 'g'), 10) = $1
        AND COALESCE(u.onboarding_status, '') NOT IN ('deactivated', 'rejected', 'suspended')
      ORDER BY cp.updated_at DESC
      LIMIT 25`,
    [key]
  );
  return r.rows.map((row) => row.id);
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
 * @param {string} args.body - message text (may be empty)
 * @param {number|null} args.clientId - matched clients.id, or null
 * @param {string} [args.twilioSid] - Twilio MessageSid
 * @param {Object} [args.metadata] - extra metadata to merge
 * @returns {Promise<Object|null>} the inserted row, or null when a concurrent
 *   retry already recorded this twilio_sid
 */
async function recordInboundMessage({ fromPhone, body, clientId, twilioSid, metadata }) {
  const phone = (fromPhone || 'unknown').slice(0, 50);
  const text = (body || '').slice(0, 2000);
  const meta = { from: fromPhone || null, to: process.env.TWILIO_PHONE_NUMBER || null, ...(metadata || {}) };
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
 * Flip an inbound row to processed=true once its side-effect has succeeded.
 * No-op without a twilio_sid (a SID-less inbound can't be deduped or healed).
 */
async function markProcessed(twilioSid) {
  if (!twilioSid) return;
  await pool.query(
    "UPDATE sms_messages SET processed = true WHERE twilio_sid = $1 AND direction = 'inbound'",
    [twilioSid]
  );
}

/**
 * Settle the inbound row (processed=true) AFTER its side-effect succeeded, then
 * return the handler result. On a thrown side-effect this is never reached, so
 * the row stays processed=false and Twilio's retry re-runs the (idempotent)
 * handler — that is the heal.
 */
async function settle(twilioSid, result) {
  await markProcessed(twilioSid);
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

/**
 * Find the texting staff member's nearest UNFINISHED approved shift.
 *
 * THE HIGHEST-STAKES CONSUMER OF THE VISIBILITY PREDICATE, because it is a
 * WRITE path: whatever this returns is what CANT denies and re-opens, and what
 * CONFIRM acknowledges. Both failure directions are real damage.
 *
 *   - Too narrow (the old `event_date >= CURRENT_DATE`, which resolves in the
 *     GMT session zone): a staffer texting CANT at 19:30 about TONIGHT matched
 *     nothing, so every caller — handleConfirm, handleCant, and the
 *     multi-account resolveShiftResponder tiebreak — took the "no upcoming
 *     shift" branch. The staffer was told there was nothing to release, the
 *     shift was never re-opened, and nobody was alerted, on the day of the
 *     event.
 *   - Too wide (the Chicago calendar day): this MORNING's finished brunch
 *     outranks tonight's event until midnight, so a bartender texting CANT at
 *     20:00 about tomorrow has the shift they ALREADY WORKED denied and
 *     re-opened — removing them from the roster payroll pays from. That is the
 *     P0 that killed the previous round.
 *
 * The end instant (server/utils/shiftEndInstant.js) is what makes both go
 * away, but only as far as the DATA allows, and the original wording here
 * ("a finished shift is not a candidate at all, no matter what day it is")
 * overclaimed. It is true when the end is KNOWN. When `end_time` is NULL the
 * end instant is ASSUMED (rule 2: start + booked length + overrun grace), so a
 * 9:00 PM start with a 4h booking is "not finished" until 05:00 the NEXT
 * morning.
 *
 * Do not re-quote a prod count here. The first version of this comment said
 * "11 of the 78 prod shifts have exactly that shape", lifted from a 2026-08-16
 * fix-list entry and never re-derived; by 2026-08-20 prod was 7 NULL-end of 72,
 * only 3 with an evening start, and NONE of those on a live approved roster.
 * The SHAPE is what matters, and it is reachable the moment anyone is approved
 * onto an evening shift with no end_time.
 *
 * That leaves a real window, 00:00 to about 08:00 Chicago: a bartender who
 * finished at 01:00 and texts CANT at 02:00 meaning TOMORROW had LAST NIGHT's
 * shift denied and re-opened, off the roster payroll pays from. Same damage as
 * the brunch P0, one calendar day over.
 *
 * ORDERING therefore has two terms, and the first one closes that window: a
 * shift dated before today NEVER outranks one dated today or later. It is a
 * tiebreak, not a filter — the candidate SET is still decided entirely by the
 * end instant, so nothing becomes invisible and a genuinely-overnight shift is
 * still returned when it is the only one.
 *
 * THE ACCEPTED COST, named so the next reader does not re-derive it as a bug:
 * a staffer still ON an overnight shift at 00:30 who ALSO holds a later shift
 * now drops the LATER one when they text CANT, where before they dropped the
 * one they were standing in. No ordering resolves both readings of a mid-shift
 * CANT. This side is chosen because the other destroys payroll for work already
 * performed, and it self-corrects: the reply names the date, and alertStaffCant
 * tells an admin.
 *
 * THE READ-SIDE TWIN HAS NOT MOVED: staffPortal.js's next-shift card still
 * orders by the end instant alone, so inside this same window the card and this
 * function can name different shifts. Open in the fix list, deliberately not
 * changed here.
 *
 * Then the end instant, not
 * `s.start_time`: start_time is free text, so the old ASC sort compared
 * '7:00 PM' against '8:00 AM' as strings and put the evening shift first on a
 * two-shift day. `s.id` breaks exact ties so the pick is deterministic.
 *
 * @param {number} staffUserId
 * @param {string} [todayYmd] the business day to measure "before today"
 *   against, as YYYY-MM-DD. Defaults to Chicago today, bound as a parameter
 *   rather than computed in SQL because this session runs at GMT and rolls over
 *   at 19:00 Chicago. It is a parameter at all because the DATABASE clock
 *   cannot be moved in a test, and this is the one input the ordering rule
 *   reads, so injecting it is what makes the rule testable at any hour.
 * @returns {Promise<Object|null>} the shift_requests+shifts row, or null
 */
async function findNearestApprovedShift(staffUserId, todayYmd = chicagoTodayYmd()) {
  // Shape-guarded, because this parameter is on an EXPORTED function and
  // $2::date accepts far more than YYYY-MM-DD: 'today' and 'yesterday' resolve
  // in the SESSION zone, which is GMT, reintroducing the exact rollover this
  // family exists to kill; a Date object serializes to an ISO timestamp and
  // resolves the same wrong way; and under DateStyle ISO,MDY '01-02-2026'
  // parses silently as January 2. Anything that is not the one shape falls back
  // to the correct value rather than throwing on a live SMS webhook.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(todayYmd) ? todayYmd : chicagoTodayYmd();
  const r = await pool.query(
    `SELECT sr.id AS request_id, s.id AS shift_id, s.event_date, s.start_time,
            s.status AS shift_status, s.client_name, s.event_type, s.event_type_custom,
            s.proposal_id
     FROM shift_requests sr
     JOIN shifts s ON s.id = sr.shift_id
     LEFT JOIN proposals p ON p.id = s.proposal_id
     WHERE sr.user_id = $1
       AND sr.status = 'approved'
       AND sr.dropped_at IS NULL
       AND ${shiftNotFinishedSql('s', 'p')}
       AND s.status NOT IN ('completed', 'cancelled')
     ORDER BY (s.event_date < $2::date) ASC,
              ${shiftEndInstantSql('s', 'p')} ASC, s.id ASC
     LIMIT 1`,
    [staffUserId, day]
  );
  return r.rows[0] || null;
}

/**
 * Decide which staff candidate a CONFIRM/CANT applies to when a number matches
 * more than one active account. The signal is "who has a matching upcoming
 * approved shift": exactly one such candidate -> act on them; none -> there is
 * nothing to act on; more than one -> refuse to guess and let a human resolve.
 *
 * @param {number[]} candidateIds
 * @returns {Promise<{status:'ok', staffUserId:number} | {status:'no_shift'} | {status:'ambiguous', userIds:number[]}>}
 */
async function resolveShiftResponder(candidateIds) {
  const withShift = [];
  // ONE business day for the whole resolution, hoisted rather than recomputed
  // per candidate: a loop straddling midnight would otherwise judge two
  // candidates against two different "todays" and could return an ambiguity
  // neither day alone produces.
  const today = chicagoTodayYmd();
  for (const uid of candidateIds || []) {
    const shift = await findNearestApprovedShift(uid, today);
    if (shift) withShift.push(uid);
  }
  if (withShift.length === 1) return { status: 'ok', staffUserId: withShift[0] };
  if (withShift.length === 0) return { status: 'no_shift' };
  return { status: 'ambiguous', userIds: withShift };
}

/**
 * Handle a staff CONFIRM response code: stamp acknowledged_at on the nearest
 * upcoming approved shift_request.
 *
 * @param {number} staffUserId
 * @returns {Promise<{ok:true, shiftId:number, eventDate:string, clientName:string|null} | {ok:false, reason:'no_shift'}>}
 */
async function handleConfirm(staffUserId) {
  const shift = await findNearestApprovedShift(staffUserId);
  if (!shift) return { ok: false, reason: 'no_shift' };
  await pool.query(
    'UPDATE shift_requests SET acknowledged_at = NOW() WHERE id = $1',
    [shift.request_id]
  );
  return { ok: true, shiftId: shift.shift_id, eventDate: shift.event_date, clientName: shift.client_name || null };
}

/**
 * Handle a staff CANT response code: un-assign the staffer from their nearest
 * upcoming approved shift and re-open that shift. Does NOT clear
 * shifts.auto_assigned_at — re-staffing is left to the admin (decision: CANT
 * is flag-and-alert, not auto-restaff). Returns shift info for the alert.
 *
 * @param {number} staffUserId
 * @returns {Promise<
 *   {ok:true, shiftId:number, requestId:number, eventDate:string, clientName:string|null, eventType:string|null, eventTypeCustom:string|null} |
 *   {ok:false, reason:'no_shift'}
 * >}
 */
async function handleCant(staffUserId, twilioSid) {
  const shift = await findNearestApprovedShift(staffUserId);
  if (!shift) return { ok: false, reason: 'no_shift' };

  const dbClient = await pool.connect();
  let bonusReleased = false;
  try {
    await dbClient.query('BEGIN');
    // $2::date is the CHICAGO business day, not NOW()::date. The DB session
    // runs at GMT, so NOW()::date is already tomorrow from 19:00 Chicago — and
    // an evening-of CANT is exactly the case this spec makes reachable, so the
    // audit note recording the drop was stamped one day in the FUTURE, dated
    // after the event it dropped. This is a NOTE about when a human acted, not
    // a shift boundary, so it takes the business DAY and not the end instant.
    await dbClient.query(
      `UPDATE shift_requests
       SET status = 'denied',
           notes = TRIM(COALESCE(notes, '') || ' [Staff texted CANT ' || $2::date || ']')
       WHERE id = $1`,
      [shift.request_id, chicagoTodayYmd()]
    );
    // Out-of-Area lock (spec 2026-08-06 §6): CANT is a drop by text. The
    // staffer is off the roster as of the UPDATE above, so their hold on an
    // attached bonus releases here, in the same transaction. Holder-scoped, and
    // the AMOUNT stays: the bonus re-arms for whoever restaffs the shift.
    bonusReleased = await releaseOutOfAreaLock(dbClient, shift.shift_id, staffUserId);
    // Re-open the shift so it shows as unstaffed. auto_assigned_at is left as-is
    // on purpose so processScheduledAutoAssigns does not auto-re-staff it.
    await dbClient.query(
      "UPDATE shifts SET status = 'open' WHERE id = $1 AND status <> 'cancelled'",
      [shift.shift_id]
    );
    // Settle the inbound SMS row in the SAME transaction as the drop (audit F1b).
    // CANT flips shift_request status approved->denied, so a retry would
    // re-resolve to a DIFFERENT branch (no_shift) and mis-alert; settling
    // atomically here guarantees a retry is skipped as a true replay rather than
    // re-entering CANT after the drop already committed.
    if (twilioSid) {
      await dbClient.query(
        "UPDATE sms_messages SET processed = true WHERE twilio_sid = $1 AND direction = 'inbound'",
        [twilioSid]
      );
    }
    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (_) { /* already rolled back or connection dropped */ }
    throw err;
  } finally {
    dbClient.release();
  }

  // Post-commit, pooled client already released.
  if (bonusReleased) reaccrueDutyForProposal(shift.proposal_id);

  return {
    ok: true,
    shiftId: shift.shift_id,
    requestId: shift.request_id,
    eventDate: shift.event_date,
    clientName: shift.client_name || null,
    eventType: shift.event_type || null,
    eventTypeCustom: shift.event_type_custom || null,
  };
}

/** Escape HTML metacharacters so untrusted inbound text is safe in email HTML. */
function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
async function alertInboundClient(client, body) {
  await safeAlert('inbound_client', async () => {
    const name = client.name || 'A client';
    // Truncate the inbound text so the outbound alert SMS cannot exceed
    // Twilio's 1600-char limit and fail to send.
    const snippet = (body || '').slice(0, 600);
    const line = `${name} texted Dr. Bartender: "${snippet}". Reply in the admin Messages page.`;
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
 * @param {Object} args
 * @param {string} args.from - inbound E.164 number
 * @param {string} args.body - message text
 * @param {string} [args.twilioSid]
 * @returns {Promise<{outcome:string, reply:string|null}>}
 */
async function processInboundSms({ from, body, twilioSid }) {
  const text = (body || '').trim();

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
    // lead's client_id. Skipped on purpose: STOP/START (opt semantics do not
    // transfer from a proxy), all alerts, all auto-replies.
    const relayClientId = sender.type === 'client' ? sender.client.id : (proxyLead.clientId || null);
    const proceed = await recordAndShouldProcess({
      fromPhone: from,
      body: text,
      clientId: relayClientId,
      twilioSid,
      metadata: { thumbtack_relay: true },
    });
    if (!proceed) return { outcome: 'duplicate', reply: null };
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
    const proceed = await recordAndShouldProcess({ fromPhone: from, body: text, clientId, twilioSid, metadata: { opt_keyword: optKeyword } });
    if (!proceed) return { outcome: 'duplicate', reply: null };
    if (optKeyword === 'stop') await applyOptOut(sender);
    else await applyOptIn(sender);
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
    const proceed = await recordAndShouldProcess({ fromPhone: from, body: text, clientId, twilioSid, metadata: { help_keyword: true } });
    if (!proceed) return { outcome: 'duplicate', reply: null };
    return settle(twilioSid, { outcome: 'help', reply: HELP_REPLY });
  }

  // Record the message (client_id set only for a client sender). Heal-aware: an
  // unsettled prior record (stranded by a failed side-effect) is re-processed.
  const clientId = sender.type === 'client' ? sender.client.id : null;
  const proceed = await recordAndShouldProcess({ fromPhone: from, body: text, clientId, twilioSid });
  if (!proceed) return { outcome: 'duplicate', reply: null };

  if (sender.type === 'client') {
    // No auto-reply to clients — the admin replies personally from the
    // Messages page. We just alert the admin a client texted in.
    await alertInboundClient(sender.client, text);
    return settle(twilioSid, { outcome: 'client_message', reply: null });
  }

  if (sender.type === 'staff') {
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
    `An unrecognized number (${from}) texted Dr. Bartender: "${text}".`);
  return settle(twilioSid, { outcome: 'unknown_sender', reply: null });
}

module.exports = {
  detectOptKeyword,
  detectHelpKeyword,
  detectResponseCode,
  lookupSender,
  findStaffCandidatesByPhone,
  resolveShiftResponder,
  recordInboundMessage,
  applyOptOut,
  applyOptIn,
  handleConfirm,
  findNearestApprovedShift,
  handleCant,
  alertInboundClient,
  alertOptKeyword,
  alertStaffCant,
  alertAdminEmail,
  processInboundSms,
  findThumbtackProxyLead,
  __setDeps,
};
