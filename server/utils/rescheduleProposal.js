const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { resolveEventTimezone, formatEventLocalTime } = require('./eventTimezone');
const { getHandlerMeta } = require('./scheduledMessageDispatcher');
const { shouldSendImmediate } = require('./messageSuppression');
const { computeScheduledFor, schedulePreEventReminders } = require('./preEventScheduling');
const { getBookingWindow } = require('./bookingWindow');
const { BOOKED_SET } = require('./proposalStatus');

// Defense-in-depth: even though post_event_wrap_up_email registers with
// offsetFromEventDate: null (which already short-circuits via the
// `if (!newScheduledFor) continue;` branch in reanchorPendingMessages),
// keep an explicit skip set so a future handler-meta change can't silently
// re-anchor wrap-up rows.
//
// `cover_broadcast` (Phase 5 Task 22): a cover-needed broadcast targets a
// SPECIFIC shift in a 12h–14d window. If the proposal's event date moves, a
// stale broadcast referring to the old date would be misleading; the cover
// request flow re-runs from scratch on the new date if the original requester
// still wants out.
//
// `beo_unack_nudge_sms` (BEO plan): nudges anchor on a per-staffer ack window,
// not the proposal's event date; the BEO handler re-derives the schedule from
// the new date itself, so re-anchoring would double-schedule.
const SKIP_REANCHOR_TYPES = new Set([
  'post_event_wrap_up_email',
  'cover_broadcast',
  'beo_unack_nudge_sms',
]);

/**
 * Normalize a bare-DATE value (`event_date`, `balance_due_date`) to a
 * 'YYYY-MM-DD' string. The `pg` driver returns `DATE` columns as JS `Date`
 * objects built at LOCAL midnight (a SQL DATE carries no zone), so the
 * calendar date is only recoverable via the local getters — `String(dateObj)`
 * yields a locale string like "Sat Aug 01 2026 ..." whose first 10 chars are
 * NOT a date, and `.toISOString().slice(0,10)` would shift the day on
 * positive-offset machines. Plain strings (a literal, an ISO date, or pg text
 * output) are sliced directly. Mirrors `toCalendarYmd` in preEventScheduling.js.
 *
 * @param {string|Date|null|undefined} value
 * @returns {string|null} 'YYYY-MM-DD', or null when value is empty
 */
