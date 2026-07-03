const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { esc } = require('./htmlEscape');
const emailTemplates = require('./emailTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');
const { resolveChannelFallback } = require('./channelFallback');
const { suspendClientAutomation } = require('./clientAutomationSuspension');
const { SuppressMessageError, QuotaExceededError } = require('./errors');
const { deferRowForQuota, maybeAlertQuotaOnce } = require('./emailQuotaDefer');
const { dispatchPushRow } = require('./pushDispatch');
const {
  pickChannelsForUserAndCategory,
  CRITICAL_CATEGORIES,
} = require('./notificationChannelResolver');
// Module-level (not destructured) so tests can monkey-patch sms.sendAndLogSms.
const sms = require('./sms');

// ─── Handler registry ──────────────────────────────────────────
// Keyed by message_type. Handler signature:
//   async ({ entity, recipient, scheduledMessage }) => void
// Throwing flips the row to 'failed'.
//
// Each registered handler carries metadata used by:
//   - Plan 2c rescheduleProposal to look up the offset and recompute
//     scheduled_for when an event date / balance due date changes
//   - The dispatcher itself to gate marketing-class messages on the
//     client's communication_preferences.marketing_enabled flag

const handlers = new Map();
const handlerMeta = new Map();

const VALID_ANCHORS = new Set(['event_date', 'balance_due_date', 'created_at', 'completed_at']);
const VALID_CATEGORIES = new Set(['operational', 'marketing']);

/**
 * Register a handler with optional metadata.
 *
 * @param {string} messageType
 * @param {Function} handlerFn  async ({ entity, recipient, scheduledMessage }) => void
 * @param {Object} [options]
 * @param {number|null} [options.offsetFromEventDate]
 *   Seconds offset from the anchor (negative = before, positive = after).
 *   null means the message is anchor-independent (e.g., drip touches anchored
 *   to proposal-sent timestamp, not event date) and is NOT re-anchored on
 *   reschedule.
 * @param {'event_date'|'balance_due_date'|'created_at'|'completed_at'} [options.anchor='event_date']
 *   Which field on the entity the offset is measured from. Plan 2c's
 *   reschedule cascade uses this to know whether to recompute from
 *   the new event_date, the new balance_due_date, etc.
 * @param {'operational'|'marketing'} [options.category='operational']
 *   Operational messages bypass the marketing-enabled gate (transactional
 *   under CAN-SPAM). Marketing messages are suppressed when the recipient
 *   has marketing_enabled = false.
 */
function registerHandler(messageType, handlerFn, options = {}) {
  if (typeof handlerFn !== 'function') {
    throw new Error(`registerHandler: handlerFn for '${messageType}' must be a function`);
  }
  // priority: integer 1-5, 1 = highest. Default 3 (Lifecycle tier) so a handler
  // registered without an explicit priority loses to operational touches but
  // beats drip/marketing. cooldownExempt: when true, the dispatcher's
  // overlap-prevention pass never defers this message_type (event_eve and
  // balance_due_today MUST fire on their exact day, see spec 7.4).
  // multiChannel: when true, this touch is scheduled as BOTH an email row and
  // an SMS row; the channel-substitution step (spec 7.3) never substitutes a
  // multiChannel row. If that row's own channel is dead it simply suppresses
  // and the paired row on the other channel handles delivery.
  const priority = (options.priority === undefined || options.priority === null)
    ? 3
    : Number(options.priority);
  const meta = {
    offsetFromEventDate: (options.offsetFromEventDate === null || options.offsetFromEventDate === undefined) ? null : Number(options.offsetFromEventDate),
    anchor: options.anchor || 'event_date',
    category: options.category || 'operational',
    priority,
    cooldownExempt: options.cooldownExempt === true,
    multiChannel: options.multiChannel === true,
  };
  if (!VALID_ANCHORS.has(meta.anchor)) {
    throw new Error(`registerHandler: invalid anchor '${meta.anchor}' for '${messageType}'`);
  }
  if (!VALID_CATEGORIES.has(meta.category)) {
    throw new Error(`registerHandler: invalid category '${meta.category}' for '${messageType}'`);
  }
  if (meta.offsetFromEventDate !== null && !Number.isFinite(meta.offsetFromEventDate)) {
    throw new Error(`registerHandler: offsetFromEventDate must be a finite number or null for '${messageType}'`);
  }
  if (!Number.isInteger(meta.priority) || meta.priority < 1 || meta.priority > 5) {
    throw new Error(`registerHandler: priority must be an integer 1-5 for '${messageType}'`);
  }
  handlers.set(messageType, handlerFn);
  handlerMeta.set(messageType, meta);
}

/**
 * Look up the metadata for a registered message_type. Returns null when no
 * handler is registered (caller should treat that as "leave the row alone").
 *
 * Consumed primarily by Plan 2c's `reanchorPendingMessages` so the reschedule
 * cascade can recompute scheduled_for for every pending row regardless of
 * which plan registered it (2a balance reminders, 2c event-week / T-30, 2d
 * marketing). This replaces Plan 2c's local `messageOffsets` constant per
 * Gemini Finding 1.
 *
 * @param {string} messageType
 * @returns {{offsetFromEventDate: number|null, anchor: string, category: string, priority: number, cooldownExempt: boolean, multiChannel: boolean} | null}
 */
