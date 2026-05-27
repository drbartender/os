const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { resolveEventTimezone, formatEventLocalTime } = require('./eventTimezone');
const { getHandlerMeta } = require('./scheduledMessageDispatcher');
const { shouldSendImmediate } = require('./messageSuppression');
const { computeScheduledFor, schedulePreEventReminders } = require('./preEventScheduling');

// Defense-in-depth: even though post_event_wrap_up_email registers with
// offsetFromEventDate: null (which already short-circuits via the
// `if (!newScheduledFor) continue;` branch in reanchorPendingMessages),
// keep an explicit skip set so a future handler-meta change can't silently
// re-anchor wrap-up rows.
const SKIP_REANCHOR_TYPES = new Set(['post_event_wrap_up_email']);

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
function hasReschedulableChange(oldRow, newRow) {
  const eventDateChanged = (toCalendarYmd(oldRow.event_date) || '') !== (toCalendarYmd(newRow.event_date) || '');
  const textFields = ['event_start_time', 'event_location'];
  const textChanged = textFields.some((f) => {
    const oldVal = (oldRow[f] === null || oldRow[f] === undefined) ? '' : String(oldRow[f]).trim();
    const newVal = (newRow[f] === null || newRow[f] === undefined) ? '' : String(newRow[f]).trim();
    return oldVal !== newVal;
  });
  return eventDateChanged || textChanged;
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
 * Send the reschedule notification email immediately. SMS deferred to Phase 3
 * per spec section 10.
 *
 * Runs AFTER the DB transaction commits (Gemini Finding 2). The DB-side
 * reschedule is atomic; the email is fired non-blockingly afterwards because
 * an email failure should not roll back the proposal UPDATE.
 *
 * Inputs:
 *   - `old`: the proposal row BEFORE the PATCH (must include event_date,
 *     event_start_time, event_location)
 *   - `updated`: the proposal row AFTER the PATCH (same shape; new values)
 *
 * Both rows should be the full proposal row from the PATCH handler — the
 * function only reads the three reschedulable fields plus client linkage.
 */
async function sendRescheduleEmail({ proposalId, old, updated }) {
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date, p.event_start_time, p.event_location,
            p.event_timezone, p.guest_count, p.total_price, p.balance_due_date,
            p.autopay_enrolled,
            c.id AS client_id, c.name AS client_name, c.email AS client_email,
            c.phone AS client_phone,
            c.communication_preferences, c.email_status, c.phone_status,
            sp.name AS package_name
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const ctx = rows[0];
  if (!ctx) throw new Error(`rescheduleProposal: proposal ${proposalId} not found`);
  // Phase 3: the reschedule touch is email + SMS. Only bail when BOTH channels
  // have no destination; otherwise proceed and let each channel's
  // shouldSendImmediate gate decide.
  if (!ctx.client_email && !ctx.client_phone) {
    throw new Error(`rescheduleProposal: proposal ${proposalId} client has no email and no phone`);
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
    return;
  }

  const tz = resolveEventTimezone(ctx);

  const fmtDate = (d) => {
    if (!d) return 'TBD';
    const ymd = toCalendarYmd(d);
    if (!ymd) return 'TBD';
    const parsed = new Date(ymd + 'T12:00:00Z');
    if (Number.isNaN(parsed.getTime())) return 'TBD';
    return formatEventLocalTime(parsed, tz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  };
  // IMPORTANT: event_start_time is wall-clock event-local time stored as a
  // string (e.g., '18:00' or '6:00 PM'). We must NOT parse it as UTC and then
  // format in event TZ — that round-trip shifts the displayed time by the TZ
  // offset (e.g., Chicago 18:00 → displays as 1:00 PM CDT). Instead we
  // string-format the literal time and append the TZ abbreviation pulled
  // from the event_date in the resolved zone.
  const fmtTime = (date, time) => {
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
  };

  const totalNumber = Number(ctx.total_price ?? 0);
  const totalFormatted = totalNumber.toFixed(2);

  const balanceDueYmd = toCalendarYmd(ctx.balance_due_date);
  const balanceDueParsed = balanceDueYmd ? new Date(balanceDueYmd + 'T12:00:00Z') : null;
  const balanceDueDateLocal = (balanceDueParsed && !Number.isNaN(balanceDueParsed.getTime()))
    ? formatEventLocalTime(balanceDueParsed, tz, { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  const firstName = (ctx.client_name || '').trim().split(/\s+/)[0] || null;

  // ── Email half ──
  if (emailCheck.ok && ctx.client_email) {
    const tpl = emailTemplates.rescheduleNotificationClient({
      clientName: ctx.client_name,
      clientFirstName: firstName,
      oldDateLocal: fmtDate(old.event_date),
      oldStartTimeLocal: fmtTime(old.event_date, old.event_start_time),
      oldLocation: old.event_location || '',
      newDateLocal: fmtDate(updated.event_date || ctx.event_date),
      newStartTimeLocal: fmtTime(updated.event_date || ctx.event_date, updated.event_start_time || ctx.event_start_time),
      newLocation: updated.event_location || ctx.event_location || '',
      packageName: ctx.package_name || '',
      guestCount: ctx.guest_count,
      totalFormatted,
      balanceDueDateLocal,
      autopayEnrolled: !!ctx.autopay_enrolled,
    });
    await sendEmail({ to: ctx.client_email, ...tpl });
  } else if (!emailCheck.ok) {
    console.log(`[rescheduleNotification] email suppressed for proposal ${proposalId}: ${emailCheck.reason}`);
  }

  // ── SMS half (Phase 3, spec 3.13) — own try/catch so an SMS failure does
  // not throw into the caller (rescheduleProposal already wraps the email
  // send best-effort post-commit; the SMS gets the same posture). ──
  if (smsCheck.ok && ctx.client_phone) {
    try {
      const { sendAndLogSms } = require('./sms');
      const smsTemplates = require('./smsTemplates');
      const body = smsTemplates.rescheduleSms({
        newDate: fmtDate(updated.event_date || ctx.event_date),
        newStartTime: fmtTime(updated.event_date || ctx.event_date, updated.event_start_time || ctx.event_start_time),
        newLocation: updated.event_location || ctx.event_location || '',
      });
      await sendAndLogSms({
        to: ctx.client_phone,
        body,
        clientId: ctx.client_id || null,
        messageType: 'reschedule',
        recipientName: ctx.client_name || null,
      });
    } catch (smsErr) {
      Sentry.captureException(smsErr, {
        tags: { component: 'rescheduleProposal', step: 'reschedule_sms' },
        extra: { proposalId },
      });
      console.error('[rescheduleNotification] SMS failed (non-blocking):', smsErr.message);
    }
  } else if (!smsCheck.ok) {
    console.log(`[rescheduleNotification] SMS suppressed for proposal ${proposalId}: ${smsCheck.reason}`);
  }
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
 *   // Post-commit, fire the email non-blockingly:
 *   sendRescheduleEmail({ proposalId, old, updated }).catch((sentry + log));
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
  const POST_SIGNPAY = new Set(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);
  if (status === 'archived' || !POST_SIGNPAY.has(status)) return { shouldSendEmail: false };

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
  const oldEventDateStr = toCalendarYmd(old.event_date);
  const newEventDateStr = toCalendarYmd(updated.event_date);
  if (oldEventDateStr && newEventDateStr && oldEventDateStr !== newEventDateStr) {
    const oldBalanceDueStr = toCalendarYmd(old.balance_due_date);
    if (oldBalanceDueStr) {
      // Preserve the existing offset (in days) between OLD event_date and
      // OLD balance_due_date. Default codebase rule is event_date - 14, but
      // an admin may have set a different lead via PATCH
      // /proposals/:id/balance-due.
      const oldEventMs = new Date(oldEventDateStr + 'T00:00:00Z').getTime();
      const oldBalanceMs = new Date(oldBalanceDueStr + 'T00:00:00Z').getTime();
      const offsetDays = Math.round((oldBalanceMs - oldEventMs) / 86400000); // typically -14
      const newEventMs = new Date(newEventDateStr + 'T00:00:00Z').getTime();
      const newBalanceMs = newEventMs + offsetDays * 86400000;
      const newBalanceIso = new Date(newBalanceMs).toISOString().slice(0, 10);
      await client.query(
        'UPDATE proposals SET balance_due_date = $1 WHERE id = $2',
        [newBalanceIso, proposalId]
      );
    } else {
      // No balance_due_date set on the old row (rare — pre-deposit reschedule
      // that somehow reached this code path, or a custom flow). Apply the
      // codebase default rule: event_date - 14 days.
      const newEventMs = new Date(newEventDateStr + 'T00:00:00Z').getTime();
      const newBalanceIso = new Date(newEventMs - 14 * 86400000).toISOString().slice(0, 10);
      await client.query(
        'UPDATE proposals SET balance_due_date = $1 WHERE id = $2',
        [newBalanceIso, proposalId]
      );
    }
  }

  await reanchorPendingMessages(client, proposalId);

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

  // Email runs OUTSIDE the transaction so a Resend failure can't roll back
  // the DB changes. Email send is not idempotent-safe — better ordering is
  // DB commits first, then email; on email failure the DB is still consistent
  // and admin can re-send manually.
  if (shouldSendEmail) {
    try {
      await sendRescheduleEmail({ proposalId, old: hydratedOld, updated });
    } catch (emailErr) {
      Sentry.captureException(emailErr, {
        tags: { component: 'rescheduleProposal', step: 'post_commit_email' },
        extra: { proposalId },
      });
      console.error('[rescheduleProposal] post-commit email failed (non-fatal):', emailErr.message);
      // Don't rethrow — DB is consistent, admin can manually resend.
    }
  }
}

module.exports = {
  rescheduleProposal,
  rescheduleProposalInTx,
  hasReschedulableChange,
  reanchorPendingMessages,
  computeReanchoredScheduledFor,
  sendRescheduleEmail,
};