function toCalendarYmd(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * Returns true when any of the three reschedule-triggering fields changed.
 * `event_date` is a SQL DATE (pg returns it as a Date object) — normalized via
 * toCalendarYmd so a Date and an equivalent string compare equal. The other
 * two are stored as text, compared trimmed.
 */
// The one list of fields whose change means "the client's event moved".
// hasReschedulableChange and notify-preflight's reasons both derive from THIS;
// a fourth reschedulable field is added here and nowhere else.
const RESCHEDULABLE_FIELDS = ['event_date', 'event_start_time', 'event_location'];

/**
 * The changed subset of RESCHEDULABLE_FIELDS, with the type-aware comparison
 * (event_date is a pg Date, compared as a calendar date; the others as
 * trimmed text). hasReschedulableChange and notify-preflight's `reasons` both
 * derive from THIS so a reason can never claim a field the trigger ignored.
 */
function changedReschedulableFields(oldRow, newRow) {
  return RESCHEDULABLE_FIELDS.filter((f) => {
    if (f === 'event_date') {
      return (toCalendarYmd(oldRow.event_date) || '') !== (toCalendarYmd(newRow.event_date) || '');
    }
    const oldVal = (oldRow[f] === null || oldRow[f] === undefined) ? '' : String(oldRow[f]).trim();
    const newVal = (newRow[f] === null || newRow[f] === undefined) ? '' : String(newRow[f]).trim();
    return oldVal !== newVal;
  });
}

function hasReschedulableChange(oldRow, newRow) {
  return changedReschedulableFields(oldRow, newRow).length > 0;
}

/**
 * The status gate for the reschedule notice, shared by the in-tx path and the
 * read-only notify-preflight so the two can never drift. Only meaningful for
 * proposals at or past deposit_paid; archived never notifies.
 */
function reschedulableStatusOk(status) {
  return Boolean(status) && status !== 'archived' && BOOKED_SET.has(status);
}

/**
 * Pure projection of the balance-due shift a date move performs. Mirrors BOTH
 * in-tx branches (offset-preserving when a due date exists; the codebase
 * default event_date - 14d when none does) — and the in-tx recompute calls
 * THIS function, so the preflight draft's promised date and the committed
 * value are one computation. Null when the event date is not moving.
 */
function computeProjectedBalanceDue(oldEventDate, oldBalanceDue, newEventDate) {
  const oldYmd = toCalendarYmd(oldEventDate);
  const newYmd = toCalendarYmd(newEventDate);
  if (!oldYmd || !newYmd || oldYmd === newYmd) return null;
  const newEventMs = new Date(newYmd + 'T00:00:00Z').getTime();
  // Junk input (preflight feeds raw body values) must yield "no projection",
  // never a RangeError 500: new Date(NaN).toISOString() throws.
  if (!Number.isFinite(newEventMs)) return null;
  const dueYmd = toCalendarYmd(oldBalanceDue);
  if (!dueYmd) {
    return new Date(newEventMs - 14 * 86400000).toISOString().slice(0, 10);
  }
  const oldEventMs = new Date(oldYmd + 'T00:00:00Z').getTime();
  const oldBalanceMs = new Date(dueYmd + 'T00:00:00Z').getTime();
  if (!Number.isFinite(oldEventMs) || !Number.isFinite(oldBalanceMs)) return null;
  const offsetDays = Math.round((oldBalanceMs - oldEventMs) / 86400000); // typically -14
  return new Date(newEventMs + offsetDays * 86400000).toISOString().slice(0, 10);
}

/**
 * Compute the new scheduled_for for a pending row given the proposal's NEW
 * event_date / balance_due_date and the handler's registered offset metadata.
 *
 * Delegates to `computeScheduledFor(messageType, proposal)` — the SAME helper
 * the initial scheduler uses (`preEventScheduling.js`) — so reanchor and
 * initial-schedule paths can NEVER drift apart. In particular, the helper
 * preserves the "10am in event-local TZ" hour (e.g., 15:00 UTC for Chicago
 * CDT), which a raw `event_date_midnight + offset_seconds` calc would lose.
 *
 * Returns null when the handler isn't registered, has a null offset (e.g.,
 * drip touches anchored to the proposal-sent moment rather than event_date),
 * or the required anchor field is missing on the proposal.
 *
 * @param {object} proposal - includes event_date, balance_due_date, event_timezone, etc.
 * @param {string} messageType - the row's message_type
 * @returns {Date|null}
 */
function computeReanchoredScheduledFor(proposal, messageType) {
  const meta = getHandlerMeta(messageType);
  if (!meta) return null;
  if (meta.offsetFromEventDate === null || meta.offsetFromEventDate === undefined) return null; // anchor-independent
  // Verify the required anchor field is present BEFORE delegating, so we can
  // distinguish "no anchor" (return null) from "computeScheduledFor throws".
  const anchorVal = meta.anchor === 'balance_due_date'
    ? proposal.balance_due_date
    : meta.anchor === 'completed_at'
      ? proposal.completed_at
      : meta.anchor === 'created_at'
        ? proposal.created_at
        : proposal.event_date;
  if (!anchorVal) return null;
  try {
    return computeScheduledFor(messageType, proposal);
  } catch (_e) {
    return null;
  }
}

/**
 * Re-anchor all pending scheduled_messages rows for the proposal. Each row's
 * scheduled_for is recomputed from the NEW proposal anchor field (event_date
 * or balance_due_date) plus the handler's offset (looked up via
 * `getHandlerMeta` from Plan 2a's dispatcher registry).
 *
 * Only touches rows where status = 'pending'. Sent / failed / suppressed rows
 * are left alone.
 *
 * Unknown / no-offset message_types are skipped (anchor-independent touches
 * like drip stay where they are).
 *
 * REQUIRES a `pg` client (pool client checked out by the caller) — the caller
 * MUST run this inside its own transaction so the reschedule is atomic with
 * the proposal UPDATE (Gemini Finding 2).
 *
 * @param {import('pg').PoolClient} client
 * @param {number|string} proposalId
 * @returns {Promise<number>} count of rows updated
 */
async function reanchorPendingMessages(client, proposalId) {
  // NOTE: `proposals` has no `completed_at` column in this codebase —
  // completion is tracked via status='completed'. The dispatcher contract
  // permits a `completed_at` anchor (VALID_ANCHORS), but no handler currently
  // uses it; a row anchored that way resolves `proposal.completed_at` to
  // undefined and is skipped by computeReanchoredScheduledFor's `!anchorVal`
  // guard. Selecting it here would raise "column does not exist".
  const propRes = await client.query(
    `SELECT id, event_date, event_start_time, event_timezone, balance_due_date,
            created_at
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal || !proposal.event_date) return 0;

  const pendingRes = await client.query(
    `SELECT id, message_type
       FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND status = 'pending'`,
    [proposalId]
  );

  let updated = 0;
  for (const row of pendingRes.rows) {
    if (SKIP_REANCHOR_TYPES.has(row.message_type)) continue;
    const meta = getHandlerMeta(row.message_type);
    if (!meta) {
      console.warn(`[rescheduleProposal] no handler metadata for message_type=${row.message_type} (row id=${row.id}); leaving scheduled_for unchanged`);
      continue;
    }
    const newScheduledFor = computeReanchoredScheduledFor(proposal, row.message_type);
    if (!newScheduledFor) {
      // Anchor-independent (offsetFromEventDate === null) or missing anchor
      // field — leave the row alone.
      continue;
    }
    await client.query(
      `UPDATE scheduled_messages SET scheduled_for = $1 WHERE id = $2`,
      [newScheduledFor, row.id]
    );
    updated += 1;
  }
  return updated;
}

/**
 * Event-local date formatting for the notice draft and send. Module scope
 * (tz-first) so buildEventDetailsDraft and sendRescheduleEmail share them.
 */
function fmtDate(tz, d) {
  if (!d) return 'TBD';
  const ymd = toCalendarYmd(d);
  if (!ymd) return 'TBD';
  const parsed = new Date(ymd + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return 'TBD';
  return formatEventLocalTime(parsed, tz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// IMPORTANT: event_start_time is wall-clock event-local time stored as a
// string (e.g., '18:00' or '6:00 PM'). We must NOT parse it as UTC and then
// format in event TZ — that round-trip shifts the displayed time by the TZ
// offset (e.g., Chicago 18:00 → displays as 1:00 PM CDT). Instead we
// string-format the literal time and append the TZ abbreviation pulled
// from the event_date in the resolved zone.
function fmtTime(tz, date, time) {
  if (!time || !date) return 'TBD';
  const raw = String(time).trim();
  let time12 = raw;
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (Number.isFinite(h) && Number.isFinite(m)) {
      const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      const ampm = h >= 12 ? 'PM' : 'AM';
      time12 = `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
    }
  }
  let tzAbbrev = '';
  try {
    const dateStr = toCalendarYmd(date) || '';
    const refMs = Date.parse(`${dateStr}T12:00:00Z`);
    if (Number.isFinite(refMs)) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'short',
      }).formatToParts(new Date(refMs));
      const tzPart = parts.find((p) => p.type === 'timeZoneName');
      if (tzPart && tzPart.value) tzAbbrev = ` ${tzPart.value}`;
    }
  } catch (_e) { /* leave empty */ }
  return `${time12}${tzAbbrev}`;
}