function getHandlerMeta(messageType) {
  return handlerMeta.get(messageType) || null;
}

function _clearHandlersForTest() {
  handlers.clear();
  handlerMeta.clear();
}

function _handlersForTest() {
  return handlers;
}

// ─── Built-in suppression checks ──────────────────────────────

// Entity and recipient are guaranteed non-null when this runs via the
// dispatcher: dispatchRow() rejects missing-lookup rows with status='failed'
// before calling this function. This is a deliberate divergence from the
// in-app shouldSendImmediate() in messageSuppression.js, which treats a
// missing client as 'bad_contact' (silent suppression). Scheduled rows with
// bad references are data integrity issues we want surfaced as 'failed', not
// hidden behind 'suppressed'.
//
// External callers via the public export (cc-import wrap-up preview UI) must
// defensively pass at least a `row` shape; the guard below returns null on
// missing `row` so the preview surface sees a clean no-suppression result
// instead of crashing on property access.
async function checkSuppression({ row, entity, recipient }) {
  if (!row) return null; // Defensive: external callers (cc-import wrap-up preview) may invoke without a row.
  // Archived-proposal cascade — universal rule per spec section 7.1.
  if (row.entity_type === 'proposal' && entity && entity.status === 'archived') {
    return 'archived: proposal is archived, cascade rule applies';
  }
  // Same cascade for staff shift rows (Phase 4a): a shift_reminder /
  // staff_thank_you row carries entity_type='shift'. lookupEntity returns the
  // shifts row, which has proposal_id but not the linked proposal's status,
  // so join to proposals here. Archived linked proposal -> suppressed (not
  // failed). Runs before the handler, so it does not rely on the handler's
  // own archived guard.
  if (row.entity_type === 'shift' && entity && entity.proposal_id) {
    const pr = await pool.query(
      'SELECT status FROM proposals WHERE id = $1',
      [entity.proposal_id]
    );
    if (pr.rows[0] && pr.rows[0].status === 'archived') {
      return 'archived: linked proposal is archived, cascade rule applies';
    }
  }
  // Per-channel client comm-prefs / bad-contact handling moved to the
  // resolveDelivery step in dispatchRow (Phase 4b): instead of a blunt
  // suppress, a single-channel operational touch substitutes the alternate
  // channel, and a both-channels-bad client has its automation suspended.
  // Phase 4a's recipient_type IN ('staff','admin') branch (if present) stays.
  // Per-channel comm-prefs for staff and admin recipients (Phase 4a). Staff
  // SMS opt-out is set by the STOP keyword flipping
  // users.communication_preferences.sms_enabled. `users` has no
  // email_status / phone_status columns, so only the prefs flags are checked
  // here — there is no bad-contact branch for staff/admin.
  if ((row.recipient_type === 'staff' || row.recipient_type === 'admin') && recipient) {
    const prefs = recipient.communication_preferences || {};
    if (row.channel === 'sms' && prefs.sms_enabled === false) {
      return `suppressed: ${row.recipient_type}.communication_preferences.sms_enabled is false`;
    }
    if (row.channel === 'email' && prefs.email_enabled === false) {
      return `suppressed: ${row.recipient_type}.communication_preferences.email_enabled is false`;
    }
  }
  return null;
}

// ─── Overlap prevention (spec 7.4) ───────────────────────────
// Max 1 scheduled message per channel per client per day. When a lower- or
// equal-priority touch collides with one that already fired in the trailing
// 24h on the same client+channel, the current row is deferred 24h. Handlers
// flagged cooldownExempt (event_eve, balance_due_today) skip this check.
//
// Returns true when the row should be deferred, false when it may proceed.
async function shouldDeferForOverlap(row) {
  // Cooldown is a client-only rule. Staff/admin touches always proceed.
  if (row.recipient_type !== 'client') return false;

  const meta = handlerMeta.get(row.message_type);
  // No metadata, or explicitly exempt: never defer.
  if (!meta || meta.cooldownExempt === true) return false;

  // Look for another row, same recipient + channel, SENT within the trailing
  // 24h. Pick the strongest (lowest priority number) colliding type so the
  // tie-break compares against the best touch that used the channel.
  const { rows } = await pool.query(
    `SELECT message_type
       FROM scheduled_messages
      WHERE recipient_type = 'client'
        AND recipient_id = $1
        AND channel = $2
        AND status = 'sent'
        AND sent_at IS NOT NULL
        AND sent_at > NOW() - INTERVAL '24 hours'
        AND id <> $3`,
    [row.recipient_id, row.channel, row.id]
  );
  if (rows.length === 0) return false;

  // Strongest colliding priority = lowest priority number among the sent rows.
  // A sent row whose message_type is no longer registered defaults to 3.
  let strongestColliding = 5;
  for (const r of rows) {
    const m = handlerMeta.get(r.message_type);
    const p = (m && Number.isInteger(m.priority)) ? m.priority : 3;
    if (p < strongestColliding) strongestColliding = p;
  }

  // Current row defers when it is NOT strictly higher priority than the
  // strongest touch that already used the channel today (i.e. its priority
  // number is >= the colliding one). A strictly-higher row (lower number)
  // proceeds, the channel is already spent, deferring would only delay it.
  return meta.priority >= strongestColliding;
}

