const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');
const { resolveChannelFallback } = require('./channelFallback');
const { suspendClientAutomation } = require('./clientAutomationSuspension');

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
      emailHtml: `<p>${bodyLine}</p>`,
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
      html: `<p>${bodyLine}</p>`,
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
              status, archived_at, setup_minutes_before, positions_needed
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

async function dispatchRow(row) {
  let entity, recipient;
  try {
    // Stale-row guard. The batch was SELECTed into memory at the top of the
    // tick; a row processed earlier in the same batch may have flipped this
    // row's status via suspendClientAutomation (the both-channels-bad cascade
    // in resolveDelivery flips a client's other pending/deferred rows to
    // 'suppressed'). Re-verify the row is still 'pending' before doing any
    // work, if it is not, it was already handled this tick; skip it silently
    // so resolveDelivery does not re-fire a duplicate admin alert.
    const stillPending = await pool.query(
      "SELECT 1 FROM scheduled_messages WHERE id = $1 AND status = 'pending'",
      [row.id]
    );
    if (stillPending.rowCount === 0) {
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

    await pool.query(
      "UPDATE scheduled_messages SET status = 'sent', sent_at = NOW(), error_message = NULL WHERE id = $1",
      [row.id]
    );
  } catch (err) {
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
        `SELECT id, entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for
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
  } finally {
    _dispatchInFlight = false;
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
    throw new Error('balance reminder fired but balance is zero or negative');
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
    throw new Error('late reminder fired but balance is zero or negative');
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
};