/**
 * Composes the event-details notice from the OLD row + pending edits, at
 * preflight time (the old values do not survive the save). Money-free by
 * design (spec: draft content): the only quoted consequence is the projected
 * balance-due shift, which is deterministic because computeProjectedBalanceDue
 * is the SAME function the save's in-tx recompute calls.
 *
 * `ctx` is the joined proposal+client row (preflight's SELECT or this module's
 * own load): client_name/client_email/token/autopay_enrolled/balance_due_date
 * plus the timezone fields resolveEventTimezone reads.
 */
function buildEventDetailsDraft({ old, updated, ctx }) {
  const { proposalUrl } = require('./urls');
  const tz = resolveEventTimezone(ctx);
  const firstName = (ctx.client_name || '').trim().split(/\s+/)[0] || 'there';

  // The changed-field set comes from the canonical comparator so the draft's
  // lines and the trigger can never drift (same function, both sides).
  const changed = new Set(changedReschedulableFields(old, updated));
  const lines = [];
  if (changed.has('event_date')) lines.push(`Date: ${fmtDate(tz, old.event_date)} is now ${fmtDate(tz, updated.event_date)}`);
  if (changed.has('event_start_time')) lines.push(`Start time: ${fmtTime(tz, old.event_date, old.event_start_time)} is now ${fmtTime(tz, updated.event_date, updated.event_start_time)}`);
  if (changed.has('event_location')) lines.push(`Location: ${old.event_location || 'TBD'} is now ${updated.event_location || 'TBD'}`);

  const projected = computeProjectedBalanceDue(old.event_date, old.balance_due_date, updated.event_date);
  let dueLine = null;
  let autopayNotice = null;
  if (projected) {
    const projectedLocal = fmtDate(tz, projected);
    dueLine = ctx.autopay_enrolled
      ? `Your card will auto-charge the remaining balance on ${projectedLocal}.`
      : `Your balance due date moves to ${projectedLocal}.`;
    autopayNotice = dueLine;
    const daysOut = Math.round((Date.parse(projected + 'T00:00:00Z') - Date.now()) / 86400000);
    if (daysOut <= 3) {
      autopayNotice += ' That is inside the reminder window, so this notice may be their only warning.';
    }
  }

  const link = ctx.token ? proposalUrl(ctx.token) : null;
  const body_text = [
    `Hi ${firstName},`,
    'Your event details have been updated. Here is what changed:',
    lines.join('\n'),
    dueLine,
    link ? `You can see your full current details and balance anytime here: ${link}` : null,
    'Let me know if you have any questions.',
  ].filter(Boolean).join('\n\n');

  // rescheduleSms's dt() is a raw passthrough, so pass PRE-FORMATTED strings
  // exactly like the send path always has. includeEmailClause is ALWAYS false
  // in the notify draft: channel selection happens after composition, so the
  // default text never promises an email (the admin can add the pointer).
  const smsTemplates = require('./smsTemplates');
  const smsBody = smsTemplates.rescheduleSms({
    newDate: fmtDate(tz, updated.event_date || ctx.event_date),
    newStartTime: fmtTime(tz, updated.event_date || ctx.event_date, updated.event_start_time || ctx.event_start_time),
    newLocation: updated.event_location || ctx.event_location || '',
    includeEmailClause: false,
  });

  return {
    email: { subject: 'Updated details for your event', body_text },
    sms: { body: smsBody },
    projected_balance_due: projected,
    autopay_notice: autopayNotice,
  };
}

