// Staff shift commands for the inbound-SMS webhook: which active staff
// accounts a number belongs to, which approved shift a CONFIRM or CANT acts
// on, and the two handlers that act. Moved verbatim out of smsInbound.js on
// 2026-10-06 (lane sms-lines, Task 1), which was at its 1000-line cap, so the
// decision 17 gate (spec 2026-10-06, Inbox) can sit beside the code it guards.
// smsInbound.js re-exports every function here, so its callers and tests are
// unchanged. handleCant is a WRITE on the roster payroll pays from, and the
// shift pick has been a P0 twice: read findNearestApprovedShift's header
// before touching its ordering. Listed in scripts/sensitive-paths.txt.

const { pool } = require('../db');
const { releaseOutOfAreaLock, reaccrueDutyForProposal } = require('./serviceArea');
const { chicagoTodayYmd } = require('./businessTime');
// THE shift-visibility predicate: see server/utils/shiftEndInstant.js.
const { shiftNotFinishedSql, shiftEndInstantSql } = require('./shiftEndInstant');
const { last10 } = require('./phone');

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
      // The outcome rides the same statement, so the row says staff_cant
      // exactly when the drop committed (spec 2026-10-06, Inbox).
      await dbClient.query(
        `UPDATE sms_messages
            SET processed = true,
                metadata = metadata || '{"outcome":"staff_cant"}'::jsonb
          WHERE twilio_sid = $1 AND direction = 'inbound'`,
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

/**
 * Decision 17 (spec 2026-10-06, Inbox): a staffer's CONFIRM or CANT is a shift
 * command, and the automated staff replies fire, only when the latest text DRB
 * sent them was automated. A human text last (Zul asking "can you cover
 * Saturday?") makes their next "Can't" an answer to her, not a request to drop
 * their own shift.
 *
 * "Sent them" is any outbound row to this staffer, matched by recipient_id OR
 * by the last-10 phone key lookupSender uses: the automated shift texts
 * (sendAndLogSms) store only recipient_phone, while the human staff send also
 * stores recipient_id. sender_id NULL means automated. A failed row never
 * reached them, so it cannot be what they are answering, and is skipped.
 *
 * Only a text DRB sent them AS STAFF counts. An admin alert (message_type
 * admin_<category>, from notifyAdminCategory), a dead-letter alert
 * (critical_path_dead_letter_alert) and an automated text on a client's
 * thread (client_id set) also have no sender, but none is "a text DRB sent
 * that staffer": a staffer whose phone also gets alerts would otherwise have
 * an alert landing after a human text reopen shift commands, so a "Can't"
 * answering the person would release their own shift. Skipping such a row
 * can only move a text toward conversation, never release a shift.
 *
 * No outbound text at all reads as NOT automated: the condition is unmet, and
 * conversation is the side that never touches a shift. The shift approval and
 * auto-assign notices go out through sendSMS directly and write no
 * sms_messages row, so they are invisible here, which errs the same safe way.
 *
 * @param {{staffUserId:number|null, phone:string|null}} args
 * @param {Object} [db] pg pool or client
 * @returns {Promise<boolean>}
 */
async function latestDrbTextWasAutomated({ staffUserId, phone }, db = pool) {
  const key = last10(phone);
  const userId = Number.isInteger(staffUserId) ? staffUserId : null;
  if (!key && userId === null) return false;
  const r = await db.query(
    `SELECT sender_id
       FROM sms_messages
      WHERE direction = 'outbound'
        AND status IS DISTINCT FROM 'failed'
        AND (recipient_id = $1
             OR RIGHT(REGEXP_REPLACE(recipient_phone, '\\D', '', 'g'), 10) = $2)
        AND NOT (sender_id IS NULL AND (
              client_id IS NOT NULL
              OR COALESCE(message_type, '') LIKE 'admin\\_%'
              OR message_type = 'critical_path_dead_letter_alert'))
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [userId, key]
  );
  return Boolean(r.rows[0]) && r.rows[0].sender_id === null;
}

module.exports = {
  findStaffCandidatesByPhone,
  findNearestApprovedShift,
  resolveShiftResponder,
  handleConfirm,
  handleCant,
  latestDrbTextWasAutomated,
};