// ─── Delivery resolution: channel substitution + both-bad suspension ──
// Spec 7.3 / 7.5. For a client-recipient row, decide whether to send on the
// row's channel, substitute the alternate channel, or suppress. On a
// no-working-channel result the client's remaining automation is suspended.
//
// Multi-channel touches (handler meta multiChannel:true) are scheduled as BOTH
// an email row and an SMS row. Spec 7.3 is explicit: a multi-channel touch gets
// NO substitution. If a multiChannel row's own channel is dead, that row
// simply suppresses and the paired row on the other channel still fires.
// Substituting would put a second message on the live channel ON TOP OF the
// paired row (e.g. a drink_plan_nudge email row substituted to SMS alongside
// the real drink_plan_nudge_sms row, two SMS). Substitution applies only to
// single-channel touches.
//
// Returns { proceed: true } when dispatch should continue (the row's `channel`
// field may have been rewritten), or { proceed: false } when the row was
// terminal-marked (suppressed) and dispatch must stop.
async function resolveDelivery(row, recipient) {
  // Staff/admin rows: Phase 4a owns their suppression in checkSuppression.
  // Phase 4b's substitution rule is a client rule only.
  if (row.recipient_type !== 'client' || !recipient) return { proceed: true };

  const meta = handlerMeta.get(row.message_type);
  const category = (meta && meta.category) || 'operational';
  const isMultiChannel = !!(meta && meta.multiChannel);
  const decision = resolveChannelFallback({ channel: row.channel, client: recipient, category });

  if (decision.action === 'proceed') {
    return { proceed: true };
  }

  if (decision.action === 'substitute') {
    if (isMultiChannel) {
      // Multi-channel touch (spec 7.3): no substitution. This row's own channel
      // is dead, so suppress just this row, the paired row on the other channel
      // handles delivery independently. Do NOT rewrite the channel.
      await pool.query(
        "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
        [row.id, `suppressed: ${row.channel} unavailable for client; multi-channel touch, paired row handles the other channel (spec 7.3)`]
      );
      return { proceed: false };
    }
    // Single-channel touch: rewrite the row's channel in place so the handler
    // and the final status='sent' write both reflect the channel actually
    // used. Mutate the in-memory row too so the handler sees the substituted
    // channel.
    await pool.query(
      'UPDATE scheduled_messages SET channel = $2 WHERE id = $1',
      [row.id, decision.channel]
    );
    row.channel = decision.channel;
    return { proceed: true };
  }

  // decision.action === 'suppress'
  if (decision.reason === 'no_working_channel') {
    // Both channels dead: suppress this row, suspend the rest of the client's
    // automation, and fire one admin alert.
    await pool.query(
      "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
      [row.id, 'suppressed: no working contact channel for client (spec 7.5)']
    );
    try {
      await suspendClientAutomation(row.recipient_id);
      await alertNoWorkingChannel(row.recipient_id, recipient);
    } catch (suspendErr) {
      Sentry.captureException(suspendErr, {
        tags: { dispatcher: 'scheduled_messages', step: 'suspend_client' },
        extra: { client_id: row.recipient_id },
      });
    }
    return { proceed: false };
  }

  // marketing_disabled or any other suppress reason: just suppress this row.
  await pool.query(
    "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
    [row.id, `suppressed: ${decision.reason || 'channel unavailable'}`]
  );
  return { proceed: false };
}

// Fire an admin alert that a client has no working contact channel. Uses the
// Phase 4b admin-notification helper when available; falls back to a direct
// email to ADMIN_EMAIL when Group 3 has not landed yet.
async function alertNoWorkingChannel(clientId, recipient) {
  const clientName = (recipient && recipient.name) || `client #${clientId}`;
  const subject = 'No working contact channel for a client';
  const bodyLine = `Automated messaging is suspended for ${clientName} (client #${clientId}). Both email and SMS are unavailable (opted out or bouncing). Update their contact details in the admin client page to resume automation.`;
  let helper = null;
  try {
    helper = require('./adminNotifications');
  } catch (_e) {
    helper = null;
  }
  if (helper && typeof helper.notifyAdminCategory === 'function') {
    await helper.notifyAdminCategory({
      category: 'system_error',
      subject,
      emailHtml: `<p>${esc(bodyLine)}</p>`,
      emailText: bodyLine,
      smsBody: `Dr. Bartender: messaging suspended for ${clientName}. No working email or phone on file. Update their contact info.`,
    });
    return;
  }
  // Fallback: direct email to the single admin address.
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    await sendEmail({
      to: adminEmail,
      subject,
      html: `<p>${esc(bodyLine)}</p>`,
      text: bodyLine,
    });
  }
}