/**
 * Sends the event-details notice on the caller's selected channels with the
 * caller's REVIEWED text. Composition happens upstream (notify-preflight /
 * buildEventDetailsDraft) because the message renders old-vs-new and the old
 * values do not survive the save. There is NO template fallback: a caller
 * that did not compose did not intend to send.
 *
 * Runs AFTER the DB transaction commits; a provider failure is reported in
 * the per-channel result, never thrown past the caller's collection.
 *
 * @returns {{ email, sms, email_error, sms_error, skip_reasons }}
 */
async function sendRescheduleEmail({ proposalId, channels, message }) {
  const wantEmail = Array.isArray(channels) && channels.includes('email');
  const wantSms = Array.isArray(channels) && channels.includes('sms');
  const results = { email: 'skipped', sms: 'skipped', skip_reasons: {} };
  if (!wantEmail) results.skip_reasons.email = 'not selected';
  if (!wantSms) results.skip_reasons.sms = 'not selected';
  if (!wantEmail && !wantSms) return results;

  // The message text is caller-composed now, so this loads ONLY recipient
  // resolution + suppression inputs (the old template-context columns and the
  // package join are gone with the template).
  const { rows } = await pool.query(
    `SELECT p.id, p.status,
            c.id AS client_id, c.name AS client_name, c.email AS client_email,
            c.phone AS client_phone,
            c.communication_preferences, c.email_status, c.phone_status
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const ctx = rows[0];
  if (!ctx) throw new Error(`rescheduleProposal: proposal ${proposalId} not found`);
  // No destination at all: report it rather than throwing. This now runs
  // behind an explicit admin Send, and the response carries per-channel truth.
  if (!ctx.client_email && !ctx.client_phone) {
    if (wantEmail) results.skip_reasons.email = 'No email on file for this client.';
    if (wantSms) results.skip_reasons.sms = 'No usable phone on file.';
    return results;
  }

  // Gemini Finding 3: respect suppression rules on this immediate send.
  // Phase 3: the touch is email + SMS — check each channel independently and
  // gate each send, instead of an early return that would also skip the SMS.
  const clientForCheck = {
    communication_preferences: ctx.communication_preferences,
    email_status: ctx.email_status,
    phone_status: ctx.phone_status,
  };
  const emailCheck = await shouldSendImmediate({
    proposal: { id: ctx.id, status: ctx.status },
    client: clientForCheck,
    channel: 'email',
  });
  const smsCheck = await shouldSendImmediate({
    proposal: { id: ctx.id, status: ctx.status },
    client: clientForCheck,
    channel: 'sms',
  });
  if (!emailCheck.ok && !smsCheck.ok) {
    console.log(`[rescheduleNotification] both channels suppressed for proposal ${proposalId}: email=${emailCheck.reason} sms=${smsCheck.reason}`);
    if (wantEmail) results.skip_reasons.email = `Suppressed: ${emailCheck.reason}.`;
    if (wantSms) results.skip_reasons.sms = `Suppressed: ${smsCheck.reason}.`;
    return results;
  }

  const { isPlaceholderEmail } = require('./emailValidation');

  // ── Email half: the admin's REVIEWED text IS the email body, rendered
  // through renderPartsEmail (the same editable-body renderer the comms
  // actions use) so what was read in the popup is what sends. The bespoke
  // rescheduleNotificationClient template is deliberately not called here:
  // it returns pre-rendered HTML, so an edited body would reach plaintext
  // only while mail clients rendered the untouched original. ──
  if (wantEmail) {
    if (!ctx.client_email) {
      results.skip_reasons.email = 'No email on file for this client.';
    } else if (isPlaceholderEmail(ctx.client_email)) {
      results.skip_reasons.email = 'Placeholder address (.invalid) from the CC import; no real email exists.';
    } else if (!emailCheck.ok) {
      console.log(`[rescheduleNotification] email suppressed for proposal ${proposalId}: ${emailCheck.reason}`);
      results.skip_reasons.email = `Suppressed: ${emailCheck.reason}.`;
    } else {
      const { renderPartsEmail } = require('./comms/render');
      const rendered = renderPartsEmail({
        subject: message.email.subject,
        heading: 'Updated details for your event',
        bodyText: message.email.bodyText,
        cta: null,
      });
      try {
        const r = await sendEmail({
          to: ctx.client_email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          meta: { proposalId: ctx.id, clientId: ctx.client_id || null, messageType: 'reschedule' },
        });
        // Defense in depth behind the placeholder gate above: sendEmail's own
        // .invalid drop returns 'skipped-invalid' and must NEVER read as sent.
        if (r && r.id === 'skipped-invalid') {
          results.email = 'skipped';
          results.skip_reasons.email = 'Placeholder address (.invalid); no email was sent.';
        } else {
          results.email = 'sent';
        }
      } catch (err) {
        results.email = 'failed';
        results.email_error = err.message || 'Email send failed.';
      }
    }
  }

  // ── SMS half — own try/catch so an SMS failure is reported per-channel and
  // never aborts a caller that also asked for email. ──
  if (wantSms) {
    if (!ctx.client_phone) {
      results.skip_reasons.sms = 'No usable phone on file.';
    } else if (!smsCheck.ok) {
      console.log(`[rescheduleNotification] SMS suppressed for proposal ${proposalId}: ${smsCheck.reason}`);
      results.skip_reasons.sms = `Suppressed: ${smsCheck.reason}.`;
    } else {
      try {
        const { sendAndLogSms } = require('./sms');
        const smsResult = await sendAndLogSms({
          to: ctx.client_phone,
          body: message.sms.body,
          clientId: ctx.client_id || null,
          messageType: 'reschedule',
          recipientName: ctx.client_name || null,
        });
        // sendAndLogSms returns { sid: null, status: 'skipped' } WITHOUT
        // throwing when the stored phone fails normalizePhone — that must
        // never read as 'sent' (per-channel truth is the whole contract).
        if (smsResult && smsResult.status === 'skipped') {
          results.sms = 'skipped';
          results.skip_reasons.sms = 'Phone on file could not be parsed for SMS.';
        } else {
          results.sms = 'sent';
        }
      } catch (smsErr) {
        Sentry.captureException(smsErr, {
          tags: { component: 'rescheduleProposal', step: 'reschedule_sms' },
          extra: { proposalId },
        });
        console.error('[rescheduleNotification] SMS failed (non-blocking):', smsErr.message);
        results.sms = 'failed';
        results.sms_error = smsErr.message || 'SMS send failed.';
      }
    }
  }

  return results;
}

/**
 * In-transaction reschedule (Gemini Finding 2): re-anchor all pending
 * scheduled_messages rows for the proposal in the same DB transaction as
 * the proposal UPDATE. The CALLER manages the transaction (BEGIN/COMMIT)
 * because the caller is also updating the proposal row.
 *
 * Caller pattern (see Task 7):
 *
 *   const client = await pool.connect();
 *   try {
 *     await client.query('BEGIN');
 *     await client.query('UPDATE proposals SET event_date=$1 ... WHERE id=$2', [...]);
 *     await rescheduleProposalInTx(client, { proposalId, old, updated });
 *     await client.query('COMMIT');
 *   } catch (err) {
 *     await client.query('ROLLBACK');
 *     throw err;
 *   } finally {
 *     client.release();
 *   }
 *   // Post-commit, SENDING IS THE CALLER'S JOB (notify-client contract,
 *   // 2026-07-22): compose via buildEventDetailsDraft/notify-preflight and
 *   // call sendRescheduleEmail({ proposalId, channels, message }) only when
 *   // the admin opted in. There is no template fallback.
 *
 * This split keeps the DB state consistent under all failure modes:
 *   - If anything before COMMIT throws → ROLLBACK; no email, no DB change
 *   - If COMMIT succeeds → DB is updated; email fires best-effort
 *   - If email send fails after COMMIT → admin can manually re-send; DB is
 *     already consistent
 *
 * @param {import('pg').PoolClient} client - pg client already inside a tx
 * @param {object} args
 * @param {number|string} args.proposalId
 * @param {object} args.old - proposal row BEFORE the UPDATE
 * @param {object} args.updated - proposal row AFTER the UPDATE
 * @returns {Promise<{shouldSendEmail: boolean}>} caller uses shouldSendEmail
 *   to decide whether to dispatch the email after COMMIT
 */
async function rescheduleProposalInTx(client, { proposalId, old, updated }) {
  if (!hasReschedulableChange(old, updated)) return { shouldSendEmail: false };

  // Read status + ORIGINAL event_date / balance_due_date as they exist BEFORE
  // this function's UPDATE. CRITICAL: when the PATCH handler is the caller,
  // it has ALREADY run `UPDATE proposals SET event_date = $newDate ...`
  // earlier in the same transaction. So a naive `SELECT event_date,
  // balance_due_date` here returns NEW event_date + OLD balance_due_date,
  // which would yield a junk offset. Instead, we rely on `old` (the pre-PATCH
  // row passed in by the caller) as the source of truth for the original
  // event_date and balance_due_date. The caller MUST include `balance_due_date`
  // on the `old` row — the PATCH handler captures it via `SELECT * FROM
  // proposals WHERE id = $1` before issuing the UPDATE.
  const statusRow = await client.query('SELECT status FROM proposals WHERE id = $1', [proposalId]);
  const status = statusRow.rows[0]?.status;
  if (!status) return { shouldSendEmail: false };

  // Gate post-sign+pay: only meaningful for proposals at or past deposit_paid.
  // Pre-sign+pay date/time edits don't need a reschedule email — the proposal
  // hasn't been sent yet (or has been sent but not signed, in which case the
  // next status-driven email replaces it).
  if (!reschedulableStatusOk(status)) return { shouldSendEmail: false };

  // Gemini Finding 4 (SUGGESTION) + Pre-execution Finding B3: when event_date
  // shifts, recompute balance_due_date by preserving the ORIGINAL offset
  // between event_date and balance_due_date.
  //
  // Use the `old` row (captured by the caller BEFORE the proposal UPDATE) for
  // both event_date and balance_due_date. Reading from the DB here would
  // return mixed-era data (new event_date + old balance_due_date) because the
  // PATCH handler updates event_date earlier in the same transaction. The
  // mixed read would produce a wrong offset and a no-op balance update.
  //
  // The codebase rule (see server/routes/stripe.js) is
  // `balance_due_date = event_date - INTERVAL '14 days'` (via COALESCE so
  // admin-edited custom dates aren't clobbered on first deposit). We preserve
  // the EXISTING offset so an admin-adjusted 21-day lead survives the
  // reschedule.
  //
  // Runs BEFORE reanchorPendingMessages so the dispatcher metadata lookup
  // for balance-anchored handlers sees the new balance_due_date.
  // Both branches (offset-preserving / default -14d) live in
  // computeProjectedBalanceDue — the SAME function notify-preflight uses to
  // quote the new date in the draft, so the promise and the write cannot drift.
  const projectedBalanceDue = computeProjectedBalanceDue(old.event_date, old.balance_due_date, updated.event_date);
  if (projectedBalanceDue) {
    await client.query(
      'UPDATE proposals SET balance_due_date = $1 WHERE id = $2',
      [projectedBalanceDue, proposalId]
    );
  }

  await reanchorPendingMessages(client, proposalId);

  // BEO nudge re-anchor. The generic reanchorPendingMessages above only touches
  // rows whose handler registers a non-null offsetFromEventDate. BEO nudges use
  // bespoke timing (event_start - 3 days, floor NOW+5min) and register with
  // offsetFromEventDate: null, so the generic pass skips them. We invoke the
  // BEO-specific reanchor here, inside the same transaction, gated on an
  // actual date OR start-time change so an unrelated reschedule field tweak
  // (e.g. location-only) doesn't churn pending BEO rows.
  const eventDateChanged = updated.event_date && String(updated.event_date) !== String(old.event_date);
  const eventStartChanged = updated.event_start_time && updated.event_start_time !== old.event_start_time;
  if (eventDateChanged || eventStartChanged) {
    const { reanchorBeoForProposal } = require('./beoHandlers');
    await reanchorBeoForProposal(proposalId, client);
  }

  // Pre-execution Finding W4: spec section 7.8 says a reschedule that moves
  // the event INTO a 90+ day window must add the T-30 long-lead recap (and
  // any other future eligibility-gated touches). The reanchor pass only
  // updates EXISTING pending rows; it can't insert net-new ones for a
  // recap that was never originally scheduled (because the proposal booked
  // <90 days out the first time around).
  //
  // We re-run the eligibility evaluation via `schedulePreEventReminders`,
  // which is idempotent (its `insertIfMissing` helper SELECTs first and
  // skips duplicates). It will:
  //   - Re-confirm the always-on event_week_reminder is in place
  //     (no-op since the row already exists and was just reanchored)
  //   - Insert a long_lead_t30_recap row IF the proposal's lead time
  //     (event_date - created_at) is now >= 90 days AND no recap row
  //     exists yet
  //
  // This runs inside the same transaction so atomicity is preserved — we
  // pass the in-tx `client` so the eligibility-driven inserts join the
  // open transaction.
  try {
    await schedulePreEventReminders(proposalId, client);
  } catch (evalErr) {
    // Eligibility re-evaluation is best-effort relative to the reanchor
    // (which is the load-bearing piece). Log + swallow so a missing
    // long_lead row doesn't roll back the date change.
    console.warn('[rescheduleProposal] post-reanchor eligibility re-evaluation failed (non-fatal):', evalErr.message);
  }

  // Touch 2.2 prerequisite: keep last_minute_hold consistent with the new
  // event_date/event_start_time. A held proposal moved past 72h becomes
  // unheld; a non-held proposal moved into 72h becomes held. The actual
  // notification fires from confirmStaffingIfFullyStaffed only when the
  // next staffing-fill flips a held proposal; this hook just keeps the
  // flag in sync with the booking window.
  //
  // getBookingWindow returns { hoursUntilEvent, fullPaymentRequired,
  // lastMinuteHold } and takes an options object (NOT a row); see
  // bookingWindow.js:39.
  // NOTE: `updated` must include `last_minute_hold`. The crud.js PATCH path
  // supplies it via `UPDATE proposals ... RETURNING *`; the convenience-path
  // `rescheduleProposal()` below accepts whatever its caller passes (tests
  // pass the full row). If a future caller narrows the projection to omit
  // last_minute_hold, `updated.last_minute_hold` becomes undefined and the
  // comparison `undefined !== lastMinuteHold` is always true, so the UPDATE
  // would fire on every reschedule (harmless but wasteful).
  const { lastMinuteHold } = getBookingWindow({
    eventDate: updated.event_date,
    eventStartTime: updated.event_start_time,
  });
  if (updated.last_minute_hold !== lastMinuteHold) {
    await client.query(
      'UPDATE proposals SET last_minute_hold = $1 WHERE id = $2',
      [lastMinuteHold, proposalId]
    );
  }

  return { shouldSendEmail: true };
}

/**
 * Convenience orchestrator used by tests and any caller that doesn't already
 * hold a transaction. Acquires its own client, runs the UPDATE re-anchor
 * inside BEGIN/COMMIT, then fires the email. The PATCH handler in
 * routes/proposals/crud.js uses the in-tx helpers directly because it has
 * its own transaction; this function is the simple-path version.
 *
 * Errors are thrown — the caller is responsible for catching and logging
 * non-blockingly.
 */
async function rescheduleProposal({ proposalId, old, updated }) {
  const client = await pool.connect();
  let shouldSendEmail = false;
  let hydratedOld = old;
  try {
    await client.query('BEGIN');
    // Hydrate `old` with balance_due_date if the caller didn't supply it.
    // Pre-execution Finding B3: rescheduleProposalInTx needs the ORIGINAL
    // balance_due_date to preserve the existing offset between event_date
    // and balance_due_date. In the convenience-path (this function), the DB
    // is still in the original state at this point because no UPDATE has
    // run yet, so reading balance_due_date here is safe and correct.
    if (old && (old.balance_due_date === null || old.balance_due_date === undefined)) {
      const r = await client.query(
        'SELECT balance_due_date FROM proposals WHERE id = $1',
        [proposalId]
      );
      hydratedOld = { ...old, balance_due_date: r.rows[0]?.balance_due_date || null };
    }
    const result = await rescheduleProposalInTx(client, { proposalId, old: hydratedOld, updated });
    shouldSendEmail = result.shouldSendEmail;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Email tail DELETED (notify-client contract, 2026-07-22): sending now
  // requires caller-composed text, which a tx-convenience wrapper cannot have.
  // This wrapper performs the reanchor + balance recompute ONLY; the caller
  // decides whether and what to send. shouldSendEmail is returned so a caller
  // can make that decision.
  return { shouldSendEmail };
}

module.exports = {
  rescheduleProposal,
  rescheduleProposalInTx,
  hasReschedulableChange,
  reanchorPendingMessages,
  computeReanchoredScheduledFor,
  sendRescheduleEmail,
  buildEventDetailsDraft,
  RESCHEDULABLE_FIELDS,
  changedReschedulableFields,
  reschedulableStatusOk,
  computeProjectedBalanceDue,
};