// ─── Entity / recipient lookups ──────────────────────────────

async function lookupEntity(entityType, entityId) {
  if (entityType === 'proposal') {
    const r = await pool.query(
      `SELECT id, status, event_date, event_type, event_type_custom, total_price, amount_paid, balance_due_date,
              autopay_enrolled, client_id, token, event_timezone
       FROM proposals WHERE id = $1`,
      [entityId]
    );
    return r.rows[0] || null;
  }
  if (entityType === 'client') {
    const r = await pool.query('SELECT id, name, email, phone FROM clients WHERE id = $1', [entityId]);
    return r.rows[0] || null;
  }
  if (entityType === 'shift') {
    const r = await pool.query(
      `SELECT id, proposal_id, event_date, start_time, end_time, location,
              status, setup_minutes_before, positions_needed,
              event_type, event_type_custom, client_name
       FROM shifts WHERE id = $1`,
      [entityId]
    );
    return r.rows[0] || null;
  }
  if (entityType === 'consult') {
    const r = await pool.query(
      `SELECT id, client_id, proposal_id, scheduled_at, calcom_event_id, status
       FROM consults WHERE id = $1`,
      [entityId]
    );
    return r.rows[0] || null;
  }
  return null;
}

async function lookupRecipient(recipientType, recipientId) {
  if (recipientType === 'client') {
    const r = await pool.query(
      `SELECT id, name, email, phone, communication_preferences, email_status, phone_status
       FROM clients WHERE id = $1`,
      [recipientId]
    );
    return r.rows[0] || null;
  }
  // staff / admin live in users table. NOTE: `users` has no `phone` column —
  // staff phone numbers live on `contractor_profiles`. Plan 2b/2d handlers
  // that need staff phone numbers must join contractor_profiles themselves;
  // the dispatcher only loads the minimal recipient row here.
  const r = await pool.query(
    `SELECT id, email, role, communication_preferences
     FROM users WHERE id = $1`,
    [recipientId]
  );
  return r.rows[0] || null;
}

// ─── Dispatch one row ────────────────────────────────────────

// Push-channel dispatch (dispatchPushRow) lives in ./pushDispatch.js — extracted
// from this file and fixed for SERVER-17 (no transaction is held across the
// web-push network sends; dead subs are pruned in a separate short transaction).

// Sibling-suppression cascade: when one row in a suppression_key group sends
// successfully, mark the remaining pending siblings 'suppressed_by_sibling' so
// the user doesn't receive the same notification on push AND SMS AND email.
async function markSiblingsSuppressed(suppressionKey, currentRowId) {
  if (!suppressionKey) return;
  await pool.query(
    `UPDATE scheduled_messages
        SET status = 'suppressed_by_sibling',
            error_message = $3
      WHERE suppression_key = $1
        AND id <> $2
        AND status = 'pending'`,
    [suppressionKey, currentRowId, `sibling_sent: row ${currentRowId} delivered first`]
  );
}

// Release a claimed row back to 'pending' when a terminal-status write itself
// fails, so the claim is never orphaned in 'processing' (the drain loop only
// re-selects 'pending', and the deferred-reactivation pass only touches
// 'deferred'). Best-effort and guarded on status='processing' so it never
// stomps a state some other path already wrote. This preserves the pre-claim
// behavior where a row whose terminal write failed simply stayed retryable.
async function releaseClaim(rowId) {
  try {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'pending', claimed_at = NULL WHERE id = $1 AND status = 'processing'",
      [rowId]
    );
  } catch (releaseErr) {
    console.error('[scheduledMessageDispatcher] failed to release claim:', releaseErr.message);
  }
}

async function dispatchRow(row) {
  let entity, recipient;
  try {
    // Atomic per-row claim (supersedes the old stale-row SELECT guard). Flip
    // this row 'pending' -> 'processing' in one statement; only the worker whose
    // UPDATE returns the row may handle it. This closes two gaps at once:
    //   1. Concurrency: a second dispatcher tick / instance that SELECTed the
    //      same pending row loses the claim (rowCount 0) and skips, so a
    //      notification is never double-sent.
    //   2. Same-tick staleness: a row flipped earlier this tick by
    //      suspendClientAutomation / sibling-suppression (pending -> suppressed)
    //      no longer matches status='pending', so the claim returns 0 and we
    //      skip silently — exactly what the old guard protected against (no
    //      duplicate admin alert).
    // The row stays 'processing' until a terminal write below moves it to
    // sent/failed/suppressed/deferred, or a failed terminal write releases it
    // back to 'pending' (releaseClaim) so it stays retryable.
    const claim = await pool.query(
      "UPDATE scheduled_messages SET status = 'processing', claimed_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING id",
      [row.id]
    );
    if (claim.rowCount === 0) {
      return;
    }

    // Push channel branch (Phase 2 Task 7). Push rows bypass the registered-handler
    // model entirely — the payload travels on the row.
    if (row.channel === 'push') {
      await dispatchPushRow(row);
      // If push sent, cascade-suppress siblings in the same logical group.
      const after = await pool.query("SELECT status FROM scheduled_messages WHERE id = $1", [row.id]);
      if (after.rows[0] && after.rows[0].status === 'sent') {
        await markSiblingsSuppressed(row.suppression_key, row.id);
      }
      return;
    }

    [entity, recipient] = await Promise.all([
      lookupEntity(row.entity_type, row.entity_id),
      lookupRecipient(row.recipient_type, row.recipient_id),
    ]);

    if (!entity || !recipient) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
        [row.id, `lookup failed: entity=${!!entity} recipient=${!!recipient}`]
      );
      return;
    }

    const suppressionReason = await checkSuppression({ row, entity, recipient });
    if (suppressionReason) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
        [row.id, suppressionReason]
      );
      return;
    }

    // Delivery resolution (spec 7.3 / 7.5): channel substitution + both-bad
    // suspension. May rewrite row.channel, or terminal-mark the row and stop.
    const delivery = await resolveDelivery(row, recipient);
    if (!delivery.proceed) {
      return;
    }

    // Marketing-class gate (Gemini Finding 5). The handler registry carries a
    // `category` metadata field; marketing-class messages are suppressed when
    // the client opted out of marketing comms. Operational messages bypass
    // this gate (CAN-SPAM allows transactional follow-ups regardless of
    // marketing preference). Plan 2d's marketing handlers all register with
    // category='marketing'; review_request stays operational because it's a
    // post-sale transactional follow-up.
    const meta = handlerMeta.get(row.message_type);
    if (meta?.category === 'marketing' && row.recipient_type === 'client') {
      const prefs = recipient.communication_preferences || {};
      if (prefs.marketing_enabled === false) {
        await pool.query(
          "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
          [row.id, 'marketing_disabled: client.communication_preferences.marketing_enabled is false']
        );
        return;
      }
    }

    // Overlap prevention (spec 7.4): defer a colliding lower-priority touch by
    // 24h. The row goes 'deferred' and its scheduled_for moves forward a day;
    // the dispatcher's deferred-reactivation pass flips it back to 'pending'
    // when it next comes due.
    if (await shouldDeferForOverlap(row)) {
      await pool.query(
        `UPDATE scheduled_messages
            SET status = 'deferred',
                scheduled_for = scheduled_for + INTERVAL '24 hours',
                error_message = 'deferred: daily per-channel cooldown (spec 7.4)'
          WHERE id = $1`,
        [row.id]
      );
      return;
    }

    const handler = handlers.get(row.message_type);
    if (!handler) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
        [row.id, `no handler registered for message_type '${row.message_type}'`]
      );
      return;
    }

    await handler({ entity, recipient, scheduledMessage: row });

    // Terminal write is guarded on the claim we still hold ('processing'): if
    // anything flipped this row out from under us, do not overwrite it as 'sent'.
    await pool.query(
      "UPDATE scheduled_messages SET status = 'sent', sent_at = NOW(), error_message = NULL WHERE id = $1 AND status = 'processing'",
      [row.id]
    );

    // Sibling-suppression cascade (Phase 2 Task 7): collapse other rows in the
    // same suppression_key group so the staffer doesn't get the same
    // notification through multiple channels when one was enough.
    await markSiblingsSuppressed(row.suppression_key, row.id);
  } catch (err) {
    // SuppressMessageError must be handled FIRST, before any Sentry / console call.
    // Suppressions are expected dispatch outcomes for handler-side gates (e.g.,
    // BEO already acknowledged, balance already paid), not failures.
    if (err instanceof SuppressMessageError) {
      const cappedReason = String(err.reason || '').slice(0, 500);
      try {
        await pool.query(
          "UPDATE scheduled_messages SET status='suppressed', error_message=$2 WHERE id=$1",
          [row.id, cappedReason]
        );
      } catch (markErr) {
        console.error('[scheduledMessageDispatcher] failed to mark row suppressed:', markErr.message);
        await releaseClaim(row.id);
      }
      return;
    }
    // QuotaExceededError is transient (provider daily cap): defer for retry after
    // reset rather than fail it ('failed' is terminal — the row would be dropped).
    if (err instanceof QuotaExceededError) {
      try {
        await deferRowForQuota(row.id);
      } catch (deferErr) {
        console.error('[scheduledMessageDispatcher] failed to defer row for quota:', deferErr.message);
        await releaseClaim(row.id);
      }
      maybeAlertQuotaOnce({ row_id: row.id, message_type: row.message_type });
      return;
    }
    Sentry.captureException(err, {
      tags: { dispatcher: 'scheduled_messages', message_type: row.message_type },
      extra: { row_id: row.id, entity_type: row.entity_type, entity_id: row.entity_id },
    });
    console.error(`[scheduledMessageDispatcher] row ${row.id} (${row.message_type}) failed:`, err.message);
    try {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
        [row.id, String(err.message || err).slice(0, 500)]
      );
    } catch (markErr) {
      console.error('[scheduledMessageDispatcher] failed to mark row failed:', markErr.message);
      await releaseClaim(row.id);
    }
  }
}

// ─── Pull pending rows and dispatch ──────────────────────────

const BATCH_LIMIT = 100;
// Max drain passes per tick — 50 x BATCH_LIMIT = 5000 messages, well above any
// real backlog. Bounds the drain loop so a row whose terminal-status write
// keeps failing cannot spin the tick (the remainder carries to the next tick).
const MAX_DRAIN_PASSES = 50;

// Re-entrancy guard. dispatchPending is fired on a 5-min setInterval, and
// wrapScheduler does NOT serialize ticks. If one run overruns the interval, the
// next tick would re-SELECT rows the prior run has already sent but not yet
// marked 'sent' (dispatchRow sends, THEN updates) and send them again —
// duplicate balance reminders / autopay receipts. A module-level in-flight flag
// makes an overlapping tick a no-op until the prior run finishes.
let _dispatchInFlight = false;

async function dispatchPending() {
  if (_dispatchInFlight) {
    console.warn('[scheduledMessageDispatcher] previous dispatch still in flight — skipping this tick');
    return;
  }
  _dispatchInFlight = true;
  try {
    // Reactivate deferred rows (spec 7.4): a row deferred by the overlap rule
    // had its scheduled_for bumped 24h. Flip any deferred row that is now due
    // back to 'pending' so the drain loop below re-evaluates it (it may defer
    // again if another touch fired in the new 24h window, or fire if clear).
    await pool.query(
      `UPDATE scheduled_messages
          SET status = 'pending'
        WHERE status = 'deferred'
          AND scheduled_for <= NOW()`
    );
    // Reap stranded claims: a crash or deploy SIGTERM between the claim and its
    // terminal write leaves a row in 'processing' that nothing re-selects (the
    // drain pulls 'pending' only), silently losing that notification forever.
    // Ten minutes is far beyond any legitimate in-flight handler, and the
    // claimed_at age guard means a concurrent instance's fresh claims are never
    // stolen.
    await pool.query(
      `UPDATE scheduled_messages
          SET status = 'pending', claimed_at = NULL
        WHERE status = 'processing'
          AND claimed_at < NOW() - INTERVAL '10 minutes'`
    );
    // Drain fully: keep pulling batches while the last one was full, so a
    // backlog larger than BATCH_LIMIT clears within this tick instead of
    // waiting for the next 5-min interval. dispatchRow normally moves a row out
    // of 'pending' (sent/failed/suppressed); MAX_DRAIN_PASSES bounds the loop so
    // a row whose terminal-status write itself keeps failing cannot spin the
    // tick — the remaining backlog just carries to the next interval.
    let batchSize;
    let passes = 0;
    do {
      const { rows } = await pool.query(
        `SELECT id, entity_id, entity_type, message_type, recipient_type, recipient_id, channel,
                scheduled_for, suppression_key, payload
         FROM scheduled_messages
         WHERE status = 'pending' AND scheduled_for <= NOW()
         ORDER BY scheduled_for ASC
         LIMIT $1`,
        [BATCH_LIMIT]
      );
      batchSize = rows.length;

      // Dispatch the batch highest-priority-first (spec 7.4). The SQL ORDER BY
      // is scheduled_for ASC, but the overlap rule needs the higher-priority
      // touch of a same-client+channel+day collision to fire FIRST so it claims
      // the channel and the lower-priority touch defers. Priority lives in the
      // in-memory handler registry (handlerMeta), not a scheduled_messages
      // column, so this is an in-memory sort, not a SQL ORDER BY. An
      // unregistered message_type (no handlerMeta entry) sorts last.
      rows.sort((a, b) => {
        const metaA = handlerMeta.get(a.message_type);
        const metaB = handlerMeta.get(b.message_type);
        const prioA = (metaA && Number.isInteger(metaA.priority)) ? metaA.priority : Number.MAX_SAFE_INTEGER;
        const prioB = (metaB && Number.isInteger(metaB.priority)) ? metaB.priority : Number.MAX_SAFE_INTEGER;
        if (prioA !== prioB) return prioA - prioB;
        return new Date(a.scheduled_for) - new Date(b.scheduled_for);
      });

      for (const row of rows) {
        // Sequential dispatch — keeps a single SMTP burst from blowing past
        // Resend's rate limit. If volume grows, swap to a concurrency-limited
        // Promise queue.
        await dispatchRow(row);
      }
      passes += 1;
    } while (batchSize === BATCH_LIMIT && passes < MAX_DRAIN_PASSES);
    if (batchSize === BATCH_LIMIT) {
      console.warn(`[scheduledMessageDispatcher] hit the ${MAX_DRAIN_PASSES}-pass drain cap — remaining backlog carries to the next tick`);
    }

    // Critical-path re-resolve sweep (Phase 2 Task 7). After the main drain,
    // find suppression_key groups where every row is terminal AND the group
    // never delivered ('sent') AND the category is in CRITICAL_CATEGORIES.
    // Bump re_resolve_count; if >= 2, dead-letter. Else re-resolve via
    // pickChannelsForUserAndCategory and enqueue ONE fresh row with a new key.
    await resolveCriticalDeadLetters();
  } finally {
    _dispatchInFlight = false;
  }
}

async function resolveCriticalDeadLetters() {
  // One row per group, GROUP BY suppression_key. Only consider groups where:
  //   - All rows are terminal (sent / failed / suppressed / suppressed_by_sibling / dead_letter)
  //   - NO sibling is 'sent', 'pending', or 'deferred' (no live retry in flight)
  //   - The category (from payload->>'category') is in CRITICAL_CATEGORIES
  //   - The group's max re_resolve_count is < 2
  // For each group, increment counter + re-resolve + enqueue OR dead-letter all rows.
  const { rows: groups } = await pool.query(
    `SELECT suppression_key,
            recipient_id AS user_id,
            entity_type, entity_id, message_type,
            MAX(COALESCE((payload->>'category'), '')) AS category,
            MAX(COALESCE((payload->>'re_resolve_count')::int, 0)) AS re_resolve_count,
            MAX(scheduled_for) AS last_scheduled
       FROM scheduled_messages
      WHERE suppression_key IS NOT NULL
        AND recipient_type = 'staff'
        AND status IN ('failed','suppressed','suppressed_by_sibling','dead_letter')
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_messages sm2
           WHERE sm2.suppression_key = scheduled_messages.suppression_key
             AND sm2.status IN ('sent','pending','deferred','processing')
        )
      GROUP BY suppression_key, recipient_id, entity_type, entity_id, message_type
      HAVING MAX(COALESCE((payload->>'re_resolve_count')::int, 0)) < 99`
  );

  for (const group of groups) {
    if (!CRITICAL_CATEGORIES.has(group.category)) continue;

    // If counter already hit the cap, dead-letter everything in the group.
    if (group.re_resolve_count >= 2) {
      await pool.query(
        `UPDATE scheduled_messages
            SET status = 'dead_letter',
                error_message = $2
          WHERE suppression_key = $1
            AND status IN ('failed','suppressed','suppressed_by_sibling')`,
        [group.suppression_key, 're_resolve_cap_reached']
      );
      Sentry.captureMessage('critical_path_dead_letter', {
        tags: { dispatcher: 'critical_path' },
        extra: {
          user_id: group.user_id,
          category: group.category,
          message_type: group.message_type,
          suppression_key: group.suppression_key,
          re_resolve_count: group.re_resolve_count,
        },
      });
      // Out-of-band hotline SMS (spec §6.13)
      if (process.env.ADMIN_PHONE) {
        try {
          await sms.sendAndLogSms({
            to: process.env.ADMIN_PHONE,
            body: `DR BARTENDER: critical message dead-lettered for user ${group.user_id} category ${group.category}, check Sentry`,
            messageType: 'critical_path_dead_letter_alert',
          });
        } catch (smsErr) {
          console.error('[dispatcher] critical-path dead-letter ADMIN_PHONE SMS failed:', smsErr.message);
        }
      }
      continue;
    }

    // Re-resolve with fresh state.
    const resolved = await pickChannelsForUserAndCategory(group.user_id, group.category);
    if (resolved.kind === 'dead_letter') {
      await pool.query(
        `UPDATE scheduled_messages
            SET status = 'dead_letter',
                error_message = $2
          WHERE suppression_key = $1
            AND status IN ('failed','suppressed','suppressed_by_sibling')`,
        [group.suppression_key, 're_resolve_all_blocked']
      );
      Sentry.captureMessage('critical_path_dead_letter', {
        tags: { dispatcher: 'critical_path' },
        extra: {
          user_id: group.user_id,
          category: group.category,
          message_type: group.message_type,
          reason: 'resolver_dead_letter',
        },
      });
      if (process.env.ADMIN_PHONE) {
        try {
          await sms.sendAndLogSms({
            to: process.env.ADMIN_PHONE,
            body: `DR BARTENDER: critical message dead-lettered for user ${group.user_id} category ${group.category}, check Sentry`,
            messageType: 'critical_path_dead_letter_alert',
          });
        } catch (smsErr) {
          console.error('[dispatcher] critical-path dead-letter ADMIN_PHONE SMS failed:', smsErr.message);
        }
      }
      continue;
    }
    // Enqueue ONE new row at the first resolved channel with a fresh
    // suppression_key + re_resolve_count + 1. Reuse the same entity context.
    const nextChannel = resolved.channels[0];
    const newCount = group.re_resolve_count + 1;
    const newKey = `${group.suppression_key}:retry${newCount}`;
    // Read the original row's payload to carry forward (modulo the counter).
    const { rows: srcRows } = await pool.query(
      `SELECT payload FROM scheduled_messages
        WHERE suppression_key = $1 ORDER BY id ASC LIMIT 1`,
      [group.suppression_key]
    );
    const srcPayload = srcRows[0]?.payload || {};
    const newPayload = { ...srcPayload, re_resolve_count: newCount };
    await pool.query(
      `INSERT INTO scheduled_messages
         (entity_id, entity_type, message_type, recipient_type, recipient_id,
          channel, scheduled_for, status, suppression_key, payload)
       VALUES ($1, $2, $3, 'staff', $4, $5, NOW(), 'pending', $6, $7::jsonb)
       ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
         WHERE status = 'pending'
       DO NOTHING`,
      [group.entity_id, group.entity_type, group.message_type, group.user_id,
       nextChannel, newKey, JSON.stringify(newPayload)]
    );
    // Degradation breadcrumb: ops can see silent channel substitution.
    Sentry.addBreadcrumb({
      category: 'notifications',
      message: 'critical_path_re_resolved',
      data: {
        user_id: group.user_id,
        category: group.category,
        new_channel: nextChannel,
        re_resolve_count: newCount,
      },
    });
  }
}

// ─── Built-in money-path handlers ────────────────────────────

function proposalUrl(token) {
  return `${PUBLIC_SITE_URL}/proposal/${token}`;
}

function lastFour(_proposal) {
  // last4 is not stored on proposals today (only stripe_payment_method_id).
  // Return null so templates skip the line. Future task: store last4 alongside
  // the payment method id at deposit time so we can render it here.
  return null;
}

async function sendBalanceReminder({ entity, recipient, paymentMode }) {
  const balanceDue = Number(entity.total_price) - Number(entity.amount_paid);
  if (balanceDue <= 0) {
    throw new SuppressMessageError(`balance_not_positive:${balanceDue}`);
  }
  const tpl = emailTemplates.paymentReminderClient({
    clientName: recipient.name,
    eventTypeLabel: getEventTypeLabel({ event_type: entity.event_type, event_type_custom: entity.event_type_custom }),
    balanceDue,
    balanceDueDate: entity.balance_due_date,
    proposalUrl: proposalUrl(entity.token),
    paymentMode,
    last4: lastFour(entity),
  });
  await sendEmail({ to: recipient.email, ...tpl });
}

async function sendBalanceDueToday({ entity, recipient }) {
  // T+0 — "balance due today" non-autopay email. Reuses paymentReminderClient
  // in manual mode but with a more urgent subject. Could be a separate template
  // later; for now, the manual variant covers the body.
  await sendBalanceReminder({ entity, recipient, paymentMode: 'manual' });
}

async function sendBalanceLate({ entity, recipient, daysLate }) {
  const balanceDue = Number(entity.total_price) - Number(entity.amount_paid);
  if (balanceDue <= 0) {
    throw new SuppressMessageError(`balance_not_positive:${balanceDue}`);
  }
  const tpl = emailTemplates.paymentReminderLate({
    clientName: recipient.name,
    eventTypeLabel: getEventTypeLabel({ event_type: entity.event_type, event_type_custom: entity.event_type_custom }),
    balanceDue,
    proposalUrl: proposalUrl(entity.token),
    daysLate,
  });
  await sendEmail({ to: recipient.email, ...tpl });
}

// All money-path handlers are anchored on balance_due_date (NOT event_date)
// so Plan 2c's reschedule cascade re-anchors them correctly when admin updates
// the balance due date (Gemini Finding 1 + 6 — balance-due-date updates on
// reschedule are tracked as a follow-up in Plan 2c).
const DAY_SECONDS = 86400;

registerHandler(
  'balance_reminder_autopay_t3',
  ({ entity, recipient }) => sendBalanceReminder({ entity, recipient, paymentMode: 'autopay' }),
  { offsetFromEventDate: -3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 1 }
);
registerHandler(
  'balance_reminder_non_autopay_t3',
  ({ entity, recipient }) => sendBalanceReminder({ entity, recipient, paymentMode: 'manual' }),
  { offsetFromEventDate: -3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 1 }
);
registerHandler(
  'balance_due_today',
  ({ entity, recipient }) => sendBalanceDueToday({ entity, recipient }),
  { offsetFromEventDate: 0, anchor: 'balance_due_date', category: 'operational', priority: 1, cooldownExempt: true, multiChannel: true }
);
registerHandler(
  'balance_late_t1',
  ({ entity, recipient }) => sendBalanceLate({ entity, recipient, daysLate: 1 }),
  { offsetFromEventDate: 1 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 2, multiChannel: true }
);
registerHandler(
  'balance_late_t3',
  ({ entity, recipient }) => sendBalanceLate({ entity, recipient, daysLate: 3 }),
  { offsetFromEventDate: 3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 2, multiChannel: true }
);

// checkSuppression is pure (SELECT + branch); safe to expose.
// resolveDelivery has DB-write side effects — DO NOT export.
module.exports = {
  registerHandler,
  getHandlerMeta,
  dispatchPending,
  checkSuppression,
  _clearHandlersForTest,
  _handlersForTest,
  // Test seam: the per-row claim + dispatch unit, exercised directly by the
  // concurrency (claim) test without draining the whole shared-DB queue.
  _dispatchRowForTest: dispatchRow,
};
